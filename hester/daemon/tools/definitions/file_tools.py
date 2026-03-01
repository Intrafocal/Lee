"""
File tool definitions - read, search, list, change directory.
"""

from .models import ToolDefinition

# All file tools require codebase access - not available in slack
_FILE_ENVIRONMENTS = {"daemon", "cli", "subagent"}


READ_FILE_TOOL = ToolDefinition(
    name="read_file",
    description="""Read the contents of a file from the filesystem.
Use this when you need to see the actual code or content in a file.
Returns the file contents with line numbers for text files.

For image files (png, jpg, jpeg, gif, webp, bmp), returns the image for visual
analysis. Use this to view screenshots, diagrams, or any image file.

Examples:
- Read a Python file: read_file(file_path="src/main.py")
- Read specific lines: read_file(file_path="config.yaml", start_line=10, end_line=20)
- View a screenshot: read_file(file_path="screenshot.png")
- Analyze an image: read_file(file_path="docs/architecture-diagram.png")""",
    parameters={
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "Path to the file (absolute or relative to working directory)",
            },
            "start_line": {
                "type": "integer",
                "description": "Optional start line (1-indexed, inclusive)",
            },
            "end_line": {
                "type": "integer",
                "description": "Optional end line (1-indexed, inclusive)",
            },
        },
        "required": ["file_path"],
    },
    environments=_FILE_ENVIRONMENTS,
)

SEARCH_FILES_TOOL = ToolDefinition(
    name="search_files",
    description="""Search for files matching a glob pattern.
Use this when you need to find files by name or extension.
Returns a list of matching file paths.

Examples:
- Find Python files: search_files(pattern="**/*.py")
- Find files in src: search_files(pattern="src/**/*.ts")
- Find config files: search_files(pattern="**/config.{yaml,json}")""",
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Glob pattern (e.g., '**/*.py', 'src/**/*.ts')",
            },
            "directory": {
                "type": "string",
                "description": "Base directory to search in (default: working directory)",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of results (default: 50)",
            },
        },
        "required": ["pattern"],
    },
    environments=_FILE_ENVIRONMENTS,
)

SEARCH_CONTENT_TOOL = ToolDefinition(
    name="search_content",
    description="""Search for text patterns in file contents (like grep).
Use this when you need to find code containing specific text or patterns.
Returns matching lines with file paths and line numbers.

Examples:
- Find function definition: search_content(pattern="def process_react")
- Find imports: search_content(pattern="from fastapi import", file_pattern="**/*.py")
- Case insensitive: search_content(pattern="TODO", case_sensitive=false)""",
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Text or regex pattern to search for",
            },
            "file_pattern": {
                "type": "string",
                "description": "Glob pattern for files to search (default: '**/*')",
            },
            "case_sensitive": {
                "type": "boolean",
                "description": "Case sensitive search (default: true)",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of matches (default: 50)",
            },
        },
        "required": ["pattern"],
    },
    environments=_FILE_ENVIRONMENTS,
)

LIST_DIRECTORY_TOOL = ToolDefinition(
    name="list_directory",
    description="""List contents of a directory.
Use this to explore the file structure.
Returns files and directories with basic metadata.

Examples:
- List current directory: list_directory(path=".")
- List src folder: list_directory(path="src")""",
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory path to list (default: working directory)",
            },
            "show_hidden": {
                "type": "boolean",
                "description": "Show hidden files (default: false)",
            },
        },
        "required": [],
    },
    environments=_FILE_ENVIRONMENTS,
)

CHANGE_DIRECTORY_TOOL = ToolDefinition(
    name="change_directory",
    description="""Change the current working directory for the session.
Use this when the user asks to cd, change directory, or navigate to a different folder.

Examples:
- cd ..: change_directory(path="..")
- cd ../services: change_directory(path="../services")
- cd /Users/ben/project: change_directory(path="/Users/ben/project")
- go to the frontend folder: change_directory(path="frontend")""",
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory path to change to (absolute or relative to current working directory)",
            },
        },
        "required": ["path"],
    },
    environments=_FILE_ENVIRONMENTS,
)


# All file tools
FILE_TOOLS = [
    READ_FILE_TOOL,
    SEARCH_FILES_TOOL,
    SEARCH_CONTENT_TOOL,
    LIST_DIRECTORY_TOOL,
    CHANGE_DIRECTORY_TOOL,
]
