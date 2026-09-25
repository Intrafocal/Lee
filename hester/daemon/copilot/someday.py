"""
Someday store: the single idea-capture store, shared with devices.

One markdown file per item at ``<workspace>/.hester/someday/<id>.md`` (0600),
YAML frontmatter plus the idea text exactly as captured. Writes are atomic
(temp file + rename). Replaces the old ``hester ideas``.
"""

import os
import re
import secrets
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

ID_RE = re.compile(r"^sd_\d{8}T\d{6}_[0-9a-f]{4}$")
STATUSES = ("open", "explored", "promoted", "dropped", "kept")
AS_VALUES = ("someday", "explore")
SURFACES = ("lee", "aeronaut", "dirigible", "device", "cli", "shared")
TRIAGE_ACTIONS = {"explore": "explored", "promote": "promoted", "drop": "dropped", "keep": "kept"}
MAX_TEXT = 10000


class SomedayError(ValueError):
    pass


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_seconds(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_time(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return None


def normalize_source(source: Any) -> Dict[str, Any]:
    src = source if isinstance(source, dict) else {}
    surface = str(src.get("surface") or "").strip().lower()
    device_id = src.get("device_id")
    device_id = str(device_id) if device_id else None
    if surface not in SURFACES:
        surface = "device" if device_id else "shared"
    out: Dict[str, Any] = {"surface": surface}
    if device_id:
        out["device_id"] = device_id
    return out


@dataclass
class SomedayItem:
    id: str
    created_at: str
    text: str
    status: str = "open"
    as_: str = "someday"
    source: Dict[str, Any] = field(default_factory=lambda: {"surface": "cli"})
    tags: List[str] = field(default_factory=list)
    triage: Optional[Dict[str, Any]] = None

    def frontmatter(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "created_at": self.created_at,
            "status": self.status,
            "as": self.as_,
            "source": self.source,
            "tags": list(self.tags),
            "triage": self.triage,
        }

    def to_dict(self) -> Dict[str, Any]:
        d = self.frontmatter()
        d["text"] = self.text
        return d

    def render(self) -> str:
        head = yaml.safe_dump(self.frontmatter(), sort_keys=False, allow_unicode=True, default_flow_style=False)
        return f"---\n{head}---\n{self.text}\n"

    @classmethod
    def parse(cls, content: str) -> "SomedayItem":
        if not content.startswith("---\n"):
            raise SomedayError("missing frontmatter")
        end = content.find("\n---\n", 3)
        if end < 0:
            raise SomedayError("unterminated frontmatter")
        meta = yaml.safe_load(content[4:end + 1]) or {}
        if not isinstance(meta, dict):
            raise SomedayError("frontmatter is not a mapping")
        text = content[end + 5:]
        if text.endswith("\n"):
            text = text[:-1]
        created = meta.get("created_at")
        if isinstance(created, datetime):
            created = _iso_seconds(created if created.tzinfo else created.replace(tzinfo=timezone.utc))
        triage = meta.get("triage")
        if isinstance(triage, dict) and isinstance(triage.get("at"), datetime):
            at = triage["at"]
            triage = dict(triage, at=_iso_seconds(at if at.tzinfo else at.replace(tzinfo=timezone.utc)))
        return cls(
            id=str(meta.get("id") or ""),
            created_at=str(created or ""),
            text=text,
            status=str(meta.get("status") or "open"),
            as_=str(meta.get("as") or "someday"),
            source=normalize_source(meta.get("source")),
            tags=[str(t) for t in (meta.get("tags") or [])],
            triage=triage if isinstance(triage, dict) else None,
        )


def new_id(now: Optional[datetime] = None) -> str:
    now = now or _utc_now()
    return f"sd_{now.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%S')}_{secrets.token_hex(2)}"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class SomedayStore:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.dir = self.workspace / ".hester" / "someday"

    def _path(self, item_id: str) -> Path:
        if not ID_RE.match(item_id or ""):
            raise SomedayError(f"invalid someday id: {item_id!r}")
        return self.dir / f"{item_id}.md"

    def create(
        self,
        text: str,
        as_: str = "someday",
        source: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        now: Optional[datetime] = None,
    ) -> SomedayItem:
        if not isinstance(text, str) or not text.strip():
            raise SomedayError("text is required")
        if len(text) > MAX_TEXT:
            raise SomedayError(f"text is longer than {MAX_TEXT} characters")
        if as_ not in AS_VALUES:
            raise SomedayError(f"as must be one of {', '.join(AS_VALUES)}")
        now = now or _utc_now()
        item = SomedayItem(
            id=new_id(now),
            created_at=_iso_seconds(now),
            text=text,
            as_=as_,
            source=normalize_source(source or {"surface": "cli"}),
            tags=[str(t) for t in (tags or [])],
        )
        path = self._path(item.id)
        while path.exists():
            item.id = new_id(now)
            path = self._path(item.id)
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.dir, 0o700)
        except OSError:
            pass
        _atomic_write(path, item.render())
        return item

    def get(self, item_id: str) -> Optional[SomedayItem]:
        path = self._path(item_id)
        try:
            return SomedayItem.parse(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def list(self, status: str = "open") -> List[SomedayItem]:
        items: List[SomedayItem] = []
        try:
            paths = sorted(self.dir.glob("sd_*.md"))
        except OSError:
            return items
        for p in paths:
            if not ID_RE.match(p.stem):
                continue
            try:
                item = SomedayItem.parse(p.read_text(encoding="utf-8"))
            except (OSError, SomedayError, yaml.YAMLError):
                continue
            if status != "all" and item.status != status:
                continue
            items.append(item)
        items.sort(key=lambda i: (i.created_at, i.id), reverse=True)
        return items

    def triage(
        self,
        item_id: str,
        action: str,
        note: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> SomedayItem:
        if action not in TRIAGE_ACTIONS:
            raise SomedayError(f"action must be one of {', '.join(TRIAGE_ACTIONS)}")
        item = self.get(item_id)
        if item is None:
            raise KeyError(item_id)
        now = now or _utc_now()
        item.status = TRIAGE_ACTIONS[action]
        item.triage = {"action": action, "at": _iso_seconds(now), "note": note or None}
        _atomic_write(self._path(item.id), item.render())
        return item

    def counts(self, now: Optional[datetime] = None, stale_days: int = 7) -> Dict[str, int]:
        now = now or _utc_now()
        open_items = self.list("open")
        cutoff = now - timedelta(days=stale_days)
        stale = 0
        for item in open_items:
            created = _parse_time(item.created_at)
            if created and created < cutoff:
                stale += 1
        return {"open": len(open_items), "untriaged_over_7d": stale}

    def triaged_between(self, since: datetime, until: datetime) -> List[SomedayItem]:
        out = []
        for item in self.list("all"):
            at = _parse_time((item.triage or {}).get("at"))
            if at and since <= at < until:
                out.append(item)
        return out


def age_ms(item: SomedayItem, now: Optional[datetime] = None) -> int:
    created = _parse_time(item.created_at)
    if not created:
        return 0
    return max(0, int(((now or _utc_now()) - created).total_seconds() * 1000))
