"""
Hester CLI - GOALS.md metrics from Lee's event log.

Deterministic, no model. Reads ``~/.lee/events/`` directly.

Usage:
    hester goals metrics
    hester goals metrics --since 14d --until now --workspace /path/to/repo --write
"""

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.table import Table

console = Console()

_DURATION_RE = re.compile(r"^(\d+)\s*([mhdw])$")
_UNITS = {"m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def parse_when(value: str, now: datetime) -> datetime:
    """``now``, a duration back from now (``14d``, ``12h``, ``30m``, ``2w``) or an ISO time."""
    text = (value or "").strip().lower()
    if text in ("", "now"):
        return now
    m = _DURATION_RE.match(text)
    if m:
        return now - timedelta(**{_UNITS[m.group(2)]: int(m.group(1))})
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        raise click.BadParameter(f"expected now, a duration like 14d, or an ISO time: {value!r}")
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone(timezone.utc)


def _fmt(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:g}"
    if isinstance(value, dict):
        return ", ".join(f"{k}={_fmt(v)}" for k, v in value.items()) or "-"
    return str(value)


@click.group()
def goals():
    """GOALS.md metrics."""
    pass


@goals.command("metrics")
@click.option("--since", "since", default="14d", show_default=True, help="Window start: duration back from now or ISO time")
@click.option("--until", "until", default="now", show_default=True, help="Window end: now, a duration back, or ISO time")
@click.option("--workspace", "-w", type=click.Path(file_okay=False), default=None, help="Only this workspace's events (default: machine-wide)")
@click.option("--write", is_flag=True, help="Append the result to <workspace>/.hester/goals/metrics.jsonl")
@click.option("--json", "as_json", is_flag=True, help="Print the record as JSON")
@click.option("--events-dir", type=click.Path(file_okay=False), default=None, hidden=True)
def goals_metrics(since: str, until: str, workspace: Optional[str], write: bool, as_json: bool, events_dir: Optional[str]):
    """Compute metrics over [since, until) from the event log."""
    from hester.daemon.copilot import metrics

    now = datetime.now(timezone.utc)
    start = parse_when(since, now)
    end = parse_when(until, now)
    if start >= end:
        console.print("[red]--since must be before --until[/red]")
        sys.exit(1)
    ws = str(Path(workspace).expanduser().resolve()) if workspace else None
    record = metrics.run(start, end, workspace=ws, events_dir=Path(events_dir) if events_dir else None, now=now)

    if as_json:
        click.echo(json.dumps(record, indent=2))
    else:
        scope = ws or "machine-wide"
        table = Table(title=f"Metrics {record['from']} to {record['to']} ({scope})", show_header=True, header_style="bold")
        table.add_column("Metric")
        table.add_column("Value", justify="right")
        for key, value in record["metrics"].items():
            table.add_row(key, _fmt(value))
        console.print(table)
        console.print(f"[dim]formula v{record['formula_version']}; unavailable: {', '.join(record['unavailable'])}[/dim]")

    if write:
        out = metrics.append_record(record, Path(ws) if ws else Path.cwd())
        console.print(f"[green]Appended[/green] {out}")
