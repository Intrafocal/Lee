"""
Hester CLI - Desk: read the workspace's Desk and Drawer (docs/16-Desk.md).

Read-only, straight from ``<workspace>/.hester/desk/`` and
``.hester/ideas/``; no daemon needed, and nothing is ever written (not even
the migration a daemon read would run, so an old ``put-away`` Drawer reads as
Stashed too). Plain text by default, for people
and for Claude Code (the ``lee:desk`` and ``lee:drawer`` skills), or --json.

Usage:
    hester desk overview            # Areas and their cards (Pages and Boards), the Goals card, the Drawer's counts, your last card
    hester desk page <id or title>  # one Page: its text, then answers, hand-offs, open questions, references, images
    hester desk board <id or title> # one Board: annotations, highlights, links, images (paths, sources), asks, hand-offs
    hester desk last                # your last card and where you stopped
    hester desk drawer [words...]   # Stashed Areas and Ideas, newest first; words filter (every word, any order)
"""

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import click

STASHED = ("stashed", "put-away")  # the Stashed Drawer; 'put-away' until the daemon's next Desk read rewrites it
PAGE_FILES = ("answers.jsonl", "references.jsonl", "questions.jsonl")


def _is_board(card_id: Any) -> bool:
    return isinstance(card_id, str) and card_id.startswith("bd-")


# ---------------------------------------------------------------------------
# Reading (never writing)
# ---------------------------------------------------------------------------


def find_workspace(start: Path) -> Optional[Path]:
    """The nearest directory at or above ``start`` with a Desk (a worktree inside the repo finds the repo's)."""
    here = start.expanduser().resolve()
    for d in (here, *here.parents):
        if (d / ".hester" / "desk" / "desk.json").is_file():
            return d
    return None


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _jsonl(path: Path) -> List[Dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


class Desk:
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.root = workspace / ".hester" / "desk"
        raw = _json(self.root / "desk.json") or {}
        self.areas: List[Dict[str, Any]] = [a for a in raw.get("areas") or [] if isinstance(a, dict)]
        self.cards: List[Dict[str, Any]] = [c for c in raw.get("cards") or [] if isinstance(c, dict)]
        self.drawers: List[Dict[str, Any]] = [d for d in raw.get("drawers") or [] if isinstance(d, dict)]
        self.goals_card_id: Optional[str] = raw.get("goals_card_id")
        self.last: Optional[Dict[str, Any]] = raw.get("last") if isinstance(raw.get("last"), dict) else None
        self.strokes = len(raw.get("strokes") or [])

    # ---- cards ----

    def page_dir(self, card_id: str) -> Path:
        """The card's folder: ``pages/<pg-id>`` or ``boards/<bd-id>``."""
        return self.root / ("boards" if _is_board(card_id) else "pages") / card_id

    def meta(self, card_id: str) -> Dict[str, Any]:
        return _json(self.page_dir(card_id) / "card.json") or {}

    def items(self, card_id: str) -> List[Dict[str, Any]]:
        """A Board's items (board.json); [] for a Page."""
        doc = _json(self.page_dir(card_id) / "board.json") if _is_board(card_id) else None
        items = (doc or {}).get("items") if isinstance(doc, dict) else None
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    def title(self, card_id: str) -> str:
        return str(self.meta(card_id).get("title") or "Untitled")

    def assets(self, card_id: str) -> List[str]:
        """The Page's images as paths relative to the Page (``assets/<name>``), oldest first."""
        d = self.page_dir(card_id) / "assets"
        try:
            files = [f for f in d.iterdir() if f.is_file() and not f.name.startswith(".")]
        except OSError:
            return []
        files.sort(key=lambda f: (f.stat().st_mtime, f.name))
        return [f"assets/{f.name}" for f in files]

    def text(self, card_id: str) -> str:
        if _is_board(card_id):
            return ""
        try:
            return (self.page_dir(card_id) / "page.md").read_text(encoding="utf-8")
        except OSError:
            return ""

    def cards_in(self, area_id: Optional[str]) -> List[Dict[str, Any]]:
        return [c for c in self.cards if c.get("area_id") == area_id and c.get("id") != self.goals_card_id]

    def area(self, area_id: Optional[str]) -> Optional[Dict[str, Any]]:
        return next((a for a in self.areas if a.get("id") == area_id), None)

    def find(self, ref: str) -> List[Dict[str, Any]]:
        """A card by id, else by title: exact (ignoring case), else every title containing it."""
        ref = ref.strip()
        by_id = [c for c in self.cards if c.get("id") == ref]
        if by_id:
            return by_id
        low = ref.lower()
        exact = [c for c in self.cards if self.title(c["id"]).lower() == low]
        return exact or [c for c in self.cards if low in self.title(c["id"]).lower()]

    def brief(self, card: Dict[str, Any]) -> Dict[str, Any]:
        m = self.meta(card["id"])
        area = self.area(card.get("area_id"))
        out = {
            "id": card["id"],
            "kind": card.get("kind") or m.get("kind") or ("board" if _is_board(card["id"]) else "page"),
            "title": m.get("title") or "Untitled",
            "area": (area or {}).get("name"),
            "area_id": card.get("area_id"),
            "stashed": bool(area and area.get("drawer_id")),
            "goals": card.get("id") == self.goals_card_id,
            "chars": len(self.text(card["id"])),
            "updated_at": m.get("updated_at"),
        }
        if _is_board(card["id"]):
            out["items"] = len(self.items(card["id"]))
        return out

    @staticmethod
    def size(b: Dict[str, Any]) -> str:
        """``page · 120 chars`` or ``board · 7 items``."""
        return f"board · {b.get('items', 0)} items" if b["kind"] == "board" else f"page · {b['chars']} chars"


def _last_line(text: str) -> Optional[str]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return lines[-1] if lines else None


def _ideas(workspace: Path) -> List[Dict[str, Any]]:
    try:
        from hester.daemon.copilot.ideas import IdeasStore

        items = IdeasStore(workspace).list("open")
    except Exception:
        return []
    out = [
        {"id": i.id, "text": i.text, "created_at": i.created_at, "surface": (i.source or {}).get("surface")}
        for i in items
    ]
    out.sort(key=lambda i: str(i["created_at"] or ""), reverse=True)
    return out


def _matches(words: List[str], *fields: Any) -> bool:
    hay = " ".join(str(f or "") for f in fields).lower()
    return all(w in hay for w in words)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _open(directory: str) -> Desk:
    ws = find_workspace(Path(directory))
    if ws is None:
        click.echo("No Desk here or above: Lee makes .hester/desk/ the first time Deep opens in a workspace.", err=True)
        sys.exit(1)
    return Desk(ws)


def _emit(data: Any, as_json: bool, text: str) -> None:
    click.echo(json.dumps(data, indent=2, ensure_ascii=False) if as_json else text.rstrip() + "\n", nl=False)


_dir = click.option("--dir", "-d", "directory", default=".", type=click.Path(file_okay=False), help="Workspace (or any directory inside it)")
_as_json = click.option("--json", "as_json", is_flag=True, help="JSON instead of text")


@click.group()
def desk():
    """Read the workspace's Desk and Drawer (read-only)."""


@desk.command("overview")
@_dir
@_as_json
def desk_overview(directory: str, as_json: bool):
    """Areas on the Desk and their cards (Pages and Boards), the Goals card, the Drawer's counts and your last card."""
    d = _open(directory)
    on_desk = [a for a in d.areas if not a.get("drawer_id")]
    data = {
        "workspace": str(d.workspace),
        "areas": [{"id": a.get("id"), "name": a.get("name"), "cards": [d.brief(c) for c in d.cards_in(a.get("id"))]} for a in on_desk],
        "goals_card": d.brief(next(c for c in d.cards if c["id"] == d.goals_card_id)) if any(c["id"] == d.goals_card_id for c in d.cards) else None,
        "stashed_areas": sum(1 for a in d.areas if a.get("drawer_id")),
        "ideas": len(_ideas(d.workspace)),
        "lines": d.strokes,
        "last_card": (d.last or {}).get("card_id"),
    }
    out = [f"Desk: {d.workspace}"]
    for a in data["areas"]:
        out.append(f"\n## {a['name']} ({a['id']})")
        if not a["cards"]:
            out.append("  (no cards)")
        for c in a["cards"]:
            out.append(f"  - {c['title']} ({c['id']}) · {d.size(c)} · updated {c['updated_at'] or '?'}")
    if data["goals_card"]:
        g = data["goals_card"]
        out.append(f"\nGoals card: {g['title']} ({g['id']}) · {g['chars']} chars (pinned; GOALS.md is the source of truth)")
    out.append(f"\nDrawer: {data['stashed_areas']} stashed Areas, {data['ideas']} ideas (hester desk drawer)")
    if data["last_card"]:
        out.append(f"Last card: {d.title(data['last_card'])} ({data['last_card']}) (hester desk last)")
    out.append(f"Lines drawn: {data['lines']} (they mean nothing; nobody reads them)")
    _emit(data, as_json, "\n".join(out))


def _one(d: Desk, ref: tuple, kind: Optional[str] = None) -> Dict[str, Any]:
    """The one card ``ref`` names (of ``kind`` when given); exits 1 for none, 2 for several."""
    hits = [c for c in d.find(" ".join(ref)) if kind is None or d.brief(c)["kind"] == kind]
    if not hits:
        what = {"board": "Board", "page": "Page"}.get(kind or "", "card")
        click.echo(f"No {what} matches {' '.join(ref)!r}. Try: hester desk overview", err=True)
        sys.exit(1)
    if len(hits) > 1:
        click.echo("Several cards match; use an id:", err=True)
        for c in hits:
            click.echo(f"  {c['id']}  {d.title(c['id'])}", err=True)
        sys.exit(2)
    return hits[0]


def _source_text(src: Any) -> str:
    """`` (from url: https://…)`` for an asset's source, else ''."""
    if not isinstance(src, dict) or not src.get("kind"):
        return ""
    kind = src["kind"]
    if kind == "url":
        where = src.get("url")
    elif kind == "file":
        where = src.get("path")
    elif kind == "answer":
        where = f"{src.get('card_id')}#{src.get('answer_id')}"
    else:
        where = str(src.get("card_id")) + (f" item {src['item_id']}" if src.get("item_id") else "")
    taken = f", taken {src['taken_at']}" if src.get("taken_at") else ""
    return f" (from {kind}: {where}{taken})"


def _answer_lines(a: Dict[str, Any], d: Desk, cid: str) -> List[str]:
    """What a Board's Ask or hand-off was about: the selection's image and its annotations."""
    anchor = a.get("anchor") or {}
    out = []
    if anchor.get("kind") == "board":
        if anchor.get("snapshot"):
            out.append(f"Selection (image): {d.page_dir(cid) / anchor['snapshot']}")
        for n in anchor.get("notes") or []:
            out.append(f"Annotation: \"{' '.join(str(n).split())[:200]}\"")
    return out


def _print_board(d: Desk, card: Dict[str, Any], as_json: bool) -> None:
    cid = card["id"]
    b = d.brief(card)
    items = d.items(cid)
    by_id = {i.get("id"): i for i in items}
    assets = {r.get("name"): r for r in _jsonl(d.page_dir(cid) / "assets.jsonl")}
    rows = _jsonl(d.page_dir(cid) / "answers.jsonl")
    answers = {a.get("id"): a for a in rows}
    asks = [a for a in rows if a.get("kind") != "handoff" and not a.get("dismissed_at")]
    handoffs = [a for a in rows if a.get("kind") == "handoff" and not a.get("dismissed_at")]

    def of(kind: str) -> List[Dict[str, Any]]:
        return sorted((i for i in items if i.get("kind") == kind), key=lambda i: (i.get("y", 0), i.get("x", 0)))

    def label(item_id: Any) -> str:
        it = by_id.get(item_id)
        if not it:
            return str(item_id)
        return f"image {it.get('asset')}" if it.get("kind") == "image" else f"{it.get('kind')} {item_id}"

    images = [{"id": i.get("id"), "path": str(d.page_dir(cid) / "assets" / str(i.get("asset"))),
               "source": (assets.get(i.get("asset")) or {}).get("source")} for i in of("image")]
    notes = [{"id": i.get("id"), "text": i.get("text") or "", "pinned_to": (i.get("pin") or {}).get("item_id")} for i in of("note")]
    highlights = [{"id": i.get("id"), "on": i.get("item_id"),
                   "notes": [n["text"] for n in notes if n["pinned_to"] == i.get("id")]} for i in of("highlight")]
    links = [{"id": i.get("id"), "card_id": i.get("card_id"), "title": d.title(i["card_id"]) if i.get("card_id") else None} for i in of("link")]
    data = {**b, "dir": str(d.page_dir(cid)), "images": images, "notes": notes, "highlights": highlights, "links": links,
            "strokes": len(of("stroke")), "asks": asks, "handoffs": handoffs,
            "preview": str(d.page_dir(cid) / "preview.png") if (d.page_dir(cid) / "preview.png").is_file() else None}

    out = [f"# {b['title']} ({cid}), a Board", f"Area: {b['area'] or '-'}{' (stashed)' if b['stashed'] else ''} · updated {b['updated_at'] or '?'}"]
    out.append(f"Folder: {data['dir']}")
    if data["preview"]:
        out.append(f"Picture of the whole Board: {data['preview']}")
    if not items:
        out.append("\n(empty)")
    if images:
        out.append(f"\n## Images ({len(images)})")
        out.extend(f"- {i['path']}{_source_text(i['source'])}" for i in images)
    if notes:
        out.append(f"\n## Annotations ({len(notes)})")
        for n in notes:
            on = f" [pinned to {label(n['pinned_to'])}]" if n["pinned_to"] else ""
            out.append(f"- {' '.join(n['text'].split()) or '(empty)'}{on}")
    if highlights:
        out.append(f"\n## Highlights ({len(highlights)})")
        for h in highlights:
            out.append(f"- on {label(h['on']) if h['on'] else 'the Board'}" + (f": {'; '.join(h['notes'])}" if h["notes"] else ""))
    if links:
        out.append(f"\n## Links ({len(links)})")
        out.extend(f"- {ln['title'] or '?'} ({ln['card_id']})" for ln in links)
    if data["strokes"]:
        out.append(f"\nDrawing: {data['strokes']} lines")
    if asks:
        out.append(f"\n## Asks ({len(asks)}), sticky notes on the Board")
        for a in asks:
            out.append(f"\n### Q: {a.get('question')}")
            out.extend(_answer_lines(a, d, cid))
            follow = answers.get(a.get("follow_up_of"))
            if follow:
                out.append(f"Follows up: {follow.get('question')}")
            out.append(f"Status: {a.get('status')}" + (f" ({a['error']})" if a.get("error") else ""))
            if a.get("answer"):
                out.append(str(a["answer"]).rstrip())
    if handoffs:
        out.append(f"\n## Hand-offs ({len(handoffs)}), clipboards on the Board")
        for h in handoffs:
            info = h.get("handoff") or {}
            out.append(f"\n### {str(info.get('kind') or 'hand-off').title()} to {info.get('provider') or '?'}: {h.get('status')}")
            out.append(f"Brief: {h.get('question')}")
            out.extend(_answer_lines(h, d, cid))
            if h.get("answer"):
                out.append(str(h["answer"]).rstrip())
    _emit(data, as_json, "\n".join(out))


@desk.command("board")
@click.argument("ref", nargs=-1, required=True)
@_dir
@_as_json
def desk_board(ref: tuple, directory: str, as_json: bool):
    """One Board by id (bd-…) or title: images (paths and sources), annotations, highlights, links, asks and hand-offs."""
    d = _open(directory)
    _print_board(d, _one(d, ref, "board"), as_json)


@desk.command("page")
@click.argument("ref", nargs=-1, required=True)
@_dir
@_as_json
@click.option("--text-only", is_flag=True, help="Only the Page's own text")
def desk_page(ref: tuple, directory: str, as_json: bool, text_only: bool):
    """One Page by id (pg-…) or title: its text, then answers, hand-offs, open questions, references and images."""
    d = _open(directory)
    card = _one(d, ref)
    cid = card["id"]
    if _is_board(cid):
        return _print_board(d, card, as_json)
    text = d.text(cid)
    rows = {f: _jsonl(d.page_dir(cid) / f) for f in PAGE_FILES}
    answers = [a for a in rows["answers.jsonl"] if a.get("kind") != "handoff" and not a.get("dismissed_at")]
    handoffs = [a for a in rows["answers.jsonl"] if a.get("kind") == "handoff" and not a.get("dismissed_at")]
    questions = [q for q in rows["questions.jsonl"] if q.get("status", "open") == "open"]
    images = d.assets(cid)
    data = {**d.brief(card), "text": text, "answers": answers, "handoffs": handoffs, "open_questions": questions,
            "references": rows["references.jsonl"], "images": images}
    if text_only:
        return _emit({"id": cid, "text": text} if as_json else None, as_json, text)
    b = d.brief(card)
    out = [f"# {b['title']} ({cid})", f"Area: {b['area'] or '-'}{' (stashed)' if b['stashed'] else ''} · updated {b['updated_at'] or '?'}", "", "---", text.rstrip() or "(empty)", "---"]
    if answers:
        out.append(f"\n## Answers ({len(answers)}), in the margin")
        for a in answers:
            quote = ((a.get("anchor") or {}).get("quote") or "").strip()
            out.append(f"\n### Q: {a.get('question') or quote}")
            if quote and quote != a.get("question"):
                out.append(f"On: \"{quote[:200]}\"")
            out.append(f"Status: {a.get('status')}")
            if a.get("answer"):
                out.append(str(a["answer"]).rstrip())
    if handoffs:
        out.append(f"\n## Hand-offs ({len(handoffs)})")
        for h in handoffs:
            info = h.get("handoff") or {}
            out.append(f"\n### {str(info.get('kind') or 'hand-off').title()} to {info.get('provider') or '?'}: {h.get('status')}")
            quote = ((h.get("anchor") or {}).get("quote") or "").strip()
            if quote:
                out.append(f"On: \"{quote[:200]}\"")
            if h.get("answer"):
                out.append(str(h["answer"]).rstrip())
    if questions:
        out.append(f"\n## Open questions ({len(questions)})")
        out.extend(f"- {q.get('text')}" for q in questions)
    refs = rows["references.jsonl"]
    if refs:
        out.append(f"\n## References ({len(refs)})")
        for r in refs:
            where = r.get("url") or (f"{r.get('file')}:{(r.get('lines') or [''])[0]}" if r.get("file") else r.get("section") or "")
            label = r.get("title") or where or r.get("kind")
            body = (r.get("quote") or "").strip().replace("\n", " ")
            out.append(f"- {label}{f' ({where})' if where and where != label else ''}{f': {body[:240]}' if body else ''}")
    if images:
        out.append(f"\n## Images ({len(images)}), in {d.page_dir(cid)}")
        out.extend(f"- {i}" for i in images)
    _emit(data, as_json, "\n".join(out))


@desk.command("last")
@_dir
@_as_json
def desk_last(directory: str, as_json: bool):
    """Your last card and the last line you wrote in it (where you stopped)."""
    d = _open(directory)
    cid = (d.last or {}).get("card_id")
    if not cid or not any(c["id"] == cid for c in d.cards):
        written = [c for c in d.cards if d.text(c["id"]).strip()]
        written.sort(key=lambda c: str(d.meta(c["id"]).get("updated_at") or ""), reverse=True)
        cid = written[0]["id"] if written else None
    if not cid:
        click.echo("Nothing written on the Desk yet.", err=True)
        sys.exit(1)
    card = next(c for c in d.cards if c["id"] == cid)
    stopped = _last_line(d.text(cid))
    data = {**d.brief(card), "stopped_at": stopped, "at": (d.last or {}).get("at")}
    _emit(data, as_json, f"Last card: {data['title']} ({cid}) in {data['area'] or '-'}\nStopped at: {stopped or '(empty)'}\nRead it: hester desk {data['kind']} {cid}")


@desk.command("drawer")
@click.argument("words", nargs=-1)
@_dir
@_as_json
def desk_drawer(words: tuple, directory: str, as_json: bool):
    """Stashed Areas (with their cards) and Ideas, newest first. Words filter: every word, any order, any case."""
    d = _open(directory)
    ws = [w.lower() for w in " ".join(words).split()]
    names = {dr.get("id"): dr.get("name") for dr in d.drawers}
    stashed = []
    for a in d.areas:
        if not a.get("drawer_id"):
            continue
        cards = [d.brief(c) for c in d.cards_in(a.get("id"))]
        if ws and not _matches(ws, a.get("name"), *(c["title"] for c in cards)):
            continue
        folder = "Stashed" if a["drawer_id"] in STASHED else names.get(a["drawer_id"]) or a["drawer_id"]
        at = a.get("stashed_at") or a.get("put_away_at") or a.get("updated_at")
        stashed.append({"id": a.get("id"), "name": a.get("name"), "folder": folder, "at": at, "cards": cards})
    stashed.sort(key=lambda a: str(a["at"] or ""), reverse=True)
    ideas = [i for i in _ideas(d.workspace) if not ws or _matches(ws, i["text"], i["surface"])]
    data = {"workspace": str(d.workspace), "stashed": stashed, "ideas": ideas}
    matching = f" (matching {' '.join(words)!r})" if ws else ""
    out = [f"Drawer: {d.workspace}{matching}"]
    out.append(f"\n## Stashed Areas ({len(stashed)})")
    for a in stashed:
        out.append(f"- {a['name']} ({a['id']}) · {a['folder']} · stashed {a['at'] or '?'}")
        out.extend(f"    - {c['title']} ({c['id']}) · {d.size(c)}" for c in a["cards"])
    out.append(f"\n## Ideas ({len(ideas)})")
    for i in ideas:
        src = f" · from {i['surface']}" if i["surface"] and i["surface"] != "lee" else ""
        out.append(f"- {i['text'].strip()} ({i['id']} · {i['created_at']}{src})")
    _emit(data, as_json, "\n".join(out))
