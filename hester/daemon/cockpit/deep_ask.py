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
    In order: the title and seed; the section the question is about (Deep next
    R2, ``section_text`` when the Ask sent one); the anchor's section and the
    quote with ±1 000 chars around it; the rest of the Page (cut from the far end); open
    questions; the last 20 references; the followed-up question and answer.
    The Page gets whatever the other parts leave of ``cap``. A Page card (Desk
    D2) is headed ``### Page``; its title and seed play the same part.
    """
    noun = "Page" if str(exp.get("id") or "").startswith("pg-") else "Exploration"
    head = f"### {noun}\n\nTitle: {exp.get('title') or ''}"
    if exp.get("seed"):
        head += f"\n\nSeed:\n{exp['seed']}"

    section_text = answer.get("section_text")
    section_part = ""
    if isinstance(section_text, str) and section_text.strip():
        section_part = "### The section this is about\n\n" + section_text.strip("\n")

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

    fixed = [p for p in (head, section_part, anchor_part, q_part, ref_part, follow_part) if p]
    budget = cap - sum(len(p) + 2 for p in fixed) - 40
    page_part = ""
    if page.strip() and budget > 0:
        page_part = "### The Page\n\n" + _window(page, center, budget)
    parts = [p for p in (head, section_part, anchor_part, page_part, q_part, ref_part, follow_part) if p]
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
    ctx: Any                      # the WorkspaceContext (path, lock, explorations(), desk())
    exp_id: str                   # an exploration id, or a Page card's (``pg-``; Desk D2)
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

    async def ensure_recovered(self, ctx, which: str = "explore") -> int:
        """
        Once per workspace per store per process: answers left queued/running
        by a previous daemon become interrupted. ``which`` is ``explore`` (the
        explorations) or ``desk`` (Page cards), so a Desk read never writes
        into ``.hester/explore/``.
        """
        key = self._key(ctx)
        if (key, which) in self._recovered:
            return 0
        self._recovered.add((key, which))
        store = ctx.desk().pages if which == "desk" else ctx.explorations()
        async with ctx.lock:
            n = await asyncio.to_thread(deep.interrupt_pending, store, set(self._tracked.get(key, ())))
        if n:
            logger.info(f"deep-ask: marked {n} unfinished answer(s) interrupted in {key} ({which})")
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
    from .desk import is_page_id, store_for

    ctx, exp_id, aid = job.ctx, job.exp_id, job.answer_id
    store = store_for(ctx, exp_id)
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
        data = {"workspace": str(ctx.path), "exploration_id": exp_id, "answer_id": aid, "status": fields["status"]}
        if is_page_id(exp_id):
            data["card_id"] = exp_id  # Desk D2 §5.3: both, so a Lee main from before the Desk still forwards it
        lee_events.ingest("deep.answer", data, workspace=str(ctx.path), actor={"kind": "hester"})
    except Exception as e:  # never fail a run over telemetry
        logger.debug(f"could not log deep.answer: {e}")
    return answer


_runner = DeepAskRunner()


def get_runner() -> DeepAskRunner:
    return _runner


# ---------------------------------------------------------------------------
# Draft from README (Deep next R12)
# ---------------------------------------------------------------------------

README_SURFACE = "goals-readme"
README_FILES = ("README.md", "CLAUDE.md")
README_CAP = 12000
GOALS_PROMPTS = (
    "What is this for, and who is it for?",
    "How will you know it's working?",
    "What won't you trade away?",
    "What pulls against what?",
)
README_INSTRUCTION = (
    "From the project files below, write a first guess at the answers to these four questions, as short "
    "markdown under exactly these four `##` headings, in this order:\n\n"
    + "\n".join(f"## {p}" for p in GOALS_PROMPTS)
    + "\n\nA few sentences or bullets under each. Say only what the files support; where they say nothing, "
    "write \"(the files don't say)\". Reply with the markdown only: no preamble, no code fence, no offers."
)


def readme_sources(workspace: Path, cap: int = README_CAP) -> Dict[str, str]:
    """``README.md`` and ``CLAUDE.md`` at the workspace root when present, each cut to ``cap`` chars."""
    out: Dict[str, str] = {}
    for name in README_FILES:
        path = Path(workspace) / name
        try:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if text.strip():
            out[name] = text if len(text) <= cap else text[: cap - 1] + "…"
    return out


def readme_context(sources: Dict[str, str]) -> str:
    return "\n\n".join(f"### {name}\n\n````markdown\n{text}\n````" for name, text in sources.items())


def strip_fence(text: str) -> str:
    """The model's markdown without a wrapping ``` fence, if it added one."""
    t = (text or "").strip()
    lines = t.splitlines()
    if len(lines) >= 2 and lines[0].startswith("```") and lines[-1].strip().startswith("```"):
        return "\n".join(lines[1:-1]).strip()
    return t


async def draft_from_readme(ctx, exp_id: str) -> Dict[str, Any]:
    """
    POST /draft-from-readme: a user action (C2). One agent turn with surface
    ``goals-readme`` (not a steer surface: no steward.md; Hester's hybrid
    routing). Returns ``{text}``; never writes the Page.
    """
    from .desk import store_for

    store = store_for(ctx, exp_id)
    async with ctx.lock:
        await asyncio.to_thread(store.require, exp_id)
    sources = await asyncio.to_thread(readme_sources, Path(ctx.path))
    if not sources:
        raise steward.StewardError("this workspace has no README.md or CLAUDE.md", 400)
    with model_log.surface_override(README_SURFACE):
        text = await steward.call_model(
            Path(ctx.path), README_SURFACE, README_INSTRUCTION, readme_context(sources), steward.new_request_id(),
        )
    return {"text": strip_fence(text), "sources": list(sources)}
