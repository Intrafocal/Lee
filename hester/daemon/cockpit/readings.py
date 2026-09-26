"""
Goal metric readings from operations' ``produces:`` (contracts section 7.6).

Appended by the event follower to ``<workspace>/.hester/goals/metrics.jsonl``,
the same file ``hester goals metrics --write`` appends to. Reading lines carry
``kind: "reading"``; lines without ``kind`` are metrics records.
"""

import json
import math
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from .tasks import VersionCounter


def reading_key(line: Dict[str, Any]) -> Tuple[str, str]:
    return (str((line.get("source") or {}).get("run_id") or ""), str(line.get("metric") or ""))


def to_api(line: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "ts": line.get("ts"),
        "metric": line.get("metric"),
        "value": line.get("value"),
        "unit": line.get("unit"),
        "source": line.get("source"),
    }


class ReadingsStore:
    def __init__(self, workspace: Path):
        self.workspace = Path(workspace)
        self.path = self.workspace / ".hester" / "goals" / "metrics.jsonl"
        self.counter = VersionCounter(self.workspace)
        self._keys: Optional[Set[Tuple[str, str]]] = None

    def _lines(self) -> List[Dict[str, Any]]:
        out = []
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as f:
                for raw in f:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        line = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(line, dict):
                        out.append(line)
        except OSError:
            pass
        return out

    def all(self) -> List[Dict[str, Any]]:
        """Every reading line, oldest first as written."""
        return [line for line in self._lines() if (line.get("kind") or "metrics") == "reading"]

    def append(
        self,
        ts: str,
        op: str,
        run_id: str,
        readings: Iterable[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Append new readings of one run; a (run_id, metric) already written is skipped."""
        if self._keys is None:
            self._keys = {reading_key(line) for line in self.all()}
        written = []
        for r in readings:
            if not isinstance(r, dict):
                continue
            metric = r.get("metric")
            value = r.get("value")
            if not isinstance(metric, str) or not metric:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                continue
            line = {
                "ts": ts,
                "kind": "reading",
                "metric": metric,
                "value": value,
                "unit": r.get("unit") if isinstance(r.get("unit"), str) else None,
                "source": {"kind": "operation", "op": op, "run_id": run_id},
                "workspace": str(self.workspace),
            }
            key = reading_key(line)
            if key in self._keys:
                continue
            self._keys.add(key)
            written.append(line)
        if written:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as f:
                for line in written:
                    f.write(json.dumps(line, separators=(",", ":")) + "\n")
            self.counter.bump()
        return written

    def list(self, metric: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        rows = [line for line in self.all() if metric is None or line.get("metric") == metric]
        rows.sort(key=lambda line: str(line.get("ts") or ""), reverse=True)
        return [to_api(line) for line in rows[: max(0, limit)]]

    def latest(self) -> List[Dict[str, Any]]:
        best: Dict[str, Dict[str, Any]] = {}
        for line in self.all():
            m = line.get("metric")
            if isinstance(m, str) and (m not in best or str(line.get("ts") or "") >= str(best[m].get("ts") or "")):
                best[m] = line
        return [to_api(best[m]) for m in sorted(best)]

    def with_previous(self, since: str, until: str) -> List[Dict[str, Any]]:
        """Readings in [since, until), newest first, each with the metric's previous value."""
        rows = sorted(self.all(), key=lambda line: str(line.get("ts") or ""))
        prev: Dict[str, Any] = {}
        out = []
        for line in rows:
            ts = str(line.get("ts") or "")
            m = line.get("metric")
            if since <= ts < until:
                out.append({**to_api(line), "previous": prev.get(m)})
            prev[m] = line.get("value")
        out.reverse()
        return out
