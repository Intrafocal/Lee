"""
Git tool definitions - git CLI wrappers for Hester.

Provides declarative schemas for git operations:
- Read-only: status, diff, log, branch
- Write: add, commit
"""

from .models import ToolDefinition

# All git tools require codebase access - not available in slack
_GIT_ENVIRONMENTS = {"daemon", "cli", "subagent"}

# =============================================================================
# Git Status Tools (Read-Only)
# =============================================================================

GIT_STATUS_TOOL = ToolDefinition(
    name="git_status",
    description="""Get current git repository status.
Returns information about staged, unstaged, and untracked files.
Also includes branch name and ahead/behind tracking.

Examples:
- git_status() - get full structured status
- git_status(short=True) - get compact status output""",
    parameters={
        "type": "object",
        "properties": {
            "short": {
                "type": "boolean",
                "description": "Use short/compact format (default: False)",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

GIT_DIFF_TOOL = ToolDefinition(
    name="git_diff",
    description="""Get diff of changes in the repository.
Can show staged changes (--cached), unstaged changes, or diff between commits.

Examples:
- git_diff() - show unstaged changes
- git_diff(staged=True) - show staged changes only
- git_diff(file="src/main.py") - show changes to specific file
- git_diff(commit="HEAD~1") - compare with previous commit
- git_diff(stat=True) - show diffstat summary""",
    parameters={
        "type": "object",
        "properties": {
            "staged": {
                "type": "boolean",
                "description": "Show staged changes only (git diff --cached)",
            },
            "file": {
                "type": "string",
                "description": "Specific file to diff",
            },
            "commit": {
                "type": "string",
                "description": "Compare against a specific commit (e.g., HEAD~1, main)",
            },
            "stat": {
                "type": "boolean",
                "description": "Show diffstat summary instead of full diff",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

GIT_LOG_TOOL = ToolDefinition(
    name="git_log",
    description="""Get recent commit history.
Shows commit hashes, messages, authors, and dates.

Examples:
- git_log() - show last 10 commits
- git_log(count=5) - show last 5 commits
- git_log(oneline=True) - compact one-line format
- git_log(file="src/main.py") - commits affecting specific file""",
    parameters={
        "type": "object",
        "properties": {
            "count": {
                "type": "integer",
                "description": "Number of commits to show (default: 10)",
            },
            "oneline": {
                "type": "boolean",
                "description": "Use compact one-line format",
            },
            "file": {
                "type": "string",
                "description": "Show commits affecting specific file",
            },
            "author": {
                "type": "string",
                "description": "Filter by author name/email",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

GIT_BRANCH_TOOL = ToolDefinition(
    name="git_branch",
    description="""List branches in the repository.
Shows local and remote branches with current branch highlighted.

Examples:
- git_branch() - list local branches
- git_branch(all=True) - include remote branches
- git_branch(remote=True) - list only remote branches
- git_branch(verbose=True) - show last commit for each branch""",
    parameters={
        "type": "object",
        "properties": {
            "all": {
                "type": "boolean",
                "description": "Show all branches (local and remote)",
            },
            "remote": {
                "type": "boolean",
                "description": "Show only remote branches",
            },
            "verbose": {
                "type": "boolean",
                "description": "Show last commit message for each branch",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

# =============================================================================
# Git Action Tools (Write)
# =============================================================================

GIT_ADD_TOOL = ToolDefinition(
    name="git_add",
    description="""Stage files for commit.
Add specific files or all changes to the staging area.

Examples:
- git_add(files=["src/main.py"]) - stage specific file
- git_add(files=["."]) - stage all changes in current directory
- git_add(all=True) - stage all changes including untracked (git add -A)""",
    parameters={
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of files/paths to stage",
            },
            "all": {
                "type": "boolean",
                "description": "Stage all changes including untracked (git add -A)",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

GIT_COMMIT_TOOL = ToolDefinition(
    name="git_commit",
    description="""Create a commit with staged changes.
Can auto-generate commit message from diff using AI summarization.

Examples:
- git_commit(message="Fix login bug") - commit with explicit message
- git_commit(auto_message=True) - auto-generate message from staged diff
- git_commit(auto_message=True, style="conventional") - use conventional commits format
- git_commit(dry_run=True) - preview commit without executing

Styles for auto_message:
- conventional (default): feat:, fix:, docs:, style:, refactor:, test:, chore:
- simple: Single sentence summary
- detailed: Summary line + bullet points""",
    parameters={
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "Commit message (required unless auto_message=True)",
            },
            "auto_message": {
                "type": "boolean",
                "description": "Auto-generate message from staged diff using AI",
            },
            "style": {
                "type": "string",
                "enum": ["conventional", "simple", "detailed"],
                "description": "Commit message style for auto-generation (default: conventional)",
            },
            "dry_run": {
                "type": "boolean",
                "description": "Preview commit without creating it",
            },
        },
        "required": [],
    },
    environments=_GIT_ENVIRONMENTS,
)

# =============================================================================
# Tool Collections
# =============================================================================

GIT_READ_TOOLS = [
    GIT_STATUS_TOOL,
    GIT_DIFF_TOOL,
    GIT_LOG_TOOL,
    GIT_BRANCH_TOOL,
]

GIT_WRITE_TOOLS = [
    GIT_ADD_TOOL,
    GIT_COMMIT_TOOL,
]

GIT_TOOLS = GIT_READ_TOOLS + GIT_WRITE_TOOLS
