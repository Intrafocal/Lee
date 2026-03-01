"""
Response rendering with mermaid diagram and inline image support.

Splits response text into segments (markdown, mermaid code fences, base64 images)
and renders each appropriately:
- Text: Rich Markdown
- Mermaid: PNG via mmdc + iTerm2 inline image, fallback to syntax panel
- Base64 images: iTerm2 inline image, fallback to placeholder panel
"""

import base64
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional

from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.syntax import Syntax


# --- Terminal capability detection (evaluated once at import time) ---

_SUPPORTS_INLINE_IMAGES: bool = os.environ.get("TERM_PROGRAM") in (
    "iTerm.app",
    "WezTerm",
)


# --- Segment types ---


class SegmentType(Enum):
    TEXT = "text"
    MERMAID = "mermaid"
    IMAGE = "image"


@dataclass
class Segment:
    type: SegmentType
    content: str = ""
    title: str = ""
    data: str = ""  # base64 data for images
    mime_type: str = ""


# --- Regex patterns ---

# Match ```mermaid ... ``` blocks (with optional title comment on first line)
MERMAID_PATTERN = re.compile(r"```mermaid\n(.*?)```", re.DOTALL)

# Match ![alt](data:image/TYPE;base64,DATA)
IMAGE_PATTERN = re.compile(
    r"!\[([^\]]*)\]\(data:image/(\w+);base64,([A-Za-z0-9+/=\s]+)\)"
)


def _split_into_segments(text: str) -> List[Segment]:
    """Split response text into typed segments for rendering."""
    segments: List[Segment] = []
    # Combine both patterns with named groups
    combined = re.compile(
        r"(?P<mermaid>```mermaid\n(?P<mermaid_body>.*?)```)"
        r"|"
        r"(?P<image>!\[(?P<img_alt>[^\]]*)\]\(data:image/(?P<img_type>\w+);base64,(?P<img_data>[A-Za-z0-9+/=\s]+)\))",
        re.DOTALL,
    )

    last_end = 0
    for match in combined.finditer(text):
        # Add any text before this match
        if match.start() > last_end:
            preceding = text[last_end : match.start()].strip()
            if preceding:
                segments.append(Segment(type=SegmentType.TEXT, content=preceding))

        if match.group("mermaid"):
            dsl = match.group("mermaid_body").strip()
            # Try to extract a title from the first line if it's a %% comment
            title = ""
            lines = dsl.split("\n")
            if lines and lines[0].strip().startswith("%%"):
                title = lines[0].strip().lstrip("%").strip()
            segments.append(
                Segment(type=SegmentType.MERMAID, content=dsl, title=title)
            )
        elif match.group("image"):
            segments.append(
                Segment(
                    type=SegmentType.IMAGE,
                    title=match.group("img_alt"),
                    data=match.group("img_data").replace("\n", "").replace(" ", ""),
                    mime_type=match.group("img_type"),
                )
            )

        last_end = match.end()

    # Add any remaining text
    if last_end < len(text):
        remaining = text[last_end:].strip()
        if remaining:
            segments.append(Segment(type=SegmentType.TEXT, content=remaining))

    # If nothing matched, return the whole text as a single segment
    if not segments and text.strip():
        segments.append(Segment(type=SegmentType.TEXT, content=text))

    return segments


def render_response(console: Console, text: str) -> None:
    """Render response with mermaid diagrams and inline images."""
    segments = _split_into_segments(text)
    for seg in segments:
        if seg.type == SegmentType.TEXT:
            console.print(Markdown(seg.content))
        elif seg.type == SegmentType.MERMAID:
            _render_mermaid(console, seg.content, seg.title)
        elif seg.type == SegmentType.IMAGE:
            _render_image(console, seg.data, seg.mime_type, seg.title)


def _render_mermaid(console: Console, dsl: str, title: str) -> None:
    """Try mmdc -> PNG -> inline image. Fallback: syntax panel."""
    png_data = _mmdc_render(dsl)
    if png_data and _SUPPORTS_INLINE_IMAGES:
        _print_iterm2_image(png_data, title or "Diagram")
    else:
        # Fallback: show DSL in a labeled panel with syntax highlighting
        panel_title = title or "Diagram"
        console.print(
            Panel(
                Syntax(dsl, "text", theme="monokai"),
                title=f"[bold]Mermaid: {panel_title}[/bold]",
                border_style="dim",
            )
        )


def _render_image(
    console: Console, b64_data: str, mime_type: str, title: str
) -> None:
    """Display image inline or show placeholder."""
    if _SUPPORTS_INLINE_IMAGES:
        try:
            raw = base64.b64decode(b64_data)
            _print_iterm2_image(raw, title or "Image")
        except Exception:
            console.print(
                Panel(f"[dim]Image: {title or 'Generated'}[/dim]", border_style="dim")
            )
    else:
        console.print(
            Panel(f"[dim]Image: {title or 'Generated'}[/dim]", border_style="dim")
        )


def _mmdc_render(dsl: str) -> Optional[bytes]:
    """Render mermaid DSL to PNG via mmdc CLI. Returns PNG bytes or None."""
    inp_path = None
    out_path = None
    try:
        with tempfile.NamedTemporaryFile(
            suffix=".mmd", mode="w", delete=False
        ) as inp:
            inp.write(dsl)
            inp_path = inp.name

        out_path = inp_path.replace(".mmd", ".png")

        result = subprocess.run(
            ["mmdc", "-i", inp_path, "-o", out_path, "-b", "transparent"],
            capture_output=True,
            timeout=15,
        )

        if result.returncode == 0:
            with open(out_path, "rb") as f:
                return f.read()
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        for path in (inp_path, out_path):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


def _print_iterm2_image(data: bytes, title: str = "") -> None:
    """Print image using iTerm2 OSC 1337 inline image protocol."""
    b64 = base64.b64encode(data).decode("ascii")
    name_b64 = base64.b64encode((title or "image").encode()).decode("ascii")
    sys.stdout.write(f"\033]1337;File=name={name_b64};inline=1:{b64}\a\n")
    sys.stdout.flush()
