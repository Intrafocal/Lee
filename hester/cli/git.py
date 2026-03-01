"""
Hester CLI - Git commands with AI-powered commit messages.

Usage:
    hester git status [-s/--short]
    hester git diff [--staged] [--stat] [FILE]
    hester git log [-n COUNT] [--oneline]
    hester git branch [-a/--all] [-r/--remote]
    hester git add [FILES...] [-A/--all]
    hester git commit [-m MESSAGE] [--style conventional|simple|detailed] [--dry-run]
"""

import asyncio
import os
import sys
from typing import Optional, Tuple

import click
from rich.console import Console
from rich.panel import Panel
from rich.syntax import Syntax

console = Console()


@click.group()
def git():
    """Git commands with AI-powered commit messages."""
    pass


@git.command("status")
@click.option(
    "--short", "-s",
    is_flag=True,
    help="Use short/compact format"
)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory (default: current directory)"
)
def git_status_cmd(short: bool, working_dir: Optional[str]):
    """Show working tree status.

    Examples:
        hester git status
        hester git status -s
    """
    from hester.daemon.tools.git_tools import git_status

    working_dir = working_dir or os.getcwd()

    result = asyncio.run(git_status(short=short, working_dir=working_dir))

    if result.success:
        data = result.data

        if short:
            # Short format - just show the porcelain output
            console.print(data.get("short_status", ""))
        else:
            # Full format
            console.print(f"[bold]On branch[/bold] {data.get('branch', 'unknown')}")

            ahead = data.get("ahead", 0)
            behind = data.get("behind", 0)
            if ahead or behind:
                tracking_info = []
                if ahead:
                    tracking_info.append(f"[green]ahead {ahead}[/green]")
                if behind:
                    tracking_info.append(f"[red]behind {behind}[/red]")
                console.print(f"Your branch is {', '.join(tracking_info)}")

            console.print()

            staged = data.get("staged", [])
            modified = data.get("modified", [])
            untracked = data.get("untracked", [])
            deleted = data.get("deleted", [])

            if staged:
                console.print("[green]Changes to be committed:[/green]")
                for file in staged:
                    console.print(f"  [green]staged:[/green] {file}")
                console.print()

            if modified:
                console.print("[red]Changes not staged for commit:[/red]")
                for file in modified:
                    console.print(f"  [red]modified:[/red] {file}")
                console.print()

            if deleted:
                console.print("[red]Deleted files not staged:[/red]")
                for file in deleted:
                    console.print(f"  [red]deleted:[/red] {file}")
                console.print()

            if untracked:
                console.print("[dim]Untracked files:[/dim]")
                for file in untracked:
                    console.print(f"  [dim]{file}[/dim]")
                console.print()

            if not staged and not modified and not untracked and not deleted:
                console.print("[green]Nothing to commit, working tree clean[/green]")
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)


@git.command("diff")
@click.option(
    "--staged", "-s",
    is_flag=True,
    help="Show staged changes only"
)
@click.option(
    "--stat",
    is_flag=True,
    help="Show diffstat summary instead of full diff"
)
@click.option(
    "--commit", "-c",
    default=None,
    help="Compare against a specific commit (e.g., HEAD~1, main)"
)
@click.argument("file", required=False)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory"
)
def git_diff_cmd(
    staged: bool,
    stat: bool,
    commit: Optional[str],
    file: Optional[str],
    working_dir: Optional[str],
):
    """Show changes in the repository.

    Examples:
        hester git diff              # unstaged changes
        hester git diff --staged     # staged changes
        hester git diff --stat       # summary
        hester git diff src/main.py  # specific file
        hester git diff -c HEAD~1    # compare with previous commit
    """
    from hester.daemon.tools.git_tools import git_diff

    working_dir = working_dir or os.getcwd()

    result = asyncio.run(git_diff(
        staged=staged,
        file=file,
        commit=commit,
        stat=stat,
        working_dir=working_dir,
    ))

    if result.success:
        diff_output = result.data.get("diff", "")
        if diff_output:
            if stat:
                console.print(diff_output)
            else:
                # Syntax highlight the diff
                syntax = Syntax(diff_output, "diff", theme="monokai")
                console.print(syntax)
        else:
            console.print("[dim]No changes[/dim]")
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)


@git.command("log")
@click.option(
    "--count", "-n",
    default=10,
    help="Number of commits to show (default: 10)"
)
@click.option(
    "--oneline",
    is_flag=True,
    help="Use compact one-line format"
)
@click.option(
    "--author", "-a",
    default=None,
    help="Filter by author name/email"
)
@click.argument("file", required=False)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory"
)
def git_log_cmd(
    count: int,
    oneline: bool,
    author: Optional[str],
    file: Optional[str],
    working_dir: Optional[str],
):
    """Show commit history.

    Examples:
        hester git log              # last 10 commits
        hester git log -n 5         # last 5 commits
        hester git log --oneline    # compact format
        hester git log src/main.py  # commits for specific file
    """
    from hester.daemon.tools.git_tools import git_log

    working_dir = working_dir or os.getcwd()

    result = asyncio.run(git_log(
        count=count,
        oneline=oneline,
        file=file,
        author=author,
        working_dir=working_dir,
    ))

    if result.success:
        if oneline:
            # Oneline mode - use raw log output
            log_output = result.data.get("log", "")
            if log_output:
                console.print(log_output.strip())
            else:
                console.print("[dim]No commits[/dim]")
        else:
            # Full mode - use parsed commits
            commits = result.data.get("commits", [])
            if not commits:
                console.print("[dim]No commits[/dim]")
                return

            for commit in commits:
                console.print(f"[yellow]commit {commit['hash']}[/yellow]")
                console.print(f"Author: {commit['author']}")
                console.print(f"Date:   {commit['date']}")
                console.print()
                console.print(f"    {commit['message']}")
                console.print()
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)


@git.command("branch")
@click.option(
    "--all", "-a",
    "show_all",
    is_flag=True,
    help="Show all branches (local and remote)"
)
@click.option(
    "--remote", "-r",
    "show_remote",
    is_flag=True,
    help="Show only remote branches"
)
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show last commit for each branch"
)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory"
)
def git_branch_cmd(
    show_all: bool,
    show_remote: bool,
    verbose: bool,
    working_dir: Optional[str],
):
    """List branches.

    Examples:
        hester git branch          # local branches
        hester git branch -a       # all branches
        hester git branch -r       # remote branches
        hester git branch -v       # with last commit
    """
    from hester.daemon.tools.git_tools import git_branch

    working_dir = working_dir or os.getcwd()

    result = asyncio.run(git_branch(
        all=show_all,
        remote=show_remote,
        verbose=verbose,
        working_dir=working_dir,
    ))

    if result.success:
        branches = result.data.get("branches", [])
        current = result.data.get("current")

        if not branches:
            console.print("[dim]No branches[/dim]")
            return

        for branch in branches:
            prefix = "[green]*[/green] " if branch == current else "  "
            color = "green" if branch == current else ""
            if color:
                console.print(f"{prefix}[{color}]{branch}[/{color}]")
            else:
                console.print(f"{prefix}{branch}")
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)


@git.command("add")
@click.argument("files", nargs=-1)
@click.option(
    "--all", "-A",
    "add_all",
    is_flag=True,
    help="Stage all changes including untracked (git add -A)"
)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory"
)
def git_add_cmd(files: Tuple[str, ...], add_all: bool, working_dir: Optional[str]):
    """Stage files for commit.

    Examples:
        hester git add src/main.py      # stage specific file
        hester git add .                 # stage all in current dir
        hester git add -A                # stage all changes
    """
    from hester.daemon.tools.git_tools import git_add

    working_dir = working_dir or os.getcwd()

    if not files and not add_all:
        console.print("[yellow]No files specified. Use -A to stage all changes.[/yellow]")
        sys.exit(1)

    result = asyncio.run(git_add(
        files=list(files) if files else None,
        all=add_all,
        working_dir=working_dir,
    ))

    if result.success:
        staged = result.data.get("staged", [])
        if staged:
            console.print(f"[green]Staged {len(staged)} file(s):[/green]")
            for file in staged:
                console.print(f"  {file}")
        else:
            console.print("[dim]No files to stage[/dim]")
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)


@git.command("commit")
@click.option(
    "--message", "-m",
    default=None,
    help="Commit message (if not provided, auto-generates from diff)"
)
@click.option(
    "--style", "-s",
    type=click.Choice(["conventional", "simple", "detailed"]),
    default="conventional",
    help="Commit message style for auto-generation (default: conventional)"
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Preview commit without creating it"
)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory"
)
def git_commit_cmd(
    message: Optional[str],
    style: str,
    dry_run: bool,
    working_dir: Optional[str],
):
    """Create a commit with staged changes.

    If no message is provided, auto-generates from the staged diff using AI.

    Styles:
      - conventional: feat:, fix:, docs:, etc. (default)
      - simple: Single sentence summary
      - detailed: Summary + bullet points

    Examples:
        hester git commit                      # auto-generate message
        hester git commit -m "Fix login bug"   # explicit message
        hester git commit --style simple       # simple auto-message
        hester git commit --dry-run            # preview without committing
    """
    from hester.daemon.tools.git_tools import git_commit

    working_dir = working_dir or os.getcwd()

    auto_message = message is None

    if auto_message:
        console.print("[cyan]Generating commit message from staged diff...[/cyan]")

    result = asyncio.run(git_commit(
        message=message,
        auto_message=auto_message,
        style=style,
        dry_run=dry_run,
        working_dir=working_dir,
    ))

    if result.success:
        data = result.data

        if dry_run:
            console.print("\n[bold]Dry run - commit preview:[/bold]")
            console.print(Panel(
                data.get("message", ""),
                title="Commit Message",
                border_style="cyan",
            ))
            console.print()
            staged_files = data.get("staged_files", [])
            console.print(f"[dim]Files to commit: {len(staged_files)}[/dim]")
            console.print("[yellow]Use without --dry-run to create the commit[/yellow]")
        else:
            console.print()
            # Parse commit hash from output
            output = data.get("output", "")
            commit_hash = ""
            for line in output.split("\n"):
                if line.strip().startswith("["):
                    # Extract hash from line like "[main abc1234] message"
                    parts = line.split("]")[0].split()
                    if len(parts) >= 2:
                        commit_hash = parts[-1]
                    break
            console.print(f"[green]Committed:[/green] {commit_hash[:7] if commit_hash else 'success'}")
            console.print(Panel(
                data.get("message", ""),
                title="Commit Message",
                border_style="green",
            ))
    else:
        console.print(f"[red]Error: {result.error}[/red]")
        sys.exit(1)
