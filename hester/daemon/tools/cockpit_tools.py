"""
Cockpit tool executors: read tasks, look at Lee's tabs, run or propose
operations. Only for user-triggered surfaces (a chat or palette request).

C3: none of these can type into a PTY, confirm/link/close a task, approve a
proposal or launch an agent. Lee enforces it too: with the shared token the
``tab`` domain refuses ``send_input`` and turns ``checkin`` into a Feed
proposal, and ``ops`` turns anything but a defined, confirmed, non-``confirm``
operation into a proposal the user approves in the Cockpit.
"""

import logging
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from ...shared.auth import auth_headers
from ...shared.workspace import encode_workspace_header, get_current_workspace

logger = logging.getLogger("hester.tools.cockpit")

MAX_READ_LINES = 200
COMMAND_TIMEOUT_S = 10.0


def _workspace(working_dir: Optional[str]) -> str:
    if working_dir:
        p = Path(working_dir).expanduser()
        if p.is_absolute() and p.is_dir():
            return str(p.resolve())
    return str(get_current_workspace())


def _lee_url() -> str:
    from ..copilot import lee_events
    return lee_events.get_client().lee_url


async def lee_command(
    domain: str,
    action: str,
    params: Dict[str, Any],
    workspace: str,
    timeout: float = COMMAND_TIMEOUT_S,
) -> Dict[str, Any]:
    """POST Lee's /command with the shared token. Returns ``{status, body}`` or ``{error}``."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{_lee_url()}/command",
                json={"domain": domain, "action": action, "params": params},
                headers=auth_headers({"X-Lee-Workspace": encode_workspace_header(workspace)}),
            )
    except httpx.ConnectError:
        return {"error": "Cannot connect to Lee. Is it running?"}
    except httpx.TimeoutException:
        return {"error": f"Lee did not answer within {timeout:.0f}s"}
    except Exception as e:
        return {"error": str(e)}
    try:
        body = resp.json()
    except ValueError:
        body = {"success": False, "error": resp.text or f"HTTP {resp.status_code}"}
    return {"status": resp.status_code, "body": body if isinstance(body, dict) else {"data": body}}


def _result(out: Dict[str, Any], message: Optional[str] = None) -> Dict[str, Any]:
    if "error" in out:
        return {"success": False, "error": out["error"]}
    body = out["body"]
    if out["status"] >= 400 or body.get("success") is False:
        return {"success": False, "error": body.get("error") or f"HTTP {out['status']}"}
    # Lee's `tab` domain and most `ops` actions wrap results in {success, data};
    # `ops run`/`propose` return the OpRunResult itself (proposal_id, run, ...).
    data = body["data"] if "data" in body else {k: v for k, v in body.items() if k != "success"}
    result = {"success": True, "data": data}
    if message:
        result["message"] = message
    return result


async def cockpit_tasks(status: str = "open", limit: int = 20, working_dir: Optional[str] = None) -> Dict[str, Any]:
    """Open (or closed/all) Cockpit tasks of this workspace. Read-only."""
    from ..cockpit.tasks import CockpitTaskStore, TaskError

    ws = _workspace(working_dir)
    try:
        tasks = CockpitTaskStore(Path(ws)).list(status, max(1, min(int(limit or 20), 100)))
    except TaskError as e:
        return {"success": False, "error": str(e)}
    rows = [
        {
            "id": t["id"], "title": t["title"], "status": t["status"], "lead": t["lead"], "kind": t["kind"],
            "confirmed": t["confirmed"], "busy_ms": t["busy_ms"], "turns": t["turns"],
            "files_count": t["files_count"], "summary": t["summary"],
            "pty_id": (t.get("agent") or {}).get("pty_id"), "updated_at": t["updated_at"],
        }
        for t in tasks
    ]
    return {"success": True, "data": {"workspace": ws, "tasks": rows}}


async def knowledge_notes(name: Optional[str] = None, working_dir: Optional[str] = None) -> Dict[str, Any]:
    """This workspace's knowledge notes (.hester/knowledge/): list, or read one by name. Read-only."""
    from ..cockpit.explore_ops import list_knowledge, read_knowledge
    from ..cockpit.explorations import ExplorationError

    ws = _workspace(working_dir)
    if not name:
        return {"success": True, "data": {"workspace": ws, "notes": list_knowledge(Path(ws))}}
    try:
        text = read_knowledge(Path(ws), str(name))
    except ExplorationError as e:
        return {"success": False, "error": str(e)}
    if text is None:
        return {"success": False, "error": f"no knowledge note named {name}"}
    return {"success": True, "data": {"workspace": ws, "name": str(name).removesuffix(".md"), "content": text}}


async def lee_tabs(working_dir: Optional[str] = None) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    return _result(await lee_command("tab", "list", {"workspace": ws}, ws))


async def lee_tab_read(pty_id: int, lines: int = 50, working_dir: Optional[str] = None) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    n = max(1, min(int(lines or 50), MAX_READ_LINES))
    return _result(await lee_command("tab", "read_output", {"pty_id": int(pty_id), "lines": n}, ws))


async def lee_tab_checkin(pty_id: int, working_dir: Optional[str] = None) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    return _result(
        await lee_command("tab", "checkin", {"pty_id": int(pty_id)}, ws),
        "Proposed a check-in. It runs only when the user clicks it in the Cockpit feed.",
    )


async def lee_operations(working_dir: Optional[str] = None) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    return _result(await lee_command("ops", "list", {"workspace": ws}, ws))


async def lee_operation_run(
    name: str,
    params: Optional[Dict[str, Any]] = None,
    working_dir: Optional[str] = None,
) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    payload: Dict[str, Any] = {"workspace": ws, "name": name}
    if params:
        payload["params"] = params
    out = await lee_command("ops", "run", payload, ws)
    result = _result(out)
    if result.get("success") and out.get("status") == 202:
        result["message"] = (
            f"'{name}' needs the user's approval. It is waiting as a proposal in the Cockpit feed; "
            "tell the user to approve it there."
        )
    elif result.get("success"):
        result["message"] = f"Lee is running '{name}' in a terminal tab."
    return result


async def lee_operation_propose(
    command: str,
    cwd: Optional[str] = None,
    reason: Optional[str] = None,
    working_dir: Optional[str] = None,
) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    payload: Dict[str, Any] = {"workspace": ws, "command": command}
    if cwd:
        payload["cwd"] = cwd
    if reason:
        payload["reason"] = reason
    return _result(
        await lee_command("ops", "propose", payload, ws),
        "Proposed. Nothing runs until the user approves it in the Cockpit feed.",
    )


async def lee_operation_result(run_id: str, working_dir: Optional[str] = None) -> Dict[str, Any]:
    ws = _workspace(working_dir)
    return _result(await lee_command("ops", "result", {"run_id": run_id}, ws))
