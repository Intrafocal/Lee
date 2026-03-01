"""
Task Store - File-based storage for tasks.
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from .models import Task, TaskStatus

logger = logging.getLogger("hester.daemon.tasks.store")

DEFAULT_TASKS_DIR = ".hester/tasks"


class TaskStore:
    """File-based task storage."""

    def __init__(self, tasks_dir: Optional[Path] = None, working_dir: Optional[Path] = None):
        """
        Initialize the task store.

        Args:
            tasks_dir: Directory for task files. If None, uses working_dir/.hester/tasks/
            working_dir: Working directory. If None, uses cwd.
        """
        self.working_dir = working_dir or Path.cwd()

        if tasks_dir:
            self.tasks_dir = Path(tasks_dir)
        else:
            self.tasks_dir = self.working_dir / DEFAULT_TASKS_DIR

        # Ensure directory exists
        self.tasks_dir.mkdir(parents=True, exist_ok=True)
        logger.debug(f"Task store initialized: {self.tasks_dir}")

    def _task_path(self, task_id: str) -> Path:
        """Get the file path for a task."""
        return self.tasks_dir / f"{task_id}.md"

    def create(self, title: str, goal: str = "", task_id: Optional[str] = None) -> Task:
        """
        Create a new task.

        Args:
            title: Task title
            goal: Task goal description
            task_id: Optional custom ID (hyphenated, e.g., 'update-deploy-docs')

        Returns:
            The created task
        """
        if task_id:
            task = Task(id=task_id, title=title, goal=goal)
        else:
            task = Task(title=title, goal=goal)
        task.add_log("Task created")

        self.save(task)
        logger.info(f"Created task: {task.id}")
        return task

    def save(self, task: Task) -> None:
        """
        Save a task to disk.

        Args:
            task: Task to save
        """
        task.updated_at = datetime.utcnow()
        path = self._task_path(task.id)
        path.write_text(task.to_markdown())
        logger.debug(f"Saved task: {task.id}")

    def get(self, task_id: str) -> Optional[Task]:
        """
        Get a task by ID.

        Args:
            task_id: Task ID

        Returns:
            Task if found, None otherwise
        """
        path = self._task_path(task_id)
        if not path.exists():
            logger.debug(f"Task not found: {task_id}")
            return None

        try:
            content = path.read_text()
            return Task.from_markdown(content)
        except Exception as e:
            logger.error(f"Failed to parse task {task_id}: {e}")
            return None

    def update(self, task_id: str, **updates) -> Optional[Task]:
        """
        Update a task.

        Args:
            task_id: Task ID
            **updates: Fields to update

        Returns:
            Updated task if found, None otherwise
        """
        task = self.get(task_id)
        if not task:
            return None

        for key, value in updates.items():
            if hasattr(task, key):
                setattr(task, key, value)

        self.save(task)
        logger.info(f"Updated task: {task_id}")
        return task

    def delete(self, task_id: str) -> bool:
        """
        Delete a task.

        Args:
            task_id: Task ID

        Returns:
            True if deleted, False if not found
        """
        path = self._task_path(task_id)
        if not path.exists():
            return False

        path.unlink()
        logger.info(f"Deleted task: {task_id}")
        return True

    def list_all(self, status: Optional[TaskStatus] = None) -> List[Task]:
        """
        List all tasks.

        Args:
            status: Optional filter by status

        Returns:
            List of tasks, sorted by updated_at descending
        """
        tasks: List[Task] = []

        for path in self.tasks_dir.glob("*.md"):
            try:
                content = path.read_text()
                task = Task.from_markdown(content)
                if status is None or task.status == status:
                    tasks.append(task)
            except Exception as e:
                logger.error(f"Failed to parse task file {path}: {e}")

        # Sort by updated_at descending (newest first)
        tasks.sort(key=lambda t: t.updated_at, reverse=True)
        return tasks

    def get_active(self) -> Optional[Task]:
        """
        Get the currently active (executing) task.

        Returns:
            Active task if any, None otherwise
        """
        tasks = self.list_all(status=TaskStatus.EXECUTING)
        return tasks[0] if tasks else None

    def get_planning(self) -> List[Task]:
        """
        Get all tasks in planning status.

        Returns:
            List of planning tasks
        """
        return self.list_all(status=TaskStatus.PLANNING)

    def get_ready(self) -> List[Task]:
        """
        Get all tasks ready for execution.

        Returns:
            List of ready tasks
        """
        return self.list_all(status=TaskStatus.READY)
