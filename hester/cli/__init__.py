"""
Hester CLI - Command-line interface for the internal daemon.

This module re-exports the main CLI group with all subcommands.
"""

from .main import cli, main

__all__ = ["cli", "main"]
