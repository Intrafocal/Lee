"""
Visualize on a Board (Boards B6; plan docs/plans/2026-09-28-boards.md §5b;
contract electron/src/shared/board.ts VisualResult).

``POST /desk/boards/{id}/visualize {brief, anchor}`` records a ``kind:
'visualize'`` answer (``deep.new_visualize``) and deep_ask's runner runs it
like an Ask: same queue, trigger, model-call log, ``deep.answer`` event,
interrupted on restart, Retry. The run is Hester's ``diagram`` agent from
the registries (``agents.yaml``: prompt ``visualize``, toolset ``diagram``,
its tier and step limit) given the Board's title, the selection's picture,
the annotations in it and the brief.

The agent runs in its own Gemini ReAct loop, never through the daemon agent's
prepare step: hybrid routing could hand an image to a local model, and the
selection must reach a model that reads images. The key is the voice
package's (``voice/config.google_api_key``), as for a Board Ask. Only the
toolset's visualization tools are declared (``render_mermaid``,
``generate_image``, ``render_markdown``); the brief and the picture are the
material.

The last visual the agent made is the answer's ``visual``: an image is saved
as a Board asset (``img-<hex>``, source ``{kind: 'answer', card_id,
answer_id}``); a Mermaid diagram or markdown is kept as text. Lee places it.
"""

import logging
from functools import partial
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..tools import visualization_tools
from .deep_ask import BoardAskError
from .explorations import ExplorationError, _clip

logger = logging.getLogger("hester.daemon.cockpit.visualize")

AGENT_ID = "diagram"
VISUAL_TOOLS = ("render_mermaid", "generate_image", "render_markdown")
VISUAL_TYPES = ("image", "mermaid", "markdown")
MAX_VISUAL_TEXT = 50_000
MAX_TITLE = 200
DEFAULT_ITERATIONS = 8
NO_GEMINI = (
    "Visualize needs Gemini, which reads images: set hester.google_api_key in ~/.lee/config.yaml "
    "or export GOOGLE_API_KEY"
)
NOTHING_MADE = "the diagram agent made nothing to place; try a clearer brief"


class VisualizeError(BoardAskError):
    """A Visualize that can't run or made nothing; the message is the answer's error."""


# ---------------------------------------------------------------------------
# The request: the Board, the selection, the brief
# ---------------------------------------------------------------------------


def build_message(card: Dict[str, Any], answer: Dict[str, Any]) -> str:
    """The Board's title, the annotations in the selection, then the brief. The picture goes beside it."""
    anchor = answer.get("anchor") or {}
    parts = [f"### Board\n\nTitle: {card.get('title') or ''}"]
    notes = [n for n in anchor.get("notes") or [] if isinstance(n, str) and n.strip()]
    if notes:
        parts.append("### The annotations in the selection\n\n" + "\n".join(f"- {' '.join(n.split())}" for n in notes))
    parts.append("The image is the selection: the images with their highlights and drawing.")
    parts.append(f"### What to make\n\n{answer.get('brief') or answer.get('question') or ''}")
    return "\n\n".join(parts)


def prompt_for(store, card_id: str, answer: Dict[str, Any]) -> Tuple[str, bytes]:
    """(the message, the selection's PNG) for a Visualize."""
    card = store.require(card_id)
    anchor = answer.get("anchor") or {}
    try:
        image = store.snapshot_path(card_id, anchor.get("snapshot")).read_bytes()
    except (OSError, ExplorationError):
        raise VisualizeError("the selection's image is gone; visualize again from the Board")
    return build_message(card, answer), image


# ---------------------------------------------------------------------------
# The diagram agent
# ---------------------------------------------------------------------------


def _tier_model(tier: Any, workspace: Path) -> str:
    """The Gemini model for a registry tier (the daemon's settings), else the voice package's model."""
    name = str(getattr(tier, "value", tier) or "STANDARD").upper()
    try:
        from ..settings import get_settings

        s = get_settings()
        return {
            "QUICK": s.gemini_model_quick, "STANDARD": s.gemini_model_standard,
            "DEEP": s.gemini_model_deep, "REASONING": s.gemini_model_reasoning,
        }.get(name, s.gemini_model_standard)
    except Exception:
        from ..voice.config import load_voice_config

        return load_voice_config(workspace).gemini_model


def agent_setup(workspace: Path) -> Dict[str, Any]:
    """
    The ``diagram`` agent as the registries describe it: ``{system_prompt,
    tools, model, max_iterations}``. ``tools`` is its toolset's visualization tools.
    """
    from ..registries import get_agent_registry, get_prompt_registry

    agents = get_agent_registry()
    config = agents.get_agent(AGENT_ID)
    if config is None:
        raise VisualizeError("Hester's diagram agent isn't in its registry")
    template = get_prompt_registry().get_content(config.prompt)
    try:
        prompt = template.format(working_dir=str(workspace), tools_description="", editor_context="")
    except (KeyError, IndexError, ValueError):
        prompt = template
    toolset = set(agents.resolve_tools(config.toolset))
    return {
        "system_prompt": prompt,
        "tools": [t for t in VISUAL_TOOLS if t in toolset],
        "model": _tier_model(config.model_tier, workspace),
        "max_iterations": config.max_iterations or DEFAULT_ITERATIONS,
    }


def _capability(api_key: str, model: str):
    """A Gemini ReAct loop of its own (tests replace this)."""
    from ...shared.react.capability import ReActCapability

    return ReActCapability(api_key=api_key, model=model)


def _handlers(workspace: Path, seen: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The visualization tools, each result copied into ``seen`` before the loop pops ``_image_data``."""
    fns = {
        "render_mermaid": visualization_tools.execute_render_mermaid,
        "generate_image": partial(visualization_tools.execute_generate_image, working_dir=str(workspace)),
        "render_markdown": visualization_tools.execute_render_markdown,
    }

    def capturing(fn):
        async def run(**kwargs):
            result = await fn(**kwargs)
            if isinstance(result, dict) and result.get("type") in VISUAL_TYPES:
                seen.append(dict(result))
            return result
        return run

    return {name: capturing(fn) for name, fn in fns.items()}


async def run_agent(workspace: Path, message: str, image: bytes) -> Tuple[str, Dict[str, Any], str]:
    """
    One run of the diagram agent with the selection as an image part. Returns
    (its short text, the last visual tool result, the model). VisualizeError
    when there's no key, the loop fails or nothing visual was made.
    """
    from ..tools.definitions import VISUALIZATION_TOOLS
    from ..voice.config import google_api_key

    key = google_api_key(workspace)
    if not key:
        raise VisualizeError(NO_GEMINI)
    setup = agent_setup(workspace)
    seen: List[Dict[str, Any]] = []
    handlers = _handlers(workspace, seen)
    loop = _capability(key, setup["model"])
    loop.register_tools(
        [{"name": t.name, "description": t.description, "parameters": t.parameters}
         for t in VISUALIZATION_TOOLS if t.name in setup["tools"]],
        {name: fn for name, fn in handlers.items() if name in setup["tools"]},
    )
    messages = [{"role": "user", "content": message, "images": [{"data": image, "mime_type": "image/png"}]}]
    result = await loop.generate_with_tools(
        system_prompt=setup["system_prompt"], messages=messages,
        max_iterations=setup["max_iterations"], model=setup["model"], tool_filter=setup["tools"],
    )
    if not result.get("success"):
        raise VisualizeError(f"the diagram agent failed ({_clip(str(result.get('error') or 'error'), 120)}); try again")
    if not seen:
        if result.get("max_iterations_reached"):
            raise VisualizeError("the diagram agent ran out of steps; try again")
        raise VisualizeError(NOTHING_MADE)
    return str(result.get("text") or "").strip(), seen[-1], result.get("model_used") or setup["model"]


# ---------------------------------------------------------------------------
# The result (shared/board.ts VisualResult)
# ---------------------------------------------------------------------------


def _title(raw: Dict[str, Any], fallback: str) -> str:
    title = " ".join(str(raw.get("title") or "").split())
    return _clip(title or fallback, MAX_TITLE)


def _image_mime(data: bytes) -> str:
    return "image/jpeg" if data[:3] == b"\xff\xd8\xff" else "image/png"


def save_result(store, card_id: str, answer_id: str, raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    A tool result -> the answer's VisualResult. An image becomes a Board asset
    whose source is this answer; a diagram or markdown is kept as text.
    """
    kind = raw.get("type")
    if kind == "image":
        data = raw.get("_image_data")
        if not isinstance(data, (bytes, bytearray)) or not data:
            raise VisualizeError("the generated image didn't arrive; try again")
        try:
            row = store.add_asset(card_id, _image_mime(bytes(data)), bytes(data), kind="image",
                                  source={"kind": "answer", "card_id": card_id, "answer_id": answer_id})
        except ExplorationError as e:
            raise VisualizeError(f"the generated image couldn't be kept ({e})")
        return {"type": "image", "asset": row["name"], "title": _title(raw, "Image")}
    text = str(raw.get("content") or "")
    if not text.strip():
        raise VisualizeError(NOTHING_MADE)
    text = _clip(text, MAX_VISUAL_TEXT)
    if kind == "mermaid":
        return {"type": "mermaid", "dsl": text, "title": _title(raw, "Diagram")}
    return {"type": "markdown", "text": text, "title": _title(raw, "Visualization")}
