"""
GOALS.md parsing.

- ``parse_goals`` / ``load_goals``: ids and titles for the Cockpit's link
  picker (``### G<n> <title>`` headings and ``- **C<n> <title>.**`` lines).
- ``parse_goals_full`` / ``load_goals_full`` (copilot v4, contract section 1):
  goals with priority, prose and metrics; constraints with telemetry; tensions
  with default and arbiter. Tolerant of the file's current shape; anything it
  can't read is skipped, never an error.
"""

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_GOAL_RE = re.compile(r"^###\s+(G\d+)\s+(.+?)\s*$")
_CONSTRAINT_RE = re.compile(r"^\s*[-*]\s+\*\*(C\d+)\s+(.+?)\.?\*\*")

GOAL_ID_RE = re.compile(r"^G\d+$")
MAX_PROSE = 1500
METRIC_KEYS = ("kind", "signal", "available", "target", "guard", "measure")
CONSTRAINT_KEYS = ("telemetry", "available", "target")


def parse_goals(text: str) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    seen = set()
    for line in text.splitlines():
        m = _GOAL_RE.match(line)
        kind = "goal"
        if not m:
            m = _CONSTRAINT_RE.match(line)
            kind = "constraint"
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        out.append({"id": m.group(1), "title": m.group(2).strip().rstrip("."), "kind": kind})
    return out


def load_goals(workspace: Path) -> List[Dict[str, str]]:
    try:
        text = (Path(workspace) / "GOALS.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return parse_goals(text)


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

_OPS = {"≥": ">=", ">=": ">=", "≤": "<=", "<=": "<=", ">": ">", "<": "<"}
_TARGET_OP_RE = re.compile(r"^\s*(≥|≤|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*(%)?")
_BARE_NUMBER_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*\.?\s*$")


def parse_target(text: Optional[str]) -> Dict[str, Any]:
    """``falling``/``rising`` -> direction; ``≥ 50%`` -> op/value (shares as 0-1); else all null."""
    out: Dict[str, Any] = {"direction": None, "op": None, "value": None, "unit": None}
    if not isinstance(text, str) or not text.strip():
        return out
    s = text.strip()
    low = s.lower()
    if low.startswith("falling"):
        out["direction"] = "falling"
        return out
    if low.startswith("rising"):
        out["direction"] = "rising"
        return out
    m = _TARGET_OP_RE.match(s)
    if m:
        value = float(m.group(2))
        unit = "%" if m.group(3) else None
        if unit:
            value = value / 100.0
        out.update({"op": _OPS[m.group(1)], "value": _num(value), "unit": unit})
    return out


def _num(value: float) -> Any:
    return int(value) if float(value).is_integer() else round(value, 6)


def target_ok(value: Any, target: Dict[str, Any]) -> Optional[bool]:
    """``value`` against an op target; None when either side is missing."""
    op, want = target.get("op"), target.get("value")
    if op is None or want is None or not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return {">=": value >= want, "<=": value <= want, ">": value > want, "<": value < want}[op]


# ---------------------------------------------------------------------------
# Full parse
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
_METRIC_RE = re.compile(r"^-\s+metric:\s*\*\*([A-Za-z0-9_.-]+)\*\*\s*:?\s*(.*)$")
_CONSTRAINT_FULL_RE = re.compile(r"^-\s+\*\*(C\d+)\s+(.+?)\*\*\s*(.*)$")
_TENSION_RE = re.compile(r"^-\s+\*\*(.+?)\s+vs\.?\s+(.+?)(?:\s+\((.+?)\))?:\*\*\s*(.*)$")
_NESTED_RE = re.compile(r"^\s+[-*]\s+([A-Za-z_]+):\s*(.*)$")
_TOP_BULLET_RE = re.compile(r"^[-*]\s+")
_ID_RE = re.compile(r"\b([GC]\d+)\b")
_TARGET_IN_TEXT_RE = re.compile(r"Target:\s*(.+?)\s*$", re.IGNORECASE)


def _join(parts: List[str]) -> str:
    return " ".join(" ".join(p.split()) for p in parts if p.strip()).strip()


def _new_metric(name: str, desc: str) -> Dict[str, Any]:
    return {"name": name, "description": desc, **{k: None for k in METRIC_KEYS}}


def _finish_metric(m: Dict[str, Any]) -> Dict[str, Any]:
    m["target_text"] = m.get("target")
    m["target"] = parse_target(m.get("target"))
    measure = m.get("measure")
    op = None
    if isinstance(measure, str):
        mm = re.match(r"^\s*op:\s*([A-Za-z0-9_.:-]+)", measure)
        op = mm.group(1) if mm else None
    m["measure"] = op
    return m


def _finish_constraint(c: Dict[str, Any]) -> Dict[str, Any]:
    telemetry = c.get("telemetry") or ""
    target_text = c.get("target")
    if not target_text:
        m = _TARGET_IN_TEXT_RE.search(telemetry)
        if m:
            target_text = m.group(1).rstrip(".").strip()
            c["telemetry"] = telemetry[: m.start()].strip()
    c["target_text"] = target_text
    target = parse_target(target_text)
    if target["op"] is None and target["direction"] is None and target_text:
        bare = _BARE_NUMBER_RE.match(target_text)
        if bare:
            # A constraint's "Target: 0" counts violations: at most that many.
            target.update({"op": "<=", "value": _num(float(bare.group(1)))})
    c["target"] = target
    return c


def _split_tension(text: str) -> Tuple[str, Optional[str], Optional[str]]:
    """(body, default, arbiter): default is the text after 'Default:' up to 'Arbiter:'."""
    body, default, arbiter = text, None, None
    ai = text.find("Arbiter:")
    if ai >= 0:
        arbiter = text[ai + len("Arbiter:"):].strip().rstrip(".").strip() or None
        body = text[:ai].strip()
    di = body.find("Default:")
    if di >= 0:
        default = body[di + len("Default:"):].strip() or None
        body = body[:di].strip()
    return body, default, arbiter


def parse_goals_full(text: str) -> Dict[str, List[Dict[str, Any]]]:
    """``{goals, constraints, tensions}`` from GOALS.md (contract section 1)."""
    goals: List[Dict[str, Any]] = []
    constraints: List[Dict[str, Any]] = []
    tensions: List[Dict[str, Any]] = []
    section = ""          # the current '## ' heading, lower-cased
    goal: Optional[Dict[str, Any]] = None
    prose: List[str] = []
    in_prose = False
    item: Optional[Dict[str, Any]] = None   # the open metric / constraint / tension
    item_kind = ""
    field: Optional[str] = None             # the field continuation lines extend
    parts: Dict[str, List[str]] = {}
    seen = set()

    def close_item() -> None:
        nonlocal item, item_kind, field, parts
        if item is None:
            return
        for k, v in parts.items():
            item[k] = _join(v) or None
        if item_kind == "metric" and goal is not None:
            goal["metrics"].append(_finish_metric(item))
        elif item_kind == "constraint":
            constraints.append(_finish_constraint(item))
        elif item_kind == "tension":
            body, default, arbiter = _split_tension(item.pop("text") or "")
            item["text"] = body or None
            item["default"] = default
            item["arbiter"] = arbiter
            known = {m["name"] for g in goals for m in g["metrics"]}
            item["arbiter_metrics"] = [n for n in re.findall(r"[a-z][a-z0-9_]+", arbiter or "") if n in known]
            ids: List[str] = []
            for s in (item["a"], item["b"], item.get("label") or ""):
                for gid in _ID_RE.findall(s):
                    if gid not in ids:
                        ids.append(gid)
            item["ids"] = ids
            tensions.append(item)
        item, item_kind, field, parts = None, "", None, {}

    def close_goal() -> None:
        nonlocal goal, prose, in_prose
        close_item()
        if goal is not None:
            text_ = "\n".join(prose).strip()
            goal["prose"] = text_ if len(text_) <= MAX_PROSE else text_[: MAX_PROSE - 1] + "…"
            goals.append(goal)
        goal, prose, in_prose = None, [], False

    for raw in text.splitlines():
        line = raw.rstrip()
        h = _HEADING_RE.match(line)
        if h:
            close_goal()
            level, title = len(h.group(1)), h.group(2)
            if level == 2:
                section = title.lower()
            g = _GOAL_RE.match(line)
            if g and g.group(1) not in seen:
                seen.add(g.group(1))
                goal = {"id": g.group(1), "title": g.group(2).strip(), "priority": len(goals), "prose": "", "metrics": []}
                in_prose = True
            continue

        if goal is not None:
            m = _METRIC_RE.match(line)
            if m:
                close_item()
                in_prose = False
                item, item_kind = _new_metric(m.group(1), ""), "metric"
                parts = {"description": [m.group(2)]}
                field = "description"
                continue
            if in_prose:
                prose.append(line)
                continue

        if goal is None:
            c = _CONSTRAINT_FULL_RE.match(line)
            if c and "constraint" in section:
                close_item()
                item, item_kind = {"id": c.group(1), "title": c.group(2).strip().rstrip("."), "text": None,
                                   "telemetry": None, "available": None, "target": None}, "constraint"
                parts = {"text": [c.group(3)]}
                field = "text"
                continue
            t = _TENSION_RE.match(line)
            if t and "tension" in section:
                close_item()
                item, item_kind = {"a": t.group(1).strip(), "b": t.group(2).strip(),
                                   "label": (t.group(3) or "").strip() or None, "text": None}, "tension"
                parts = {"text": [t.group(4)]}
                field = "text"
                continue

        if item is None:
            continue
        n = _NESTED_RE.match(line)
        if n and item_kind in ("metric", "constraint"):
            key = n.group(1).lower()
            allowed = METRIC_KEYS if item_kind == "metric" else CONSTRAINT_KEYS
            if key in allowed:
                parts[key] = [n.group(2)]
                field = key
            else:
                field = None
            continue
        if not line.strip():
            continue
        if _TOP_BULLET_RE.match(line):
            # A top-level bullet that isn't one of ours ends the item.
            close_item()
            continue
        if field is not None and line.startswith((" ", "\t")):
            parts.setdefault(field, []).append(line.strip())
    close_goal()
    return {"goals": goals, "constraints": constraints, "tensions": tensions}


_full_cache: Dict[str, Tuple[Optional[Tuple[int, int]], Dict[str, Any]]] = {}


def goals_path(workspace: Path) -> Path:
    return Path(workspace) / "GOALS.md"


def load_goals_full(workspace: Path) -> Dict[str, List[Dict[str, Any]]]:
    """``parse_goals_full`` of ``<workspace>/GOALS.md``, cached on (mtime, size); empty when missing."""
    path = goals_path(workspace)
    key = str(path)
    try:
        st = os.stat(path)
        stamp: Optional[Tuple[int, int]] = (st.st_mtime_ns, st.st_size)
    except OSError:
        stamp = None
    hit = _full_cache.get(key)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    if stamp is None:
        parsed: Dict[str, Any] = {"goals": [], "constraints": [], "tensions": []}
    else:
        try:
            parsed = parse_goals_full(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            parsed = {"goals": [], "constraints": [], "tensions": []}
    _full_cache[key] = (stamp, parsed)
    return parsed


def goal_priorities(goals: List[Dict[str, Any]]) -> Dict[str, int]:
    """Goal id -> priority (0 = top) from ``parse_goals_full(...)['goals']``."""
    return {g["id"]: int(g.get("priority") or 0) for g in goals if isinstance(g, dict) and g.get("id")}
