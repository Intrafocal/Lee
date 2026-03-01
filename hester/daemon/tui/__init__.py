"""
TUI package - modular components for Hester chat interface.

This package contains:
- constants: Style definitions, depth options, slash commands
- utils: Utility functions (clipboard image handling)
- models: Data models (ChatMessage, PendingImage, TUIChatState)
- completers: Input completers for prompt_toolkit
- selectors: Interactive terminal selectors
- display: HesterChatTUI display class
- runner: HesterChatRunner and run_chat_tui entry point
"""

from .runner import HesterChatRunner, run_chat_tui

__all__ = ["HesterChatRunner", "run_chat_tui"]
