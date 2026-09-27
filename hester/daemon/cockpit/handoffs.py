"""
Hand-offs (Deep next R3): a section of a Page handed to an agent as a Cockpit
task. Deterministic, no model.

The record lives in the exploration's ``answers.jsonl`` (``kind: 'handoff'``,
``surface: 'deep-handoff'``; ``deep.new_handoff`` creates it). Lee launches the
task with ``origin: {kind: 'exploration', ref: '<exp id>#<answer id>'}``;
whenever such a task is relayed, followed or closed (the follower and the task
routes call ``sync``), the record follows it:

- queued/running/idle -> ``state: 'running'``; waiting (``agent.waiting``, a
  pending approval or question) -> ``'waiting'``;
- review -> ``'review'``, and ``answer`` = the task's latest summary (its
  lee-status summary and next, else the agent's message), refreshed on each
  ``agent.turn_end`` while in review;
- done -> ``'done'``, ``status: 'done'``, ``answered_at``;
- discarded -> ``'error'``, ``status: 'error'``, ``error: 'discarded'``.

While running, waiting or in review the record's ``status`` is ``running``
(pending). Each change is ingested to Lee as ``deep.answer`` so the Page
updates. ``sync`` never raises.
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from . import deep
from .explorations import EXP_ID_RE, ExplorationStore, utc_now
from .tasks import clip, iso_s

logger = logging.getLogger("hester.daemon.cockpit.handoffs")

ORIGIN_KIND = "exploration"
STATE_MAP = {
    "queued": "running", "running": "running", "idle": "running",
    "waiting": "waiting", "review": "review", "done": "done", "discarded": "error",
}


def parse_ref(ref: Any) -> Tuple[Optional[str], Optional[str]]:
    """``exp-1a2b3c4d#ans-5e6f7a8b`` -> (exp id, answer id); (None, None) otherwise."""
    if not isinstance(ref, str) or "#" not in ref:
        return None, None
    exp_id, _, answer_id = ref.partition("#")
    if not EXP_ID_RE.match(exp_id) or not deep.ANSWER_ID_RE.match(answer_id):
        return None, None
    return exp_id, answer_id


def task_answer(task: Dict[str, Any]) -> Optional[str]:
    """The task's latest summary: its lee-status summary and next, else the agent's message."""
    ls = task.get("lee_status") if isinstance(task.get("lee_status"), dict) else None
    summary = (ls or {}).get("summary")
    nxt = (ls or {}).get("next")
    if (isinstance(summary, str) and summary.strip()) or (isinstance(nxt, str) and nxt.strip()):
        parts = []
        if isinstance(summary, str) and summary.strip():
            parts.append(summary.strip())
        if isinstance(nxt, str) and nxt.strip():
            parts.append(f"Next: {nxt.strip()}")
        return clip("\n\n".join(parts))
    message = task.get("summary")
    return clip(message.strip()) if isinstance(message, str) and message.strip() else None


def _ingest(ctx, exp_id: str, row: Dict[str, Any]) -> None:
    from ..copilot import lee_events

    try:
        lee_events.ingest("deep.answer", {
            "workspace": str(ctx.path), "exploration_id": exp_id, "answer_id": row["id"], "status": row.get("status"),
            "kind": "handoff", "state": (row.get("handoff") or {}).get("state"),
        }, workspace=str(ctx.path), actor={"kind": "hester"})
    except Exception as e:  # never fail over telemetry
        logger.debug(f"could not log deep.answer: {e}")


def sync(ctx, task: Dict[str, Any], turn_end: bool = False, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Bring an ``exploration``-origin task's hand-off record up to date. Returns the record or None. Never raises."""
    try:
        origin = task.get("origin") or {}
        if origin.get("kind") != ORIGIN_KIND:
            return None
        exp_id, answer_id = parse_ref(origin.get("ref"))
        if exp_id is None:
            return None
        store: ExplorationStore = ctx.explorations()
        if not store.exists(exp_id):
            return None
        row = deep.get_answer(store, exp_id, answer_id)
        if not deep.is_handoff(row):
            return None
        handoff = dict(row.get("handoff") or {})
        if handoff.get("task_id") and handoff["task_id"] != task.get("id"):
            return None
        new = STATE_MAP.get(task.get("status"))
        prev = handoff.get("state")
        if new is None or (prev == "done" and new != "done"):
            return row
        now = now or utc_now()
        fields: Dict[str, Any] = {}
        changed = dict(handoff)
        if not changed.get("task_id"):
            changed["task_id"] = task.get("id")
        changed["state"] = new
        if new in ("running", "waiting", "review"):
            fields["status"] = "running"
            if row.get("error"):
                fields["error"] = None
        if new in ("review", "done"):
            text = task_answer(task)
            if text and (new != "review" or prev != "review" or turn_end or not row.get("answer")):
                fields["answer"] = text
        if new == "done":
            fields["status"] = "done"
            if not row.get("answered_at"):
                fields["answered_at"] = iso_s(now)
            if row.get("error"):
                fields["error"] = None
        if new == "error":
            fields["status"] = "error"
            fields["error"] = "discarded"
        if changed != handoff:
            fields["handoff"] = changed
        fields = {k: v for k, v in fields.items() if row.get(k) != v}
        if not fields:
            return row
        updated = deep.update_answer(store, exp_id, answer_id, fields)
        if updated is not None:
            _ingest(ctx, exp_id, updated)
        return updated
    except Exception as e:
        logger.warning(f"Hand-off sync failed for {task.get('id')}: {e}")
        return None
