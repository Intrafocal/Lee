"""
Plain text from agent words, for stored titles.

A Python port of the renderer's helpers in
``electron/src/renderer/lib/cockpitModel.ts`` (stripMarkdown, looksLikeCode,
plainTitle): fenced code (including lee-status) is dropped, markdown markup is
stripped, code-looking lines are skipped and the first real sentence is kept,
clipped at a word boundary. Keep the two in step.
"""

import re
from typing import Any, List

_FENCE_OPEN = re.compile(r"^[ \t]*(`{3,}|~{3,})")
_BARE_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[ \t]*$")


def _strip_inline(line: str) -> str:
    s = line
    s = re.sub(r"</?[A-Za-z][^>]*>", "", s)  # HTML tags
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)  # images -> alt
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)  # [t](u) -> t
    s = re.sub(r"\[([^\]]+)\]\[[^\]]*\]", r"\1", s)  # [t][ref] -> t
    s = re.sub(r"<((?:https?|mailto):[^>\s]+)>", r"\1", s)  # <autolink>
    s = re.sub(r"(`+)([^`]*?)\1", r"\2", s)  # inline code keeps its text
    s = re.sub(r"(\*\*|__)(?=\S)([\s\S]*?\S)\1", r"\2", s)  # bold
    s = re.sub(r"~~(?=\S)([\s\S]*?\S)~~", r"\1", s)  # strikethrough
    s = re.sub(r"(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)", r"\1\2", s)  # *em*
    s = re.sub(r"(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)", r"\1\2", s)  # _em_ (not snake_case)
    return re.sub(r"\s+", " ", s).strip()


_CODE_KEYWORD = re.compile(r"^(const|let|var|function|def|class|import|export|return|async|await|package|public|private)\s+\S")


def looks_like_code(line: str) -> bool:
    """Does a (stripped) line look like source code rather than prose?"""
    s = line.strip()
    if not s:
        return False
    if re.match(r"^(//|/\*|\*/|#!|#include\b)", s):
        return True
    if re.search(r",\s*$", s) and len(s.split()) <= 4:
        return True
    if re.search(r"\$\{|=>|\)\s*\{|;\s*$|^[)}\]]|[{\[(]\s*$|['\"`],\s*$|^['\"`][^'\"`]*['\"`],?$", s):
        return True
    if _CODE_KEYWORD.match(s) and re.search(r"[=(){};]", s):
        return True
    if re.match(r"^[\w.$\[\]]+\s*[-+*/]?=\s*[^=\s]", s):
        return True
    sym = len(re.findall(r"[{}\[\]();=<>$|&\\]", re.sub(r"\w\(\)", "x", s)))
    return sym >= 3 and sym / len(s) > 0.08


def strip_markdown(text: Any) -> List[str]:
    """Markdown to plain lines; blank lines kept as '' (paragraph breaks)."""
    if not text:
        return []
    out: List[str] = []
    fence = None
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    fences = [i for i, l in enumerate(lines) if _FENCE_OPEN.match(l)]
    if len(fences) % 2 == 1 and _BARE_FENCE.match(lines[fences[0]]) and any(looks_like_code(l) for l in lines[: fences[0]]):
        lines = lines[fences[0] + 1:]
    for raw in lines:
        m = _FENCE_OPEN.match(raw)
        if fence is not None:
            t = raw.strip()
            if m and t[0] == fence[0] and len(t) >= len(fence) and re.fullmatch(r"`+|~+", t):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        line = raw.strip()
        if not line:
            if out and out[-1] != "":
                out.append("")
            continue
        if re.fullmatch(r"([-*_])(\s*\1){2,}", line):
            continue
        if re.fullmatch(r"\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?", line):
            continue
        line = re.sub(r"^(>\s?)+", "", line)
        line = re.sub(r"\s+#+$", "", re.sub(r"^#{1,6}\s+", "", line))
        line = re.sub(r"^([-*+]|\d{1,3}[.)])\s+", "", line)
        line = re.sub(r"^\[[ xX]\]\s+", "", line)
        if line.startswith("|") and line.endswith("|") and len(line) > 1:
            line = " · ".join(c.strip() for c in line[1:-1].split("|") if c.strip())
        line = _strip_inline(line)
        if line:
            out.append(line)
    while out and out[-1] == "":
        out.pop()
    return out


def _clip_words(s: str, limit: int) -> str:
    if len(s) <= limit:
        return s
    cut = s[: limit - 1]
    sp = cut.rfind(" ")
    head = cut[:sp] if sp > limit * 0.5 else cut
    return re.sub(r"[\s,;:.–—-]+$", "", head) + "…"


def plain_title(text: Any, limit: int = 80) -> str:
    """The first meaningful, non-code sentence of agent words; '' if none."""
    line = next((l for l in strip_markdown(text) if l and not looks_like_code(l) and re.search(r"[A-Za-z]{2}", l)), None)
    if not line:
        return ""
    m = re.match(r"^(.+?[.!?])(?=\s+\S)", line)
    sentence = m.group(1) if m and len(m.group(1)) >= 16 else line
    return _clip_words(re.sub(r"[:;,]\s*$", "", sentence), limit)
