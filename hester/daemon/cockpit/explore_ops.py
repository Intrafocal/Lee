"""
Explore operations beyond the store (v3 contracts §5-§8), all deterministic:

- promote an exploration (or some of its nodes) to a task, a workstream or a
  goal **draft** (never GOALS.md); what is carried is ``outline()``, not a
  transcript;
- escalate a task into an exploration;
- archive as knowledge: ``.hester/knowledge/explore-<id>.md``, read back by the
  ``knowledge_notes`` tool;
- the Library pane's view of an exploration (``/library/*`` shapes).
"""

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from .explorations import (
    LOG_KINDS,
    PROMOTE_TARGETS,
    ROOT,
    ExplorationError,
    ExplorationStore,
    all_conversations,
    children_of,
    outline_line,
    render_outline,
    subtree_ids,
    to_api,
    utc_now,
)
from .goals import load_goals
from .tasks import atomic_write, clip, first_line, iso_s

MAX_TASK_TITLE = 80
MAX_OBJECTIVE = 4000
MAX_ESCALATE_FILES = 20
MAX_KNOWLEDGE_ANSWER = 1500
MAX_SAVE_TEXT = 4000
KNOWLEDGE_DIR = Path(".hester") / "knowledge"
GOAL_DRAFTS_DIR = Path(".hester") / "goals" / "drafts"
NOTE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$")
_G_RE = re.compile(r"^G(\d+)$")


def _chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _chmod(path.parent, 0o700)
    atomic_write(path, text)
    _chmod(path, 0o600)


def _node_ids(exp: Dict[str, Any], node_ids: Any) -> Optional[List[str]]:
    if node_ids is None:
        return None
    if not isinstance(node_ids, list) or not all(isinstance(n, str) for n in node_ids):
        raise ExplorationError("node_ids must be a list of node ids")
    known = {n["id"] for n in exp["nodes"]}
    missing = [n for n in node_ids if n not in known]
    if missing:
        raise ExplorationError(f"unknown node ids: {', '.join(missing)}")
    return list(dict.fromkeys(node_ids)) or None


def _scope_decisions(exp: Dict[str, Any], node_ids: Optional[List[str]]) -> List[Dict[str, Any]]:
    """Decision nodes the outline carries (not the promote bookkeeping ones)."""
    if node_ids:
        scope = set(subtree_ids(exp, node_ids))
    else:
        scope = {n["id"] for n in exp["nodes"]}
    out = []
    for n in exp["nodes"]:
        d = n.get("decision") or {}
        if n["kind"] != "decision" or d.get("auto"):
            continue
        refs = set((d.get("chosen") or []) + (d.get("pruned") or []))
        if n["id"] in scope or refs & scope:
            out.append(n)
    return out


def _labels(exp: Dict[str, Any], ids: List[str]) -> List[str]:
    by_id = {n["id"]: n["label"] for n in exp["nodes"]}
    return [by_id.get(i, i) for i in ids]


# ---------------------------------------------------------------------------
# Promote (§5)
# ---------------------------------------------------------------------------


async def promote(ctx, exp_id: str, body: Dict[str, Any], now: Optional[datetime] = None) -> Dict[str, Any]:
    """POST /cockpit/explorations/{id}/promote. Callers hold ``ctx.lock``."""
    now = now or utc_now()
    store: ExplorationStore = ctx.explorations()
    exp = store.require(exp_id)
    to = body.get("to")
    if to not in PROMOTE_TARGETS:
        raise ExplorationError(f"to must be one of {', '.join(PROMOTE_TARGETS)}")
    node_ids = _node_ids(exp, body.get("node_ids"))
    title = body.get("title")
    if title is not None and (not isinstance(title, str) or not title.strip()):
        raise ExplorationError("title must be a non-empty string")
    outline = render_outline(exp, node_ids)

    if to == "task":
        task_title = first_line(title or exp["title"], MAX_TASK_TITLE) or "Exploration"
        task, _ = ctx.tasks().upsert({
            "title": task_title,
            "status": "queued",
            "lead": "delegate",
            "kind": "unknown",
            "confirmed": True,
            "serves": list(exp.get("serves") or []),
            "origin": {"kind": "explore", "ref": exp_id},
            "note": outline,
        }, now=now)
        exp = store.record_promote(exp_id, "task", task["id"], node_ids, now)
        from .tasks import to_api as task_to_api
        return {"exploration": to_api(exp), "task": task_to_api(task)}

    if to == "workstream":
        from ..workstream.orchestrator import WorkstreamOrchestrator
        from ..workstream.models import DesignDecision, DesignDoc

        ws_store = ctx.ws_store()
        orchestrator = WorkstreamOrchestrator(ws_store=ws_store)
        ws_title = (title or exp["title"]).strip()
        ws = await orchestrator.promote_from_idea(session_id=exp_id, title=ws_title, objective=outline[:MAX_OBJECTIVE])
        ws.serves = list(exp.get("serves") or [])
        ws_store.save(ws)
        for n in _scope_decisions(exp, node_ids):
            d = n.get("decision") or {}
            chosen = _labels(exp, d.get("chosen") or [])
            pruned = _labels(exp, d.get("pruned") or [])
            decided = ", ".join(chosen) if chosen else (f"pruned: {', '.join(pruned)}" if pruned else d.get("text") or "")
            args = dict(question=d.get("text") or n["label"], decision=decided, rationale=d.get("reason") or "", alternatives=pruned)
            try:
                await orchestrator.record_decision(ws.id, **args)
            except Exception:
                current = ws_store.get(ws.id) or ws
                doc = current.design_doc or DesignDoc(summary="")
                doc.decisions.append(DesignDecision(**args))
                ws_store.save_design(ws.id, doc)
        exp = store.record_promote(exp_id, "workstream", ws.id, node_ids, now)
        return {"exploration": to_api(exp), "workstream_id": ws.id, "title": ws.title, "phase": ws.phase.value}

    draft_rel = GOAL_DRAFTS_DIR / f"{exp_id}.md"
    _write_private(Path(ctx.path) / draft_rel, goal_draft(Path(ctx.path), exp, node_ids, title))
    exp = store.record_promote(exp_id, "goal", str(draft_rel), node_ids, now)
    return {"exploration": to_api(exp), "draft_path": str(draft_rel)}


def next_goal_id(workspace: Path) -> str:
    nums = [int(m.group(1)) for g in load_goals(workspace) if (m := _G_RE.match(g["id"]))]
    return f"G{(max(nums) if nums else 0) + 1}"


def goal_draft(workspace: Path, exp: Dict[str, Any], node_ids: Optional[List[str]], title: Optional[str] = None) -> str:
    """A ``### G<next>`` block in GOALS.md's format; the human edits GOALS.md."""
    gid = next_goal_id(workspace)
    lines = [
        f"<!-- Draft goal from exploration {exp['id']} (.hester/explore/{exp['id']}.md). "
        "Only a human edits GOALS.md: copy this block in, edited, if you want it. -->",
        "",
        f"### {gid} {(title or exp['title']).strip()}",
        "",
        (exp.get("seed") or exp["title"]).strip(),
        "",
    ]
    decisions = _scope_decisions(exp, node_ids)
    if decisions:
        lines.append("Decisions from the exploration:")
        lines.append("")
        for n in decisions:
            d = n.get("decision") or {}
            s = f"- {d.get('text') or n['label']}"
            if d.get("chosen"):
                s += f" (chose: {', '.join(_labels(exp, d['chosen']))})"
            if d.get("pruned"):
                s += f" (pruned: {', '.join(_labels(exp, d['pruned']))})"
            if d.get("reason"):
                s += f". {d['reason']}"
            lines.append(s)
        lines.append("")
    lines += [
        "- metric: **<name>**: <what it counts, and why that shows the goal is met>.",
        "  - kind: <runnable | proxy | judged>",
        "  - signal: <what it's computed from>",
        "  - available: <yes | no; what's missing | partly>",
        "  - target: <rising | falling | a value>",
        "  - guard: <a metric that must not get worse while this one moves>",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Escalate a task (§6)
# ---------------------------------------------------------------------------


def escalate(ctx, task_id: str, now: Optional[datetime] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Create an exploration from a task; the task stays open with note ``explore:<id>``."""
    now = now or utc_now()
    tasks = ctx.tasks()
    task = tasks.require(task_id)
    report = (task.get("lee_status") or {}).get("summary") or task.get("summary")
    parts = [task["title"]]
    if report:
        parts.append(f"Agent's last report (the agent's words): {clip(report)}")
    files = [f for f in task.get("files") or [] if isinstance(f, str)]
    if files:
        more = f" (+{len(files) - MAX_ESCALATE_FILES} more)" if len(files) > MAX_ESCALATE_FILES else ""
        parts.append("Files: " + ", ".join(files[:MAX_ESCALATE_FILES]) + more)
    exp = ctx.explorations().create({
        "title": task["title"],
        "seed": "\n\n".join(parts),
        "origin": {"kind": "task", "ref": task_id},
        "serves": list(task.get("serves") or []),
    }, now=now)
    task, _ = tasks.upsert({"id": task_id, "note": f"explore:{exp['id']}"}, now=now)
    return task, exp


# ---------------------------------------------------------------------------
# Archive as knowledge (§7)
# ---------------------------------------------------------------------------


def knowledge_rel_path(exp_id: str) -> str:
    return str(KNOWLEDGE_DIR / f"explore-{exp_id}.md")


def knowledge_note(exp: Dict[str, Any], text: str, archived_at: str) -> str:
    convs = all_conversations(exp, text)
    meta = {
        "title": exp["title"],
        "exploration": exp["id"],
        "created_at": exp.get("created_at"),
        "archived_at": archived_at,
        "serves": list(exp.get("serves") or []),
    }
    head = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, default_flow_style=False)
    lines = [
        f"# {exp['title']}",
        "",
        f"Explored {str(exp.get('created_at') or '')[:10]} to {archived_at[:10]}. "
        f"Source: .hester/explore/{exp['id']}.md",
        "",
        "## Seed",
        "",
        (exp.get("seed") or "(none)").strip(),
        "",
        "## Outline",
        "",
        render_outline(exp).rstrip(),
        "",
    ]
    if exp.get("promoted"):
        lines += ["## Promoted", ""]
        for p in exp["promoted"]:
            lines.append(f"- {p.get('to')}: {p.get('ref')} ({p.get('at')})")
        lines.append("")
    findings = []
    for n in exp["nodes"]:
        if n["kind"] not in LOG_KINDS or n.get("pruned"):
            continue
        answer = next((m["content"] for m in reversed(convs.get(n["id"], [])) if m["role"] == "assistant"), None)
        if answer:
            findings += [f"### {n['label']}", "", clip(answer.strip(), MAX_KNOWLEDGE_ANSWER), ""]
    if findings:
        lines += ["## Last answers", ""] + findings
    return f"---\n{head}---\n" + "\n".join(lines).rstrip() + "\n"


def archive(ctx, exp_id: str, as_knowledge: bool = False, now: Optional[datetime] = None) -> Dict[str, Any]:
    """POST .../archive. Returns {exploration, knowledge_path?}."""
    now = now or utc_now()
    store: ExplorationStore = ctx.explorations()
    if not as_knowledge:
        return {"exploration": to_api(store.patch(exp_id, {"status": "archived"}, now))}
    exp = store.require(exp_id)
    text = store.body(exp_id)
    archived_at = exp.get("archived_at") or iso_s(now)
    rel = knowledge_rel_path(exp_id)
    _write_private(Path(ctx.path) / rel, knowledge_note(exp, text, archived_at))
    exp = store.set_knowledge(exp_id, rel, now)
    return {"exploration": to_api(exp), "knowledge_path": rel}


def _front(text: str) -> Dict[str, Any]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---\n", 3)
    if end < 0:
        return {}
    try:
        meta = yaml.safe_load(text[4:end + 1]) or {}
    except yaml.YAMLError:
        return {}
    return meta if isinstance(meta, dict) else {}


def list_knowledge(workspace: Path) -> List[Dict[str, Any]]:
    d = Path(workspace) / KNOWLEDGE_DIR
    out = []
    try:
        paths = sorted(d.glob("*.md"))
    except OSError:
        return out
    for p in paths:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        meta = _front(text)
        title = meta.get("title")
        if not title:
            title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), p.stem)
        archived = meta.get("archived_at")
        out.append({"name": p.stem, "title": str(title), "archived_at": str(archived) if archived else None})
    out.sort(key=lambda n: (n["archived_at"] or "", n["name"]), reverse=True)
    return out


def read_knowledge(workspace: Path, name: str) -> Optional[str]:
    name = name[:-3] if name.endswith(".md") else name
    if not NOTE_NAME_RE.match(name or ""):
        raise ExplorationError(f"invalid note name: {name!r}")
    try:
        return (Path(workspace) / KNOWLEDGE_DIR / f"{name}.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Library views (§8)
# ---------------------------------------------------------------------------


def library_node(n: Dict[str, Any], kids: List[str], conversation: List[Dict[str, Any]]) -> Dict[str, Any]:
    out = {
        "id": n["id"],
        "parent_id": n["parent"],
        "label": n["label"],
        "node_type": n["kind"],
        "agent_mode": n.get("mode") or "ideate",
        "conversation_history": conversation,
        "children": kids,
        "collapsed": bool(n.get("collapsed")),
        "created_at": n.get("created_at"),
        "pruned": bool(n.get("pruned")),
        "kind": n["kind"],
        "turns": int(n.get("turns") or 0),
    }
    for key in ("decision", "spike", "evidence"):
        if n.get(key) is not None:
            out[key] = n[key]
    return out


def library_nodes(exp: Dict[str, Any], text: str) -> Dict[str, Dict[str, Any]]:
    convs = all_conversations(exp, text)
    kids = children_of(exp)
    return {n["id"]: library_node(n, kids[n["id"]], convs.get(n["id"], [])) for n in exp["nodes"]}


def library_session(exp: Dict[str, Any], text: str) -> Dict[str, Any]:
    return {
        "session_id": exp["id"],
        "title": exp["title"],
        "root_id": ROOT,
        "active_node_id": exp.get("active_node") or ROOT,
        "nodes": library_nodes(exp, text),
        "created_at": exp.get("created_at"),
        "last_activity": exp.get("last_touched_at") or exp.get("updated_at"),
        "status": exp.get("status"),
    }


def library_summary(exp: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "session_id": exp["id"],
        "title": exp["title"],
        "node_count": len(exp["nodes"]),
        "created_at": exp.get("created_at"),
        "last_activity": exp.get("last_touched_at") or exp.get("updated_at"),
    }


def render_subtree(exp: Dict[str, Any], text: str, node_id: str = ROOT, limit: int = MAX_SAVE_TEXT) -> str:
    """Markdown of a node and its descendants (the Library's Save), clipped to ``limit``."""
    convs = all_conversations(exp, text)
    kids = children_of(exp)
    by_id = {n["id"]: n for n in exp["nodes"]}
    out: List[str] = []

    def walk(nid: str, depth: int) -> None:
        n = by_id[nid]
        hashes = "#" * min(depth + 1, 6)
        if n["kind"] in LOG_KINDS:
            out.append(f"{hashes} {n['label']}{' (pruned)' if n.get('pruned') else ''}")
            for m in convs.get(nid, []):
                out.append(f"\n**Q:** {m['content']}" if m["role"] == "user" else f"\n{m['content']}")
        else:
            out.append(f"- {outline_line(n, by_id)}")
        out.append("")
        for child in kids.get(nid, []):
            walk(child, depth + 1)

    walk(node_id, 0)
    return clip("\n".join(out).strip(), limit) or exp["title"]
