"""
deep-ask: Ask, don't wait (Deep D1 contract section 6; spec 14 section 5.3).

``POST /cockpit/explorations/{id}/asks`` appends a queued Answer and hands it
here. Each run is one non-streaming agent turn through ``steward.call_model``
with surface ``deep-ask``: Hester's hybrid routing and model-call logging as
they are, and no ``steward.md`` (``deep-ask`` isn't a steer surface), no
proposals and no steer. The answer lands in ``answers.jsonl``; Lee hears about
it through the ingested ``deep.answer`` event and nothing else happens: no
notification, no toast, no attention item.

A Visualize on a Board (``kind: 'visualize'``, Boards B6) runs here too, as
an Ask does, but through Hester's diagram agent (visualize.py); its result
lands in the answer's ``visual``.

An Ask on a Board (a ``bd-`` card) is the exception to the routing: it sends
the selection Lee flattened (the anchor's snapshot PNG) with the annotations
in it straight to Gemini, which reads images, with the voice package's key
and model. It never goes to a local model; with no Gemini key it ends in
``error`` saying so.

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
from typing import Any, Deque, Dict, List, Optional, Set, Tuple

from ..copilot import lee_events, model_log
from . import deep, steward
from .explorations import ExplorationError, ExplorationStore, _clip, utc_now
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
# Asks on a Board (plan docs/plans/2026-09-28-boards.md §3): the selection as an image
# ---------------------------------------------------------------------------

BOARD_INSTRUCTION = (
    "You're answering a question the user asked about part of their Board, a canvas of images they mark up "
    "while thinking. The image is what they selected: the images with their highlights and drawing. Answer "
    "the question directly and concisely, in markdown. Don't offer to do more, don't ask questions back, and "
    "don't propose actions."
)
BOARD_TIMEOUT_S = 120
NO_GEMINI = (
    "Asks on a Board need Gemini, which reads images: set hester.google_api_key in ~/.lee/config.yaml "
    "or export GOOGLE_API_KEY"
)


class BoardAskError(Exception):
    """A Board Ask that can't run; the message is the answer's error."""


def build_board_prompt(
    card: Dict[str, Any],
    answer: Dict[str, Any],
    all_notes: List[str],
    follow_up: Optional[Dict[str, Any]] = None,
    cap: int = CONTEXT_CAP,
) -> str:
    """
    The instruction; the Board's title; the annotations in the selection (every
    annotation on the Board when the Ask has no selection); the followed-up
    question and answer; then the question. The image goes beside it.
    """
    anchor = answer.get("anchor") or {"kind": "none"}
    parts = [BOARD_INSTRUCTION, f"### Board\n\nTitle: {card.get('title') or ''}"]
    if anchor.get("kind") == "board":
        notes = [n for n in anchor.get("notes") or [] if isinstance(n, str) and n.strip()]
        if notes:
            parts.append("### The annotations in the selection\n\n" + "\n".join(f"- {' '.join(n.split())}" for n in notes))
    elif all_notes:
        parts.append("### The Board's annotations (nothing was selected; there's no image)\n\n"
                     + "\n".join(f"- {' '.join(n.split())}" for n in all_notes))
    if follow_up:
        parts.append(
            "### This follows up an earlier question\n\n"
            f"Question: {follow_up.get('question') or ''}\n\nAnswer: {follow_up.get('answer') or '(none)'}"
        )
    parts.append(f"### The question\n\n{answer.get('question') or ''}")
    text = "\n\n".join(parts)
    return text if len(text) <= cap else text[: cap - 1] + "…"


def board_prompt_for(store, card_id: str, answer: Dict[str, Any]) -> Tuple[str, Optional[bytes]]:
    """(the prompt, the selection's PNG or None) for a Board Ask."""
    from .board import note_texts

    card = store.require(card_id)
    follow = deep.get_answer(store, card_id, answer["follow_up_of"]) if answer.get("follow_up_of") else None
    anchor = answer.get("anchor") or {}
    image = None
    if anchor.get("kind") == "board":
        try:
            image = store.snapshot_path(card_id, anchor.get("snapshot")).read_bytes()
        except (OSError, ExplorationError):
            raise BoardAskError("the selection's image is gone; ask again from the Board")
    return build_board_prompt(card, answer, note_texts(store.items(card_id)), follow), image


def _gemini_client(api_key: str):
    from google import genai

    return genai.Client(api_key=api_key)


async def ask_with_image(workspace: Path, prompt: str, image: Optional[bytes]) -> Tuple[str, str]:
    """
    One Gemini call with the image as a part: the voice package's key and
    Gemini model (``hester.google_api_key``, ``hester.voice.gemini_model``).
    Never a local model. The daemon's class-level wrap logs it as a
    ``model.call`` with the job's trigger. Returns (answer, model).
    """
    from ..voice.config import google_api_key, load_voice_config

    key = google_api_key(workspace)
    if not key:
        raise BoardAskError(NO_GEMINI)
    model = load_voice_config(workspace).gemini_model
    contents: List[Any] = [prompt]
    if image is not None:
        from google.genai import types

        contents.append(types.Part.from_bytes(data=image, mime_type="image/png"))
    client = _gemini_client(key)
    try:
        response = await asyncio.wait_for(
            client.aio.models.generate_content(model=model, contents=contents), BOARD_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise BoardAskError("Gemini took too long; try again")
    except Exception as e:
        raise BoardAskError(f"Gemini couldn't answer ({type(e).__name__}); try again")
    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise BoardAskError("Gemini gave an empty answer; try again")
    return text, model


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
        stores = [ctx.desk().pages, ctx.desk().boards] if which == "desk" else [ctx.explorations()]
        keep = set(self._tracked.get(key, ()))
        n = 0
        async with ctx.lock:
            for store in stores:
                n += await asyncio.to_thread(deep.interrupt_pending, store, keep)
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
    from .desk import is_board_id, is_card_id, store_for

    ctx, exp_id, aid = job.ctx, job.exp_id, job.answer_id
    store = store_for(ctx, exp_id)
    board = is_board_id(exp_id)  # a Board's Ask goes to Gemini with the selection's image
    image: Optional[bytes] = None
    prep_error: Optional[str] = None
    visual = False
    async with ctx.lock:
        answer = await asyncio.to_thread(deep.update_answer, store, exp_id, aid, {"status": "running"})
        if answer is None:
            return None
        visual = board and deep.is_visualize(answer)  # B6: the diagram agent, not an Ask (visualize.py)
        if board:
            try:
                if visual:
                    from . import visualize

                    context, image = await asyncio.to_thread(visualize.prompt_for, store, exp_id, answer)
                else:
                    context, image = await asyncio.to_thread(board_prompt_for, store, exp_id, answer)
            except BoardAskError as e:
                context, prep_error = "", str(e)
        else:
            context = await asyncio.to_thread(context_for, store, exp_id, answer)
    token = model_log.current_trigger.set(dict(job.trigger) if job.trigger else {"kind": "unknown", "surface": SURFACE})
    fields: Dict[str, Any]
    try:
        if prep_error:
            raise BoardAskError(prep_error)
        model_name = None
        made: Optional[Dict[str, Any]] = None
        with model_log.collect_calls() as calls:
            if visual:
                from . import visualize

                text, raw, model_name = await visualize.run_agent(Path(ctx.path), context, image)
                async with ctx.lock:
                    made = await asyncio.to_thread(visualize.save_result, store, exp_id, aid, raw)
            elif board:
                text, model_name = await ask_with_image(Path(ctx.path), context, image)
            else:
                steward_context = INSTRUCTION + "\n\n" + context
                text = await steward.call_model(Path(ctx.path), SURFACE, answer["question"], steward_context, steward.new_request_id())
        fields = {"status": "done", "answer": text.strip(), "answered_at": iso_s(utc_now()), "error": None}
        if made is not None:
            fields["visual"] = made
        last = next((c for c in reversed(calls) if c.get("ok")), calls[-1] if calls else None)
        if last is not None:
            fields["model"] = {"location": "local" if last.get("location") == "local" else "cloud", "name": last.get("name") or ""}
        elif model_name:
            fields["model"] = {"location": "cloud", "name": model_name}
    except Exception as e:
        logger.warning(f"deep-ask {aid} in {exp_id}: {e}")
        fields = {"status": "error", "error": _clip(str(e) or type(e).__name__, deep.MAX_ERROR)}
    finally:
        model_log.reset_trigger(token)
    async with ctx.lock:
        answer = await asyncio.to_thread(deep.update_answer, store, exp_id, aid, fields)
    try:
        data = {"workspace": str(ctx.path), "exploration_id": exp_id, "answer_id": aid, "status": fields["status"]}
        if is_card_id(exp_id):
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
