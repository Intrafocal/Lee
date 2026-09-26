"""
Steward mode (copilot v4, contract section 5).

Every steward answer is a user action (C1/C2): a request handler calls the
agent's ``process_context`` with a ``surface`` and a ``steward_context``.
Steer surfaces layer ``registries/prompts/steward.md`` on the system prompt
when the steward is on for the workspace (``hester.steward`` in
``.lee/config.yaml``, default on, and not quieted for today).

Deterministic parts live here too: on/off state, ask/steer classification,
``lee-proposals`` / ``lee-steer`` block parsing, proposal storage, GOALS.md
drafts (diff and explicit apply). Nothing here sends text to a tab and
nothing writes GOALS.md except ``apply_draft``.
"""

import asyncio
import difflib
import hashlib
import json
import logging
import os
import re
import secrets
import tempfile
import textwrap
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import yaml

from ..copilot.event_reader import iso, parse_ts
from .tasks import KINDS, LEADS, atomic_write, is_open

logger = logging.getLogger("hester.daemon.cockpit.steward")

SURFACES = ("launch-suggest", "what-next", "evaluate", "lint-ask", "rail-steer", "rail-ask", "goal-edit", "palette", "tui")
STEER_SURFACES = frozenset({"launch-suggest", "what-next", "evaluate", "lint-ask", "rail-steer", "goal-edit"})
ABOUT_KINDS = ("task", "exploration", "goal", "lint", "feed", "tile", "operation")
STEER_PREFIXES = (
    "keep going", "continue", "go ahead", "stop", "wait", "tell it", "tell the agent", "ask it", "ask the agent",
    "have it", "get it to", "start", "now", "please", "instead", "don't", "do not", "switch to", "focus on",
)
# Each prefix must end at a word boundary ("stop now" steers, "Stopwatch?" asks).
_STEER_RE = re.compile(r"^(?:" + "|".join(re.escape(p) for p in STEER_PREFIXES) + r")\b")
# A question ("...?") steers only when it asks to relay something to the agent.
_QUESTION_STEER_RE = re.compile(
    r"^(?:(?:can|could|would|will) you (?:please )?|please )?"
    r"(?:tell it|tell the agent|ask it|ask the agent|have it|get it to)\b"
)
# Tools a steward call may use: observe and read only. No writes (files, docs,
# GOALS.md), no bash or git writes, devops, ui_control, tab input or task
# orchestration. The agent enforces it at declaration and at call time.
STEWARD_TOOLS: Tuple[str, ...] = (
    "read_file", "search_files", "search_content", "list_directory",
    "git_status", "git_diff", "git_log", "git_branch",
    "semantic_doc_search", "get_context_bundle", "list_context_bundles",
    "cockpit_tasks", "knowledge_notes", "lee_tabs", "lee_tab_read", "lee_operations", "lee_operation_result",
)
RAIL_STEER_INSTRUCTION = (
    "The user wants to steer the agent working on this task. End with a fenced `lee-steer` block holding "
    "exactly the text to type into the agent's terminal, written to the agent, and nothing after it. "
    "It will be shown to the user before anything is sent."
)

PROMPT_PATH = Path(__file__).resolve().parent.parent / "registries" / "prompts" / "steward.md"
STATE_FILE = Path(".hester") / "cockpit" / "steward.json"
PROPOSALS_FILE = Path(".hester") / "cockpit" / "proposals.jsonl"
DRAFTS_DIR = Path(".hester") / "goals" / "drafts"
EVALUATIONS_DIR = Path(".hester") / "goals" / "evaluations"

MAX_PROPOSALS = 5
MAX_LABEL = 80
MAX_PARAM_TEXT = 4000
MAX_STEER = 2000
MAX_CONTEXT = 24000
MAX_QUESTION = 4000

OPEN_KINDS = ("task", "exploration", "goal", "workstream")
# action -> (required params, allowed params)
PROPOSAL_PARAMS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "create_task": (("title",), ("title", "serves", "lead", "kind")),
    "launch": (("prompt",), ("prompt", "lead", "kind", "serves", "title")),
    "link_goal": (("task_id", "serves"), ("task_id", "serves")),
    "set_lead": (("task_id", "lead"), ("task_id", "lead")),
    "park": (("text",), ("text",)),
    "open": (("kind", "id"), ("kind", "id")),
    "run_op": (("name",), ("name",)),
    "explore": (("seed",), ("seed",)),
}
PROPOSAL_ID_RE = re.compile(r"^prop-[0-9a-f]{8}$")
DRAFT_ID_RE = re.compile(r"^draft-\d{8}T\d{6}-[0-9a-f]{4}$")

_PROPOSALS_BLOCK_RE = re.compile(r"```lee-proposals[^\n]*\n(.*?)(?:```|\Z)", re.DOTALL)
_STEER_BLOCK_RE = re.compile(r"```lee-steer[^\n]*\n(.*?)(?:```|\Z)", re.DOTALL)
_FENCE_RE = re.compile(r"```([A-Za-z0-9_-]*)[^\n]*\n(.*?)```", re.DOTALL)


class StewardError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_request_id() -> str:
    return f"st-{secrets.token_hex(6)}"


# ---------------------------------------------------------------------------
# On / off
# ---------------------------------------------------------------------------


def config_enabled(config: Any) -> bool:
    """``hester.steward: on | off`` (YAML may read these as booleans); default on."""
    block = config.get("hester") if isinstance(config, dict) else None
    value = block.get("steward") if isinstance(block, dict) else None
    if value is None:
        return True
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("off", "false", "no", "0", "disabled")
    if isinstance(value, dict):
        return config_enabled({"hester": {"steward": value.get("enabled")}})
    return True


def next_local_midnight(now: datetime) -> datetime:
    local = now.astimezone()
    midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(timezone.utc)


def _read_state(workspace: Path) -> Dict[str, Any]:
    try:
        data = json.loads((Path(workspace) / STATE_FILE).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def state(workspace: Path, config: Any, now: Optional[datetime] = None) -> Dict[str, Any]:
    """``{enabled, not_today_until, active}``."""
    now = now or utc_now()
    enabled = config_enabled(config)
    until = parse_ts(_read_state(workspace).get("not_today_until"))
    if until is not None and until <= now:
        until = None
    return {"enabled": enabled, "not_today_until": iso(until) if until else None, "active": bool(enabled and until is None)}


def set_not_today(workspace: Path, config: Any, not_today: bool, now: Optional[datetime] = None) -> Dict[str, Any]:
    now = now or utc_now()
    data = _read_state(workspace)
    data["not_today_until"] = iso(next_local_midnight(now)) if not_today else None
    data["updated_at"] = iso(now)
    atomic_write(Path(workspace) / STATE_FILE, json.dumps(data))
    return state(workspace, config, now)


def is_active(workspace: Path, now: Optional[datetime] = None) -> bool:
    from ..workspaces.registry import get_registry

    try:
        ctx = get_registry().get(workspace, source="request")
        return state(ctx.path, ctx.config(), now)["active"]
    except Exception as e:
        logger.debug(f"steward state unavailable for {workspace}: {e}")
        return False


# ---------------------------------------------------------------------------
# Prompt layering
# ---------------------------------------------------------------------------

_prompt_cache: Dict[str, Any] = {}


def steward_prompt() -> str:
    try:
        st = PROMPT_PATH.stat()
        key = (st.st_mtime_ns, st.st_size)
        if _prompt_cache.get("key") != key:
            _prompt_cache["key"] = key
            _prompt_cache["text"] = PROMPT_PATH.read_text(encoding="utf-8").strip()
        return _prompt_cache["text"]
    except OSError:
        logger.warning(f"steward prompt missing: {PROMPT_PATH}")
        return ""


def prompt_layer(surface: Optional[str], steward_context: Optional[str], active: bool) -> str:
    """
    What goes after the base system prompt: ``steward.md`` (steer surfaces,
    steward active only), the rail-steer instruction, then ``steward_context``.
    ``rail-ask``, ``palette`` and ``tui`` never get ``steward.md``.
    """
    parts: List[str] = []
    if surface in STEER_SURFACES and active:
        text = steward_prompt()
        if text:
            parts.append(text)
    if surface == "rail-steer":
        parts.append(RAIL_STEER_INSTRUCTION)
    if steward_context and steward_context.strip():
        parts.append("## Context for this request\n\n" + steward_context.strip())
    return "\n\n".join(parts)


def prompt_layer_for_request(request: Any, working_dir: Optional[str]) -> str:
    surface = getattr(request, "surface", None)
    context = getattr(request, "steward_context", None)
    if not surface and not context:
        return ""
    active = bool(surface in STEER_SURFACES and working_dir and is_active(Path(working_dir)))
    return prompt_layer(surface, context, active)


# ---------------------------------------------------------------------------
# Ask vs steer
# ---------------------------------------------------------------------------


def live_pty(task: Optional[Dict[str, Any]]) -> Optional[int]:
    if not task or not is_open(task):
        return None
    pty = (task.get("agent") or {}).get("pty_id")
    return pty if isinstance(pty, int) and not isinstance(pty, bool) else None


def classify(question: str, about_kind: Optional[str], task: Optional[Dict[str, Any]]) -> str:
    """'steer' only for a task/tile with a live agent and a question that reads as an instruction to it."""
    if about_kind not in ("task", "tile") or live_pty(task) is None:
        return "ask"
    q = " ".join((question or "").strip().lower().replace("’", "'").split())
    if not q:
        return "ask"
    if q.endswith("?"):
        return "steer" if _QUESTION_STEER_RE.match(q) else "ask"
    return "steer" if (_STEER_RE.match(q) or _QUESTION_STEER_RE.match(q)) else "ask"


# ---------------------------------------------------------------------------
# Answer blocks
# ---------------------------------------------------------------------------


def _items(block: str) -> List[str]:
    """
    The top-level ``- `` items of a block, each as its own dedented one-item
    YAML list (continuation lines keep their relative indentation, so
    block-style mappings and multi-line flow mappings survive).
    """
    items: List[List[str]] = []
    base: Optional[int] = None
    for line in block.splitlines():
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        is_item = line.lstrip().startswith("- ")
        if is_item and (base is None or indent <= base):
            base = indent
            items.append([line])
        elif items and indent > (base or 0):
            items[-1].append(line)
        elif items:
            # a flush-left continuation (e.g. of a flow mapping)
            items[-1].append(" " * ((base or 0) + 2) + line.lstrip())
    return [textwrap.dedent("\n".join(lines)) for lines in items]


# Free-text keys whose unquoted values may carry a colon ("label: Spike: defer mDNS").
_TOLERANT_RE = re.compile(
    r"(?P<key>\b(?:label|title|text|prompt|seed)[ \t]*:[ \t]+)(?![\"'\[{|>])"
    r"(?P<value>[^\n]+?)(?=[ \t]*,[ \t]*[A-Za-z_]+[ \t]*:|[ \t]*\}|[ \t]*$)",
    re.MULTILINE,
)


def _tolerant(text: str) -> str:
    """Quote free-text values; deterministic (a JSON string is a YAML double-quoted scalar)."""
    return _TOLERANT_RE.sub(lambda m: m.group("key") + json.dumps(m.group("value").strip(), ensure_ascii=False), text)


def _load_item(raw: str) -> Any:
    for candidate in (raw, _tolerant(raw)):
        try:
            data = yaml.safe_load(candidate)
        except yaml.YAMLError:
            continue
        if isinstance(data, list) and len(data) == 1:
            data = data[0]
        if isinstance(data, dict):
            return data
    return None


def _proposal_items(block: str) -> List[Any]:
    """The whole block as YAML (block list, flow list, JSON), else item by item with a tolerant retry."""
    try:
        data = yaml.safe_load(block)
    except yaml.YAMLError:
        data = None
    if isinstance(data, dict):
        data = data.get("proposals") if isinstance(data.get("proposals"), list) else [data]
    if isinstance(data, list) and any(isinstance(x, dict) for x in data):
        return data
    return [_load_item(raw) for raw in _items(block)]


def _text_param(value: Any) -> Optional[str]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    return s if len(s) <= MAX_PARAM_TEXT else s[: MAX_PARAM_TEXT - 1] + "…"


def _clean_params(action: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    required, allowed = PROPOSAL_PARAMS[action]
    out: Dict[str, Any] = {}
    for key in allowed:
        if key not in params or params[key] is None:
            continue
        value = params[key]
        if key == "serves":
            if isinstance(value, str):
                value = [value]
            if not isinstance(value, list):
                return None
            value = [str(v).strip() for v in value if isinstance(v, (str, int)) and str(v).strip()]
        elif key == "lead":
            if value not in LEADS:
                return None
        elif key == "kind" and action == "open":
            if value not in OPEN_KINDS:
                return None
        elif key == "kind":
            if value not in KINDS:
                return None
        else:
            value = _text_param(value)
            if value is None:
                return None
        out[key] = value
    if any(k not in out or out[k] in ("", []) for k in required):
        return None
    return out


def parse_proposals(text: str, origin: Optional[Dict[str, Any]] = None) -> Tuple[str, List[Dict[str, Any]]]:
    """
    ``(text without the lee-proposals block, proposals)``. Unknown actions and
    malformed lines are dropped; at most 5 are kept. ``origin`` is added to
    ``create_task`` params (Evaluate: ``{kind: 'goal-eval', ref: gid}``).
    """
    text = text or ""
    blocks = _PROPOSALS_BLOCK_RE.findall(text)
    clean = _PROPOSALS_BLOCK_RE.sub("", text).rstrip()
    proposals: List[Dict[str, Any]] = []
    if not blocks:
        return clean, proposals
    for item in _proposal_items(blocks[-1]):
        if not isinstance(item, dict):
            continue
        action = item.get("action")
        label = item.get("label")
        params = item.get("params") if isinstance(item.get("params"), dict) else ({} if item.get("params") is None else None)
        if action not in PROPOSAL_PARAMS or params is None or not isinstance(label, (str, int)) or not str(label).strip():
            continue
        cleaned = _clean_params(action, params)
        if cleaned is None:
            continue
        if action == "create_task" and origin:
            cleaned["origin"] = dict(origin)
        label = " ".join(str(label).split())
        proposals.append({
            "id": f"prop-{secrets.token_hex(4)}",
            "label": label if len(label) <= MAX_LABEL else label[: MAX_LABEL - 1] + "…",
            "action": action,
            "params": cleaned,
        })
        if len(proposals) >= MAX_PROPOSALS:
            break
    return clean, proposals


def parse_steer(text: str) -> Tuple[str, Optional[str]]:
    """``(text without the lee-steer block, the exact text to type or None)``."""
    text = text or ""
    blocks = _STEER_BLOCK_RE.findall(text)
    clean = _STEER_BLOCK_RE.sub("", text).rstrip()
    if not blocks:
        return clean, None
    steer = blocks[-1].strip()
    if not steer:
        return clean, None
    return clean, steer[:MAX_STEER]


# ---------------------------------------------------------------------------
# Proposals store
# ---------------------------------------------------------------------------


MAX_PROPOSAL_ROWS = 2000
# proposals.jsonl is written from worker threads (asyncio.to_thread); one lock
# for every workspace's file keeps appends and trims whole.
_STORE_LOCK = threading.RLock()


class ProposalStore:
    def __init__(self, workspace: Path, max_rows: int = MAX_PROPOSAL_ROWS):
        self.path = Path(workspace) / PROPOSALS_FILE
        self.max_rows = max_rows

    def _append(self, row: Dict[str, Any]) -> None:
        with _STORE_LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
            self._trim()

    def _trim(self) -> None:
        """Keep the newest ``max_rows`` lines (atomic rewrite, only when over)."""
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
        except OSError:
            return
        if len(lines) <= self.max_rows:
            return
        atomic_write(self.path, "".join(lines[-self.max_rows:]))

    def rows(self) -> List[Dict[str, Any]]:
        out = []
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as f:
                for raw in f:
                    try:
                        row = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(row, dict):
                        out.append(row)
        except OSError:
            pass
        return out

    def record_answer(self, answer: Dict[str, Any], extra: Dict[str, Any], now: datetime) -> None:
        self._append({
            "kind": "answer", "at": iso(now), "request_id": answer["request_id"], "surface": answer["surface"],
            **extra, "text": answer["text"], "proposals": answer["proposals"], "steer": answer.get("steer"),
        })

    def find(self, proposal_id: str) -> Optional[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """(answer row, proposal) for a proposal id, newest first."""
        for row in reversed(self.rows()):
            if row.get("kind") != "answer":
                continue
            for p in row.get("proposals") or []:
                if isinstance(p, dict) and p.get("id") == proposal_id:
                    return row, p
        return None

    def record_outcome(self, proposal_id: str, outcome: str, now: datetime) -> Dict[str, Any]:
        if not PROPOSAL_ID_RE.match(proposal_id or ""):
            raise StewardError("invalid proposal id")
        if outcome not in ("accepted", "dismissed"):
            raise StewardError("outcome must be accepted or dismissed")
        with _STORE_LOCK:
            hit = self.find(proposal_id)
            if hit is None:
                raise StewardError("not found", 404)
            answer, proposal = hit
            row = {
                "kind": "outcome", "at": iso(now), "proposal_id": proposal_id, "outcome": outcome,
                "action": proposal.get("action"), "request_id": answer.get("request_id"), "surface": answer.get("surface"),
            }
            self._append(row)
        return row


# ---------------------------------------------------------------------------
# GOALS.md drafts
# ---------------------------------------------------------------------------


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_goals_text(workspace: Path) -> str:
    try:
        return (Path(workspace) / "GOALS.md").read_text(encoding="utf-8")
    except OSError:
        return ""


def _looks_like_goals(lang: str, body: str) -> bool:
    return lang.lower() not in ("lee-proposals", "lee-steer") and ("### G" in body or body.lstrip().startswith("# "))


def strip_goals_file(text: str) -> str:
    """``text`` without fenced blocks that look like a GOALS.md (what proposals.jsonl stores for goal-edit)."""
    out = _FENCE_RE.sub(lambda m: "" if _looks_like_goals(m.group(1), m.group(2)) else m.group(0), text or "")
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def extract_goals_file(answer: str) -> Optional[str]:
    """The proposed GOALS.md in an answer: the largest fenced block that looks like it, else the answer itself."""
    candidates = []
    for lang, body in _FENCE_RE.findall(answer or ""):
        if _looks_like_goals(lang, body):
            candidates.append(body)
    if candidates:
        text = max(candidates, key=len)
    elif (answer or "").lstrip().startswith("# ") and "### G" in answer:
        text = answer
    else:
        return None
    return text.strip("\n") + "\n"


def unified_diff(old: str, new: str) -> str:
    return "".join(difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True),
        fromfile="GOALS.md", tofile="GOALS.md (draft)",
    ))


def _drafts_dir(workspace: Path) -> Path:
    return Path(workspace) / DRAFTS_DIR


def save_draft(
    workspace: Path, proposed: str, instruction: str, goal_id: Optional[str], now: datetime,
    base: Optional[str] = None,
) -> Dict[str, Any]:
    """
    ``base`` is the GOALS.md text the model was shown; the draft's hash and
    diff are against it, so an edit made during the model call makes apply 409.
    """
    if base is None:
        base = read_goals_text(workspace)
    draft_id = f"draft-{now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(2)}"
    d = _drafts_dir(workspace)
    atomic_write(d / f"{draft_id}.GOALS.md", proposed)
    atomic_write(d / f"{draft_id}.json", json.dumps({
        "draft_id": draft_id, "base_sha256": _sha(base), "goal_id": goal_id, "instruction": instruction,
        "created_at": iso(now), "applied_at": None,
    }))
    return {"draft_id": draft_id, "diff": unified_diff(base, proposed), "path": str(DRAFTS_DIR / f"{draft_id}.GOALS.md")}


def _write_preserving_mode(path: Path, content: str) -> None:
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def apply_draft(workspace: Path, draft_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Write GOALS.md from a draft, only if the file still matches the draft's base (409 otherwise). Never commits."""
    now = now or utc_now()
    if not DRAFT_ID_RE.match(draft_id or ""):
        raise StewardError("invalid draft id")
    d = _drafts_dir(workspace)
    try:
        meta = json.loads((d / f"{draft_id}.json").read_text(encoding="utf-8"))
        proposed = (d / f"{draft_id}.GOALS.md").read_text(encoding="utf-8")
    except (OSError, ValueError):
        raise StewardError("not found", 404)
    if _sha(read_goals_text(workspace)) != meta.get("base_sha256"):
        raise StewardError("GOALS.md changed since this draft was made; make a new draft", 409)
    _write_preserving_mode(Path(workspace) / "GOALS.md", proposed)
    meta["applied_at"] = iso(now)
    atomic_write(d / f"{draft_id}.json", json.dumps(meta))
    return {"applied": True, "draft_id": draft_id, "path": str(Path(workspace) / "GOALS.md"), "applied_at": meta["applied_at"]}


# ---------------------------------------------------------------------------
# Evaluations
# ---------------------------------------------------------------------------


def save_evaluation(workspace: Path, gid: str, title: str, packet: Dict[str, Any], answer: str, now: datetime) -> str:
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S")
    rel = EVALUATIONS_DIR / f"{gid}-{stamp}.md"
    text = (
        f"# Evaluation: {gid} {title}\n\n"
        f"_{iso(now)}_\n\n"
        f"## Answer\n\n{answer.strip()}\n\n"
        f"## Evidence packet\n\n```json\n{json.dumps(packet, indent=2, default=str)}\n```\n"
    )
    atomic_write(Path(workspace) / rel, text)
    return str(rel)


# ---------------------------------------------------------------------------
# Model call
# ---------------------------------------------------------------------------

_agent_provider: Optional[Callable[[], Any]] = None


def set_agent_provider(provider: Optional[Callable[[], Any]]) -> None:
    """main.py hands over the daemon's agent (a zero-arg getter)."""
    global _agent_provider
    _agent_provider = provider


def context_json(title: str, data: Any, limit: int = MAX_CONTEXT) -> str:
    text = json.dumps(data, indent=1, default=str, ensure_ascii=False)
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return f"### {title}\n\n```json\n{text}\n```"


async def call_model(workspace: Path, surface: str, message: str, steward_context: str, request_id: str) -> str:
    """One non-streaming agent turn with ``surface`` and ``steward_context``. Returns the answer text."""
    from ..models import ContextRequest, EditorState

    agent = _agent_provider() if _agent_provider else None
    if agent is None:
        raise StewardError("Hester's agent isn't ready", 503)
    session_id = f"steward-{request_id}"
    request = ContextRequest(
        session_id=session_id,
        message=message,
        editor_state=EditorState(working_directory=str(workspace)),
        surface=surface,
        steward_context=steward_context,
        tool_allowlist=list(STEWARD_TOOLS),
    )
    try:
        response = await agent.process_context(request)
    finally:
        await _drop_session(agent, session_id)
    status = getattr(response, "status", None)
    text = getattr(response, "response", None)
    failure = model_failure(status, text)
    if failure:
        logger.warning(f"steward {surface} {request_id}: model call failed ({failure}): {str(text or '')[:300]}")
        raise StewardError(f"Hester couldn't answer ({failure}); try again", 502)
    return text


# What the agent returns (with status "complete") when a turn failed.
_AGENT_ERROR_PREFIXES = ("I encountered an error:", "An unexpected error occurred:")
_AGENT_EMPTY_FALLBACK = "I couldn't generate a response. Please try rephrasing your question."


def model_failure(status: Any, text: Any) -> Optional[str]:
    """A short reason when an agent response is a failure, else None."""
    if status == "error":
        return "error"
    if status == "max_iterations":
        return "ran out of steps"
    if not isinstance(text, str) or not text.strip():
        return "empty answer"
    t = text.strip()
    if t.startswith(_AGENT_ERROR_PREFIXES):
        return "error"
    if t == _AGENT_EMPTY_FALLBACK:
        return "empty answer"
    return None


async def _drop_session(agent: Any, session_id: str) -> None:
    """Each steward call is one-shot: delete its chat session so none pile up (never fails the call)."""
    sessions = getattr(agent, "sessions", None)
    delete = getattr(sessions, "delete", None)
    if delete is None:
        return
    try:
        await delete(session_id)
    except Exception as e:
        logger.debug(f"could not delete steward session {session_id}: {e}")


async def answer(
    workspace: Path,
    surface: str,
    message: str,
    steward_context: str,
    *,
    origin: Optional[Dict[str, Any]] = None,
    steer_target: Optional[Dict[str, Any]] = None,
    record: Optional[Dict[str, Any]] = None,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Run the model and shape ``{text, proposals, steer, surface, request_id}``; stores proposals."""
    request_id = new_request_id()
    raw = await call_model(workspace, surface, message, steward_context, request_id)
    text, proposals = parse_proposals(raw, origin=origin)
    steer = None
    text, steer_text = parse_steer(text)
    if surface == "rail-steer" and steer_target and steer_text:
        steer = {"task_id": steer_target.get("task_id"), "pty_id": steer_target.get("pty_id"), "text": steer_text}
    out = {"text": text, "proposals": proposals, "steer": steer, "surface": surface, "request_id": request_id, "raw": raw}
    now = now or utc_now()
    stored = dict(out, text=strip_goals_file(text)) if surface == "goal-edit" else out
    try:
        await asyncio.to_thread(ProposalStore(workspace).record_answer, stored, record or {}, now)
    except OSError as e:
        logger.warning(f"could not store steward answer: {e}")
    return out
