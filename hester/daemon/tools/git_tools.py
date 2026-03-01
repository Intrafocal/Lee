"""
Git Tools - Git CLI wrappers for Hester.

Provides async implementations for git operations:
- Read-only: git_status, git_diff, git_log, git_branch
- Write: git_add, git_commit (with AI-powered message generation)
"""

import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .definitions.models import ToolResult
from .summarize import summarize_text

logger = logging.getLogger("hester.daemon.tools.git_tools")


# =============================================================================
# Shell Execution Helpers
# =============================================================================

def _get_shell_env() -> Dict[str, str]:
    """Get environment with extended PATH for shell commands."""
    env = {**os.environ}

    extra_paths = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / "bin"),
    ]

    current_path = env.get("PATH", "")
    path_parts = current_path.split(":") if current_path else []

    for extra in extra_paths:
        if extra not in path_parts:
            path_parts.insert(0, extra)

    env["PATH"] = ":".join(path_parts)
    return env


def _run_git_command(
    args: List[str],
    cwd: Optional[str] = None,
    timeout: int = 60,
) -> subprocess.CompletedProcess:
    """
    Run a git command with proper environment setup.

    Args:
        args: Git command arguments (without 'git' prefix)
        cwd: Working directory
        timeout: Command timeout in seconds

    Returns:
        subprocess.CompletedProcess with stdout/stderr
    """
    cmd = ["git"] + args
    cmd_str = " ".join(cmd)

    shell = os.environ.get("SHELL", "/bin/bash")
    shell_cmd = [shell, "-ilc", cmd_str]

    return subprocess.run(
        shell_cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_get_shell_env(),
    )


# =============================================================================
# Data Models
# =============================================================================

@dataclass
class GitStatusResult:
    """Parsed git status information."""
    branch: str = ""
    ahead: int = 0
    behind: int = 0
    staged_files: List[str] = field(default_factory=list)
    modified_files: List[str] = field(default_factory=list)
    untracked_files: List[str] = field(default_factory=list)
    deleted_files: List[str] = field(default_factory=list)

    @property
    def has_changes(self) -> bool:
        return bool(
            self.staged_files or self.modified_files or
            self.untracked_files or self.deleted_files
        )

    @property
    def total_changes(self) -> int:
        return (
            len(self.staged_files) + len(self.modified_files) +
            len(self.untracked_files) + len(self.deleted_files)
        )


def _parse_git_status(porcelain_output: str, branch: str = "") -> GitStatusResult:
    """Parse git status --porcelain output into structured data."""
    status = GitStatusResult(branch=branch)

    for line in porcelain_output.strip().split("\n"):
        if not line or len(line) < 3:
            continue

        index_status = line[0]
        work_tree_status = line[1]
        file_path = line[3:].strip()

        if not file_path:
            continue

        # Untracked files
        if index_status == "?" and work_tree_status == "?":
            status.untracked_files.append(file_path)
        # Staged files (added, modified, renamed, copied, type changed)
        elif index_status in "AMRCT" and work_tree_status in " ":
            status.staged_files.append(file_path)
        # Staged deletion
        elif index_status == "D" and work_tree_status == " ":
            status.staged_files.append(file_path)
        # Modified in working tree (not staged)
        elif work_tree_status == "M":
            status.modified_files.append(file_path)
        # Deleted in working tree (not staged)
        elif work_tree_status == "D":
            status.deleted_files.append(file_path)

    return status


def _parse_ahead_behind(status_sb_output: str, status: GitStatusResult) -> None:
    """Parse ahead/behind counts from git status -sb output."""
    first_line = status_sb_output.split("\n")[0] if status_sb_output else ""

    ahead_match = re.search(r"ahead (\d+)", first_line)
    if ahead_match:
        status.ahead = int(ahead_match.group(1))

    behind_match = re.search(r"behind (\d+)", first_line)
    if behind_match:
        status.behind = int(behind_match.group(1))


# =============================================================================
# Commit Message Generation
# =============================================================================

COMMIT_MESSAGE_PROMPT = """Generate a git commit message for the following diff.

Style: {style}
- conventional: Use conventional commits format (feat:, fix:, docs:, style:, refactor:, test:, chore:)
- simple: Single sentence summary
- detailed: Summary line + blank line + bullet points

Guidelines:
- Focus on WHAT changed and WHY (not HOW)
- Be concise but informative
- For conventional commits, choose the appropriate type:
  - feat: A new feature
  - fix: A bug fix
  - docs: Documentation changes
  - style: Code style changes (formatting, whitespace)
  - refactor: Code refactoring (no feature/bug change)
  - test: Adding/updating tests
  - chore: Maintenance tasks, build changes

Diff:
{diff}

Return ONLY the commit message, no quotes or additional text."""


async def generate_commit_message(
    diff: str,
    style: str = "conventional",
) -> str:
    """
    Generate a commit message from git diff using AI summarization.

    Args:
        diff: The git diff output
        style: Message style - "conventional", "simple", or "detailed"

    Returns:
        Generated commit message string
    """
    if not diff or not diff.strip():
        return "Empty commit"

    # Truncate diff to avoid token limits
    truncated_diff = diff[:4000]
    if len(diff) > 4000:
        truncated_diff += "\n... (diff truncated)"

    prompt = COMMIT_MESSAGE_PROMPT.format(style=style, diff=truncated_diff)

    result = await summarize_text(
        text=prompt,
        max_length=200 if style == "simple" else 500,
        style="technical",
        context=f"git commit message ({style} style)",
    )

    message = result.get("summary", "")

    # Clean up the message
    message = message.strip()
    # Remove surrounding quotes if present
    if message.startswith('"') and message.endswith('"'):
        message = message[1:-1]
    if message.startswith("'") and message.endswith("'"):
        message = message[1:-1]

    return message or "Update code"


# =============================================================================
# Tool Implementations
# =============================================================================

async def git_status(
    short: bool = False,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    Get current git repository status.

    Args:
        short: Use short/compact format
        working_dir: Working directory (defaults to cwd)

    Returns:
        ToolResult with branch, staged, modified, untracked files
    """
    working_dir = working_dir or os.getcwd()

    try:
        # Check if it's a git repo
        check_result = _run_git_command(["rev-parse", "--git-dir"], cwd=working_dir)
        if check_result.returncode != 0:
            return ToolResult(
                success=False,
                error="Not a git repository",
            )

        # Get branch name
        branch_result = _run_git_command(["branch", "--show-current"], cwd=working_dir)
        branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""

        # Get status with porcelain for parsing
        status_result = _run_git_command(["status", "--porcelain=v1"], cwd=working_dir)

        if status_result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Git status failed: {status_result.stderr}",
            )

        # Parse status output
        status = _parse_git_status(status_result.stdout, branch)

        # Get ahead/behind info
        tracking_result = _run_git_command(["status", "-sb"], cwd=working_dir)
        if tracking_result.returncode == 0:
            _parse_ahead_behind(tracking_result.stdout, status)

        return ToolResult(
            success=True,
            data={
                "branch": status.branch,
                "ahead": status.ahead,
                "behind": status.behind,
                "staged": status.staged_files,
                "modified": status.modified_files,
                "untracked": status.untracked_files,
                "deleted": status.deleted_files,
                "has_changes": status.has_changes,
                "total_changes": status.total_changes,
                "short_status": status_result.stdout,  # Raw porcelain output
            },
            message=f"Branch: {status.branch}, "
                    f"{len(status.staged_files)} staged, "
                    f"{len(status.modified_files)} modified, "
                    f"{len(status.untracked_files)} untracked",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git command timed out")
    except Exception as e:
        logger.error(f"git_status error: {e}")
        return ToolResult(success=False, error=f"Git status error: {e}")


async def git_diff(
    staged: bool = False,
    file: Optional[str] = None,
    commit: Optional[str] = None,
    stat: bool = False,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    Get diff of changes in the repository.

    Args:
        staged: Show staged changes only (--cached)
        file: Specific file to diff
        commit: Compare against specific commit
        stat: Show diffstat summary instead of full diff
        working_dir: Working directory

    Returns:
        ToolResult with diff output
    """
    working_dir = working_dir or os.getcwd()

    try:
        args = ["diff"]

        if staged:
            args.append("--cached")

        if stat:
            args.append("--stat")

        if commit:
            args.append(commit)

        if file:
            args.append("--")
            args.append(file)

        result = _run_git_command(args, cwd=working_dir)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Git diff failed: {result.stderr}",
            )

        diff_output = result.stdout

        # Count files changed if stat mode
        files_changed = 0
        if stat and diff_output:
            # Count lines that look like file stats
            files_changed = len([
                line for line in diff_output.split("\n")
                if "|" in line and ("+" in line or "-" in line)
            ])

        return ToolResult(
            success=True,
            data={
                "diff": diff_output,
                "staged": staged,
                "file": file,
                "commit": commit,
                "stat": stat,
                "files_changed": files_changed if stat else None,
            },
            message=f"Diff: {len(diff_output)} chars"
                    + (f", {files_changed} files" if stat else ""),
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git diff timed out")
    except Exception as e:
        logger.error(f"git_diff error: {e}")
        return ToolResult(success=False, error=f"Git diff error: {e}")


async def git_log(
    count: int = 10,
    oneline: bool = False,
    file: Optional[str] = None,
    author: Optional[str] = None,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    Get recent commit history.

    Args:
        count: Number of commits to show
        oneline: Use compact one-line format
        file: Show commits affecting specific file
        author: Filter by author
        working_dir: Working directory

    Returns:
        ToolResult with commit history
    """
    working_dir = working_dir or os.getcwd()

    try:
        args = ["log", f"-{count}"]

        if oneline:
            args.append("--oneline")
        else:
            args.append("--format=%H%n%an%n%ae%n%ai%n%s%n---")

        if author:
            args.append(f"--author={author}")

        if file:
            args.append("--")
            args.append(file)

        result = _run_git_command(args, cwd=working_dir)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Git log failed: {result.stderr}",
            )

        log_output = result.stdout

        # Parse commits if not oneline
        commits = []
        if not oneline and log_output:
            for entry in log_output.strip().split("---"):
                entry = entry.strip()
                if not entry:
                    continue
                lines = entry.split("\n")
                if len(lines) >= 5:
                    commits.append({
                        "hash": lines[0],
                        "author": lines[1],
                        "email": lines[2],
                        "date": lines[3],
                        "message": lines[4],
                    })

        return ToolResult(
            success=True,
            data={
                "commits": commits if not oneline else None,
                "log": log_output if oneline else None,
                "count": len(commits) if commits else count,
            },
            message=f"Log: {len(commits) if commits else count} commits",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git log timed out")
    except Exception as e:
        logger.error(f"git_log error: {e}")
        return ToolResult(success=False, error=f"Git log error: {e}")


async def git_branch(
    all: bool = False,
    remote: bool = False,
    verbose: bool = False,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    List branches in the repository.

    Args:
        all: Show all branches (local and remote)
        remote: Show only remote branches
        verbose: Show last commit for each branch
        working_dir: Working directory

    Returns:
        ToolResult with branch list
    """
    working_dir = working_dir or os.getcwd()

    try:
        args = ["branch"]

        if all:
            args.append("-a")
        elif remote:
            args.append("-r")

        if verbose:
            args.append("-v")

        result = _run_git_command(args, cwd=working_dir)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Git branch failed: {result.stderr}",
            )

        # Parse branches
        branches = []
        current_branch = None

        for line in result.stdout.strip().split("\n"):
            if not line:
                continue

            is_current = line.startswith("*")
            branch_name = line.lstrip("* ").split()[0] if line.strip() else ""

            if branch_name:
                branches.append(branch_name)
                if is_current:
                    current_branch = branch_name

        return ToolResult(
            success=True,
            data={
                "branches": branches,
                "current": current_branch,
                "count": len(branches),
                "raw_output": result.stdout if verbose else None,
            },
            message=f"Branches: {len(branches)}, current: {current_branch}",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git branch timed out")
    except Exception as e:
        logger.error(f"git_branch error: {e}")
        return ToolResult(success=False, error=f"Git branch error: {e}")


async def git_add(
    files: Optional[List[str]] = None,
    all: bool = False,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    Stage files for commit.

    Args:
        files: List of files/paths to stage
        all: Stage all changes including untracked (git add -A)
        working_dir: Working directory

    Returns:
        ToolResult with staged files
    """
    working_dir = working_dir or os.getcwd()

    try:
        if not files and not all:
            return ToolResult(
                success=False,
                error="Specify files to add or use all=True",
            )

        args = ["add"]

        if all:
            args.append("-A")
        elif files:
            args.extend(files)

        result = _run_git_command(args, cwd=working_dir)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Git add failed: {result.stderr}",
            )

        # Get updated status to confirm what was staged
        status_result = await git_status(working_dir=working_dir)

        staged = []
        if status_result.success and status_result.data:
            staged = status_result.data.get("staged", [])

        return ToolResult(
            success=True,
            data={
                "staged": staged,
                "files_added": files if files else "all",
            },
            message=f"Staged {len(staged)} files",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git add timed out")
    except Exception as e:
        logger.error(f"git_add error: {e}")
        return ToolResult(success=False, error=f"Git add error: {e}")


async def git_commit(
    message: Optional[str] = None,
    auto_message: bool = False,
    style: str = "conventional",
    dry_run: bool = False,
    working_dir: Optional[str] = None,
    **kwargs,
) -> ToolResult:
    """
    Create a commit with staged changes.

    Args:
        message: Commit message (required unless auto_message=True)
        auto_message: Auto-generate message from staged diff
        style: Message style for auto-generation (conventional/simple/detailed)
        dry_run: Preview commit without executing
        working_dir: Working directory

    Returns:
        ToolResult with commit info
    """
    working_dir = working_dir or os.getcwd()

    try:
        # Check for staged changes
        status_result = await git_status(working_dir=working_dir)
        if not status_result.success:
            return status_result

        staged = status_result.data.get("staged", [])
        if not staged:
            return ToolResult(
                success=False,
                error="No staged changes to commit. Use git_add first.",
            )

        # Generate message if auto_message requested
        if auto_message and not message:
            logger.info(f"Generating commit message with style: {style}")

            diff_result = await git_diff(staged=True, working_dir=working_dir)
            if not diff_result.success:
                return diff_result

            diff = diff_result.data.get("diff", "")
            message = await generate_commit_message(diff, style=style)

            logger.info(f"Generated commit message: {message[:80]}...")

            if dry_run:
                return ToolResult(
                    success=True,
                    data={
                        "dry_run": True,
                        "message": message,
                        "staged_files": staged,
                        "style": style,
                    },
                    message=f"[DRY RUN] Would commit {len(staged)} files: {message[:60]}...",
                )

        if not message:
            return ToolResult(
                success=False,
                error="Commit message required. Provide message or use auto_message=True.",
            )

        # Execute commit
        args = ["commit", "-m", message]
        if dry_run:
            args.insert(1, "--dry-run")

        result = _run_git_command(args, cwd=working_dir)

        if result.returncode != 0:
            return ToolResult(
                success=False,
                error=f"Commit failed: {result.stderr}",
            )

        return ToolResult(
            success=True,
            data={
                "message": message,
                "files_committed": staged,
                "output": result.stdout,
                "dry_run": dry_run,
            },
            message=f"Committed {len(staged)} files: {message[:60]}...",
        )

    except subprocess.TimeoutExpired:
        return ToolResult(success=False, error="Git commit timed out")
    except Exception as e:
        logger.error(f"git_commit error: {e}")
        return ToolResult(success=False, error=f"Git commit error: {e}")
