"""
Task Tools - ReAct tool handlers for task management.

Automatically pushes task status updates to Lee IDE status bar.
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Union

from .models import Task, TaskBatch, TaskStatus, BatchStatus, BatchDelegate, TaskContext
from .store import TaskStore

logger = logging.getLogger("hester.daemon.tasks.tools")


async def _notify_task_status(
    task_id: str,
    task_title: str,
    status: str,
    message_type: Literal["hint", "info", "success", "warning"] = "info",
    details: Optional[str] = None,
) -> None:
    """
    Push task status notification to Lee IDE status bar.

    Args:
        task_id: Task identifier
        task_title: Human-readable task title
        status: Status string (e.g., "created", "updated", "ready")
        message_type: Type of status message
        details: Optional additional details
    """
    try:
        from ..tools.ui_control import push_status_message

        # Build status message
        status_icons = {
            "created": "📋",
            "updated": "✏️",
            "ready": "▶️",
            "executing": "⚙️",
            "completed": "✅",
            "failed": "❌",
        }
        icon = status_icons.get(status, "📌")

        # Truncate title if too long
        short_title = task_title[:30] + "..." if len(task_title) > 30 else task_title

        message = f"{icon} {short_title}: {status}"
        if details:
            message = f"{message} - {details}"

        # Set TTL based on status
        ttl = 20 if status in ("created", "ready") else 15

        # Include prompt for quick access to task details
        prompt = f"/task {task_id}"

        await push_status_message(
            message=message,
            message_type=message_type,
            prompt=prompt,
            ttl=ttl,
        )
    except Exception as e:
        # Don't fail task operations if notification fails
        logger.debug(f"Failed to push task status to Lee: {e}")

# Module-level store instance (initialized by daemon)
_store: Optional[TaskStore] = None


def init_task_store(tasks_dir: Optional[Path] = None, working_dir: Optional[Path] = None) -> TaskStore:
    """
    Initialize the task store.

    Args:
        tasks_dir: Optional custom tasks directory
        working_dir: Working directory for default tasks location

    Returns:
        Initialized TaskStore
    """
    global _store
    _store = TaskStore(tasks_dir=tasks_dir, working_dir=working_dir)
    return _store


def get_store() -> TaskStore:
    """Get the task store, initializing if needed."""
    global _store
    if _store is None:
        _store = TaskStore()
    return _store


async def create_task(
    task_id: str,
    title: str,
    goal: str = "",
    **kwargs,
) -> Dict[str, Any]:
    """
    Create a new task.

    Args:
        task_id: Hyphenated 2-3 word ID (e.g., 'update-deploy-docs', 'fix-auth-bug')
        title: Task title
        goal: Task goal description

    Returns:
        Dict with task ID and status
    """
    store = get_store()
    task = store.create(task_id=task_id, title=title, goal=goal)

    logger.info(f"Created task: {task.id} - {title}")

    # Notify Lee of task creation
    await _notify_task_status(
        task_id=task.id,
        task_title=title,
        status="created",
        message_type="info",
    )

    return {
        "task_id": task.id,
        "title": task.title,
        "status": task.status.value,
        "file": str(store._task_path(task.id)),
        "message": f"Task created: {task.id}. Use add_context and add_batch to build the task, then mark_task_ready.",
    }


async def get_task(
    task_id: str,
    **kwargs,
) -> Dict[str, Any]:
    """
    Get task details.

    Args:
        task_id: Task ID

    Returns:
        Task details or error
    """
    store = get_store()
    task = store.get(task_id)

    if not task:
        return {"error": f"Task not found: {task_id}"}

    return {
        "task_id": task.id,
        "title": task.title,
        "status": task.status.value,
        "goal": task.goal,
        "context": task.context.model_dump(),
        "batches": [b.model_dump() for b in task.batches],
        "success_criteria": task.success_criteria,
        "log": [{"timestamp": e.timestamp.isoformat(), "event": e.event} for e in task.log],
    }


async def update_task(
    task_id: str,
    goal: Optional[str] = None,
    context: Optional[Dict[str, Any]] = None,
    batches: Optional[List[Dict[str, Any]]] = None,
    success_criteria: Optional[List[str]] = None,
    status: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Update a task.

    Args:
        task_id: Task ID
        goal: New goal description
        context: Context updates (files, web_research, codebase_notes)
        batches: List of batch definitions
        success_criteria: List of success criteria
        status: New status (planning, ready, executing, completed, failed)

    Returns:
        Updated task or error
    """
    store = get_store()
    task = store.get(task_id)

    if not task:
        return {"error": f"Task not found: {task_id}"}

    # Update fields
    if goal is not None:
        task.goal = goal
        task.add_log("Goal updated")

    if context is not None:
        if "files" in context:
            # Ensure files is always a list
            files_val = context["files"]
            if isinstance(files_val, str):
                task.context.files = _parse_list_param(files_val)
            elif isinstance(files_val, list):
                task.context.files = files_val
            else:
                task.context.files = []
        if "web_research" in context:
            # Ensure web_research is always a list
            research_val = context["web_research"]
            if isinstance(research_val, str):
                task.context.web_research = _parse_list_param(research_val)
            elif isinstance(research_val, list):
                task.context.web_research = research_val
            else:
                task.context.web_research = []
        if "codebase_notes" in context:
            task.context.codebase_notes = context["codebase_notes"]
        task.add_log("Context updated")

    if batches is not None:
        task.batches = []
        for batch_data in batches:
            batch = TaskBatch(
                title=batch_data.get("title", "Untitled Batch"),
                delegate=BatchDelegate(batch_data.get("delegate", "claude_code")),
                prompt=batch_data.get("prompt", ""),
                action=batch_data.get("action", ""),
                steps=batch_data.get("steps", []),
            )
            task.batches.append(batch)
        task.add_log(f"Updated with {len(task.batches)} batches")

    if success_criteria is not None:
        task.success_criteria = success_criteria
        task.add_log("Success criteria updated")

    if status is not None:
        old_status = task.status
        task.status = TaskStatus(status)
        task.add_log(f"Status changed: {old_status.value} -> {status}")

    store.save(task)

    # Notify Lee of task update
    await _notify_task_status(
        task_id=task.id,
        task_title=task.title,
        status="updated",
        message_type="info",
    )

    return {
        "task_id": task.id,
        "status": task.status.value,
        "message": "Task updated successfully",
    }


async def list_tasks(
    status: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    List all tasks.

    Args:
        status: Optional filter by status

    Returns:
        List of task summaries
    """
    store = get_store()

    status_filter = TaskStatus(status) if status else None
    tasks = store.list_all(status=status_filter)

    return {
        "tasks": [
            {
                "task_id": t.id,
                "title": t.title,
                "status": t.status.value,
                "goal": t.goal[:100] + "..." if len(t.goal) > 100 else t.goal,
                "batches": len(t.batches),
                "updated": t.updated_at.isoformat(),
            }
            for t in tasks
        ],
        "total": len(tasks),
    }


async def delete_task(
    task_id: str,
    **kwargs,
) -> Dict[str, Any]:
    """
    Delete a task.

    Args:
        task_id: Task ID

    Returns:
        Success or error
    """
    store = get_store()

    if store.delete(task_id):
        return {"message": f"Task deleted: {task_id}"}
    else:
        return {"error": f"Task not found: {task_id}"}


async def mark_task_ready(
    task_id: str,
    **kwargs,
) -> Dict[str, Any]:
    """
    Mark a task as ready for execution (after planning is complete).

    Args:
        task_id: Task ID

    Returns:
        Updated task or error
    """
    store = get_store()
    task = store.get(task_id)

    if not task:
        return {"error": f"Task not found: {task_id}"}

    if task.status != TaskStatus.PLANNING:
        return {"error": f"Task is not in planning status: {task.status.value}"}

    if not task.batches:
        return {"error": "Task has no batches defined. Add batches before marking as ready."}

    task.status = TaskStatus.READY
    task.add_log("Task marked as ready for execution")
    store.save(task)

    # Notify Lee that task is ready
    await _notify_task_status(
        task_id=task.id,
        task_title=task.title,
        status="ready",
        message_type="info",
        details=f"{len(task.batches)} batches",
    )

    return {
        "task_id": task.id,
        "status": task.status.value,
        "message": "Task is ready for execution. Use execute_task to start.",
    }


def _parse_list_param(value: Union[List[str], str, None]) -> List[str]:
    """Parse a parameter that may be a list or a JSON string of a list."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
        # If it's a non-empty string that's not JSON, treat as single item
        return [value] if value.strip() else []
    return []


async def add_batch(
    task_id: str,
    title: str,
    delegate: str = "claude_code",
    prompt: str = "",
    action: str = "",
    steps: Union[List[str], str, None] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Add a batch to a task.

    Args:
        task_id: Task ID
        title: Batch title
        delegate: Who handles it (claude_code, hester, manual)
        prompt: For claude_code batches, the prompt to send
        action: For hester batches, the action to perform
        steps: List of step descriptions (can be list or JSON string)

    Returns:
        Updated task or error
    """
    store = get_store()
    task = store.get(task_id)

    if not task:
        return {"error": f"Task not found: {task_id}"}

    # Parse steps - LLMs sometimes pass JSON strings instead of lists
    parsed_steps = _parse_list_param(steps)

    batch = TaskBatch(
        title=title,
        delegate=BatchDelegate(delegate),
        prompt=prompt,
        action=action,
        steps=parsed_steps,
    )
    task.batches.append(batch)
    task.add_log(f"Added batch: {title}")
    store.save(task)

    return {
        "task_id": task.id,
        "batch_id": batch.id,
        "message": f"Batch added: {title}",
    }


async def add_context(
    task_id: str,
    files: Union[List[str], str, None] = None,
    web_research: Union[List[str], str, None] = None,
    codebase_notes: Optional[str] = None,
    **kwargs,
) -> Dict[str, Any]:
    """
    Add context to a task.

    Args:
        task_id: Task ID
        files: Relevant file paths (can be list or JSON string)
        web_research: Web research findings (can be list or JSON string)
        codebase_notes: Notes about the codebase

    Returns:
        Updated task or error
    """
    store = get_store()
    task = store.get(task_id)

    if not task:
        return {"error": f"Task not found: {task_id}"}

    # Parse list parameters - LLMs sometimes pass JSON strings
    parsed_files = _parse_list_param(files)
    parsed_research = _parse_list_param(web_research)

    if parsed_files:
        task.context.files.extend(parsed_files)
    if parsed_research:
        task.context.web_research.extend(parsed_research)
    if codebase_notes:
        if task.context.codebase_notes:
            task.context.codebase_notes += f"\n{codebase_notes}"
        else:
            task.context.codebase_notes = codebase_notes

    task.add_log("Context updated")
    store.save(task)

    return {
        "task_id": task.id,
        "context": task.context.model_dump(),
        "message": "Context updated",
    }
