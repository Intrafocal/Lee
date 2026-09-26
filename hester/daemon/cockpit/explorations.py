"""
Explore: durable explorations (spec §7.5; v3 contracts: Explore absorbs the Library).

One directory per exploration (Deep D1 contract section 3) at
``<workspace>/.hester/explore/<id>/`` (0700; ``.hester/`` is gitignored):
``exploration.md`` (0600; the format below), ``page.md`` (the user's Page),
and ``references.jsonl``, ``answers.jsonl`` and ``sessions.jsonl`` (see
``deep.py``). Legacy flat files ``<id>.md`` move into their directory the
first time they're loaded. ``exploration.md`` is YAML frontmatter plus a
free-form body:

    ---
    id: exp-1a2b3c4d
    title: ...
    status: active | archived
    nodes: [...]            # the tree; absent in v-now files => just the root
    active_node: root
    serves: [G1]
    promoted: [{to, ref, at, node_ids}]
    knowledge_path: null
    links: [{kind: exploration, id, rel: child | parent, at}]
    questions: [{id, text, source, anchor, status, at, closed_at}]
    ...
    ---
    # <title>

    ## Seed

    <seed text>

    ## Log                                    <- the root node's conversation

    ### You · 2026-09-26T10:00:00Z

    ...

    ### Hester · 2026-09-26T10:00:05Z

    ...

    ## Node n-1a2b3c4d · Try a file-first store   <- one section per non-root node with a log
    ### You · 2026-09-26T10:03:00Z
    ...

This is the one store for open-ended work. The Library pane is a tree view onto
the same files (``/library/*`` in main.py; ``session_id`` is the exploration
id, node ids are ``root`` or ``n-<8 hex>``); nothing about an exploration
expires. Nodes are branches (``thought`` and ``source_*``, each with its own
log section), ``decision`` nodes (a choice, what was chosen and pruned, an
optional reason), ``spike`` nodes (a timeboxed agent task in a git worktree,
kept current by ``spikes.sync``) and ``evidence`` nodes (one per spike: the
agent's claim, files, diffstat, diff file and commits). Decision, spike and
evidence nodes have no log; their text lives in the frontmatter.

The parser splits only on exact headings (``### You|Hester · <iso>`` and
``## Node n-<hex> · <label>`` for a known node), so markdown headings inside
answers are safe.

An exploration's deep dive is a Hester chat session with the deterministic id
``explore-<id>``: POST .../open seeds that session from the file, and every
finished turn in it is appended back to the root Log (``record_turn``), so the
file outlives the session's TTL and a later open re-seeds from it. Library
per-node chats use ``library-<id>-<node>`` the same way (``open_node_session``).

Everything here is deterministic; no model runs in the store. Promotes, escalate
and archive-as-knowledge live in ``explore_ops.py``.
"""

import copy
import logging
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import yaml

from .plain import plain_title
from .tasks import atomic_write, iso_s

logger = logging.getLogger("hester.daemon.cockpit.explorations")

EXP_ID_RE = re.compile(r"^exp-[0-9a-f]{8}$")
NODE_ID_RE = re.compile(r"^n-[0-9a-f]{8}$")
MSG_HEADING_RE = re.compile(r"^### (You|Hester) · (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)$")
NODE_HEADING_RE = re.compile(r"^## Node (n-[0-9a-f]{8}) · .*$")
SESSION_PREFIX = "explore-"
LIBRARY_PREFIX = "library-"
ROOT = "root"
STATUSES = ("active", "archived")
ORIGIN_KINDS = ("cockpit", "someday", "hester", "library", "task", "exploration", "opener")
NODE_KINDS = ("thought", "source_file", "source_web", "source_db", "decision", "spike", "evidence")
LOG_KINDS = ("thought", "source_file", "source_web", "source_db")
MODES = ("ideate", "explore", "learn", "brainstorm", "visualize", "search")
SPIKE_STATUSES = ("pending", "running", "review", "done", "discarded", "failed")
PROMOTE_TARGETS = ("task", "workstream", "goal")
FIELDS = (
    "id", "workspace", "title", "status", "seed", "origin", "session_id", "turns",
    "created_at", "updated_at", "last_touched_at", "archived_at", "version",
    "nodes", "active_node", "serves", "promoted", "knowledge_path", "links", "questions",
)
# Derived on load from the exploration's directory (never written to frontmatter).
DEEP_FIELDS = (
    "page_chars", "page_updated_at", "answers_unread", "answers_pending", "open_questions", "last_session",
)
EXPLORATION_FILE = "exploration.md"
PAGE_FILE = "page.md"
LINK_RELS = ("child", "parent")
MAX_TITLE = 200
MAX_LABEL = 200
MAX_SEED = 8000
MAX_TURN_TEXT = 8000
MAX_DECISION_TEXT = 2000
MAX_PROMPT = 8000
CONTEXT_CHARS = 12000
MAX_PAGE_BYTES = 1024 * 1024
LOG_HEADING = "## Log"
DEFAULT_TIMEBOX_MIN = 30

_YAML_LOADER = getattr(yaml, "CSafeLoader", yaml.SafeLoader)


class ExplorationError(ValueError):
    pass


class ExplorationNotFound(KeyError):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_exploration_id() -> str:
    return f"exp-{secrets.token_hex(4)}"


def new_node_id() -> str:
    return f"n-{secrets.token_hex(4)}"


def session_id_for(exp_id: str) -> str:
    return f"{SESSION_PREFIX}{exp_id}"


def node_session_id(exp_id: str, node_id: str) -> str:
    """The Hester chat session behind a Library node's chat."""
    return f"{LIBRARY_PREFIX}{exp_id}-{node_id}"


def exploration_id_from_session(session_id: Any) -> Optional[str]:
    """``explore-exp-1a2b3c4d`` -> ``exp-1a2b3c4d``; None for any other session."""
    if not isinstance(session_id, str) or not session_id.startswith(SESSION_PREFIX):
        return None
    exp_id = session_id[len(SESSION_PREFIX):]
    return exp_id if EXP_ID_RE.match(exp_id) else None


def _clip(text: Any, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _one_line(text: Any, limit: int) -> str:
    return _clip(" ".join(str(text or "").split()), limit)


def _stringify_times(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso_s(value if value.tzinfo else value.replace(tzinfo=timezone.utc))
    if isinstance(value, dict):
        return {k: _stringify_times(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_stringify_times(v) for v in value]
    return value


def _str_list(name: str, value: Any) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ExplorationError(f"{name} must be a list of strings")
    out: List[str] = []
    for v in value:
        v = v.strip()
        if v and v not in out:
            out.append(v)
    return out


def _opt_reason(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ExplorationError("reason must be a string or null")
    return _clip(value, MAX_DECISION_TEXT) or None


_warned_both: Set[Tuple[Path, str]] = set()
QUESTION_ID_RE = re.compile(r"^q-[0-9a-f]{8}$")


def _norm_links(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in raw if isinstance(raw, list) else []:
        if not isinstance(r, dict) or r.get("kind") != "exploration" or r.get("rel") not in LINK_RELS:
            continue
        if not isinstance(r.get("id"), str) or not EXP_ID_RE.match(r["id"]):
            continue
        out.append({"kind": "exploration", "id": r["id"], "rel": r["rel"], "at": r.get("at")})
    return out


def _norm_questions(raw: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in raw if isinstance(raw, list) else []:
        if not isinstance(r, dict) or not QUESTION_ID_RE.match(str(r.get("id") or "")):
            continue
        q = {
            "id": r["id"], "text": str(r.get("text") or ""),
            "source": r.get("source") if r.get("source") in ("page", "ask") else "page",
            "status": r.get("status") if r.get("status") in ("open", "closed") else "open", "at": r.get("at"),
        }
        if isinstance(r.get("anchor"), dict):
            q["anchor"] = r["anchor"]
        if r.get("closed_at"):
            q["closed_at"] = r["closed_at"]
        out.append(q)
    return out


def root_node(exp: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": ROOT, "parent": None, "label": exp.get("title") or "", "kind": "thought", "mode": "ideate",
        "collapsed": False, "pruned": False, "created_at": exp.get("created_at"), "turns": int(exp.get("turns") or 0),
    }


def _norm_node(raw: Dict[str, Any]) -> Dict[str, Any]:
    kind = raw.get("kind") if raw.get("kind") in NODE_KINDS else "thought"
    node = {
        "id": str(raw.get("id")),
        "parent": raw.get("parent"),
        "label": str(raw.get("label") or ""),
        "kind": kind,
        "mode": raw.get("mode") if raw.get("mode") in MODES else ("ideate" if kind in LOG_KINDS else None),
        "collapsed": bool(raw.get("collapsed")),
        "pruned": bool(raw.get("pruned")),
        "created_at": raw.get("created_at"),
        "turns": int(raw.get("turns") or 0),
    }
    for key in ("decision", "spike", "evidence"):
        if isinstance(raw.get(key), dict):
            node[key] = raw[key]
    return node


def _norm_nodes(exp: Dict[str, Any], raw: Any) -> List[Dict[str, Any]]:
    """The node list from frontmatter; a v-now file (no nodes) is just the root."""
    nodes: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    if isinstance(raw, list):
        for r in raw:
            if not isinstance(r, dict) or not r.get("id"):
                continue
            n = _norm_node(r)
            if n["id"] in seen or (n["id"] != ROOT and not NODE_ID_RE.match(n["id"])):
                continue
            seen.add(n["id"])
            nodes.append(n)
    root = next((n for n in nodes if n["id"] == ROOT), None)
    if root is None:
        root = root_node(exp)
    else:
        nodes.remove(root)
    root.update({"parent": None, "label": exp.get("title") or root["label"]})
    if root["kind"] not in LOG_KINDS:
        root["kind"] = "thought"
    ids = {ROOT} | {n["id"] for n in nodes}
    for n in nodes:
        if n["parent"] not in ids or n["parent"] == n["id"]:
            n["parent"] = ROOT
    return [root] + nodes


# ---------------------------------------------------------------------------
# Body: exact-heading parser
# ---------------------------------------------------------------------------


def _node_sections(lines: List[str], known: Iterable[str]) -> Tuple[int, Dict[str, Tuple[int, int]]]:
    """(end of the root part, {node id: (heading line, end)}); only known node ids split."""
    known = set(known)
    starts: List[Tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = NODE_HEADING_RE.match(line)
        if m and m.group(1) in known and all(nid != m.group(1) for _, nid in starts):
            starts.append((i, m.group(1)))
    sections: Dict[str, Tuple[int, int]] = {}
    for k, (i, nid) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(lines)
        sections[nid] = (i, end)
    return (starts[0][0] if starts else len(lines)), sections


def parse_messages(lines: List[str]) -> List[Dict[str, Any]]:
    """Messages between exact ``### You|Hester · <iso>`` headings, trimmed."""
    out: List[Dict[str, Any]] = []
    cur: Optional[Tuple[str, str]] = None
    buf: List[str] = []

    def flush():
        if cur is not None:
            out.append({
                "role": "user" if cur[0] == "You" else "assistant",
                "content": "\n".join(_unescape_line(b) for b in buf).strip(),
                "timestamp": cur[1],
                "metadata": {},
            })

    for line in lines:
        m = MSG_HEADING_RE.match(line)
        if m:
            flush()
            cur, buf = (m.group(1), m.group(2)), []
        elif cur is not None:
            buf.append(line)
    flush()
    return out


def _root_log_lines(root_lines: List[str]) -> List[str]:
    for i, line in enumerate(root_lines):
        if line == LOG_HEADING:
            return root_lines[i + 1:]
    return []


def _heading_like(line: str) -> bool:
    bare = line.lstrip(" ")
    return bool(MSG_HEADING_RE.match(bare) or NODE_HEADING_RE.match(bare))


def _escape_headings(text: str) -> str:
    """Indent content lines shaped like our own headings (one more space each, so
    it reverses exactly), so the parser never splits on them."""
    return "\n".join(" " + line if _heading_like(line) else line for line in text.split("\n"))


def _unescape_line(line: str) -> str:
    return line[1:] if line.startswith(" ") and _heading_like(line) else line


def _turn_text(user: Optional[str], assistant: Optional[str], stamp: str) -> str:
    parts = []
    if user and user.strip():
        parts.append(f"\n### You · {stamp}\n\n{_escape_headings(_clip(user, MAX_TURN_TEXT))}\n")
    if assistant and assistant.strip():
        parts.append(f"\n### Hester · {stamp}\n\n{_escape_headings(_clip(assistant, MAX_TURN_TEXT))}\n")
    return "".join(parts)


def _node_heading(nid: str, label: str) -> str:
    return f"## Node {nid} · {_one_line(label, MAX_LABEL)}"


class ExplorationStore:
    """File-first exploration store for one workspace. Callers serialise writes (ctx.lock)."""

    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / ".hester" / "explore"

    # ---------------------------------------------------------------- files

    def _check_id(self, exp_id: str) -> str:
        if not isinstance(exp_id, str) or not EXP_ID_RE.match(exp_id):
            raise ExplorationError(f"invalid exploration id: {exp_id!r}")
        return exp_id

    def exp_dir(self, exp_id: str) -> Path:
        """``.hester/explore/<id>/``: the exploration's directory."""
        return self.dir / self._check_id(exp_id)

    def _path(self, exp_id: str) -> Path:
        return self.exp_dir(exp_id) / EXPLORATION_FILE

    def _legacy_path(self, exp_id: str) -> Path:
        return self.dir / f"{self._check_id(exp_id)}.md"

    def page_path(self, exp_id: str) -> Path:
        return self.exp_dir(exp_id) / PAGE_FILE

    def exists(self, exp_id: str) -> bool:
        return self._path(exp_id).exists() or self._legacy_path(exp_id).exists()

    def migrate(self, exp_id: str) -> Path:
        """
        Move a legacy flat ``<id>.md`` into ``<id>/exploration.md`` and create an
        empty ``page.md``. Idempotent. If both exist the directory wins and the
        flat file is left alone (with a WARN, once). Returns the current path.
        Callers normally hold the workspace lock; the move is a rename, so a
        reader racing it only ever finds one of the two places.
        """
        path = self._path(exp_id)
        legacy = self._legacy_path(exp_id)
        if path.exists():
            if legacy.exists() and (self.workspace, exp_id) not in _warned_both:
                _warned_both.add((self.workspace, exp_id))
                logger.warning(f"Both {legacy} and {path} exist; using the directory and leaving the flat file alone")
            return path
        if not legacy.exists():
            return path
        d = path.parent
        try:
            d.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(d, 0o700)
            os.replace(legacy, path)
        except FileNotFoundError:
            return path  # another reader moved it first
        except OSError as e:
            logger.warning(f"Could not migrate {legacy} into {d}: {e}")
            return legacy
        self._ensure_page(exp_id)
        logger.info(f"Migrated exploration {exp_id} to {d}")
        return path

    def _ensure_page(self, exp_id: str, text: str = "") -> None:
        page = self.page_path(exp_id)
        if page.exists():
            return
        atomic_write(page, text)
        try:
            os.chmod(page, 0o600)
        except OSError:
            pass

    def _load(self, path: Path, deep: bool = True) -> Optional[Tuple[Dict[str, Any], str]]:
        try:
            content = path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return None
        if not content.startswith("---\n"):
            return None
        end = content.find("\n---\n", 3)
        if end < 0:
            return None
        try:
            meta = yaml.load(content[4:end + 1], Loader=_YAML_LOADER) or {}
        except yaml.YAMLError:
            return None
        if not isinstance(meta, dict):
            return None
        meta = _stringify_times(meta)
        exp = {k: meta.get(k) for k in FIELDS}
        exp["id"] = str(meta.get("id") or (path.parent.name if path.name == EXPLORATION_FILE else path.stem))
        exp["workspace"] = str(meta.get("workspace") or self.workspace)
        exp["status"] = meta.get("status") if meta.get("status") in STATUSES else "active"
        exp["turns"] = int(meta.get("turns") or 0)
        exp["version"] = int(meta.get("version") or 0)
        exp["session_id"] = meta.get("session_id") or session_id_for(exp["id"])
        exp["nodes"] = _norm_nodes(exp, meta.get("nodes"))
        ids = {n["id"] for n in exp["nodes"]}
        exp["active_node"] = meta.get("active_node") if meta.get("active_node") in ids else ROOT
        exp["serves"] = [str(g) for g in meta.get("serves") or [] if isinstance(g, (str, int))]
        exp["promoted"] = [p for p in meta.get("promoted") or [] if isinstance(p, dict)]
        exp["knowledge_path"] = meta.get("knowledge_path") if isinstance(meta.get("knowledge_path"), str) else None
        exp["links"] = _norm_links(meta.get("links"))
        exp["questions"] = _norm_questions(meta.get("questions"))
        if deep and path.name == EXPLORATION_FILE:
            from . import deep as deep_files

            exp.update(deep_files.summary(path.parent, exp))
        return exp, content[end + 5:]

    def _save(self, exp: Dict[str, Any], body: str, now: datetime) -> Dict[str, Any]:
        path = self._path(exp["id"])
        exp["updated_at"] = iso_s(now)
        exp["version"] = int(exp.get("version") or 0) + 1
        head = yaml.safe_dump({k: exp.get(k) for k in FIELDS}, sort_keys=False, allow_unicode=True, default_flow_style=False)
        for d in (self.dir, path.parent):
            d.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(d, 0o700)
            except OSError:
                pass
        atomic_write(path, f"---\n{head}---\n{body}")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return exp

    def _open(self, exp_id: str) -> Tuple[Dict[str, Any], str]:
        loaded = self._load(self.migrate(exp_id))
        if loaded is None:
            raise ExplorationNotFound(exp_id)
        return loaded

    # ---------------------------------------------------------------- reads

    def get(self, exp_id: str) -> Optional[Dict[str, Any]]:
        loaded = self._load(self.migrate(exp_id))
        return loaded[0] if loaded else None

    def require(self, exp_id: str) -> Dict[str, Any]:
        exp = self.get(exp_id)
        if exp is None:
            raise ExplorationNotFound(exp_id)
        return exp

    def body(self, exp_id: str) -> str:
        return self._open(exp_id)[1]

    def ids(self) -> List[str]:
        """Every exploration id on disk (directories and legacy flat files), sorted."""
        found: Set[str] = set()
        try:
            for p in self.dir.glob(f"exp-*/{EXPLORATION_FILE}"):
                if EXP_ID_RE.match(p.parent.name):
                    found.add(p.parent.name)
            for p in self.dir.glob("exp-*.md"):
                if EXP_ID_RE.match(p.stem):
                    found.add(p.stem)
        except OSError:
            pass
        return sorted(found)

    def load_all(self) -> List[Dict[str, Any]]:
        out = []
        for exp_id in self.ids():
            loaded = self._load(self.migrate(exp_id))
            if loaded:
                out.append(loaded[0])
        return out

    def list(self, status: str = "active", limit: int = 100) -> List[Dict[str, Any]]:
        if status not in ("active", "archived", "all"):
            raise ExplorationError("status must be active, archived or all")
        items = self.load_all()
        if status != "all":
            items = [e for e in items if e["status"] == status]
        items.sort(key=lambda e: (str(e.get("last_touched_at") or e.get("updated_at") or ""), e["id"]), reverse=True)
        return items[: max(0, limit)]

    def nodes(self, exp_id: str) -> List[Dict[str, Any]]:
        return self.require(exp_id)["nodes"]

    def node(self, exp_id: str, node_id: str) -> Dict[str, Any]:
        return _find(self.require(exp_id), node_id)

    def conversation(self, exp_id: str, node_id: str = ROOT) -> List[Dict[str, Any]]:
        """A node's parsed log: [{role, content, timestamp, metadata}]."""
        exp, text = self._open(exp_id)
        _find(exp, node_id)
        return conversation_of(exp, text, node_id)

    def conversations(self, exp_id: str) -> Tuple[Dict[str, Any], Dict[str, List[Dict[str, Any]]]]:
        """The exploration plus every log node's conversation, parsed once."""
        exp, text = self._open(exp_id)
        return exp, all_conversations(exp, text)

    # ---------------------------------------------------------------- writes

    def create(self, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        seed = _clip(body.get("seed"), MAX_SEED) if body.get("seed") is not None else ""
        if body.get("seed") is not None and not isinstance(body.get("seed"), str):
            raise ExplorationError("seed must be a string")
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            raise ExplorationError("title must be a string")
        title = _clip(title, MAX_TITLE) if title and title.strip() else (plain_title(seed, 80) or "")
        if not title:
            raise ExplorationError("title or seed is required")
        origin = body.get("origin") or {"kind": "cockpit", "ref": None}
        if not isinstance(origin, dict) or origin.get("kind") not in ORIGIN_KINDS:
            raise ExplorationError(f"origin.kind must be one of {', '.join(ORIGIN_KINDS)}")
        origin = {"kind": origin["kind"], "ref": origin.get("ref") if isinstance(origin.get("ref"), str) else None}
        serves = _str_list("serves", body.get("serves"))
        page = body.get("page")
        if page is not None:
            if not isinstance(page, str):
                raise ExplorationError("page must be a string")
            if len(page.encode("utf-8")) > MAX_PAGE_BYTES:
                raise ExplorationError("page is larger than 1 MB")
        exp_id = body.get("id") or new_exploration_id()
        if self.exists(exp_id):
            raise ExplorationError(f"exploration {exp_id} already exists")
        exp = {k: None for k in FIELDS}
        exp.update({
            "id": exp_id,
            "workspace": str(self.workspace),
            "title": title,
            "status": "active",
            "seed": seed or None,
            "origin": origin,
            "session_id": session_id_for(exp_id),
            "turns": 0,
            "created_at": iso_s(now),
            "last_touched_at": iso_s(now),
            "version": 0,
            "active_node": ROOT,
            "serves": serves,
            "promoted": [],
            "knowledge_path": None,
            "links": _norm_links(body.get("links")),
            "questions": [],
        })
        exp["nodes"] = [root_node(exp)]
        text = f"# {title}\n\n## Seed\n\n{seed or '(none)'}\n\n{LOG_HEADING}\n"
        self._save(exp, text, now)
        self._ensure_page(exp_id, page or "")
        return self.require(exp_id)

    def patch(self, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        exp, text = self._open(exp_id)
        unknown = set(body) - {"title", "status", "serves", "active_node"}
        if unknown:
            raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
        if "title" in body:
            if not isinstance(body["title"], str) or not body["title"].strip():
                raise ExplorationError("title must be a non-empty string")
            text = _retitle(exp, text, _clip(body["title"], MAX_TITLE))
        if "status" in body:
            if body["status"] not in STATUSES:
                raise ExplorationError("status must be active or archived")
            if body["status"] != exp["status"]:
                exp["status"] = body["status"]
                exp["archived_at"] = iso_s(now) if body["status"] == "archived" else None
        if "serves" in body:
            exp["serves"] = _str_list("serves", body["serves"])
        if "active_node" in body:
            exp["active_node"] = _find(exp, body["active_node"])["id"]
        return self._save(exp, text, now)

    def record_turn(
        self,
        exp_id: str,
        user: Optional[str],
        assistant: Optional[str],
        node_id: str = ROOT,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Append one exchange to a node's log (the root's is ``## Log``) and touch the exploration."""
        if isinstance(node_id, datetime):  # the v-now signature took ``now`` fourth
            node_id, now = ROOT, node_id
        now = now or utc_now()
        exp, text = self._open(exp_id)
        node = _find(exp, node_id)
        if node["kind"] not in LOG_KINDS:
            raise ExplorationError(f"a {node['kind']} node has no log")
        stamp = iso_s(now)
        add = _turn_text(user, assistant, stamp)
        if not add:
            return exp
        lines = text.split("\n")
        root_end, sections = _node_sections(lines, (n["id"] for n in exp["nodes"] if n["id"] != ROOT))
        if node_id == ROOT:
            root_part = "\n".join(lines[:root_end])
            rest = "\n".join(lines[root_end:])
            if LOG_HEADING not in lines[:root_end]:
                root_part = root_part.rstrip("\n") + f"\n\n{LOG_HEADING}\n"
            root_part = root_part.rstrip("\n") + "\n" + add
            text = root_part + ("\n" + rest.lstrip("\n") if rest.strip() else "")
        elif node_id in sections:
            start, end = sections[node_id]
            section = "\n".join(lines[start:end]).rstrip("\n") + "\n" + add
            after = "\n".join(lines[end:])
            text = "\n".join(lines[:start]) + "\n" + section + ("\n" + after if after.strip() else "")
        else:
            text = text.rstrip("\n") + f"\n\n{_node_heading(node_id, node['label'])}\n" + add
        node["turns"] = int(node.get("turns") or 0) + 1
        exp["turns"] = int(exp.get("turns") or 0) + 1
        exp["last_touched_at"] = stamp
        if exp["status"] == "archived":
            exp["status"], exp["archived_at"] = "active", None
        return self._save(exp, text, now)

    def touch(self, exp_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        exp, text = self._open(exp_id)
        exp["last_touched_at"] = iso_s(now)
        return self._save(exp, text, now)

    # ---------------------------------------------------------------- nodes

    def add_node(
        self,
        exp_id: str,
        parent: Optional[str],
        label: Any,
        kind: str = "thought",
        mode: Optional[str] = None,
        extra: Optional[Dict[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        now = now or utc_now()
        exp, text = self._open(exp_id)
        node = self._new_node(exp, parent or ROOT, label, kind, mode, extra, now)
        exp["active_node"] = node["id"] if kind in LOG_KINDS else exp.get("active_node") or ROOT
        exp["last_touched_at"] = iso_s(now)
        self._save(exp, text, now)
        return node

    def _new_node(self, exp, parent_id, label, kind, mode, extra, now) -> Dict[str, Any]:
        if kind not in NODE_KINDS:
            raise ExplorationError(f"kind must be one of {', '.join(NODE_KINDS)}")
        if mode is not None and mode not in MODES:
            raise ExplorationError(f"mode must be one of {', '.join(MODES)}")
        if not isinstance(label, str) or not label.strip():
            raise ExplorationError("label must be a non-empty string")
        if kind not in LOG_KINDS and not (extra and isinstance(extra.get(kind), dict)):
            raise ExplorationError(f"use the {kind} route to add a {kind} node")
        parent = _find(exp, parent_id)
        if kind == "evidence":
            if parent["kind"] != "spike":
                raise ExplorationError("evidence goes under a spike")
        elif parent["kind"] in ("spike", "evidence"):
            raise ExplorationError(f"a {parent['kind']} node cannot have children")
        ids = {n["id"] for n in exp["nodes"]}
        nid = new_node_id()
        while nid in ids:
            nid = new_node_id()
        node = {
            "id": nid, "parent": parent["id"], "label": _one_line(label, MAX_LABEL), "kind": kind,
            "mode": (mode or "ideate") if kind in LOG_KINDS else None,
            "collapsed": False, "pruned": False, "created_at": iso_s(now), "turns": 0,
        }
        for key in ("decision", "spike", "evidence"):
            if extra and isinstance(extra.get(key), dict):
                node[key] = copy.deepcopy(extra[key])
        exp["nodes"].append(node)
        return node

    def patch_node(self, exp_id: str, node_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """PATCH a node: {label?, collapsed?, reason?} (``reason`` only on decisions)."""
        now = now or utc_now()
        exp, text = self._open(exp_id)
        node = _find(exp, node_id)
        unknown = set(body) - {"label", "collapsed", "reason", "mode"}
        if unknown:
            raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
        if "reason" in body:
            if node["kind"] != "decision":
                raise ExplorationError("reason is only on decision nodes")
            node["decision"] = dict(node.get("decision") or {}, reason=_opt_reason(body["reason"]))
        if "collapsed" in body:
            if not isinstance(body["collapsed"], bool):
                raise ExplorationError("collapsed must be a boolean")
            node["collapsed"] = body["collapsed"]
        if "mode" in body:
            if node["kind"] not in LOG_KINDS or body["mode"] not in MODES:
                raise ExplorationError(f"mode must be one of {', '.join(MODES)} on a thought or source node")
            node["mode"] = body["mode"]
        if "label" in body:
            if not isinstance(body["label"], str) or not body["label"].strip():
                raise ExplorationError("label must be a non-empty string")
            if node_id == ROOT:
                text = _retitle(exp, text, _clip(body["label"], MAX_TITLE))
            else:
                node["label"] = _one_line(body["label"], MAX_LABEL)
                text = _rename_section(exp, text, node)
        self._save(exp, text, now)
        return node

    def rename_node(self, exp_id: str, node_id: str, label: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        return self.patch_node(exp_id, node_id, {"label": label}, now)

    def set_collapsed(self, exp_id: str, node_id: str, collapsed: bool, now: Optional[datetime] = None) -> Dict[str, Any]:
        return self.patch_node(exp_id, node_id, {"collapsed": collapsed}, now)

    # ---------------------------------------------------------------- decisions

    def decide(self, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """A decision node: {text, parent?, chosen?, pruned?, reason?}. Marks ``pruned`` nodes."""
        now = now or utc_now()
        exp, text = self._open(exp_id)
        node = self._decide(exp, body, now)
        exp["last_touched_at"] = iso_s(now)
        self._save(exp, text, now)
        return node

    def _decide(self, exp: Dict[str, Any], body: Dict[str, Any], now: datetime, auto: bool = False) -> Dict[str, Any]:
        dtext = body.get("text")
        if not isinstance(dtext, str) or not dtext.strip():
            raise ExplorationError("text must be a non-empty string")
        chosen = _str_list("chosen", body.get("chosen"))
        pruned = _str_list("pruned", body.get("pruned"))
        for nid in chosen + pruned:
            _find(exp, nid)
        if ROOT in pruned:
            raise ExplorationError("the root cannot be pruned")
        parent = _find(exp, body.get("parent") or ROOT)
        by_id = {n["id"]: n for n in exp["nodes"]}
        while parent["kind"] in ("spike", "evidence") and parent["parent"]:
            parent = by_id[parent["parent"]]
        decision = {"text": _clip(dtext, MAX_DECISION_TEXT), "chosen": chosen, "pruned": pruned, "reason": _opt_reason(body.get("reason"))}
        if auto:
            decision["auto"] = True
        label = _one_line(dtext, 120)
        node = self._new_node(exp, parent["id"], label, "decision", None, {"decision": decision}, now)
        for nid in pruned:
            by_id[nid]["pruned"] = True
        return node

    def prune(self, exp_id: str, node_id: str, reason: Optional[str] = None, now: Optional[datetime] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """``decide`` with ``pruned=[node]`` under the node's parent. Returns (node, decision)."""
        exp = self.require(exp_id)
        node = _find(exp, node_id)
        if node_id == ROOT:
            raise ExplorationError("the root cannot be pruned")
        decision = self.decide(exp_id, {
            "text": f"Pruned: {node['label']}", "parent": node["parent"], "pruned": [node_id], "reason": reason,
        }, now)
        return self.node(exp_id, node_id), decision

    # ---------------------------------------------------------------- spikes

    def add_spike(self, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """A spike node (status pending): {parent?, prompt, title?, timebox_min=30}."""
        now = now or utc_now()
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ExplorationError("prompt must be a non-empty string")
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            raise ExplorationError("title must be a string")
        timebox = body.get("timebox_min", DEFAULT_TIMEBOX_MIN)
        if timebox is not None and (isinstance(timebox, bool) or not isinstance(timebox, int) or timebox < 0):
            raise ExplorationError("timebox_min must be a non-negative integer or null")
        label = (title or "").strip() or plain_title(prompt, 80) or "Spike"
        spike = {
            "prompt": _clip(prompt, MAX_PROMPT), "task_id": None, "status": "pending", "timebox_min": timebox,
            "worktree": None, "started_at": None, "ended_at": None,
        }
        return self.add_node(exp_id, body.get("parent") or ROOT, label, "spike", None, {"spike": spike}, now)

    def update_spike(self, exp_id: str, node_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        exp, text = self._open(exp_id)
        node = _find(exp, node_id)
        if node["kind"] != "spike":
            raise ExplorationError(f"{node_id} is not a spike")
        unknown = set(body) - {"task_id", "status", "worktree", "started_at", "ended_at"}
        if unknown:
            raise ExplorationError(f"cannot patch {', '.join(sorted(unknown))}")
        spike = dict(node.get("spike") or {})
        if "task_id" in body:
            if body["task_id"] is not None and not isinstance(body["task_id"], str):
                raise ExplorationError("task_id must be a string or null")
            spike["task_id"] = body["task_id"] or None
        if "worktree" in body:
            spike["worktree"] = _worktree(body["worktree"])
        for key in ("started_at", "ended_at"):
            if key in body:
                if body[key] is not None and not isinstance(body[key], str):
                    raise ExplorationError(f"{key} must be a string or null")
                spike[key] = body[key]
        if "status" in body:
            if body["status"] not in SPIKE_STATUSES:
                raise ExplorationError(f"status must be one of {', '.join(SPIKE_STATUSES)}")
            spike["status"] = body["status"]
            if body["status"] == "running" and not spike.get("started_at"):
                spike["started_at"] = iso_s(now)
            if body["status"] in ("done", "discarded", "failed") and not spike.get("ended_at"):
                spike["ended_at"] = iso_s(now)
        node["spike"] = spike
        exp["last_touched_at"] = iso_s(now)
        self._save(exp, text, now)
        return node

    def add_evidence(self, exp_id: str, spike_node_id: str, evidence: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
        """The spike's evidence node, replaced in place when it already has one."""
        now = now or utc_now()
        exp, text = self._open(exp_id)
        spike = _find(exp, spike_node_id)
        if spike["kind"] != "spike":
            raise ExplorationError(f"{spike_node_id} is not a spike")
        summary = evidence.get("summary")
        label = f"Evidence: {plain_title(summary, 60)}" if summary and plain_title(summary, 60) else "Evidence"
        existing = next((n for n in exp["nodes"] if n["kind"] == "evidence" and n["parent"] == spike_node_id), None)
        if existing is not None:
            existing["evidence"] = copy.deepcopy(evidence)
            existing["label"] = label
            node = existing
        else:
            node = self._new_node(exp, spike_node_id, label, "evidence", None, {"evidence": evidence}, now)
        exp["last_touched_at"] = iso_s(now)
        self._save(exp, text, now)
        return node

    # ---------------------------------------------------------------- promotes / archive bookkeeping

    def record_promote(
        self, exp_id: str, to: str, ref: str, node_ids: Optional[List[str]], now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Append to ``promoted`` and add a ``Promoted to <to>: <ref>`` decision node."""
        now = now or utc_now()
        exp, text = self._open(exp_id)
        exp["promoted"] = list(exp.get("promoted") or []) + [{"to": to, "ref": ref, "at": iso_s(now), "node_ids": node_ids}]
        self._decide(exp, {"text": f"Promoted to {to}: {ref}", "chosen": [n for n in (node_ids or []) if n != ROOT]}, now, auto=True)
        exp["last_touched_at"] = iso_s(now)
        return self._save(exp, text, now)

    def set_knowledge(self, exp_id: str, knowledge_path: str, now: Optional[datetime] = None) -> Dict[str, Any]:
        now = now or utc_now()
        exp, text = self._open(exp_id)
        exp["knowledge_path"] = knowledge_path
        if exp["status"] != "archived":
            exp["status"], exp["archived_at"] = "archived", iso_s(now)
        return self._save(exp, text, now)

    # ---------------------------------------------------------------- outline

    def outline(self, exp_id: str, node_ids: Optional[List[str]] = None) -> str:
        return render_outline(self.require(exp_id), node_ids)

    # ---------------------------------------------------------------- seeding

    def context_text(self, exp_id: str, limit: int = CONTEXT_CHARS) -> str:
        """System-message seed for the deep-dive session: the file, newest log kept."""
        exp = self.require(exp_id)
        text = self.body(exp_id).strip()
        if len(text) > limit:
            text = "…(earlier log omitted)…\n" + text[-limit:]
        return (
            "You are Hester in an Explore deep dive with the user: an open-ended, "
            "thinking-out-loud investigation, not a task to finish. Build on what is "
            "already written, raise options and trade-offs, and ask what to dig into "
            f"next. The exploration is titled \"{exp['title']}\" and lives at "
            f".hester/explore/{exp_id}/exploration.md in the workspace; each exchange here is "
            "appended to its Log automatically.\n\n"
            "The exploration so far:\n\n" + text
        )

    def node_context_text(self, exp_id: str, node_id: str, limit: int = CONTEXT_CHARS) -> str:
        """System-message seed for a Library node chat: breadcrumb plus the node's log tail."""
        exp, convs = self.conversations(exp_id)
        node = _find(exp, node_id)
        crumb = breadcrumb(exp, convs, node_id)
        log = "\n\n".join(
            f"{'You' if m['role'] == 'user' else 'Hester'}: {m['content']}" for m in convs.get(node_id, [])
        )
        if len(log) > limit:
            log = "…(earlier log omitted)…\n" + log[-limit:]
        return (
            "You are Hester in the Library, exploring one branch of an exploration tree with the user. "
            f"The exploration is \"{exp['title']}\" (.hester/explore/{exp_id}/exploration.md); this branch is "
            f"\"{node['label']}\". Each exchange here is appended to the file automatically.\n\n"
            f"Path to this branch: {crumb or node['label']}\n\n"
            + (f"This branch so far:\n\n{log}" if log else "This branch has no conversation yet.")
        )


# ---------------------------------------------------------------------------
# Helpers on a loaded exploration
# ---------------------------------------------------------------------------


def _find(exp: Dict[str, Any], node_id: Any) -> Dict[str, Any]:
    for n in exp["nodes"]:
        if n["id"] == node_id:
            return n
    raise ExplorationNotFound(f"{exp['id']}/{node_id}")


def _worktree(value: Any) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ExplorationError("worktree must be an object or null")
    return {k: (str(value[k]) if value.get(k) is not None else None) for k in ("slug", "path", "branch")}


def _retitle(exp: Dict[str, Any], text: str, title: str) -> str:
    """Rename the exploration: title, the root node's label and the ``# <title>`` line."""
    exp["title"] = title
    exp["nodes"][0]["label"] = title
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("# "):
            lines[i] = f"# {_one_line(title, MAX_TITLE)}"
            break
        if line.startswith("## "):
            break
    return "\n".join(lines)


def _rename_section(exp: Dict[str, Any], text: str, node: Dict[str, Any]) -> str:
    lines = text.split("\n")
    _, sections = _node_sections(lines, (n["id"] for n in exp["nodes"] if n["id"] != ROOT))
    if node["id"] in sections:
        lines[sections[node["id"]][0]] = _node_heading(node["id"], node["label"])
    return "\n".join(lines)


def all_conversations(exp: Dict[str, Any], text: str) -> Dict[str, List[Dict[str, Any]]]:
    lines = text.split("\n")
    root_end, sections = _node_sections(lines, (n["id"] for n in exp["nodes"] if n["id"] != ROOT))
    out = {ROOT: parse_messages(_root_log_lines(lines[:root_end]))}
    for n in exp["nodes"]:
        if n["id"] != ROOT and n["kind"] in LOG_KINDS:
            start, end = sections.get(n["id"], (0, 0))
            out[n["id"]] = parse_messages(lines[start + 1:end]) if end else []
    return out


def conversation_of(exp: Dict[str, Any], text: str, node_id: str) -> List[Dict[str, Any]]:
    return all_conversations(exp, text).get(node_id, [])


def children_of(exp: Dict[str, Any]) -> Dict[str, List[str]]:
    kids: Dict[str, List[str]] = {n["id"]: [] for n in exp["nodes"]}
    for n in exp["nodes"]:
        if n["parent"] in kids:
            kids[n["parent"]].append(n["id"])
    return kids


def subtree_ids(exp: Dict[str, Any], node_ids: Iterable[str]) -> List[str]:
    """The given nodes and all their descendants, in file order."""
    kids = children_of(exp)
    keep: Set[str] = set()
    stack = [n for n in node_ids if n in kids]
    while stack:
        nid = stack.pop()
        if nid in keep:
            continue
        keep.add(nid)
        stack.extend(kids[nid])
    return [n["id"] for n in exp["nodes"] if n["id"] in keep]


def breadcrumb(exp: Dict[str, Any], convs: Dict[str, List[Dict[str, Any]]], node_id: str) -> str:
    """Root > ... > node, each with the first line of its first answer (≤ 200 chars)."""
    by_id = {n["id"]: n for n in exp["nodes"]}
    chain = []
    cur = by_id.get(node_id)
    while cur is not None:
        chain.append(cur)
        cur = by_id.get(cur["parent"]) if cur["parent"] else None
    parts = []
    for n in reversed(chain):
        summary = n["label"]
        first = next((m["content"] for m in convs.get(n["id"], []) if m["role"] == "assistant"), None)
        if first:
            summary += f": {first[:200]}"
        parts.append(summary)
    return " > ".join(parts)


def outline_line(n: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> str:
    labels = lambda ids: ", ".join(by_id[i]["label"] if i in by_id else i for i in ids)  # noqa: E731
    kind = n["kind"]
    if kind == "decision":
        d = n.get("decision") or {}
        s = f"Decision: {_one_line(d.get('text'), 300)}"
        if d.get("chosen"):
            s += f"; chose: {labels(d['chosen'])}"
        if d.get("pruned"):
            s += f"; pruned: {labels(d['pruned'])}"
        if d.get("reason"):
            s += f"; reason: {_one_line(d['reason'], 300)}"
        return s
    if kind == "spike":
        sp = n.get("spike") or {}
        s = f"Spike [{sp.get('status') or 'pending'}]: {n['label']}"
        if sp.get("task_id"):
            s += f" (task {sp['task_id']})"
        if sp.get("timebox_min"):
            s += f", timebox {sp['timebox_min']} min"
        return s
    if kind == "evidence":
        ev = n.get("evidence") or {}
        s = f"Evidence (agent's claim): {_one_line(ev.get('summary') or '(no summary)', 300)}"
        stat = (ev.get("diffstat") or "").strip().splitlines()
        if stat:
            s += f"; {stat[-1].strip()}"
        if ev.get("commits"):
            s += f"; {len(ev['commits'])} commit(s)"
        if ev.get("diff_path"):
            s += f"; diff: {ev['diff_path']}"
        return s
    label = f"~~{n['label']}~~ (pruned)" if n.get("pruned") else n["label"]
    if kind != "thought":
        label += f" [{kind.replace('_', ' ')}]"
    return label


def render_outline(exp: Dict[str, Any], node_ids: Optional[List[str]] = None) -> str:
    """Deterministic markdown outline of the tree (or of ``node_ids``' subtrees and their decisions)."""
    by_id = {n["id"]: n for n in exp["nodes"]}
    kids = children_of(exp)
    if node_ids:
        include = set(subtree_ids(exp, [n for n in node_ids if n in by_id]))
        for n in exp["nodes"]:
            d = n.get("decision") or {}
            if n["kind"] == "decision" and include.intersection((d.get("chosen") or []) + (d.get("pruned") or [])):
                include.add(n["id"])
    else:
        include = set(by_id)
    lines = [f"Exploration: {exp['title']} ({exp['id']})", ""]

    def walk(nid: str, depth: int) -> None:
        n = by_id[nid]
        here = nid in include
        if here:
            lines.append(f"{'  ' * depth}- {outline_line(n, by_id)}")
        for child in kids.get(nid, []):
            walk(child, depth + 1 if here else depth)

    walk(ROOT, 0)
    return "\n".join(lines).rstrip() + "\n"


def to_api(exp: Dict[str, Any]) -> Dict[str, Any]:
    data = {k: copy.deepcopy(exp.get(k)) for k in FIELDS}
    data["links"] = data.get("links") or []
    data["questions"] = data.get("questions") or []
    for k in DEEP_FIELDS:
        data[k] = copy.deepcopy(exp.get(k))
    for k in ("page_chars", "answers_unread", "answers_pending", "open_questions"):
        data[k] = int(data[k] or 0)
    return data


def to_api_with_conversations(exp: Dict[str, Any], text: str) -> Dict[str, Any]:
    """GET /cockpit/explorations/{id}: nodes each carry ``conversation`` (thought/source nodes)."""
    data = to_api(exp)
    convs = all_conversations(exp, text)
    for n in data["nodes"]:
        if n["kind"] in LOG_KINDS:
            n["conversation"] = convs.get(n["id"], [])
    return data


# ---------------------------------------------------------------------------
# Deep-dive sessions: seed on open, write back after each turn
# ---------------------------------------------------------------------------

# Workspace of each deep-dive session opened since the daemon started.
_session_workspaces: Dict[str, Path] = {}
_session_manager_getter = None


def configure_sessions(getter) -> None:
    """Give the store the daemon's Hester SessionManager (a zero-arg getter; main.py)."""
    global _session_manager_getter
    _session_manager_getter = getter


def _sessions():
    return _session_manager_getter() if _session_manager_getter else None


async def open_session(store: ExplorationStore, exp_id: str) -> Dict[str, Any]:
    """Make sure ``explore-<id>`` exists and is seeded from the file. Returns {session_id, seeded}."""
    exp = store.require(exp_id)
    sid = exp.get("session_id") or session_id_for(exp_id)
    _session_workspaces[sid] = store.workspace
    manager = _sessions()
    if manager is None:
        return {"session_id": sid, "seeded": False}
    session = await manager.get(sid)
    if session is not None:
        return {"session_id": sid, "seeded": False}
    session = await manager.create(sid, str(store.workspace))
    session.add_message("system", store.context_text(exp_id))
    lines = [f"**Exploring: {exp['title']}**"]
    if exp.get("seed"):
        lines.append(str(exp["seed"]))
    if int(exp.get("turns") or 0) > 0:
        lines.append(f"_{exp['turns']} earlier exchange(s) are in .hester/explore/{exp_id}/exploration.md; I have them in context._")
    lines.append("Where do you want to start?")
    session.add_message("assistant", "\n\n".join(lines))
    await manager.save(session)
    return {"session_id": sid, "seeded": True}


async def open_node_session(store: ExplorationStore, exp_id: str, node_id: str) -> Dict[str, Any]:
    """Make sure ``library-<id>-<node>`` exists, seeded from the file when missing."""
    store.require(exp_id)
    sid = node_session_id(exp_id, node_id)
    manager = _sessions()
    if manager is None:
        return {"session_id": sid, "seeded": False}
    if await manager.get(sid) is not None:
        return {"session_id": sid, "seeded": False}
    session = await manager.create(sid, str(store.workspace))
    session.add_message("system", store.node_context_text(exp_id, node_id))
    await manager.save(session)
    return {"session_id": sid, "seeded": True}


def _workspace_for_session(session_id: str, exp_id: str, working_directory: Optional[str]) -> Optional[Path]:
    ws = _session_workspaces.get(session_id)
    if ws is not None:
        return ws
    if working_directory:
        cand = Path(working_directory)
        d = cand / ".hester" / "explore"
        if (d / exp_id / EXPLORATION_FILE).exists() or (d / f"{exp_id}.md").exists():
            return cand
    return None


async def record_session_turn_locked(session_id: Any, working_directory: Optional[str], user: Optional[str], assistant: Optional[str]) -> bool:
    """``record_session_turn`` under the workspace's lock, so it can't race spike syncs or routes. Never raises."""
    exp_id = exploration_id_from_session(session_id)
    if exp_id is None:
        return False
    ws = _workspace_for_session(session_id, exp_id, working_directory)
    if ws is None:
        return False
    try:
        from ..workspaces.registry import get_registry

        ctx = get_registry().get(ws, source="request")
    except Exception:
        ctx = None
    if ctx is None:
        return record_session_turn(session_id, working_directory, user, assistant)
    async with ctx.lock:
        return record_session_turn(session_id, working_directory, user, assistant)


def record_session_turn(session_id: Any, working_directory: Optional[str], user: Optional[str], assistant: Optional[str]) -> bool:
    """Write a finished deep-dive turn back to its exploration. Never raises."""
    exp_id = exploration_id_from_session(session_id)
    if exp_id is None:
        return False
    try:
        ws = _workspace_for_session(session_id, exp_id, working_directory)
        if ws is None:
            return False
        ExplorationStore(ws).record_turn(exp_id, user, assistant)
        return True
    except Exception as e:  # write-back must never break a chat turn
        logger.warning(f"Explore write-back failed for {session_id}: {e}")
        return False
