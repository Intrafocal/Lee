"""
Hand-offs (Deep next R3): a section of a Page handed to an agent as a Cockpit
task. Deterministic, no model.

The record lives in the Page card's ``answers.jsonl`` (``kind: 'handoff'``,
``surface: 'deep-handoff'``; ``deep.new_handoff`` creates it). Lee launches the
task with ``origin: {kind: 'page', ref: '<pg id>#<answer id>'}`` (Desk D2), or
the pre-Desk ``{kind: 'exploration', ref: '<exp id>#<answer id>'}``, which
follows the migration to its card when there is one; whenever such a task is relayed, followed or closed (the follower and the task
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
from .desk import PAGE_ID_RE
from .explorations import EXP_ID_RE, utc_now
from .tasks import clip, iso_s

logger = logging.getLogger("hester.daemon.cockpit.handoffs")

ORIGIN_KIND = "exploration"  # the pre-Desk form
PAGE_ORIGIN_KIND = "page"
ORIGIN_KINDS = (PAGE_ORIGIN_KIND, ORIGIN_KIND)
STATE_MAP = {
    "queued": "running", "running": "running", "idle": "running",
    "waiting": "waiting", "review": "review", "done": "done", "discarded": "error",
}


def parse_ref(ref: Any, kind: str = ORIGIN_KIND) -> Tuple[Optional[str], Optional[str]]:
    """
    ``exp-1a2b3c4d#ans-5e6f7a8b`` (kind ``exploration``) or
    ``pg-1a2b3c4d#ans-5e6f7a8b`` (kind ``page``) -> (record id, answer id);
    (None, None) otherwise.
    """
    if not isinstance(ref, str) or "#" not in ref:
        return None, None
    rec_id, _, answer_id = ref.partition("#")
    id_re = PAGE_ID_RE if kind == PAGE_ORIGIN_KIND else EXP_ID_RE
    if not id_re.match(rec_id) or not deep.ANSWER_ID_RE.match(answer_id):
        return None, None
    return rec_id, answer_id


def resolve(ctx, origin: Dict[str, Any]) -> Tuple[Any, Optional[str], Optional[str]]:
    """
    (store, record id, answer id) for a hand-off origin, or (None, None, None).
    A ``page`` ref goes to the Page card; an ``exploration`` ref goes to the
    card the migration made of it, else to the exploration as before.
    """
    kind = origin.get("kind")
    if kind not in ORIGIN_KINDS:
        return None, None, None
    rec_id, answer_id = parse_ref(origin.get("ref"), kind)
    if rec_id is None:
        return None, None, None
    if kind == PAGE_ORIGIN_KIND:
        pages = ctx.desk().pages
        return (pages, rec_id, answer_id) if pages.exists(rec_id) else (None, None, None)
    card_id = ctx.desk().card_for_exploration(rec_id)
    if card_id is not None:
        return ctx.desk().pages, card_id, answer_id
    store = ctx.explorations()
    return (store, rec_id, answer_id) if store.exists(rec_id) else (None, None, None)


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
        data = {
            "workspace": str(ctx.path), "exploration_id": exp_id, "answer_id": row["id"], "status": row.get("status"),
            "kind": "handoff", "state": (row.get("handoff") or {}).get("state"),
        }
        if PAGE_ID_RE.match(exp_id):
            data["card_id"] = exp_id  # Desk D2 §5.3: both fields
        lee_events.ingest("deep.answer", data, workspace=str(ctx.path), actor={"kind": "hester"})
    except Exception as e:  # never fail over telemetry
        logger.debug(f"could not log deep.answer: {e}")


def sync(ctx, task: Dict[str, Any], turn_end: bool = False, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """Bring a ``page``- or ``exploration``-origin task's hand-off record up to date. Returns the record or None. Never raises."""
    try:
        store, exp_id, answer_id = resolve(ctx, task.get("origin") or {})
        if store is None:
            return None
        row = deep.get_answer(store, exp_id, answer_id)
        if not deep.is_handoff(row):
            return None
        handoff = dict(row.get("handoff") or {})
        if handoff.get("task_id") and handoff["task_id"] != task.get("id"):
            return None
        new = STATE_MAP.get(task.get("status"))
        # A hand-off's agent that finished a turn and went idle has its result
        # ready even though its session is still open (a research agent answers
        # and waits): that's review, with the answer filled in, not "running".
        # A reply that starts another turn moves it back to running.
        if task.get("status") == "idle" and (task.get("turns") or 0) >= 1 and task_answer(task):
            new = "review"
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
