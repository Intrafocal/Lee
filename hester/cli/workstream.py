"""
Workstream CLI commands.

Usage:
    hester workstream create <title> --objective "..."
    hester workstream list [--phase ...]
    hester workstream show <ws-id>
    hester workstream delete <ws-id>
    hester workstream advance <ws-id>
    hester workstream brief <ws-id> [--constraints ...] [--out-of-scope ...]
    hester workstream task add <ws-id> <title> --goal "..."
    hester workstream task list <ws-id>
    hester workstream next <ws-id>
    hester workstream complete <ws-id> <task-id>
    hester workstream warehouse add <ws-id> <bundle-id>
    hester workstream warehouse show <ws-id>
"""

import sys

import click
import httpx
from rich.console import Console
from rich.table import Table

console = Console()

DAEMON_URL = "http://localhost:9000"


def _post(path: str, **kwargs) -> dict:
    """POST to daemon and return JSON."""
    try:
        resp = httpx.post(f"{DAEMON_URL}{path}", **kwargs, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        console.print("[red]Error:[/red] Cannot connect to Hester daemon. Is it running?")
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        console.print(f"[red]Error {e.response.status_code}:[/red] {e.response.text}")
        sys.exit(1)


def _get(path: str, **kwargs) -> dict:
    """GET from daemon and return JSON."""
    try:
        resp = httpx.get(f"{DAEMON_URL}{path}", **kwargs, timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        console.print("[red]Error:[/red] Cannot connect to Hester daemon. Is it running?")
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        console.print(f"[red]Error {e.response.status_code}:[/red] {e.response.text}")
        sys.exit(1)


def _delete(path: str) -> dict:
    """DELETE from daemon."""
    try:
        resp = httpx.delete(f"{DAEMON_URL}{path}", timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        console.print("[red]Error:[/red] Cannot connect to Hester daemon. Is it running?")
        sys.exit(1)


@click.group()
def workstream():
    """Manage Workstreams - multi-agent development objectives."""
    pass


# ── CRUD ──────────────────────────────────────────────────────

@workstream.command("create")
@click.argument("title")
@click.option("--objective", "-o", required=True, help="What needs to be accomplished")
@click.option("--rationale", "-r", default="", help="Why this matters")
def create(title, objective, rationale):
    """Create a new Workstream."""
    data = _post("/workstream/", json={"title": title, "objective": objective, "rationale": rationale})
    console.print(f"[green]Created[/green] workstream [bold]{data['id']}[/bold]: {data['title']}")


@workstream.command("list")
@click.option("--phase", "-p", default=None, help="Filter by phase")
def list_ws(phase):
    """List all Workstreams."""
    params = {}
    if phase:
        params["phase"] = phase
    data = _get("/workstream/", params=params)

    if not data:
        console.print("[dim]No workstreams found.[/dim]")
        return

    table = Table(title="Workstreams")
    table.add_column("ID", style="cyan")
    table.add_column("Title")
    table.add_column("Phase", style="green")
    table.add_column("Tasks")

    for ws in data:
        table.add_row(
            ws["id"],
            ws["title"],
            ws["phase"],
            str(ws.get("task_count", 0)),
        )
    console.print(table)


@workstream.command("show")
@click.argument("ws_id")
def show(ws_id):
    """Show Workstream details."""
    data = _get(f"/workstream/{ws_id}")
    console.print(f"\n[bold]{data['title']}[/bold] [{data['phase']}]")
    console.print(f"ID: [cyan]{data['id']}[/cyan]")

    if data.get("brief"):
        console.print(f"\n[bold]Objective:[/bold] {data['brief'].get('objective', '')}")

    if data.get("runbook_tasks"):
        console.print(f"\n[bold]Runbook:[/bold] {len(data['runbook_tasks'])} tasks")
        for t in data["runbook_tasks"]:
            status_icon = {"pending": "[ ]", "completed": "[x]", "failed": "[!]"}.get(t.get("status", ""), "[?]")
            console.print(f"  {status_icon} {t['title']}")


@workstream.command("delete")
@click.argument("ws_id")
@click.confirmation_option(prompt="Are you sure you want to delete this workstream?")
def delete(ws_id):
    """Delete a Workstream."""
    _delete(f"/workstream/{ws_id}")
    console.print(f"[red]Deleted[/red] workstream {ws_id}")


# ── Phase Transitions ────────────────────────────────────────

@workstream.command("advance")
@click.argument("ws_id")
def advance(ws_id):
    """Advance Workstream to the next phase."""
    data = _post(f"/workstream/{ws_id}/phase/advance")
    console.print(f"Advanced to [green]{data['phase']}[/green]")


@workstream.command("pause")
@click.argument("ws_id")
def pause(ws_id):
    """Pause a Workstream."""
    data = _post(f"/workstream/{ws_id}/phase/paused")
    console.print(f"[yellow]Paused[/yellow] workstream {ws_id}")


@workstream.command("resume")
@click.argument("ws_id")
def resume(ws_id):
    """Resume a paused Workstream."""
    data = _post(f"/workstream/{ws_id}/phase/resume")
    console.print(f"[green]Resumed[/green] workstream {ws_id} -> {data['phase']}")


# ── Design ───────────────────────────────────────────────────

@workstream.command("brief")
@click.argument("ws_id")
@click.option("--constraints", "-c", multiple=True, help="Add constraint")
@click.option("--out-of-scope", "-x", multiple=True, help="Add out-of-scope item")
def brief(ws_id, constraints, out_of_scope):
    """Update brief and advance to Design phase."""
    data = _post(f"/workstream/{ws_id}/phase/design", json={
        "constraints": list(constraints),
        "out_of_scope": list(out_of_scope),
    })
    console.print(f"Brief finalized, now in [green]{data['phase']}[/green] phase")


@workstream.command("ground")
@click.argument("ws_id")
@click.option("--files", "-f", multiple=True, help="File glob patterns")
@click.option("--grep", "-g", multiple=True, help="Grep patterns")
@click.option("--tables", "-t", multiple=True, help="DB table names")
def ground(ws_id, files, grep, tables):
    """Perform codebase grounding for Design phase."""
    data = _post(f"/workstream/{ws_id}/design/grounding", json={
        "file_patterns": list(files),
        "grep_patterns": list(grep),
        "db_tables": list(tables),
    })
    console.print(f"[green]Grounding complete[/green]: bundle {data.get('bundle_id', 'created')}")


@workstream.command("research")
@click.argument("ws_id")
@click.option("--title", required=True)
@click.option("--source", required=True)
@click.option("--summary", required=True)
def research(ws_id, title, source, summary):
    """Add research finding to Design phase."""
    _post(f"/workstream/{ws_id}/design/research", json={
        "title": title, "source": source, "summary": summary,
    })
    console.print(f"[green]Added[/green] research: {title}")


@workstream.command("decide")
@click.argument("ws_id")
@click.option("--question", "-q", required=True)
@click.option("--decision", "-d", required=True)
@click.option("--rationale", "-r", required=True)
@click.option("--alternative", "-a", multiple=True)
def decide(ws_id, question, decision, rationale, alternative):
    """Record a design decision."""
    _post(f"/workstream/{ws_id}/design/decision", json={
        "question": question, "decision": decision,
        "rationale": rationale, "alternatives": list(alternative),
    })
    console.print(f"[green]Recorded[/green] decision: {decision}")


# ── Runbook ──────────────────────────────────────────────────

@workstream.group("task")
def task_group():
    """Manage Runbook tasks."""
    pass


@task_group.command("add")
@click.argument("ws_id")
@click.argument("title")
@click.option("--goal", "-g", required=True, help="What this task accomplishes")
@click.option("--depends-on", "-d", multiple=True, help="Task IDs this depends on")
def task_add(ws_id, title, goal, depends_on):
    """Add a task to the Runbook."""
    data = _post(f"/workstream/{ws_id}/runbook/tasks", json={
        "title": title, "goal": goal, "dependencies": list(depends_on),
    })
    console.print(f"[green]Added[/green] task: {data.get('task_id', title)}")


@task_group.command("list")
@click.argument("ws_id")
def task_list(ws_id):
    """List Runbook tasks."""
    data = _get(f"/workstream/{ws_id}/runbook")
    if not data.get("tasks"):
        console.print("[dim]No tasks in runbook.[/dim]")
        return

    table = Table(title="Runbook")
    table.add_column("Task ID", style="cyan")
    table.add_column("Title")
    table.add_column("Priority")
    table.add_column("Dependencies")

    for t in data["tasks"]:
        deps = ", ".join(t.get("dependencies", []))
        table.add_row(t["task_id"], t["title"], str(t.get("priority", 0)), deps or "-")
    console.print(table)


@task_group.command("generate")
@click.argument("ws_id")
def task_generate(ws_id):
    """Auto-generate Runbook tasks from Design Doc."""
    data = _post(f"/workstream/{ws_id}/runbook/generate")
    console.print(f"[green]Generated[/green] {len(data.get('tasks', []))} tasks")


# ── Warehouse ────────────────────────────────────────────────

@workstream.group("warehouse")
def warehouse_group():
    """Manage Context Warehouse."""
    pass


@warehouse_group.command("add")
@click.argument("ws_id")
@click.argument("bundle_id")
def warehouse_add(ws_id, bundle_id):
    """Add a context bundle to the warehouse."""
    _post(f"/workstream/{ws_id}/warehouse/bundle", json={"bundle_id": bundle_id})
    console.print(f"[green]Added[/green] bundle {bundle_id} to warehouse")


@warehouse_group.command("show")
@click.argument("ws_id")
def warehouse_show(ws_id):
    """Show warehouse contents."""
    data = _get(f"/workstream/{ws_id}/warehouse")
    console.print(f"\n[bold]Context Warehouse[/bold]")
    if data.get("bundles"):
        console.print(f"Bundles: {', '.join(data['bundles'])}")
    if data.get("files"):
        console.print(f"Files: {len(data['files'])}")
    if data.get("notes"):
        console.print(f"Notes: {data['notes'][:200]}...")


# ── Execution ────────────────────────────────────────────────

@workstream.command("next")
@click.argument("ws_id")
def next_task(ws_id):
    """Get the next ready task from the Runbook."""
    data = _get(f"/workstream/{ws_id}/next-task")
    if not data:
        console.print("[dim]No tasks ready.[/dim]")
        return
    console.print(f"[bold]Next task:[/bold] {data['title']} ({data['task_id']})")


@workstream.command("dispatch")
@click.argument("ws_id")
@click.argument("task_id")
@click.option("--agent-type", "-a", default="claude_code", help="Agent type")
def dispatch(ws_id, task_id, agent_type):
    """Dispatch a task to an agent with sliced context."""
    data = _post(f"/workstream/{ws_id}/dispatch/{task_id}", json={"agent_type": agent_type})
    console.print(f"[green]Dispatched[/green] {task_id} to {agent_type}")
    if data.get("context_slice_id"):
        console.print(f"Context slice: {data['context_slice_id']}")


@workstream.command("complete")
@click.argument("ws_id")
@click.argument("task_id")
@click.option("--success/--failed", default=True)
@click.option("--output", "-o", default="", help="Task output")
def complete(ws_id, task_id, success, output):
    """Mark a task as completed."""
    data = _post(f"/workstream/{ws_id}/complete/{task_id}", json={
        "success": success, "output": output,
    })
    status = "[green]completed[/green]" if success else "[red]failed[/red]"
    console.print(f"Task {task_id} {status}")
