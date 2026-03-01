"""
Hester Task System - Task orchestration with markdown storage.
"""

from .models import (
    Task,
    TaskBatch,
    TaskStatus,
    BatchStatus,
    BatchDelegate,
    TaskContext,
    TaskLogEntry,
)
from .store import TaskStore
from .planner import TaskPlanner
from .executor import TaskExecutor
from .claude_delegate import ClaudeDelegate
from .code_explorer_delegate import CodeExplorerDelegate
from .web_researcher_delegate import WebResearcherDelegate
from .docs_manager_delegate import DocsManagerDelegate
from .db_explorer_delegate import DbExplorerDelegate
from .test_runner_delegate import TestRunnerDelegate
from .tools import (
    init_task_store,
    get_store,
    create_task,
    get_task,
    update_task,
    list_tasks,
    delete_task,
    mark_task_ready,
    add_batch,
    add_context,
)

__all__ = [
    # Models
    "Task",
    "TaskBatch",
    "TaskStatus",
    "BatchStatus",
    "BatchDelegate",
    "TaskContext",
    "TaskLogEntry",
    # Core classes
    "TaskStore",
    "TaskPlanner",
    "TaskExecutor",
    "ClaudeDelegate",
    "CodeExplorerDelegate",
    "WebResearcherDelegate",
    "DocsManagerDelegate",
    "DbExplorerDelegate",
    "TestRunnerDelegate",
    # Tool functions
    "init_task_store",
    "get_store",
    "create_task",
    "get_task",
    "update_task",
    "list_tasks",
    "delete_task",
    "mark_task_ready",
    "add_batch",
    "add_context",
]
