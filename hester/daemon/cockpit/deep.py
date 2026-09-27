"""
Deep D1: the files inside an exploration's directory (contract section 3).

    .hester/explore/<id>/
      exploration.md      frontmatter (questions, links) + Seed + Log   (explorations.py)
      page.md             the Page: the user's own writing
      references.jsonl    kept quotes and links
      answers.jsonl       deep-ask questions and answers (deep_ask.py runs them)
      sessions.jsonl      Deep sessions: stopped-at note, depth rating, questions kept

Everything here is deterministic; no model runs. Hester never writes
``page.md``: only ``write_page`` does, for a PUT from the renderer (the user's
own text), and ``ExplorationStore.create`` for an initial page the user typed.
JSONL files are appended to, rewritten atomically on PATCH and capped at
5 000 records (oldest dropped with a WARN). Callers serialise writes with the
workspace lock; a process-wide lock also keeps each read-modify-write whole.
"""

import hashlib
import json
import logging
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .explorations import (
    EXP_ID_RE,
    MAX_PAGE_BYTES,
    ExplorationError,
    ExplorationNotFound,
    ExplorationStore,
    _clip,
    utc_now,
)
from .tasks import atomic_write, iso_s

logger = logging.getLogger("hester.daemon.cockpit.deep")

REFERENCES_FILE = "references.jsonl"
ANSWERS_FILE = "answers.jsonl"
SESSIONS_FILE = "sessions.jsonl"
MAX_RECORDS = 5000

REF_ID_RE = re.compile(r"^ref-[0-9a-f]{8}$")
ANSWER_ID_RE = re.compile(r"^ans-[0-9a-f]{8}$")
QUESTION_ID_RE = re.compile(r"^q-[0-9a-f]{8}$")
SESSION_ID_RE = re.compile(r"^ses-[0-9a-f]{8}$")

REF_KINDS = ("quote", "link")
REF_SOURCE_KINDS = ("page", "palette", "answer")
ANSWER_STATUSES = ("queued", "running", "done", "error", "interrupted")
PENDING = ("queued", "running")
ANSWER_FLAGS = {"read": "read_at", "dismissed": "dismissed_at", "inserted": "inserted_at", "kept": "kept_at"}
QUESTION_SOURCES = ("page", "ask")
SESSION_REASONS = ("ritual", "esc", "away", "quit")
RATINGS = ("deep", "mixed", "shallow")

MAX_QUOTE = 4000
MAX_ANCHOR_QUOTE = 500
MAX_SECTION = 200
MAX_URL = 2000
MAX_TITLE = 300
MAX_NOTE = 2000
MAX_QUESTION = 2000
MAX_QUESTION_TEXT = 500
MAX_STOPPED_AT = 1000
MAX_ERROR = 300
MAX_QUESTIONS = 500
MAX_KEPT = 200
# A PUT /page touches the exploration's last_touched_at at most this often, so
# daily writing never reads as "quiet" without rewriting exploration.md per save.
PAGE_TOUCH_S = 300

_LOCK = threading.RLock()


class PageConflict(Exception):
    """PUT /page with a stale ``base_version``: carries the current text."""

    def __init__(self, version: str, text: str):
        super().__init__("version_conflict")
        self.version = version
        self.text = text


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def _parse(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _opt_text(body: Dict[str, Any], key: str, limit: int) -> Optional[str]:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ExplorationError(f"{key} must be a string")
    return _clip(value, limit) or None


def is_http_url(value: Any) -> bool:
    return isinstance(value, str) and bool(re.match(r"^https?://[^\s]+$", value.strip(), re.IGNORECASE))


# ---------------------------------------------------------------------------
# JSONL files
# ---------------------------------------------------------------------------


def read_jsonl(path: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(row, dict):
                    out.append(row)
    except OSError:
        pass
    return out


def _render(rows: List[Dict[str, Any]]) -> str:
    return "".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n" for r in rows)


def write_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    """Atomic rewrite, keeping the newest ``MAX_RECORDS``."""
    if len(rows) > MAX_RECORDS:
        logger.warning(f"{path} is over {MAX_RECORDS} records; dropping the oldest {len(rows) - MAX_RECORDS}")
        rows = rows[-MAX_RECORDS:]
    atomic_write(path, _render(rows))
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def append_jsonl(path: Path, row: Dict[str, Any]) -> None:
    with _LOCK:
        rows = read_jsonl(path)
        if len(rows) + 1 > MAX_RECORDS:
            write_jsonl(path, rows + [row])
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(_render([row]))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def update_jsonl(path: Path, row_id: str, fn) -> Optional[Dict[str, Any]]:
    """Read, apply ``fn(row)`` to the row with ``id == row_id``, rewrite atomically. None if missing."""
    with _LOCK:
        rows = read_jsonl(path)
        for i, row in enumerate(rows):
            if row.get("id") == row_id:
                rows[i] = fn(dict(row))
                write_jsonl(path, rows)
                return rows[i]
    return None


def _dir(store: ExplorationStore, exp_id: str) -> Path:
    store.require(exp_id)  # 404 for an unknown id; migrates a legacy file
    return store.exp_dir(exp_id)


def newest_first(rows: List[Dict[str, Any]], key: str) -> List[Dict[str, Any]]:
    return sorted(rows, key=lambda r: str(r.get(key) or ""), reverse=True)


# ---------------------------------------------------------------------------
# Summary for to_api
# ---------------------------------------------------------------------------


def summary(exp_dir: Path, exp: Dict[str, Any]) -> Dict[str, Any]:
    """``page_chars``, ``page_updated_at``, answer counts, open questions, ``last_session``."""
    page = exp_dir / "page.md"
    chars, updated = 0, None
    try:
        st = page.stat()
        updated = iso_s(datetime.fromtimestamp(st.st_mtime, tz=timezone.utc))
        chars = len(page.read_text(encoding="utf-8")) if st.st_size else 0
    except (OSError, UnicodeDecodeError):
        pass
    unread = pending = 0
    for a in read_jsonl(exp_dir / ANSWERS_FILE):
        if a.get("status") in PENDING:
            pending += 1
        elif a.get("status") == "done" and not a.get("read_at") and not a.get("dismissed_at"):
            unread += 1
    sessions = read_jsonl(exp_dir / SESSIONS_FILE)
    last = max(sessions, key=lambda r: str(r.get("ended_at") or ""), default=None)
    return {
        "page_chars": chars,
        "page_updated_at": updated,
        "answers_unread": unread,
        "answers_pending": pending,
        "open_questions": sum(1 for q in exp.get("questions") or [] if q.get("status") == "open"),
        "last_session": last,
    }


# ---------------------------------------------------------------------------
# Anchors
# ---------------------------------------------------------------------------


def norm_anchor(raw: Any) -> Dict[str, Any]:
    """``{kind:'page', quote, offset, section}`` or ``{kind:'none'}``; stored verbatim otherwise."""
    if raw is None:
        return {"kind": "none"}
    if not isinstance(raw, dict):
        raise ExplorationError("anchor must be an object")
    if raw.get("kind") == "none":
        return {"kind": "none"}
    if raw.get("kind") != "page":
        raise ExplorationError("anchor.kind must be page or none")
    quote = raw.get("quote")
    if not isinstance(quote, str):
        raise ExplorationError("anchor.quote must be a string")
    offset = raw.get("offset")
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ExplorationError("anchor.offset must be a non-negative integer")
    section = raw.get("section")
    if section is not None and not isinstance(section, str):
        raise ExplorationError("anchor.section must be a string or null")
    return {
        "kind": "page",
        "quote": quote[:MAX_ANCHOR_QUOTE],
        "offset": offset,
        "section": section[:MAX_SECTION] if section else None,
    }


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------


def page_version(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def read_page_text(store: ExplorationStore, exp_id: str) -> str:
    try:
        return store.page_path(exp_id).read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def read_page(store: ExplorationStore, exp_id: str) -> Dict[str, Any]:
    _dir(store, exp_id)
    text = read_page_text(store, exp_id)
    return {"text": text, "version": page_version(text)}


def write_page(store: ExplorationStore, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """PUT /page ``{text, base_version}``. Raises PageConflict when ``base_version`` isn't current."""
    now = now or utc_now()
    text = body.get("text")
    if not isinstance(text, str):
        raise ExplorationError("text must be a string")
    if len(text.encode("utf-8")) > MAX_PAGE_BYTES:
        raise ExplorationError("the Page is larger than 1 MB")
    base = body.get("base_version")
    if not isinstance(base, str):
        raise ExplorationError("base_version must be a string")
    exp = store.require(exp_id)
    with _LOCK:
        current = read_page_text(store, exp_id)
        version = page_version(current)
        if base != version:
            raise PageConflict(version, current)
        if text != current:
            path = store.page_path(exp_id)
            atomic_write(path, text)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
    touched = _parse(exp.get("last_touched_at"))
    if text != current and (touched is None or (now - touched).total_seconds() >= PAGE_TOUCH_S):
        store.touch(exp_id, now)
    return {"version": page_version(text)}


# ---------------------------------------------------------------------------
# References
# ---------------------------------------------------------------------------


def list_references(store: ExplorationStore, exp_id: str) -> List[Dict[str, Any]]:
    return newest_first(read_jsonl(_dir(store, exp_id) / REFERENCES_FILE), "at")


def add_reference(store: ExplorationStore, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    kind = body.get("kind")
    if kind not in REF_KINDS:
        raise ExplorationError("kind must be quote or link")
    ref: Dict[str, Any] = {"id": _new_id("ref"), "kind": kind}
    quote = body.get("quote")
    if quote is not None:
        if not isinstance(quote, str):
            raise ExplorationError("quote must be a string")
        quote = quote.strip()[:MAX_QUOTE]
    url = body.get("url")
    if url is not None:
        if not is_http_url(url) or len(url.strip()) > MAX_URL:
            raise ExplorationError("url must be an http(s) URL")
        url = url.strip()
    if kind == "quote" and not quote:
        raise ExplorationError("a quote reference needs quote")
    if kind == "link" and not url:
        raise ExplorationError("a link reference needs url")
    for key, value in (("quote", quote), ("url", url)):
        if value:
            ref[key] = value
    for key, limit in (("title", MAX_TITLE), ("note", MAX_NOTE), ("section", MAX_SECTION)):
        value = _opt_text(body, key, limit)
        if value:
            ref[key] = value
    source = body.get("source")
    if source is not None:
        if not isinstance(source, dict) or source.get("kind") not in REF_SOURCE_KINDS:
            raise ExplorationError(f"source.kind must be one of {', '.join(REF_SOURCE_KINDS)}")
        ref["source"] = {"kind": source["kind"]}
        if isinstance(source.get("ref"), str) and source["ref"].strip():
            ref["source"]["ref"] = source["ref"].strip()[:100]
    ref["at"] = iso_s(now)
    append_jsonl(_dir(store, exp_id) / REFERENCES_FILE, ref)
    return ref


def patch_reference(store: ExplorationStore, exp_id: str, ref_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    if not REF_ID_RE.match(ref_id or ""):
        raise ExplorationError("invalid reference id")
    unknown = set(body) - {"note", "opened"}
    if unknown:
        raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
    if "opened" in body and body["opened"] is not True:
        raise ExplorationError("opened must be true")
    note = _opt_text(body, "note", MAX_NOTE) if "note" in body else None

    def apply(row: Dict[str, Any]) -> Dict[str, Any]:
        if "note" in body:
            if note:
                row["note"] = note
            else:
                row.pop("note", None)
        if body.get("opened") and not row.get("opened_at"):
            row["opened_at"] = iso_s(now)
        return row

    row = update_jsonl(_dir(store, exp_id) / REFERENCES_FILE, ref_id, apply)
    if row is None:
        raise ExplorationNotFound(f"{exp_id}/{ref_id}")
    return row


# ---------------------------------------------------------------------------
# Answers (deep-ask records; deep_ask.py runs them)
# ---------------------------------------------------------------------------


def list_answers(store: ExplorationStore, exp_id: str) -> List[Dict[str, Any]]:
    return newest_first(read_jsonl(_dir(store, exp_id) / ANSWERS_FILE), "asked_at")


def get_answer(store: ExplorationStore, exp_id: str, answer_id: str) -> Optional[Dict[str, Any]]:
    for row in read_jsonl(_dir(store, exp_id) / ANSWERS_FILE):
        if row.get("id") == answer_id:
            return row
    return None


def new_answer(store: ExplorationStore, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """POST /asks ``{question, anchor, follow_up_of?}``: a queued Answer (the route schedules the run)."""
    now = now or utc_now()
    question = body.get("question")
    if question is None:
        question = ""
    if not isinstance(question, str):
        raise ExplorationError("question must be a string")
    question = question.strip() or "Explain this."
    if len(question) > MAX_QUESTION:
        raise ExplorationError(f"question is longer than {MAX_QUESTION} characters")
    if "anchor" not in body:
        raise ExplorationError("anchor is required")
    anchor = norm_anchor(body.get("anchor"))
    answer: Dict[str, Any] = {
        "id": _new_id("ans"), "anchor": anchor, "question": question, "status": "queued",
        "surface": "deep-ask", "asked_at": iso_s(now),
    }
    follow = body.get("follow_up_of")
    if follow is not None:
        if not isinstance(follow, str) or not ANSWER_ID_RE.match(follow) or get_answer(store, exp_id, follow) is None:
            raise ExplorationError("follow_up_of must be an answer id of this exploration")
        answer["follow_up_of"] = follow
    append_jsonl(_dir(store, exp_id) / ANSWERS_FILE, answer)
    return answer


def update_answer(store: ExplorationStore, exp_id: str, answer_id: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Merge ``fields`` into an answer (``None`` values remove keys). For the runner."""
    def apply(row: Dict[str, Any]) -> Dict[str, Any]:
        for k, v in fields.items():
            if v is None:
                row.pop(k, None)
            else:
                row[k] = v
        return row

    return update_jsonl(store.exp_dir(exp_id) / ANSWERS_FILE, answer_id, apply)


def patch_answer(store: ExplorationStore, exp_id: str, answer_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """PATCH ``{read?, dismissed?, inserted?, kept?}`` (each ``true``): sets ``<flag>_at`` once."""
    now = now or utc_now()
    if not ANSWER_ID_RE.match(answer_id or ""):
        raise ExplorationError("invalid answer id")
    unknown = set(body) - set(ANSWER_FLAGS)
    if unknown:
        raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
    for k, v in body.items():
        if v is not True:
            raise ExplorationError(f"{k} must be true")

    def apply(row: Dict[str, Any]) -> Dict[str, Any]:
        for flag in body:
            if not row.get(ANSWER_FLAGS[flag]):
                row[ANSWER_FLAGS[flag]] = iso_s(now)
        return row

    row = update_jsonl(_dir(store, exp_id) / ANSWERS_FILE, answer_id, apply)
    if row is None:
        raise ExplorationNotFound(f"{exp_id}/{answer_id}")
    return row


def requeue_answer(store: ExplorationStore, exp_id: str, answer_id: str) -> Dict[str, Any]:
    """Retry: an ``error`` or ``interrupted`` answer back to ``queued``."""
    if not ANSWER_ID_RE.match(answer_id or ""):
        raise ExplorationError("invalid answer id")
    current = get_answer(store, exp_id, answer_id)
    if current is None:
        raise ExplorationNotFound(f"{exp_id}/{answer_id}")
    if current.get("status") not in ("error", "interrupted"):
        raise ExplorationError(f"only an errored or interrupted answer can be retried (this one is {current.get('status')})")
    row = update_answer(store, exp_id, answer_id, {"status": "queued", "error": None, "answered_at": None})
    return row or current


def interrupt_pending(store: ExplorationStore, keep: Optional[set] = None) -> int:
    """Every ``queued``/``running`` answer in the workspace not in ``keep`` becomes ``interrupted``."""
    keep = keep or set()
    n = 0
    for exp_id in store.ids():
        path = store.migrate(exp_id).parent / ANSWERS_FILE
        with _LOCK:
            rows = read_jsonl(path)
            changed = False
            for row in rows:
                if row.get("status") in PENDING and row.get("id") not in keep:
                    row["status"] = "interrupted"
                    changed = True
                    n += 1
            if changed:
                write_jsonl(path, rows)
    return n


# ---------------------------------------------------------------------------
# Questions (exploration.md frontmatter)
# ---------------------------------------------------------------------------


def list_questions(store: ExplorationStore, exp_id: str) -> List[Dict[str, Any]]:
    return list(store.require(exp_id).get("questions") or [])


def add_question(store: ExplorationStore, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ExplorationError("text must be a non-empty string")
    source = body.get("source")
    if source not in QUESTION_SOURCES:
        raise ExplorationError("source must be page or ask")
    question: Dict[str, Any] = {
        "id": _new_id("q"), "text": _clip(text, MAX_QUESTION_TEXT), "source": source, "status": "open", "at": iso_s(now),
    }
    if body.get("anchor") is not None:
        question["anchor"] = norm_anchor(body["anchor"])
    exp, text_body = store._open(exp_id)
    questions = list(exp.get("questions") or [])
    if len(questions) >= MAX_QUESTIONS:
        # Drop the oldest closed question first, else the oldest.
        drop = next((q for q in questions if q.get("status") == "closed"), questions[0])
        logger.warning(f"{exp_id} has {MAX_QUESTIONS} questions; dropping {drop['id']}")
        questions.remove(drop)
    exp["questions"] = questions + [question]
    store._save(exp, text_body, now)
    return question


def patch_question(store: ExplorationStore, exp_id: str, question_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    if not QUESTION_ID_RE.match(question_id or ""):
        raise ExplorationError("invalid question id")
    unknown = set(body) - {"status"}
    if unknown:
        raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
    if body.get("status") not in ("open", "closed"):
        raise ExplorationError("status must be open or closed")
    exp, text_body = store._open(exp_id)
    for q in exp.get("questions") or []:
        if q["id"] == question_id:
            if q["status"] != body["status"]:
                q["status"] = body["status"]
                if body["status"] == "closed":
                    q["closed_at"] = iso_s(now)
                else:
                    q.pop("closed_at", None)
                store._save(exp, text_body, now)
            return q
    raise ExplorationNotFound(f"{exp_id}/{question_id}")


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def list_sessions(store: ExplorationStore, exp_id: str) -> List[Dict[str, Any]]:
    return read_jsonl(_dir(store, exp_id) / SESSIONS_FILE)


def norm_session(body: Dict[str, Any]) -> Dict[str, Any]:
    fsid = body.get("focus_session_id")
    if not isinstance(fsid, str) or not fsid.strip() or len(fsid) > 100:
        raise ExplorationError("focus_session_id must be a non-empty string")
    for key in ("started_at", "ended_at"):
        if _parse(body.get(key)) is None:
            raise ExplorationError(f"{key} must be an ISO 8601 time")
    reason = body.get("reason")
    if reason not in SESSION_REASONS:
        raise ExplorationError(f"reason must be one of {', '.join(SESSION_REASONS)}")
    stopped = body.get("stopped_at")
    if stopped is not None and not isinstance(stopped, str):
        raise ExplorationError("stopped_at must be a string or null")
    rating = body.get("rating")
    if rating is not None and rating not in RATINGS:
        raise ExplorationError("rating must be deep, mixed, shallow or null")
    kept = body.get("questions_kept")
    if kept is None:
        kept = []
    if not isinstance(kept, list) or not all(isinstance(k, str) for k in kept):
        raise ExplorationError("questions_kept must be a list of strings")
    return {
        "id": _new_id("ses"),
        "focus_session_id": fsid.strip(),
        "started_at": body["started_at"],
        "ended_at": body["ended_at"],
        "reason": reason,
        "stopped_at": stopped[:MAX_STOPPED_AT] if stopped else None,
        "rating": rating,
        "questions_kept": [k for k in kept if k][:MAX_KEPT],
    }


def add_session(store: ExplorationStore, exp_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    record = norm_session(body)
    append_jsonl(_dir(store, exp_id) / SESSIONS_FILE, record)
    return record


# ---------------------------------------------------------------------------
# Explore (a child exploration from a selection)
# ---------------------------------------------------------------------------


def explore_child(store: ExplorationStore, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """POST /explore ``{seed, anchor?}``: a new exploration linked both ways. The parent isn't touched."""
    now = now or utc_now()
    seed = body.get("seed")
    if not isinstance(seed, str) or not seed.strip():
        raise ExplorationError("seed must be a non-empty string")
    if body.get("anchor") is not None:
        norm_anchor(body["anchor"])
    parent, parent_body = store._open(exp_id)
    child = store.create({
        "seed": seed,
        "origin": {"kind": "exploration", "ref": exp_id},
        "links": [{"kind": "exploration", "id": exp_id, "rel": "parent", "at": iso_s(now)}],
    }, now)
    parent["links"] = list(parent.get("links") or []) + [
        {"kind": "exploration", "id": child["id"], "rel": "child", "at": iso_s(now)}
    ]
    store._save(parent, parent_body, now)
    return child


def is_exploration_id(value: Any) -> bool:
    return isinstance(value, str) and bool(EXP_ID_RE.match(value))


def last_nonempty_line(text: str) -> Optional[str]:
    for line in reversed((text or "").splitlines()):
        if line.strip():
            return line.strip()
    return None
