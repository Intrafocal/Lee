"""
Boards (docs/16-Desk.md §3.1; plan docs/plans/2026-09-28-boards.md §2; contract
electron/src/shared/board.ts). A Board is a Desk card for thinking visually:
images, annotations, highlights and drawing, with Asks and hand-offs as cards
on it. Hester stores it; Lee draws it.

    .hester/desk/boards/<bd-id>/
      card.json        {id, kind: 'board', title, origin, created_at, updated_at, last_touched_at}
      board.json       {version, items}: the whole document, versioned like page.md (1 MB cap)
      answers.jsonl    Asks and hand-offs (deep.py's rows; anchor kind 'board')
      assets.jsonl     one row per asset: {name, mime, bytes, created_at, source?}
      assets/          img-<hex>.png|jpg (images), sel-<hex>.png (selections Lee flattened)
      preview.png      the Board as a picture, written by Lee

In ``desk.json`` a Board is a card entry with ``kind: 'board'``, so Areas,
Move, Stash, Delete and the Drawer treat it as they treat a Page.
``BoardStore`` gives deep.py the same surface ``PageStore`` does (``require``,
``exists``, ``get``, ``exp_dir``, ``touch``, ``workspace``), so a Board's Asks
and hand-offs follow the Page's rules. Items are checked (kinds, ids, numbers)
and stored as Lee sent them; Hester never places or reads them for meaning,
except to count them and to give an Ask its annotation text.
"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import deep
from .desk import (
    _LOCK,
    ASSET_TYPES,
    ASSETS_DIR,
    ASSETS_FILE,
    CARD_FILE,
    DESK_DIR,
    MAX_COORD,
    MAX_EXCERPT,
    MAX_STROKE_POINTS,
    MAX_STROKE_WIDTH,
    DeskError,
    DeskNotFound,
    _chmod,
    _read_json,
    _write_json,
    excerpt,
    image_ext,
    is_board_id,
    is_card_id,
    store_asset,
    write_file,
)
from .explorations import utc_now
from .tasks import atomic_write, iso_s

BOARD_FILE = "board.json"
PREVIEW_FILE = "preview.png"
BOARD_ITEM_KINDS = ("image", "note", "highlight", "stroke", "ask", "handoff", "link")
MAX_BOARD_BYTES = 1_000_000
MAX_BOARD_ITEMS = 2000
ITEM_ID_RE = re.compile(r"^it-[0-9a-f]{8}$")
BOARD_ASSET_RE = re.compile(r"^(img|sel)-[0-9a-f]{8}\.(png|jpg)$")
SNAPSHOT_RE = re.compile(r"^assets/(sel-[0-9a-f]{8}\.png)$")
MAX_ANCHOR_NOTES = 50
MAX_ANCHOR_NOTE = 2000
IN_FLIGHT = ("launching", "running", "waiting", "review")


class BoardConflict(Exception):
    """PUT /board with a stale ``version``: carries the current document."""

    def __init__(self, version: str, items: List[Dict[str, Any]]):
        super().__init__("version_conflict")
        self.version = version
        self.items = items


def board_version(items: List[Dict[str, Any]]) -> str:
    """Opaque, from the items (as ``page_version`` is from the text)."""
    canon = json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(canon.encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Items (shared/board.ts BoardItem)
# ---------------------------------------------------------------------------


def _is_num(v: Any) -> bool:
    return not isinstance(v, bool) and isinstance(v, (int, float)) and v == v and abs(v) <= MAX_COORD


def _rect(value: Any, what: str) -> None:
    if not isinstance(value, dict) or not all(_is_num(value.get(k)) for k in ("x", "y", "w", "h")):
        raise DeskError(f"{what} must be {{x, y, w, h}} numbers")
    if value["w"] < 0 or value["h"] < 0:
        raise DeskError(f"{what}.w and h can't be negative")


def _target(value: Any, where: str) -> None:
    if not isinstance(value, dict):
        raise DeskError(f"{where}.target must be {{item_ids, rect}}")
    ids = value.get("item_ids")
    if not isinstance(ids, list) or len(ids) > MAX_BOARD_ITEMS or not all(isinstance(i, str) and ITEM_ID_RE.match(i) for i in ids):
        raise DeskError(f"{where}.target.item_ids must be a list of item ids")
    _rect(value.get("rect"), f"{where}.target.rect")


def check_item(item: Any, i: int) -> None:
    """One item against shared/board.ts; DeskError says which and why."""
    if not isinstance(item, dict):
        raise DeskError(f"items[{i}] must be an object")
    kind = item.get("kind")
    if kind not in BOARD_ITEM_KINDS:
        raise DeskError(f"items[{i}].kind must be one of {', '.join(BOARD_ITEM_KINDS)}")
    where = f"items[{i}] ({kind})"
    if not isinstance(item.get("id"), str) or not ITEM_ID_RE.match(item["id"]):
        raise DeskError(f"{where}.id must be it-<8 hex>")
    for k in ("x", "y", "w", "h", "z"):
        if not _is_num(item.get(k)):
            raise DeskError(f"{where}.{k} must be a number")
    if item["w"] < 0 or item["h"] < 0:
        raise DeskError(f"{where}.w and h can't be negative")
    if kind == "image":
        if not isinstance(item.get("asset"), str) or not BOARD_ASSET_RE.match(item["asset"]):
            raise DeskError(f"{where}.asset must be an asset name (img-<hex>.png)")
    elif kind == "note":
        if not isinstance(item.get("text"), str):
            raise DeskError(f"{where}.text must be a string")
        pin = item.get("pin")
        if pin is not None:
            if (
                not isinstance(pin, dict) or not isinstance(pin.get("item_id"), str) or not ITEM_ID_RE.match(pin["item_id"])
                or not all(_is_num(pin.get(k)) and 0 <= pin[k] <= 1 for k in ("u", "v"))
            ):
                raise DeskError(f"{where}.pin must be {{item_id, u, v}} with u and v from 0 to 1")
    elif kind == "highlight":
        on = item.get("item_id")
        if on is not None and (not isinstance(on, str) or not ITEM_ID_RE.match(on)):
            raise DeskError(f"{where}.item_id must be an item id or null")
    elif kind == "stroke":
        points = item.get("points")
        if not isinstance(points, list) or not points or len(points) > MAX_STROKE_POINTS:
            raise DeskError(f"{where}.points must be 1 to {MAX_STROKE_POINTS} [x, y] pairs")
        for p in points:
            if not isinstance(p, list) or len(p) != 2 or not all(_is_num(v) for v in p):
                raise DeskError(f"{where}.points must be [x, y] pairs of numbers")
        if not _is_num(item.get("width")) or not 0 < item["width"] <= MAX_STROKE_WIDTH:
            raise DeskError(f"{where}.width must be above 0 and at most {MAX_STROKE_WIDTH}")
    elif kind in ("ask", "handoff"):
        if not isinstance(item.get("answer_id"), str) or not deep.ANSWER_ID_RE.match(item["answer_id"]):
            raise DeskError(f"{where}.answer_id must be an answer id")
        _target(item.get("target"), where)
        if item.get("open") is not None and not isinstance(item["open"], bool):
            raise DeskError(f"{where}.open must be true or false")
    elif kind == "link":
        if not is_card_id(item.get("card_id")):
            raise DeskError(f"{where}.card_id must be a card id (pg-… or bd-…)")


def check_items(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        raise DeskError("items must be a list")
    if len(items) > MAX_BOARD_ITEMS:
        raise DeskError(f"a Board has at most {MAX_BOARD_ITEMS} items")
    seen = set()
    for i, item in enumerate(items):
        check_item(item, i)
        if item["id"] in seen:
            raise DeskError(f"items[{i}].id {item['id']} is used twice")
        seen.add(item["id"])
    return items


def note_texts(items: List[Dict[str, Any]], ids: Optional[List[str]] = None) -> List[str]:
    """The annotations' text (those in ``ids`` when given), in their order on the Board."""
    want = set(ids) if ids is not None else None
    return [
        it["text"].strip() for it in items
        if it.get("kind") == "note" and isinstance(it.get("text"), str) and it["text"].strip()
        and (want is None or it.get("id") in want)
    ]


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


class BoardStore:
    """``.hester/desk/boards/``: one directory per Board card. deep.py's record functions take it."""

    questions_in_file = True  # a Board has no questions; list_questions reads an absent file

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / DESK_DIR / "boards"

    def _check_id(self, card_id: str) -> str:
        if not is_board_id(card_id):
            raise DeskError(f"invalid card id: {card_id!r}")
        return card_id

    def exp_dir(self, card_id: str) -> Path:
        return self.dir / self._check_id(card_id)

    card_dir = exp_dir

    def migrate(self, card_id: str) -> Path:
        """deep.interrupt_pending's hook; a Board has no legacy form."""
        return self.exp_dir(card_id) / CARD_FILE

    def exists(self, card_id: str) -> bool:
        return is_board_id(card_id) and (self.dir / card_id / CARD_FILE).exists()

    def ids(self) -> List[str]:
        try:
            return sorted(p.parent.name for p in self.dir.glob(f"bd-*/{CARD_FILE}") if is_board_id(p.parent.name))
        except OSError:
            return []

    def read_card(self, card_id: str) -> Optional[Dict[str, Any]]:
        if not is_board_id(card_id):
            return None
        return _read_json(self.dir / card_id / CARD_FILE)

    def get(self, card_id: str) -> Optional[Dict[str, Any]]:
        card = self.read_card(card_id)
        return None if card is None else dict(card, id=card_id, questions=[])

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
        return False

    # ---- board.json

    def board_path(self, card_id: str) -> Path:
        return self.exp_dir(card_id) / BOARD_FILE

    def items(self, card_id: str) -> List[Dict[str, Any]]:
        """The stored items ([] when there's no board.json or it's unreadable)."""
        data = _read_json(self.board_path(card_id)) or {}
        items = data.get("items")
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    def read(self, card_id: str) -> Dict[str, Any]:
        """GET /board: ``{version, items}``."""
        self.require(card_id)
        items = self.items(card_id)
        return {"version": board_version(items), "items": items}

    def _save(self, card_id: str, items: List[Dict[str, Any]]) -> str:
        version = board_version(items)
        text = json.dumps({"version": version, "items": items}, ensure_ascii=False, separators=(",", ":")) + "\n"
        path = self.board_path(card_id)
        atomic_write(path, text)
        _chmod(path, 0o600)
        return version

    def write(self, card_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """
        PUT /board ``{version, items}``: the whole document. BoardConflict (409)
        when ``version`` isn't the current one; ``null`` stands for an empty Board.
        """
        now = now or utc_now()
        base = body.get("version")
        if "version" not in body or (base is not None and not isinstance(base, str)):
            raise DeskError("version must be a string or null")
        items = check_items(body.get("items"))
        size = len(json.dumps({"version": "x" * 12, "items": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        if size > MAX_BOARD_BYTES:
            raise DeskError("the Board is larger than 1 MB")
        card = self.require(card_id)
        with _LOCK:
            current = self.items(card_id)
            version = board_version(current)
            if base != version and not (base is None and not current):
                raise BoardConflict(version, current)
            new_version = self._save(card_id, items) if items != current else version
        touched = deep._parse(card.get("last_touched_at"))
        if items != current and (touched is None or (now - touched).total_seconds() >= deep.PAGE_TOUCH_S):
            self.touch(card_id, now)
        return {"version": new_version}

    # ---- assets and the preview

    def add_asset(self, card_id: str, content_type: str, data: bytes, kind: str = "image",
                  source: Optional[Dict[str, Any]] = None, now: Optional[datetime] = None) -> Dict[str, Any]:
        """
        An image (``img-<hex>``) or a flattened selection (``kind: 'selection'``,
        ``sel-<hex>.png``) -> its ``assets.jsonl`` row plus ``path``.
        """
        self.require(card_id)
        if kind not in ("image", "selection"):
            raise DeskError("kind must be image or selection")
        ext = image_ext(content_type, data)
        if kind == "selection" and ext != "png":
            raise DeskError("a selection is a PNG")
        row = store_asset(self.exp_dir(card_id), "sel" if kind == "selection" else "img", ext, data, source, now)
        return dict(row, path=f"{ASSETS_DIR}/{row['name']}")

    def list_assets(self, card_id: str) -> List[Dict[str, Any]]:
        self.require(card_id)
        return deep.read_jsonl(self.exp_dir(card_id) / ASSETS_FILE)

    def asset_path(self, card_id: str, name: str) -> Tuple[Path, str]:
        self.require(card_id)
        if not BOARD_ASSET_RE.match(name or ""):
            raise DeskError("invalid asset name")
        path = self.exp_dir(card_id) / ASSETS_DIR / name
        if not path.is_file():
            raise DeskNotFound(name)
        ext = name.rsplit(".", 1)[1]
        return path, next(t for t, e in ASSET_TYPES.items() if e == ext)

    def put_preview(self, card_id: str, content_type: str, data: bytes) -> Dict[str, Any]:
        self.require(card_id)
        if image_ext(content_type, data) != "png":
            raise DeskError("the preview is a PNG")
        write_file(self.exp_dir(card_id) / PREVIEW_FILE, data)
        return {"bytes": len(data)}

    def preview_path(self, card_id: str) -> Path:
        self.require(card_id)
        path = self.exp_dir(card_id) / PREVIEW_FILE
        if not path.is_file():
            raise DeskNotFound(f"{card_id}/{PREVIEW_FILE}")
        return path

    # ---- the anchor of an Ask or hand-off (shared/board.ts BoardAnchor)

    def snapshot_path(self, card_id: str, snapshot: Any) -> Path:
        """The file ``assets/sel-<hex>.png`` names; DeskError unless it's one of this Board's."""
        m = SNAPSHOT_RE.match(snapshot) if isinstance(snapshot, str) else None
        if m is None:
            raise DeskError("anchor.snapshot must be assets/sel-<8 hex>.png")
        path = self.exp_dir(card_id) / ASSETS_DIR / m.group(1)
        if not path.is_file():
            raise DeskError("anchor.snapshot isn't one of this Board's selections")
        return path

    def norm_anchor(self, card_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
        """``{kind: 'board', item_ids, rect, snapshot, notes}``; the snapshot must exist on this Board."""
        ids = raw.get("item_ids")
        if not isinstance(ids, list) or len(ids) > MAX_BOARD_ITEMS or not all(isinstance(i, str) and ITEM_ID_RE.match(i) for i in ids):
            raise DeskError("anchor.item_ids must be a list of item ids")
        rect = raw.get("rect")
        _rect(rect, "anchor.rect")
        self.snapshot_path(card_id, raw.get("snapshot"))
        notes = raw.get("notes")
        if notes is None:
            notes = []
        if not isinstance(notes, list) or not all(isinstance(n, str) for n in notes):
            raise DeskError("anchor.notes must be a list of strings")
        return {
            "kind": "board", "item_ids": list(ids),
            "rect": {k: rect[k] for k in ("x", "y", "w", "h")},
            "snapshot": raw["snapshot"],
            "notes": [n[:MAX_ANCHOR_NOTE] for n in notes if n.strip()][:MAX_ANCHOR_NOTES],
        }

    # ---- the Desk card's summary

    def summary(self, card_id: str) -> Dict[str, Any]:
        """DeskCardSummary's fields (a Board has no Page text) plus ``board``: counts, open asks, the preview's time."""
        d = self.dir / card_id
        items = self.items(card_id)
        count = {k: 0 for k in BOARD_ITEM_KINDS}
        for it in items:
            count[it.get("kind")] = count.get(it.get("kind"), 0) + 1
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
        updated = preview_at = None
        for name in (BOARD_FILE, PREVIEW_FILE):
            try:
                at = iso_s(datetime.fromtimestamp((d / name).stat().st_mtime, tz=timezone.utc))
            except OSError:
                continue
            if name == BOARD_FILE:
                updated = at
            else:
                preview_at = at
        return {
            "page_chars": 0,
            "page_updated_at": updated,
            "excerpt": excerpt("\n\n".join(note_texts(items)), MAX_EXCERPT),
            "answers_unread": unread,
            "answers_pending": pending,
            "handoffs_in_flight": in_flight,
            "open_questions": 0,
            "board": {
                "items": len(items), "images": count["image"], "notes": count["note"],
                "highlights": count["highlight"], "strokes": count["stroke"], "links": count["link"],
                "asks": count["ask"], "handoffs": count["handoff"], "asks_open": pending + unread,
                "preview_at": preview_at,
            },
        }

    def is_empty(self, card_id: str) -> bool:
        """Still Untitled, no items and nothing asked or handed off."""
        card = self.require(card_id)
        if not deep.UNTITLED_RE.match(str(card.get("title") or "Untitled").strip()):
            return False
        return not self.items(card_id) and not deep.read_jsonl(self.exp_dir(card_id) / deep.ANSWERS_FILE)


def new_board_card(card_id: str, title: str, now: datetime, origin: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    return {
        "id": card_id, "kind": "board", "title": title, "origin": origin,
        "created_at": iso_s(now), "updated_at": iso_s(now), "last_touched_at": iso_s(now),
    }
