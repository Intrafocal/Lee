"""
The vocabulary hint: the words a transcript should spell the way you do.

Deterministic, at most 40 terms and 1500 characters, most specific first:

1. ``purpose=reply``: the attention item's title and text (Lee ``GET /attention/:id``);
   an ``item_id`` that is a Page card (any purpose, and ``send``'s target): its title and headings;
   a Board card (``bd-``): its title and its annotations' text (short ones whole, else the names);
2. Lee's live context: tab labels and open file basenames;
3. the workspace's name.

From running text only the words that look like names are kept (a capital,
a digit, ``_``, ``-``, ``.`` or ``/`` inside); labels, titles and headings go
in whole. Never logged or stored.
"""

import logging
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import httpx

from ...shared.auth import auth_headers

logger = logging.getLogger("hester.daemon.voice.hints")

MAX_TERMS = 40
MAX_CHARS = 1500
MAX_TERM = 80
MAX_HEADINGS = 12
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_./\-]*[A-Za-z0-9]")
_NAMEY_RE = re.compile(r"[A-Z0-9_./\-]")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
_STOP = {"I", "A", "The", "This", "That", "It", "We", "You", "OK", "Ok"}


def name_words(text: Any) -> List[str]:
    """The name-like words in running text, in order."""
    s = str(text or "")
    out = []
    for m in _WORD_RE.finditer(s):
        w = m.group(0).strip(".-/")
        if len(w) < 2 or w in _STOP:
            continue
        if _NAMEY_RE.search(w[1:]):  # camelCase, ACRONYM, snake_case, dotted.name, a/path, v2
            out.append(w)
        elif w[0].isupper():
            before = s[:m.start()].rstrip()
            if before and before[-1] not in ".!?:":  # capitalised mid-sentence: a name
                out.append(w)
    return out


def headings(page: str) -> List[str]:
    out = []
    for line in (page or "").splitlines():
        m = _HEADING_RE.match(line)
        if m:
            out.append(m.group(1).strip())
            if len(out) >= MAX_HEADINGS:
                break
    return out


def context_terms(lee_context: Any) -> List[str]:
    """Tab labels and open file basenames from ``app_state.lee_client.context`` (a LeeContext or a dict)."""
    if lee_context is None:
        return []
    ctx = lee_context.model_dump() if hasattr(lee_context, "model_dump") else lee_context
    if not isinstance(ctx, dict):
        return []
    out: List[str] = []
    editor = ctx.get("editor") if isinstance(ctx.get("editor"), dict) else {}
    if editor.get("file"):
        out.append(Path(str(editor["file"])).name)
    for tab in ctx.get("tabs") or []:
        if isinstance(tab, dict) and tab.get("label"):
            out.append(str(tab["label"]))
    return out


def page_terms(workspace: Optional[Path], card_id: str) -> List[str]:
    """A Page card's title and headings (the Desk store; nothing when it isn't there)."""
    if workspace is None:
        return []
    try:
        from ..cockpit.desk import DeskStore, is_page_id

        if not is_page_id(card_id):
            return []
        pages = DeskStore(workspace).pages
        card = pages.get(card_id)
        if card is None:
            return []
        return [str(card.get("title") or "")] + headings(pages.page_text(card_id))
    except Exception:
        return []


MAX_NOTE_TERM_WORDS = 4
_LINK_RE = re.compile(r"\[\[(?:pg|bd)-[0-9a-f]{8}(?:\|([^\]]*))?\]\]")


def board_terms(workspace: Optional[Path], card_id: str) -> List[str]:
    """
    A Board card's title, then its annotations: a short one (a few words) whole,
    the linked cards' titles and the name-like words of the rest. Nothing when it isn't there.
    """
    if workspace is None:
        return []
    try:
        from ..cockpit.board import note_texts
        from ..cockpit.desk import DeskStore, is_board_id

        if not is_board_id(card_id):
            return []
        boards = DeskStore(workspace).boards
        card = boards.get(card_id)
        if card is None:
            return []
        out = [str(card.get("title") or "")]
        for note in note_texts(boards.items(card_id)):
            out.extend(t for t in _LINK_RE.findall(note) if t)
            text = _LINK_RE.sub(" ", note)
            if 0 < len(text.split()) <= MAX_NOTE_TERM_WORDS:
                out.append(text)
            out.extend(name_words(text))
        return out
    except Exception:
        return []


def item_terms(item: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(item, dict):
        return []
    title = str(item.get("title") or "")
    return ([title] if title else []) + name_words(title) + name_words(item.get("text"))


def build_hint(*groups: Iterable[str], max_terms: int = MAX_TERMS, max_chars: int = MAX_CHARS) -> List[str]:
    """Terms from each group in order, deduplicated ignoring case, within both caps."""
    out: List[str] = []
    seen = set()
    used = 0
    for group in groups:
        for raw in group or []:
            term = " ".join(str(raw or "").split())[:MAX_TERM].strip()
            key = term.lower()
            if not term or key in seen:
                continue
            cost = len(term) + (2 if out else 0)
            if used + cost > max_chars:
                continue
            seen.add(key)
            out.append(term)
            used += cost
            if len(out) >= max_terms:
                return out
    return out


async def fetch_attention_item(item_id: str, timeout: float = 2.0) -> Optional[Dict[str, Any]]:
    """Lee's ``GET /attention/:id`` (as ``fetch_attention_items`` in copilot/routes.py); None when unreachable."""
    from ..copilot import lee_events

    if not item_id or not re.match(r"^[A-Za-z0-9_.:\-]{1,128}$", item_id):
        return None
    url = f"{lee_events.get_client().lee_url}/attention/{item_id}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=auth_headers())
    except Exception:
        return None
    if resp.status_code != 200:
        return None
    try:
        data = resp.json().get("data")
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def hint_for(
    purpose: str,
    item_id: Optional[str],
    workspace: Optional[Path],
    lee_context: Any = None,
    fetch_item=fetch_attention_item,
) -> List[str]:
    """The hint for one transcription (the route's inputs; ``fetch_item`` is replaceable in tests)."""
    first: List[str] = []
    if item_id:
        first = page_terms(workspace, item_id) or board_terms(workspace, item_id)
        if not first and purpose == "reply":
            first = item_terms(await fetch_item(item_id))
    return build_hint(first, context_terms(lee_context), [workspace.name] if workspace else [])
