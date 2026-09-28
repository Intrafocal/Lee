"""
The Desk (docs/16-Desk.md; contract docs/plans/2026-09-27-desk-foundation-contract.md §3, §6).

One store per workspace at ``<workspace>/.hester/desk/`` (0700)::

    desk.json                   layout: Areas, card positions, Drawers, the Goals card, strokes, last, migration
    sessions.jsonl              Desk session records, one per line
    pages/<pg-id>/
      card.json                 {id, kind: 'page', title, purpose, seed, goals, origin, created_at,
                                 updated_at, last_touched_at, migrated_from}
      page.md                   the user's writing
      answers.jsonl             asks and hand-offs (deep.py's rows, same ids)
      references.jsonl          kept quotes and links
      questions.jsonl           questions (an exploration kept them in frontmatter)

Titles live in ``card.json`` only; ``desk.json`` holds layout and ``GET /desk``
joins them. ``PageStore`` gives deep.py the surface of an ``ExplorationStore``
(``require``, ``exists``, ``get``, ``exp_dir``, ``page_path``, ``touch``,
``workspace``), so a Page card has exactly the Page's rules: the 1 MB cap, the
version conflict, anchors, file references and the delete guard.

The migration from ``.hester/explore/`` copies (it never writes or deletes
there), is idempotent through ``migration.map`` and runs lazily before every
Desk read. Everything here is deterministic; no model runs. Callers hold the
workspace lock; a process-wide lock also keeps each ``desk.json``
read-modify-write whole.
"""

import json
import logging
import os
import re
import secrets
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import deep
from .explorations import (
    EXPLORATION_FILE,
    MAX_PAGE_BYTES,
    MAX_TITLE,
    PAGE_FILE,
    ExplorationError,
    ExplorationNotFound,
    ExplorationStore,
    seed_page,
    utc_now,
)
from .plain import _clip_words
from .tasks import atomic_write, iso_s

logger = logging.getLogger("hester.daemon.cockpit.desk")

PAGE_ID_RE = re.compile(r"^pg-[0-9a-f]{8}$")
AREA_ID_RE = re.compile(r"^area-[0-9a-f]{8}$")
DRAWER_ID_RE = re.compile(r"^(put-away|ideas|drw-[0-9a-f]{8})$")
STROKE_ID_RE = re.compile(r"^stk-[0-9a-f]{8}$")
IDEAS_DRAWER = "ideas"
PUT_AWAY_DRAWER = "put-away"
CARD_KINDS = ("page",)

DESK_DIR = Path(".hester") / "desk"
DESK_FILE = "desk.json"
SESSIONS_FILE = "sessions.jsonl"
CARD_FILE = "card.json"

AREA_W, AREA_H, AREA_GAP, AREA_COLS = 1200, 800, 200, 3
CARD_X, CARD_Y, CARD_W, CARD_H, CARD_GAP = 48, 96, 360, 240, 48
MAX_NAME = 120
MAX_IDEA_TITLE = 60
MAX_EXCERPT = 600
MAX_STOPPED = 160
MAX_SESSIONS = 200
DEFAULT_SESSIONS = 20
MAX_COORD = 10_000_000
MAX_STROKE_POINTS = 2000
MAX_STROKES = 2000
MAX_STROKE_WIDTH = 64
DEFAULT_STROKE_WIDTH = 2
IN_FLIGHT = ("launching", "running", "waiting", "review")
DEFAULT_TITLE = "Untitled"
GOALS_TITLE = "Goals"

_LOCK = threading.RLock()


class DeskError(ExplorationError):
    """400 with a message."""


class DeskNotFound(ExplorationNotFound):
    """404 ``not found``."""


class DeskConflict(Exception):
    """409 with a code: ``not_empty``, ``not_put_away`` or ``not_open``."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _hex_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def page_id_for_exploration(exp_id: Any) -> Optional[str]:
    """``exp-1a2b3c4d`` -> ``pg-1a2b3c4d`` (migration keeps the hex)."""
    m = re.match(r"^exp-([0-9a-f]{8})$", exp_id) if isinstance(exp_id, str) else None
    return f"pg-{m.group(1)}" if m else None


def is_page_id(value: Any) -> bool:
    return isinstance(value, str) and bool(PAGE_ID_RE.match(value))


def _chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    atomic_write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    _chmod(path, 0o600)


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.warning(f"{path} is unreadable: {e}")
        return None
    return data if isinstance(data, dict) else None


def _name(value: Any, what: str = "name") -> str:
    if not isinstance(value, str) or not value.strip():
        raise DeskError(f"{what} must be a non-empty string")
    s = " ".join(value.split())
    if len(s) > MAX_NAME:
        raise DeskError(f"{what} is longer than {MAX_NAME} characters")
    return s


def _title(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DeskError("title must be a non-empty string")
    s = " ".join(value.split())
    return s if len(s) <= MAX_TITLE else s[: MAX_TITLE - 1] + "…"


def _num(body: Dict[str, Any], key: str, positive: bool = False) -> Optional[float]:
    if key not in body or body[key] is None:
        return None
    v = body[key]
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) > MAX_COORD:
        raise DeskError(f"{key} must be a number")
    if positive and v <= 0:
        raise DeskError(f"{key} must be positive")
    return int(v) if float(v).is_integer() else float(v)


def _overlaps(a: Dict[str, Any], b: Dict[str, Any]) -> bool:
    return (
        a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"]
        and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]
    )


def _points(value: Any) -> List[List[float]]:
    """A stroke's points: 2 to ``MAX_STROKE_POINTS`` ``[x, y]`` pairs of finite numbers, rounded to 0.01."""
    if not isinstance(value, list) or len(value) < 2:
        raise DeskError("points must be a list of at least 2 [x, y] pairs")
    if len(value) > MAX_STROKE_POINTS:
        raise DeskError(f"a stroke has at most {MAX_STROKE_POINTS} points")
    out = []
    for p in value:
        if (
            not isinstance(p, (list, tuple)) or len(p) != 2
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) > MAX_COORD for v in p)
        ):
            raise DeskError("points must be [x, y] pairs of numbers")
        out.append([_round(p[0]), _round(p[1])])
    return out


def _round(v: float) -> float:
    r = round(float(v), 2)
    return int(r) if r.is_integer() else r


def area_slot(i: int) -> Tuple[int, int]:
    """The i-th Area slot: a 3-column grid of 1200x800 with a 200 gap."""
    return (i % AREA_COLS) * (AREA_W + AREA_GAP), (i // AREA_COLS) * (AREA_H + AREA_GAP)


def tail_clip(text: str, limit: int = MAX_STOPPED) -> str:
    """The end of a line, keeping where you stopped: ``…the vector clock only helps if every write``."""
    s = " ".join(text.split())
    return s if len(s) <= limit else "…" + s[-(limit - 1):]


def excerpt(text: str, limit: int = MAX_EXCERPT) -> str:
    """The start of a Page, at most ``limit`` chars, cut at a line when it's longer."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    nl = cut.rfind("\n")
    return cut[:nl].rstrip() if nl > 0 else cut


def stopped_line(page: str, stopped_at: Optional[str]) -> Optional[int]:
    """
    The 1-based line of the last occurrence of ``stopped_at`` (without its
    leading "…", whitespace-normalised) in ``page``, else the last non-empty
    line's number, else None.
    """
    lines = page.splitlines()
    needle = " ".join((stopped_at or "").lstrip("…").split())
    if needle:
        for i in range(len(lines) - 1, -1, -1):
            if needle in " ".join(lines[i].split()):
                return i + 1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            return i + 1
    return None


# ---------------------------------------------------------------------------
# Page cards: the ExplorationStore surface deep.py needs
# ---------------------------------------------------------------------------


class PageStore:
    """``.hester/desk/pages/``: one directory per Page card. deep.py's record functions take it."""

    questions_in_file = True  # deep.py: questions live in questions.jsonl

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / DESK_DIR / "pages"

    def _check_id(self, card_id: str) -> str:
        if not is_page_id(card_id):
            raise DeskError(f"invalid card id: {card_id!r}")
        return card_id

    def exp_dir(self, card_id: str) -> Path:
        return self.dir / self._check_id(card_id)

    card_dir = exp_dir

    def migrate(self, card_id: str) -> Path:
        """deep.interrupt_pending's hook; a card has no legacy form."""
        return self.exp_dir(card_id) / CARD_FILE

    def page_path(self, card_id: str) -> Path:
        return self.exp_dir(card_id) / PAGE_FILE

    def exists(self, card_id: str) -> bool:
        return is_page_id(card_id) and (self.dir / card_id / CARD_FILE).exists()

    def ids(self) -> List[str]:
        try:
            return sorted(p.parent.name for p in self.dir.glob(f"pg-*/{CARD_FILE}") if is_page_id(p.parent.name))
        except OSError:
            return []

    def read_card(self, card_id: str) -> Optional[Dict[str, Any]]:
        if not is_page_id(card_id):
            return None
        return _read_json(self.dir / card_id / CARD_FILE)

    def get(self, card_id: str) -> Optional[Dict[str, Any]]:
        """card.json plus its questions (as an exploration carries them, for deep-ask's context)."""
        card = self.read_card(card_id)
        if card is None:
            return None
        card = dict(card, id=card_id)
        card["questions"] = deep.read_jsonl(self.dir / card_id / deep.QUESTIONS_FILE)
        return card

    def require(self, card_id: str) -> Dict[str, Any]:
        self._check_id(card_id)
        card = self.get(card_id)
        if card is None:
            raise DeskNotFound(card_id)
        return card

    def write_card(self, card: Dict[str, Any]) -> None:
        d = self.exp_dir(card["id"])
        for p in (self.workspace / DESK_DIR, self.dir, d):
            p.mkdir(parents=True, exist_ok=True)
            _chmod(p, 0o700)
        _write_json(d / CARD_FILE, {k: v for k, v in card.items() if k != "questions"})

    def touch(self, card_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        with _LOCK:
            card = self.read_card(card_id)
            if card is None:
                raise DeskNotFound(card_id)
            card["last_touched_at"] = iso_s(now)
            card["updated_at"] = iso_s(now)
            self.write_card(card)
        return card

    def backfill_page(self, card_id: str, now: Optional[datetime] = None) -> bool:
        """An exploration's seed-to-Page backfill; a card's Page is written when it's made."""
        return False

    def page_text(self, card_id: str) -> str:
        return deep.read_page_text(self, card_id)


def new_card(card_id: str, title: str, now: datetime, **fields: Any) -> Dict[str, Any]:
    card = {
        "id": card_id, "kind": "page", "title": title, "purpose": None, "seed": None, "goals": [],
        "origin": None, "created_at": iso_s(now), "updated_at": iso_s(now), "last_touched_at": iso_s(now),
        "migrated_from": None,
    }
    card.update(fields)
    return card


# ---------------------------------------------------------------------------
# The Desk
# ---------------------------------------------------------------------------


def _empty_raw() -> Dict[str, Any]:
    return {
        "version": 1, "areas": [], "cards": [],
        "drawers": [{"id": PUT_AWAY_DRAWER, "name": "Put away"}], "strokes": [],
        "goals_card_id": None, "last": None,
        "migration": {"map": {}, "last_report": None},
    }


class DeskStore:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.root = self.workspace / DESK_DIR
        self.path = self.root / DESK_FILE
        self.sessions_path = self.root / SESSIONS_FILE
        self.pages = PageStore(self.workspace)

    # ---------------------------------------------------------------- desk.json

    def _read(self) -> Dict[str, Any]:
        raw = _read_json(self.path) or _empty_raw()
        base = _empty_raw()
        for k, v in base.items():
            if k not in raw or not isinstance(raw[k], type(v)) and v is not None:
                raw[k] = v
        raw["areas"] = [a for a in raw["areas"] if isinstance(a, dict) and AREA_ID_RE.match(str(a.get("id") or ""))]
        raw["cards"] = [c for c in raw["cards"] if isinstance(c, dict) and is_page_id(c.get("id"))]
        raw["strokes"] = [s for s in raw["strokes"] if isinstance(s, dict) and STROKE_ID_RE.match(str(s.get("id") or ""))
                          and isinstance(s.get("points"), list)]
        raw["drawers"] = [d for d in raw["drawers"] if isinstance(d, dict) and DRAWER_ID_RE.match(str(d.get("id") or ""))
                          and d.get("id") != IDEAS_DRAWER]
        if not any(d["id"] == PUT_AWAY_DRAWER for d in raw["drawers"]):
            raw["drawers"].insert(0, {"id": PUT_AWAY_DRAWER, "name": "Put away"})
        mig = raw["migration"] if isinstance(raw.get("migration"), dict) else {}
        raw["migration"] = {
            "map": mig.get("map") if isinstance(mig.get("map"), dict) else {},
            "last_report": mig.get("last_report") if isinstance(mig.get("last_report"), dict) else None,
        }
        if not isinstance(raw.get("last"), dict) or not is_page_id(raw["last"].get("card_id")):
            raw["last"] = None
        if not is_page_id(raw.get("goals_card_id")):
            raw["goals_card_id"] = None
        return raw

    def _write(self, raw: Dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        _chmod(self.root, 0o700)
        _write_json(self.path, raw)

    def load(self, now: Optional[datetime] = None, ensure_main: bool = True) -> Dict[str, Any]:
        """
        ``desk.json`` for a read: migrates first when it's due, and gives an
        empty Desk its one Area, ``Main``, at 0,0 (unless ``ensure_main`` is
        false: readers like goal status that shouldn't make a Desk).
        """
        now = now or utc_now()
        with _LOCK:
            raw = self._read()
            if self._migration_due(raw):
                self._migrate(raw, now)
                raw = self._read()
            if not raw["areas"] and ensure_main:
                raw["areas"].append(self._area_record(_hex_id("area"), "Main", 0, 0, AREA_W, AREA_H, now))
                self._write(raw)
            return raw

    # ---------------------------------------------------------------- lookups

    @staticmethod
    def _area(raw: Dict[str, Any], area_id: Any) -> Dict[str, Any]:
        for a in raw["areas"]:
            if a["id"] == area_id:
                return a
        raise DeskNotFound(str(area_id))

    @staticmethod
    def _entry(raw: Dict[str, Any], card_id: str) -> Optional[Dict[str, Any]]:
        return next((c for c in raw["cards"] if c["id"] == card_id), None)

    def _require_card(self, raw: Dict[str, Any], card_id: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        if not is_page_id(card_id):
            raise DeskError("invalid card id")
        entry = self._entry(raw, card_id)
        card = self.pages.read_card(card_id)
        if entry is None or card is None:
            raise DeskNotFound(card_id)
        return entry, dict(card, id=card_id)

    @staticmethod
    def _area_record(area_id: str, name: str, x, y, w, h, now: datetime, migrated_from=None) -> Dict[str, Any]:
        return {
            "id": area_id, "name": name, "x": x, "y": y, "w": w, "h": h, "drawer_id": None, "put_away_at": None,
            "created_at": iso_s(now), "updated_at": iso_s(now), "migrated_from": migrated_from,
        }

    @staticmethod
    def _free_area_slot(raw: Dict[str, Any]) -> Tuple[int, int]:
        i = 0
        while True:
            x, y = area_slot(i)
            rect = {"x": x, "y": y, "w": AREA_W, "h": AREA_H}
            if not any(_overlaps(rect, a) for a in raw["areas"]):
                return x, y
            i += 1

    @staticmethod
    def _free_card_slot(raw: Dict[str, Any], area: Dict[str, Any], w=CARD_W, h=CARD_H) -> Tuple[int, int]:
        cols = max(1, int((area["w"] - CARD_X) // (w + CARD_GAP)))
        taken = [c for c in raw["cards"] if c.get("area_id") == area["id"]]
        i = 0
        while True:
            x, y = CARD_X + (i % cols) * (w + CARD_GAP), CARD_Y + (i // cols) * (h + CARD_GAP)
            rect = {"x": x, "y": y, "w": w, "h": h}
            if not any(_overlaps(rect, c) for c in taken):
                return x, y
            i += 1

    def _unique(self, prefix: str, taken: set) -> str:
        while True:
            new = _hex_id(prefix)
            if new not in taken and not (prefix == "pg" and (self.pages.dir / new).exists()):
                return new

    # ---------------------------------------------------------------- API shapes

    def summary(self, card_id: str) -> Dict[str, Any]:
        d = self.pages.dir / card_id
        page = d / PAGE_FILE
        text, updated = "", None
        try:
            st = page.stat()
            updated = iso_s(datetime.fromtimestamp(st.st_mtime, tz=timezone.utc))
            text = page.read_text(encoding="utf-8") if st.st_size else ""
        except (OSError, UnicodeDecodeError):
            pass
        unread = pending = in_flight = 0
        for a in deep.read_jsonl(d / deep.ANSWERS_FILE):
            if deep.is_handoff(a):
                if (a.get("handoff") or {}).get("state") in IN_FLIGHT:
                    in_flight += 1
                continue
            if a.get("status") in deep.PENDING:
                pending += 1
            elif a.get("status") == "done" and not a.get("read_at") and not a.get("dismissed_at"):
                unread += 1
        questions = deep.read_jsonl(d / deep.QUESTIONS_FILE)
        return {
            "page_chars": len(text),
            "page_updated_at": updated,
            "excerpt": excerpt(text),
            "answers_unread": unread,
            "answers_pending": pending,
            "handoffs_in_flight": in_flight,
            "open_questions": sum(1 for q in questions if q.get("status") == "open"),
        }

    def card_api(self, entry: Dict[str, Any], card: Dict[str, Any], raw: Dict[str, Any]) -> Dict[str, Any]:
        pinned = card.get("purpose") == "goals" and raw.get("goals_card_id") == card["id"]
        return {
            "id": card["id"], "kind": card.get("kind") or "page",
            "area_id": None if pinned else entry.get("area_id"),
            "x": entry.get("x", 0), "y": entry.get("y", 0), "w": entry.get("w", 0), "h": entry.get("h", 0),
            "title": card.get("title") or DEFAULT_TITLE,
            "purpose": card.get("purpose") if card.get("purpose") == "goals" else None,
            "pinned": pinned,
            "created_at": card.get("created_at"), "updated_at": card.get("updated_at"),
            "last_touched_at": card.get("last_touched_at"), "migrated_from": card.get("migrated_from"),
            "summary": self.summary(card["id"]),
        }

    @staticmethod
    def area_api(a: Dict[str, Any]) -> Dict[str, Any]:
        return {k: a.get(k) for k in ("id", "name", "x", "y", "w", "h", "drawer_id", "put_away_at", "created_at", "updated_at", "migrated_from")}

    @staticmethod
    def stroke_api(s: Dict[str, Any]) -> Dict[str, Any]:
        return {k: s.get(k) for k in ("id", "area_id", "points", "width", "created_at")}

    def drawers_api(self, raw: Dict[str, Any]) -> List[Dict[str, Any]]:
        from ..copilot.someday import SomedayStore

        try:
            ideas = len(SomedayStore(self.workspace).list("open"))
        except Exception:
            ideas = 0
        out = [{"id": IDEAS_DRAWER, "name": "Ideas", "kind": "ideas", "area_ids": [], "count": ideas}]
        drawers = sorted(raw["drawers"], key=lambda d: 0 if d["id"] == PUT_AWAY_DRAWER else 1)
        for d in drawers:
            out.append(self.drawer_api(raw, d))
        return out

    @staticmethod
    def drawer_api(raw: Dict[str, Any], d: Dict[str, Any]) -> Dict[str, Any]:
        inside = [a for a in raw["areas"] if a.get("drawer_id") == d["id"]]
        inside.sort(key=lambda a: str(a.get("put_away_at") or ""), reverse=True)
        return {"id": d["id"], "name": d.get("name") or "", "kind": "areas",
                "area_ids": [a["id"] for a in inside], "count": len(inside)}

    def desk(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        """GET /desk."""
        raw = self.load(now)
        cards = []
        for entry in raw["cards"]:
            card = self.pages.read_card(entry["id"])
            if card is not None:
                cards.append(self.card_api(entry, dict(card, id=entry["id"]), raw))
        return {
            "version": 1,
            "workspace": str(self.workspace),
            "areas": [self.area_api(a) for a in raw["areas"]],
            "cards": cards,
            "drawers": self.drawers_api(raw),
            "strokes": [self.stroke_api(s) for s in raw["strokes"]],
            "goals_card_id": raw["goals_card_id"],
            "last": raw["last"],
            "migration": raw["migration"].get("last_report"),
        }

    def get_card(self, card_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        raw = self.load(now)
        entry, card = self._require_card(raw, card_id)
        return self.card_api(entry, card, raw)

    def briefs(self, raw: Optional[Dict[str, Any]] = None, on_desk: bool = False) -> List[Dict[str, Any]]:
        """Every card as {id, kind, title, area_id, area_name, purpose, last_touched_at, goals, page_updated_at, put_away}."""
        raw = raw or self.load()
        areas = {a["id"]: a for a in raw["areas"]}
        out = []
        for entry in raw["cards"]:
            card = self.pages.read_card(entry["id"])
            if card is None:
                continue
            area = areas.get(entry.get("area_id"))
            put_away = bool(area and area.get("drawer_id"))
            if on_desk and put_away:
                continue
            out.append({
                "id": entry["id"], "kind": card.get("kind") or "page", "title": card.get("title") or DEFAULT_TITLE,
                "area_id": entry.get("area_id") if area else None, "area_name": area.get("name") if area else None,
                "purpose": card.get("purpose") if card.get("purpose") == "goals" else None,
                "last_touched_at": card.get("last_touched_at"), "created_at": card.get("created_at"),
                "goals": [g for g in card.get("goals") or [] if isinstance(g, str)], "put_away": put_away,
            })
        return out

    @staticmethod
    def brief_api(b: Dict[str, Any]) -> Dict[str, Any]:
        return {k: b.get(k) for k in ("id", "kind", "title", "area_id", "area_name", "purpose", "last_touched_at")}

    # ---------------------------------------------------------------- Areas and Drawers

    def create_area(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        name = _name(body.get("name"))
        x, y = _num(body, "x"), _num(body, "y")
        w, h = _num(body, "w", True) or AREA_W, _num(body, "h", True) or AREA_H
        with _LOCK:
            raw = self.load(now)
            if x is None or y is None:
                fx, fy = self._free_area_slot(raw)
                x = fx if x is None else x
                y = fy if y is None else y
            area = self._area_record(self._unique("area", {a["id"] for a in raw["areas"]}), name, x, y, w, h, now)
            raw["areas"].append(area)
            self._write(raw)
        return self.area_api(area)

    def patch_area(self, area_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        unknown = set(body) - {"name", "x", "y", "w", "h"}
        if unknown:
            raise DeskError(f"cannot patch {', '.join(sorted(unknown))}")
        with _LOCK:
            raw = self.load(now)
            area = self._area(raw, area_id)
            if "name" in body:
                area["name"] = _name(body["name"])
            for k in ("x", "y", "w", "h"):
                v = _num(body, k, positive=k in ("w", "h"))
                if v is not None:
                    area[k] = v
            area["updated_at"] = iso_s(now)
            self._write(raw)
        return self.area_api(area)

    def delete_area(self, area_id: str, now: Optional[datetime] = None, with_cards: bool = False) -> Dict[str, Any]:
        """An empty Area; with ``with_cards`` (the user confirmed), its cards go too. Its lines always go. Not undoable."""
        with _LOCK:
            raw = self.load(now)
            area = self._area(raw, area_id)
            cards = [c["id"] for c in raw["cards"] if c.get("area_id") == area_id]
            if cards and not with_cards:
                raise DeskConflict("not_empty")
            for card_id in cards:
                self._drop_card(raw, card_id)
            raw["strokes"] = [s for s in raw["strokes"] if s.get("area_id") != area_id]
            raw["areas"].remove(area)
            self._write(raw)
        return {"deleted": True, "cards": len(cards)}

    def _drop_card(self, raw: Dict[str, Any], card_id: str) -> None:
        """Remove a card and its folder from ``raw`` (caller holds the lock and writes)."""
        shutil.rmtree(self.pages.dir / card_id, ignore_errors=True)
        raw["cards"] = [c for c in raw["cards"] if c["id"] != card_id]
        if raw.get("goals_card_id") == card_id:
            raw["goals_card_id"] = None
        if (raw.get("last") or {}).get("card_id") == card_id:
            raw["last"] = None

    def put_away(self, area_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        drawer_id = body.get("drawer_id") or PUT_AWAY_DRAWER
        with _LOCK:
            raw = self.load(now)
            area = self._area(raw, area_id)
            if drawer_id == IDEAS_DRAWER or not any(d["id"] == drawer_id for d in raw["drawers"]):
                raise DeskError("drawer_id must be a Drawer that holds Areas")
            area["drawer_id"] = drawer_id
            area["put_away_at"] = iso_s(now)
            area["updated_at"] = iso_s(now)
            self._write(raw)
        return self.area_api(area)

    def take_out(self, area_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        x, y = _num(body, "x"), _num(body, "y")
        with _LOCK:
            raw = self.load(now)
            area = self._area(raw, area_id)
            if not area.get("drawer_id"):
                raise DeskConflict("not_put_away")
            area["drawer_id"] = None
            area["put_away_at"] = None
            if x is not None:
                area["x"] = x
            if y is not None:
                area["y"] = y
            area["updated_at"] = iso_s(now)
            self._write(raw)
        return self.area_api(area)

    def create_drawer(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        name = _name(body.get("name"))
        with _LOCK:
            raw = self.load(now)
            d = {"id": self._unique("drw", {x["id"] for x in raw["drawers"]}), "name": name}
            raw["drawers"].append(d)
            self._write(raw)
            return self.drawer_api(raw, d)

    def patch_drawer(self, drawer_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        if drawer_id == IDEAS_DRAWER:
            raise DeskError("the Ideas Drawer can't be renamed")
        name = _name(body.get("name"))
        with _LOCK:
            raw = self.load(now)
            d = next((x for x in raw["drawers"] if x["id"] == drawer_id), None)
            if d is None:
                raise DeskNotFound(drawer_id)
            d["name"] = name
            self._write(raw)
            return self.drawer_api(raw, d)

    # ---------------------------------------------------------------- cards

    def patch_card(self, card_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        unknown = set(body) - {"x", "y", "w", "h", "area_id", "title"}
        if unknown:
            raise DeskError(f"cannot patch {', '.join(sorted(unknown))}")
        with _LOCK:
            raw = self.load(now)
            entry, card = self._require_card(raw, card_id)
            layout = {k for k in ("x", "y", "w", "h", "area_id") if k in body}
            if layout and raw.get("goals_card_id") == card_id:
                raise DeskError("the Goals card doesn't move")
            if "area_id" in body:
                if not isinstance(body["area_id"], str) or not AREA_ID_RE.match(body["area_id"]):
                    raise DeskError("area_id must be an Area id")
                area = self._area(raw, body["area_id"])
                if area.get("drawer_id"):
                    raise DeskError("that Area is put away")
                entry["area_id"] = area["id"]
            for k in ("x", "y", "w", "h"):
                v = _num(body, k, positive=k in ("w", "h"))
                if v is not None:
                    entry[k] = v
            if "title" in body:
                card["title"] = _title(body["title"])
                card["updated_at"] = iso_s(now)
                self.pages.write_card(card)
            if layout:
                self._write(raw)
            return self.card_api(entry, card, raw)

    # ---------------------------------------------------------------- strokes

    def create_stroke(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """
        POST /desk/strokes: a freehand line, ``points`` relative to its Area
        (or to the Desk when ``area_id`` is null). Lines mean nothing: Hester
        stores them and never reads, places or connects them.
        """
        now = now or utc_now()
        unknown = set(body) - {"area_id", "points", "width"}
        if unknown:
            raise DeskError(f"unknown field {', '.join(sorted(unknown))}")
        area_id = body.get("area_id")
        if area_id is not None and (not isinstance(area_id, str) or not AREA_ID_RE.match(area_id)):
            raise DeskError("area_id must be an Area id or null")
        points = _points(body.get("points"))
        width = _num(body, "width", positive=True)
        if width is None:
            width = DEFAULT_STROKE_WIDTH
        if width > MAX_STROKE_WIDTH:
            raise DeskError(f"width is more than {MAX_STROKE_WIDTH}")
        with _LOCK:
            raw = self.load(now)
            if area_id is not None and self._area(raw, area_id).get("drawer_id"):
                raise DeskError("that Area is put away")
            if len(raw["strokes"]) >= MAX_STROKES:
                raise DeskError(f"the Desk has {MAX_STROKES} lines; delete some first")
            stroke = {
                "id": self._unique("stk", {x["id"] for x in raw["strokes"]}), "area_id": area_id,
                "points": points, "width": width, "created_at": iso_s(now),
            }
            raw["strokes"].append(stroke)
            self._write(raw)
        return self.stroke_api(stroke)

    def delete_stroke(self, stroke_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        if not isinstance(stroke_id, str) or not STROKE_ID_RE.match(stroke_id):
            raise DeskError("invalid stroke id")
        with _LOCK:
            raw = self.load(now)
            if not any(s["id"] == stroke_id for s in raw["strokes"]):
                raise DeskNotFound(stroke_id)
            raw["strokes"] = [s for s in raw["strokes"] if s["id"] != stroke_id]
            self._write(raw)
        return {"deleted": True}

    def create_page(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Tuple[Dict[str, Any], Dict[str, Any], bool]:
        """POST /desk/pages -> (card, {text, version}, created)."""
        now = now or utc_now()
        purpose = body.get("purpose")
        if purpose not in (None, "goals"):
            raise DeskError("purpose must be goals")
        text = body.get("text")
        if text is None:
            text = ""
        if not isinstance(text, str):
            raise DeskError("text must be a string")
        if len(text.encode("utf-8")) > MAX_PAGE_BYTES:
            raise DeskError("the Page is larger than 1 MB")
        title = _title(body["title"]) if body.get("title") is not None else None
        pos = {k: _num(body, k, positive=k in ("w", "h")) for k in ("x", "y", "w", "h")}
        origin = body.get("origin") if isinstance(body.get("origin"), dict) else None
        with _LOCK:
            raw = self.load(now)
            if purpose == "goals":
                gid = raw.get("goals_card_id")
                if gid and self.pages.exists(gid):
                    entry, card = self._require_card(raw, gid)
                    return self.card_api(entry, card, raw), deep.read_page(self.pages, gid), False
                card_id = self._unique("pg", {c["id"] for c in raw["cards"]})
                entry = {"id": card_id, "kind": "page", "area_id": None, "x": 0, "y": 0, "w": 0, "h": 0}
                card = new_card(card_id, title or GOALS_TITLE, now, purpose="goals", origin=origin)
                raw["goals_card_id"] = card_id
            else:
                src = body.get("from")
                area = None
                if src is not None:
                    if not isinstance(src, dict) or not is_page_id(src.get("card_id")):
                        raise DeskError("from.card_id must be a card id")
                    if src.get("anchor") is not None:
                        deep.norm_anchor(src["anchor"])
                    src_entry, _ = self._require_card(raw, src["card_id"])
                    if body.get("area_id") is None and src_entry.get("area_id"):
                        area = self._area(raw, src_entry["area_id"])
                        if pos["x"] is None and pos["y"] is None:
                            pos["x"] = src_entry.get("x", 0) + src_entry.get("w", CARD_W) + CARD_GAP
                            pos["y"] = src_entry.get("y", 0)
                    origin = origin or {"kind": "page", "ref": src["card_id"]}
                if area is None and body.get("area_id") is not None:
                    area = self._area(raw, body["area_id"])
                if area is None and src is not None:
                    # "New Page from" the Goals card, which has no Area: the first Area on the Desk.
                    area = next((a for a in raw["areas"] if not a.get("drawer_id")), None)
                if area is None:
                    raise DeskError("area_id is required")
                if area.get("drawer_id"):
                    raise DeskError("that Area is put away")
                w, h = pos["w"] or CARD_W, pos["h"] or CARD_H
                if pos["x"] is None or pos["y"] is None:
                    fx, fy = self._free_card_slot(raw, area, w, h)
                    pos["x"] = fx if pos["x"] is None else pos["x"]
                    pos["y"] = fy if pos["y"] is None else pos["y"]
                card_id = self._unique("pg", {c["id"] for c in raw["cards"]})
                entry = {"id": card_id, "kind": "page", "area_id": area["id"], "x": pos["x"], "y": pos["y"], "w": w, "h": h}
                card = new_card(card_id, title or DEFAULT_TITLE, now, origin=origin)
            self.pages.write_card(card)
            path = self.pages.page_path(card_id)
            atomic_write(path, text)
            _chmod(path, 0o600)
            raw["cards"].append(entry)
            self._write(raw)
            return self.card_api(entry, card, raw), {"text": text, "version": deep.page_version(text)}, True

    def patch_page(self, card_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        unknown = set(body) - {"title"}
        if unknown:
            raise DeskError(f"cannot patch {', '.join(sorted(unknown))}")
        if "title" not in body:
            raise DeskError("title is required")
        return self.patch_card(card_id, {"title": body["title"]}, now)

    def is_empty(self, card_id: str) -> bool:
        """Deep next R8 on a card: still Untitled, a blank Page, and nothing asked, kept or questioned."""
        card = self.pages.require(card_id)
        if not deep.UNTITLED_RE.match(str(card.get("title") or DEFAULT_TITLE).strip()):
            return False
        if self.pages.page_text(card_id).strip():
            return False
        d = self.pages.dir / card_id
        return not any(deep.read_jsonl(d / f) for f in (deep.ANSWERS_FILE, deep.REFERENCES_FILE, deep.QUESTIONS_FILE))

    def delete_page(self, card_id: str, now: Optional[datetime] = None, force: bool = False) -> Dict[str, Any]:
        """Only an empty card (R8's guard), unless ``force`` (the user confirmed deleting it). Not undoable."""
        with _LOCK:
            raw = self.load(now)
            self._require_card(raw, card_id)
            if not force and not self.is_empty(card_id):
                raise DeskConflict("not_empty")
            self._drop_card(raw, card_id)
            self._write(raw)
        return {"deleted": True}

    def set_last(self, card_id: Any, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        with _LOCK:
            raw = self.load(now)
            self._require_card(raw, card_id)
            raw["last"] = {"card_id": card_id, "at": iso_s(now)}
            self._write(raw)
            return dict(raw["last"])

    def idea_to_page(self, someday_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """POST /desk/ideas/{id}/page: the idea's text as a Page, in ``area_id`` or a new Area named after it."""
        from ..copilot.someday import ID_RE as SOMEDAY_ID_RE
        from ..copilot.someday import SomedayStore

        now = now or utc_now()
        if not SOMEDAY_ID_RE.match(someday_id or ""):
            raise DeskError("invalid someday id")
        someday = SomedayStore(self.workspace)
        item = someday.get(someday_id)
        if item is None:
            raise DeskNotFound(someday_id)
        if item.status != "open":
            raise DeskConflict("not_open")
        name = idea_name(item.text)
        area_id = body.get("area_id")
        with _LOCK:
            if area_id is None:
                area = self.create_area({"name": name}, now)
            else:
                area = self.area_api(self._area(self.load(now), area_id))
            card, _, _ = self.create_page({
                "area_id": area["id"], "x": body.get("x"), "y": body.get("y"), "title": name,
                "text": item.text if len(item.text.encode("utf-8")) <= MAX_PAGE_BYTES else "",
                "origin": {"kind": "someday", "ref": item.id},
            }, now)
            someday.triage(item.id, "explore", note=f"page:{card['id']}", now=now)
        return {"card": card, "area": area, "someday_id": item.id}

    # ---------------------------------------------------------------- sessions

    def list_sessions(self, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        rows = deep.read_jsonl(self.sessions_path)
        rows.sort(key=lambda r: str(r.get("ended_at") or ""), reverse=True)
        return rows if limit is None else rows[:limit]

    def norm_session(self, body: Dict[str, Any]) -> Dict[str, Any]:
        """``DeskSessionCreate`` -> a record. Malformed card ids are refused; unknown ones are dropped."""
        base = dict(body)
        reason = base.get("reason")
        if reason not in deep.DESK_SESSION_REASONS:
            raise DeskError(f"reason must be one of {', '.join(deep.DESK_SESSION_REASONS)}")
        kept_raw = base.get("questions_kept")
        base["reason"] = "ritual"  # deep.norm_session checks the rest; the reason is checked above
        base["questions_kept"] = []
        record = deep.norm_session(base)
        record["reason"] = reason

        touched_raw = body.get("cards_touched")
        if touched_raw is None:
            touched_raw = []
        if not isinstance(touched_raw, list) or not all(is_page_id(c) for c in touched_raw):
            raise DeskError("cards_touched must be a list of card ids")
        touched: List[str] = []
        for c in touched_raw:
            if c not in touched and self.pages.exists(c):
                touched.append(c)
        stopped_card = body.get("stopped_card_id")
        if stopped_card is not None and not is_page_id(stopped_card):
            raise DeskError("stopped_card_id must be a card id or null")
        if stopped_card is not None and not self.pages.exists(stopped_card):
            stopped_card = None
        if kept_raw is None:
            kept_raw = []
        if not isinstance(kept_raw, list):
            raise DeskError("questions_kept must be a list of {card_id, question_id}")
        kept: List[Dict[str, str]] = []
        for k in kept_raw:
            if (
                not isinstance(k, dict) or not is_page_id(k.get("card_id"))
                or not deep.QUESTION_ID_RE.match(str(k.get("question_id") or ""))
            ):
                raise DeskError("questions_kept must be a list of {card_id, question_id}")
            if self.pages.exists(k["card_id"]):
                kept.append({"card_id": k["card_id"], "question_id": k["question_id"]})
        return {
            "id": record["id"], "focus_session_id": record["focus_session_id"],
            "started_at": record["started_at"], "ended_at": record["ended_at"], "reason": reason,
            "stopped_at": record["stopped_at"], "stopped_card_id": stopped_card, "rating": record["rating"],
            "questions_kept": kept[: deep.MAX_KEPT], "cards_touched": touched,
        }

    def add_session(self, body: Dict[str, Any]) -> Dict[str, Any]:
        record = self.norm_session(body)
        with _LOCK:
            # One record per Deep session: Lee main (an ignored idle push) and the opener (the log) can both write it.
            fsid = record.get("focus_session_id")
            if fsid:
                existing = next((r for r in self.list_sessions() if r.get("focus_session_id") == fsid), None)
                if existing is not None:
                    return existing
            self.root.mkdir(parents=True, exist_ok=True)
            deep.append_jsonl(self.sessions_path, record)
        return record

    # ---------------------------------------------------------------- migration (§6.1)

    def _explore(self) -> ExplorationStore:
        return ExplorationStore(self.workspace)

    def _migration_due(self, raw: Dict[str, Any]) -> bool:
        mapped = raw["migration"]["map"]
        return any(e not in mapped for e in self._explore().ids())

    def migrate(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        """POST /desk/migrate: run now; a run with nothing new reports ``migrated: 0``."""
        now = now or utc_now()
        with _LOCK:
            raw = self._read()
            return self._migrate(raw, now)

    def _load_exploration(self, xs: ExplorationStore, exp_id: str) -> Optional[Tuple[Dict[str, Any], Path, bool]]:
        """Read-only: (exploration, its directory, has a directory). Never moves a legacy flat file."""
        d = xs.dir / exp_id
        if (d / EXPLORATION_FILE).exists():
            loaded = xs._load(d / EXPLORATION_FILE, deep=False)
            return (loaded[0], d, True) if loaded else None
        loaded = xs._load(xs.dir / f"{exp_id}.md", deep=False)
        return (loaded[0], d, False) if loaded else None

    @staticmethod
    def _exploration_page(exp: Dict[str, Any], d: Path, has_dir: bool) -> Optional[str]:
        """page.md's text, or None to copy the file as is; an unseeded empty Page gets its seed, as the backfill would."""
        text = ""
        if has_dir:
            try:
                text = (d / PAGE_FILE).read_text(encoding="utf-8")
            except FileNotFoundError:
                text = ""
            except (OSError, UnicodeDecodeError):
                return None
        if not text.strip() and not exp.get("page_seeded"):
            return seed_page(exp.get("seed")) or text
        return text

    @staticmethod
    def _exploration_empty(exp: Dict[str, Any], d: Path, has_dir: bool, page: Optional[str]) -> bool:
        if not deep.UNTITLED_RE.match(str(exp.get("title") or "").strip()):
            return False
        if page and page.strip():
            return False
        if exp.get("questions") or int(exp.get("turns") or 0) > 0 or len(exp.get("nodes") or []) > 1:
            return False
        if has_dir and (deep.read_jsonl(d / deep.ANSWERS_FILE) or deep.read_jsonl(d / deep.REFERENCES_FILE)):
            return False
        return True

    def _migrate(self, raw: Dict[str, Any], now: datetime) -> Dict[str, Any]:
        mapping: Dict[str, Optional[str]] = raw["migration"]["map"]
        report = {"at": iso_s(now), "migrated": 0, "already": 0, "skipped_empty": 0,
                  "goals_card_id": raw.get("goals_card_id"), "errors": []}
        xs = self._explore()
        todo = []
        for exp_id in xs.ids():
            if exp_id in mapping:
                if mapping[exp_id]:
                    report["already"] += 1
                continue
            try:
                loaded = self._load_exploration(xs, exp_id)
            except Exception:  # pragma: no cover - _load swallows its own errors
                loaded = None
            if loaded is None:
                report["errors"].append({"exploration_id": exp_id, "error": "unreadable"})
                continue
            todo.append(loaded)
        todo.sort(key=lambda t: (str(t[0].get("created_at") or ""), t[0]["id"]))
        sessions = self.list_sessions()
        seen_sessions = {r.get("focus_session_id") for r in sessions}
        new_sessions: List[Dict[str, Any]] = []
        for exp, d, has_dir in todo:
            exp_id = exp["id"]
            try:
                page = self._exploration_page(exp, d, has_dir)
                if self._exploration_empty(exp, d, has_dir, page):
                    mapping[exp_id] = None
                    report["skipped_empty"] += 1
                    continue
                card_id = self._migrate_one(raw, exp, d, has_dir, page, now)
                mapping[exp_id] = card_id
                report["migrated"] += 1
                if has_dir:
                    for r in deep.read_jsonl(d / deep.SESSIONS_FILE):
                        fsid = r.get("focus_session_id")
                        if not fsid or fsid in seen_sessions:
                            continue
                        seen_sessions.add(fsid)
                        new_sessions.append(_migrated_session(r, card_id))
            except Exception as e:
                logger.warning(f"Desk migration of {exp_id} failed: {e}")
                report["errors"].append({"exploration_id": exp_id, "error": str(e)[:300]})
        report["goals_card_id"] = raw.get("goals_card_id")
        if new_sessions:
            rows = deep.read_jsonl(self.sessions_path) + new_sessions
            self.root.mkdir(parents=True, exist_ok=True)
            deep.write_jsonl(self.sessions_path, rows)
        if report["migrated"]:
            raw["migration"]["last_report"] = report
            logger.info(
                f"Desk migration in {self.workspace}: {report['migrated']} migrated, {report['already']} already, "
                f"{report['skipped_empty']} empty skipped, {len(report['errors'])} errors"
            )
        self._write(raw)
        self._rewrite_open_next(mapping)
        return report

    def _migrate_one(self, raw, exp, d: Path, has_dir: bool, page: Optional[str], now: datetime) -> str:
        exp_id = exp["id"]
        hexpart = exp_id[len("exp-"):]
        card_id = f"pg-{hexpart}"
        existing = self.pages.read_card(card_id)
        taken = {c["id"] for c in raw["cards"]}
        if (existing is not None and existing.get("migrated_from") != exp_id) or (
            existing is None and (card_id in taken or (self.pages.dir / card_id).exists())
        ):
            card_id = self._unique("pg", taken)
        raw["cards"] = [c for c in raw["cards"] if c["id"] != card_id]  # a half-finished earlier run
        is_goals = exp.get("purpose") == "goals" and exp.get("status") == "active" and not raw.get("goals_card_id")

        target = self.pages.dir / card_id
        target.mkdir(parents=True, exist_ok=True)
        _chmod(target, 0o700)
        for name in (deep.ANSWERS_FILE, deep.REFERENCES_FILE):
            src = d / name
            if has_dir and src.exists():
                shutil.copyfile(src, target / name)
                _chmod(target / name, 0o600)
        if page is None:
            shutil.copyfile(d / PAGE_FILE, target / PAGE_FILE)
        else:
            atomic_write(target / PAGE_FILE, page)
        _chmod(target / PAGE_FILE, 0o600)
        questions = [q for q in exp.get("questions") or [] if isinstance(q, dict)]
        if questions:
            deep.write_jsonl(target / deep.QUESTIONS_FILE, questions)
        # Asks left pending in the copy have no job: interrupted, so they offer Retry (hand-offs run in Lee).
        answers = deep.read_jsonl(target / deep.ANSWERS_FILE)
        if any(a.get("status") in deep.PENDING and not deep.is_handoff(a) for a in answers):
            for a in answers:
                if a.get("status") in deep.PENDING and not deep.is_handoff(a):
                    a["status"] = "interrupted"
            deep.write_jsonl(target / deep.ANSWERS_FILE, answers)

        card = new_card(
            card_id, exp.get("title") or DEFAULT_TITLE, now,
            purpose="goals" if is_goals else None, seed=exp.get("seed"),
            goals=[str(g) for g in exp.get("serves") or []],
            origin=exp.get("origin") if isinstance(exp.get("origin"), dict) else None,
            created_at=exp.get("created_at") or iso_s(now),
            updated_at=exp.get("updated_at") or iso_s(now),
            last_touched_at=exp.get("last_touched_at") or exp.get("updated_at"),
            migrated_from=exp_id,
        )
        self.pages.write_card(card)

        if is_goals:
            raw["goals_card_id"] = card_id
            raw["cards"].append({"id": card_id, "kind": "page", "area_id": None, "x": 0, "y": 0, "w": 0, "h": 0})
            return card_id
        area_id = f"area-{hexpart}"
        clash = next((a for a in raw["areas"] if a["id"] == area_id), None)
        if clash is not None and clash.get("migrated_from") == exp_id:
            raw["areas"].remove(clash)  # a half-finished earlier run
        elif clash is not None:
            area_id = self._unique("area", {a["id"] for a in raw["areas"]})
        x, y = self._free_area_slot(raw)
        name = " ".join(str(exp.get("title") or DEFAULT_TITLE).split())
        area = self._area_record(area_id, _clip_words(name, MAX_NAME), x, y, AREA_W, AREA_H, now, migrated_from=exp_id)
        area["created_at"] = exp.get("created_at") or iso_s(now)
        if exp.get("status") == "archived":
            area["drawer_id"] = PUT_AWAY_DRAWER
            area["put_away_at"] = exp.get("archived_at") or iso_s(now)
        raw["areas"].append(area)
        raw["cards"].append({"id": card_id, "kind": "page", "area_id": area_id,
                             "x": CARD_X, "y": CARD_Y, "w": CARD_W, "h": CARD_H})
        return card_id

    def _rewrite_open_next(self, mapping: Dict[str, Optional[str]]) -> None:
        """Open next's ``exploration_id`` becomes ``card_id`` through the map."""
        from ..copilot import open_next

        rec = open_next._read(self.workspace)
        exp_id = (rec or {}).get("exploration_id")
        if not exp_id or exp_id not in mapping:
            return
        rec = dict(rec)
        rec.pop("exploration_id", None)
        if mapping[exp_id]:
            rec["card_id"] = mapping[exp_id]
        if not rec.get("card_id") and not rec.get("someday_id"):
            open_next.clear(self.workspace)
            return
        atomic_write(open_next.path_for(self.workspace), json.dumps(rec, indent=2) + "\n")

    def card_for_exploration(self, exp_id: Any) -> Optional[str]:
        """The Page card an exploration id maps to (the migration's map, else ``pg-<hex>`` when it exists)."""
        raw = self._read()
        mapped = raw["migration"]["map"].get(exp_id)
        if mapped and self.pages.exists(mapped):
            return mapped
        guess = page_id_for_exploration(exp_id)
        return guess if guess and self.pages.exists(guess) else None

    # ---------------------------------------------------------------- GET /desk/last (§6.4)

    def last(self, now: Optional[datetime] = None, open_next_rec: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        from ..copilot.event_reader import parse_ts
        from ..copilot.someday import SomedayStore

        now = now or utc_now()
        raw = self.load(now)
        briefs = {b["id"]: b for b in self.briefs(raw)}
        sessions = self.list_sessions()
        latest = sessions[0] if sessions else None

        card_id, source = None, None
        nxt = (open_next_rec or {}).get("card_id")
        if nxt in briefs:
            card_id, source = nxt, "open_next"
        elif (raw.get("last") or {}).get("card_id") in briefs:
            card_id, source = raw["last"]["card_id"], "last"
        elif latest and latest.get("stopped_card_id") in briefs:
            card_id, source = latest["stopped_card_id"], "session"
        else:
            written = []
            for cid, b in briefs.items():
                s = self.summary(cid)
                if s["page_chars"] > 0:
                    written.append((max(str(s["page_updated_at"] or ""), str(b.get("last_touched_at") or "")), cid))
            if written:
                card_id, source = max(written)[1], "recent"

        arrived = {"answers": 0, "handoffs": 0, "open_questions": 0, "captured": 0}
        out = {"card": None, "source": None, "stopped_at": None, "stopped_line": None,
               "arrived": arrived, "last_session": latest}
        if card_id is None:
            return out
        page = self.pages.page_text(card_id)
        stopped = latest.get("stopped_at") if latest and latest.get("stopped_card_id") == card_id else None
        if not stopped:
            line = deep.last_nonempty_line(page)
            stopped = tail_clip(line) if line else None
        since = parse_ts((latest or {}).get("ended_at"))
        for a in deep.read_jsonl(self.pages.dir / card_id / deep.ANSWERS_FILE):
            if a.get("status") != "done":
                continue
            key = "handoffs" if deep.is_handoff(a) else "answers"
            if since is None:
                arrived[key] += 0 if (a.get("read_at") or a.get("dismissed_at")) else 1
            else:
                at = parse_ts(a.get("answered_at"))
                arrived[key] += 1 if at is not None and at > since else 0
        arrived["open_questions"] = sum(
            1 for q in deep.read_jsonl(self.pages.dir / card_id / deep.QUESTIONS_FILE) if q.get("status") == "open"
        )
        for item in SomedayStore(self.workspace).list("open"):
            created = parse_ts(item.created_at)
            if item.source.get("card_id") == card_id and (since is None or (created is not None and created > since)):
                arrived["captured"] += 1
        out.update({
            "card": self.brief_api(briefs[card_id]), "source": source, "stopped_at": stopped,
            "stopped_line": stopped_line(page, stopped),
        })
        return out


def _migrated_session(r: Dict[str, Any], card_id: str) -> Dict[str, Any]:
    """An exploration's session record as a Desk one."""
    kept = [k for k in r.get("questions_kept") or [] if isinstance(k, str) and deep.QUESTION_ID_RE.match(k)]
    rid = r.get("id") if isinstance(r.get("id"), str) and deep.SESSION_ID_RE.match(r["id"]) else _hex_id("ses")
    return {
        "id": rid, "focus_session_id": r.get("focus_session_id"),
        "started_at": r.get("started_at"), "ended_at": r.get("ended_at"),
        "reason": r.get("reason") if r.get("reason") in deep.DESK_SESSION_REASONS else "quit",
        "stopped_at": r.get("stopped_at"), "stopped_card_id": card_id,
        "rating": r.get("rating") if r.get("rating") in deep.RATINGS else None,
        "questions_kept": [{"card_id": card_id, "question_id": k} for k in kept],
        "cards_touched": [card_id],
    }


def idea_name(text: str) -> str:
    """An Area's name from an idea: its first line, at most 60 chars, cut at a word."""
    line = deep.first_line(text) or "Idea"
    return _clip_words(" ".join(line.split()), MAX_IDEA_TITLE)


def store_for(ctx, some_id: str):
    """The record store for an id: a Page card's (``pg-``) or an exploration's (``exp-``)."""
    return ctx.desk().pages if is_page_id(some_id) else ctx.explorations()
