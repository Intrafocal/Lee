"""
Knowledge Package - Proactive knowledge management for Hester.

This package provides:
- KnowledgeStore: Redis-based storage for bundle and doc embeddings
- WarmContextBuffer: Per-session pre-loaded context with token budget
- KnowledgeEngine: Main orchestrator watching Lee context and conversation
- GitWatcher: Background task for git status polling
- TaskWatcher: Task completion hooks for documentation suggestions

Usage:
    from daemon.knowledge import (
        KnowledgeStore,
        WarmContextBuffer,
        WarmContext,
        KnowledgeEngine,
        KnowledgeMetrics,
        GitWatcher,
        TaskWatcher,
    )
"""

from .store import KnowledgeStore
from .buffer import WarmContextBuffer, WarmContext, LoadedBundle, LoadedDocChunk
from .engine import KnowledgeEngine, KnowledgeMetrics
from .git_watcher import GitWatcher, GitStatus
from .task_watcher import TaskWatcher, CompletedTask, analyze_task_changes
from .proactive_watcher import ProactiveWatcher, ProactiveStatus

__all__ = [
    "KnowledgeStore",
    "WarmContextBuffer",
    "WarmContext",
    "LoadedBundle",
    "LoadedDocChunk",
    "KnowledgeEngine",
    "KnowledgeMetrics",
    "GitWatcher",
    "GitStatus",
    "TaskWatcher",
    "CompletedTask",
    "analyze_task_changes",
    "ProactiveWatcher",
    "ProactiveStatus",
]
