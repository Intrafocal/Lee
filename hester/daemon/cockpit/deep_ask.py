"""
deep-ask: Ask, don't wait (Deep D1 contract section 6; spec 14 section 5.3).

``POST /cockpit/explorations/{id}/asks`` appends a queued Answer and hands it
here. Each run is one non-streaming agent turn through ``steward.call_model``
with surface ``deep-ask``: Hester's hybrid routing and model-call logging as
they are, and no ``steward.md`` (``deep-ask`` isn't a steer surface), no
proposals and no steer. The answer lands in ``answers.jsonl``; Lee hears about
it through the ingested ``deep.answer`` event and nothing else happens: no
notification, no toast, no attention item.

C2: a run only ever starts from a user action (Ask, Follow up or Retry in the
renderer). The trigger captured from that request is re-entered in the task,
so logged model calls carry ``trigger {kind: 'user', surface: 'deep-ask'}``.

At most 2 runs are in flight per workspace, FIFO. Answers that were queued or
running when the daemon last stopped become ``interrupted`` the first time a
workspace's explorations are read in this process; the renderer offers Retry.
"""

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Set

from ..copilot import lee_events, model_log
from . import deep, steward
from .explorations import ExplorationStore, _clip, utc_now
from .tasks import iso_s

logger = logging.getLogger("hester.daemon.cockpit.deep_ask")

SURFACE = "deep-ask"
MAX_IN_FLIGHT = 2
CONTEXT_CAP = 24000
EXCERPT_CHARS = 1000
MAX_REFERENCES = 20
INSTRUCTION = (
    "You're answering a question asked while the user is thinking and writing. Answer the question "
    "directly and concisely, in markdown. Don't offer to do more, don't ask questions back, and don't "
    "propose actions."
)


# ---------------------------------------------------------------------------
# Context (deterministic, capped)
# ---------------------------------------------------------------------------


def locate(page: str, quote: str, offset: int) -> Optional[int]:
    """The start of the occurrence of ``quote`` nearest ``offset``, else None."""
    if not quote:
        return None
    best = None
    i = page.find(quote)
    while i >= 0:
        if best is None or abs(i - offset) < abs(best - offset):
            best = i
        i = page.find(quote, i + 1)
    return best


def _window(text: str, center: Optional[int], budget: int) -> str:
    """At most ``budget`` chars of ``text``, cut from the end(s) farthest from ``center``."""
    if budget <= 0:
        return ""
    if len(text) <= budget:
        return text
    if center is None:
        return text[: budget - 1] + "…"
    start = max(0, min(center - budget // 2, len(text) - budget))
    out = text[start:start + budget]
    if start > 0:
        out = "…" + out[1:]
    if start + budget < len(text):
        out = out[:-1] + "…"
    return out


def build_context(
    exp: Dict[str, Any],
    page: str,
    answer: Dict[str, Any],
    references: List[Dict[str, Any]],
    follow_up: Optional[Dict[str, Any]] = None,
    cap: int = CONTEXT_CAP,
) -> str:
    """
    In order: the title and seed; the anchor's section and the quote with
    ±1 000 chars around it; the rest of the Page (cut from the far end); open
    questions; the last 20 references; the followed-up question and answer.
    The Page gets whatever the other parts leave of ``cap``.
    """
    head = f"### Exploration\n\nTitle: {exp.get('title') or ''}"
    if exp.get("seed"):
        head += f"\n\nSeed:\n{exp['seed']}"

    anchor = answer.get("anchor") or {"kind": "none"}
    center = None
    anchor_part = ""
    if anchor.get("kind") == "page":
        quote = str(anchor.get("quote") or "")
        at = locate(page, quote, int(anchor.get("offset") or 0))
        lines = ["### Where the question was asked"]
        if anchor.get("section"):
            lines.append(f"Section: {anchor['section']}")
        if quote:
            lines.append(f"Selected text:\n{quote}")
        if at is not None:
            center = at + len(quote) // 2
            lo, hi = max(0, at - EXCERPT_CHARS), min(len(page), at + len(quote) + EXCERPT_CHARS)
            lines.append(f"Around it on the Page:\n{page[lo:hi]}")
        anchor_part = "\n\n".join(lines)

    questions = [q for q in exp.get("questions") or [] if q.get("status") == "open"]
    q_part = ("### Open questions\n\n" + "\n".join(f"- {q.get('text')}" for q in questions)) if questions else ""

    ref_lines = []
    for r in references[:MAX_REFERENCES]:
        bits = []
        if r.get("quote"):
            bits.append(f"\"{_clip(r['quote'], 500)}\"")
        for key in ("url", "title"):
            if r.get(key):
                bits.append(str(r[key]))
        if r.get("note"):
            bits.append(f"note: {r['note']}")
        if bits:
            ref_lines.append("- " + " · ".join(bits))
    ref_part = ("### References kept\n\n" + "\n".join(ref_lines)) if ref_lines else ""

    follow_part = ""
    if follow_up:
        follow_part = (
            "### This follows up an earlier question\n\n"
            f"Question: {follow_up.get('question') or ''}\n\nAnswer: {follow_up.get('answer') or '(none)'}"
        )

    fixed = [p for p in (head, anchor_part, q_part, ref_part, follow_part) if p]
    budget = cap - sum(len(p) + 2 for p in fixed) - 40
    page_part = ""
    if page.strip() and budget > 0:
        page_part = "### The Page\n\n" + _window(page, center, budget)
    parts = [p for p in (head, anchor_part, page_part, q_part, ref_part, follow_part) if p]
    text = "\n\n".join(parts)
    return text if len(text) <= cap else text[: cap - 1] + "…"


def context_for(store: ExplorationStore, exp_id: str, answer: Dict[str, Any]) -> str:
    exp = store.require(exp_id)
    follow = deep.get_answer(store, exp_id, answer["follow_up_of"]) if answer.get("follow_up_of") else None
    return build_context(
        exp, deep.read_page_text(store, exp_id), answer, deep.list_references(store, exp_id), follow,
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


@dataclass
class Job:
    ctx: Any                      # the WorkspaceContext (path, lock, explorations())
    exp_id: str
    answer_id: str
    trigger: Dict[str, Any] = field(default_factory=dict)


def request_trigger() -> Dict[str, Any]:
    """The current request's model-call trigger, with surface ``deep-ask`` (call it in the route)."""
    trig = model_log.get_trigger()
    trig["surface"] = SURFACE
    return trig


class DeepAskRunner:
    def __init__(self, max_in_flight: int = MAX_IN_FLIGHT):
        self.max_in_flight = max_in_flight
        self._queues: Dict[str, Deque[Job]] = {}
        self._running: Dict[str, int] = {}
        self._tracked: Dict[str, Set[str]] = {}
        self._recovered: Set[str] = set()
        self._tasks: Set[asyncio.Task] = set()
        self.max_seen: Dict[str, int] = {}

    @staticmethod
    def _key(ctx) -> str:
        return str(Path(ctx.path))

    async def ensure_recovered(self, ctx) -> int:
        """Once per workspace per process: answers left queued/running by a previous daemon become interrupted."""
        key = self._key(ctx)
        if key in self._recovered:
            return 0
        self._recovered.add(key)
        async with ctx.lock:
            n = await asyncio.to_thread(deep.interrupt_pending, ctx.explorations(), set(self._tracked.get(key, ())))
        if n:
            logger.info(f"deep-ask: marked {n} unfinished answer(s) interrupted in {key}")
        return n

    def schedule(self, job: Job) -> None:
        key = self._key(job.ctx)
        self._queues.setdefault(key, deque()).append(job)
        self._tracked.setdefault(key, set()).add(job.answer_id)
        self._pump(key)

    def _pump(self, key: str) -> None:
        queue = self._queues.get(key)
        while queue and self._running.get(key, 0) < self.max_in_flight:
            job = queue.popleft()
            self._running[key] = self._running.get(key, 0) + 1
            self.max_seen[key] = max(self.max_seen.get(key, 0), self._running[key])
            task = asyncio.get_running_loop().create_task(self._run(key, job))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run(self, key: str, job: Job) -> None:
        try:
            await run_job(job)
        except Exception:
            logger.exception(f"deep-ask {job.answer_id} failed outside the model call")
        finally:
            self._running[key] = max(0, self._running.get(key, 1) - 1)
            self._tracked.get(key, set()).discard(job.answer_id)
            self._pump(key)

    def pending(self, ctx) -> Set[str]:
        return set(self._tracked.get(self._key(ctx), ()))

    async def drain(self) -> None:
        """Wait for every queued and running job (tests, shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


async def run_job(job: Job) -> Optional[Dict[str, Any]]:
    ctx, exp_id, aid = job.ctx, job.exp_id, job.answer_id
    store = ctx.explorations()
    async with ctx.lock:
        answer = await asyncio.to_thread(deep.update_answer, store, exp_id, aid, {"status": "running"})
        if answer is None:
            return None
        context = await asyncio.to_thread(context_for, store, exp_id, answer)
    steward_context = INSTRUCTION + "\n\n" + context
    token = model_log.current_trigger.set(dict(job.trigger) if job.trigger else {"kind": "unknown", "surface": SURFACE})
    fields: Dict[str, Any]
    try:
        with model_log.collect_calls() as calls:
            text = await steward.call_model(Path(ctx.path), SURFACE, answer["question"], steward_context, steward.new_request_id())
        fields = {"status": "done", "answer": text.strip(), "answered_at": iso_s(utc_now()), "error": None}
        last = next((c for c in reversed(calls) if c.get("ok")), calls[-1] if calls else None)
        if last is not None:
            fields["model"] = {"location": "local" if last.get("location") == "local" else "cloud", "name": last.get("name") or ""}
    except Exception as e:
        logger.warning(f"deep-ask {aid} in {exp_id}: {e}")
        fields = {"status": "error", "error": _clip(str(e) or type(e).__name__, deep.MAX_ERROR)}
    finally:
        model_log.reset_trigger(token)
    async with ctx.lock:
        answer = await asyncio.to_thread(deep.update_answer, store, exp_id, aid, fields)
    try:
        lee_events.ingest("deep.answer", {
            "workspace": str(ctx.path), "exploration_id": exp_id, "answer_id": aid, "status": fields["status"],
        }, workspace=str(ctx.path), actor={"kind": "hester"})
    except Exception as e:  # never fail a run over telemetry
        logger.debug(f"could not log deep.answer: {e}")
    return answer


_runner = DeepAskRunner()


def get_runner() -> DeepAskRunner:
    return _runner
