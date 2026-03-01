"""
File Search Tools - Glob and grep implementations for file searching.
"""

import logging
import os
import re
from pathlib import Path
from typing import Optional, Dict, Any, List

logger = logging.getLogger("hester.daemon.tools.file_search")


async def search_files(
    pattern: str,
    working_dir: str,
    directory: Optional[str] = None,
    max_results: int = 50,
    **kwargs,  # Accept extra kwargs to handle model hallucinations
) -> Dict[str, Any]:
    """
    Search for files matching a glob pattern.

    Args:
        pattern: Glob pattern (e.g., '**/*.py', 'src/**/*.ts')
        working_dir: Base working directory
        directory: Optional subdirectory to search in
        max_results: Maximum number of results
        **kwargs: Ignored (handles extra parameters from LLM)

    Returns:
        Dictionary with matching file paths
    """
    # Log if unexpected kwargs were passed
    if kwargs:
        logger.debug(f"search_files ignoring extra kwargs: {list(kwargs.keys())}")
    try:
        # Determine search directory
        if directory:
            search_dir = Path(working_dir) / directory
        else:
            search_dir = Path(working_dir)

        search_dir = search_dir.resolve()

        if not search_dir.exists():
            return {
                "success": False,
                "error": f"Directory not found: {search_dir}",
                "pattern": pattern,
            }

        if not search_dir.is_dir():
            return {
                "success": False,
                "error": f"Not a directory: {search_dir}",
                "pattern": pattern,
            }

        # Perform glob search
        matches = []
        try:
            for match in search_dir.glob(pattern):
                if match.is_file():
                    # Get relative path from working directory
                    try:
                        rel_path = match.relative_to(Path(working_dir))
                    except ValueError:
                        rel_path = match

                    matches.append({
                        "path": str(rel_path),
                        "absolute_path": str(match),
                        "size": match.stat().st_size,
                        "is_file": True,
                    })

                    if len(matches) >= max_results:
                        break
        except Exception as e:
            logger.warning(f"Glob error for pattern {pattern}: {e}")

        truncated = len(matches) >= max_results

        return {
            "success": True,
            "pattern": pattern,
            "search_directory": str(search_dir),
            "matches": matches,
            "count": len(matches),
            "truncated": truncated,
        }

    except Exception as e:
        logger.error(f"Error searching files with pattern {pattern}: {e}")
        return {
            "success": False,
            "error": f"Search error: {e}",
            "pattern": pattern,
        }


async def search_content(
    pattern: str,
    working_dir: str,
    file_pattern: str = "**/*",
    case_sensitive: bool = True,
    max_results: int = 50,
    context_lines: int = 0,
    **kwargs,  # Accept extra kwargs to handle model hallucinations
) -> Dict[str, Any]:
    """
    Search for text patterns in file contents (grep-like).

    Args:
        pattern: Text or regex pattern to search for
        working_dir: Base working directory
        file_pattern: Glob pattern for files to search
        case_sensitive: Case sensitive search
        max_results: Maximum number of matches
        context_lines: Number of context lines before/after
        **kwargs: Ignored (handles extra parameters from LLM)

    Returns:
        Dictionary with matching lines and file info
    """
    if kwargs:
        logger.debug(f"search_content ignoring extra kwargs: {list(kwargs.keys())}")
    try:
        search_dir = Path(working_dir).resolve()

        if not search_dir.exists():
            return {
                "success": False,
                "error": f"Directory not found: {search_dir}",
                "pattern": pattern,
            }

        # Compile regex
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            regex = re.compile(pattern, flags)
        except re.error as e:
            # If invalid regex, treat as literal string
            escaped = re.escape(pattern)
            regex = re.compile(escaped, flags)

        matches = []
        files_searched = 0
        files_with_matches = set()

        # Skip binary extensions
        binary_extensions = {
            ".pyc", ".pyo", ".so", ".dylib", ".dll", ".exe",
            ".zip", ".tar", ".gz", ".bz2", ".xz",
            ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg",
            ".pdf", ".doc", ".docx", ".xls", ".xlsx",
            ".mp3", ".mp4", ".avi", ".mov", ".wav",
            ".woff", ".woff2", ".ttf", ".eot",
            ".db", ".sqlite", ".sqlite3",
        }

        # Skip directories
        skip_dirs = {
            ".git", ".svn", "node_modules", "__pycache__",
            ".tox", ".venv", "venv", ".env", "env",
            "dist", "build", ".next", ".nuxt",
            "target", "coverage", ".pytest_cache",
        }

        for file_path in search_dir.glob(file_pattern):
            if len(matches) >= max_results:
                break

            if not file_path.is_file():
                continue

            # Skip binary files
            if file_path.suffix.lower() in binary_extensions:
                continue

            # Skip files in skip directories
            if any(skip_dir in file_path.parts for skip_dir in skip_dirs):
                continue

            # Skip large files
            try:
                if file_path.stat().st_size > 1024 * 1024:  # 1MB
                    continue
            except OSError:
                continue

            files_searched += 1

            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()

                for line_num, line in enumerate(lines, 1):
                    if regex.search(line):
                        try:
                            rel_path = file_path.relative_to(Path(working_dir))
                        except ValueError:
                            rel_path = file_path

                        match_entry = {
                            "file": str(rel_path),
                            "line_number": line_num,
                            "content": line.rstrip("\n\r"),
                        }

                        # Add context if requested
                        if context_lines > 0:
                            start = max(0, line_num - 1 - context_lines)
                            end = min(len(lines), line_num + context_lines)
                            context_before = [
                                l.rstrip("\n\r")
                                for l in lines[start:line_num - 1]
                            ]
                            context_after = [
                                l.rstrip("\n\r")
                                for l in lines[line_num:end]
                            ]
                            match_entry["context_before"] = context_before
                            match_entry["context_after"] = context_after

                        matches.append(match_entry)
                        files_with_matches.add(str(rel_path))

                        if len(matches) >= max_results:
                            break

            except (IOError, OSError) as e:
                logger.debug(f"Could not read {file_path}: {e}")
                continue

        truncated = len(matches) >= max_results

        return {
            "success": True,
            "pattern": pattern,
            "file_pattern": file_pattern,
            "case_sensitive": case_sensitive,
            "matches": matches,
            "match_count": len(matches),
            "files_with_matches": len(files_with_matches),
            "files_searched": files_searched,
            "truncated": truncated,
        }

    except Exception as e:
        logger.error(f"Error searching content for pattern {pattern}: {e}")
        return {
            "success": False,
            "error": f"Search error: {e}",
            "pattern": pattern,
        }


async def list_directory(
    working_dir: str,
    path: Optional[str] = None,
    show_hidden: bool = False,
    max_items: int = 100,
    **kwargs,  # Accept extra kwargs to handle model hallucinations
) -> Dict[str, Any]:
    """
    List contents of a directory.

    Args:
        working_dir: Base working directory
        path: Optional subdirectory path
        show_hidden: Whether to show hidden files
        max_items: Maximum number of items to return
        **kwargs: Ignored (handles extra parameters from LLM)

    Returns:
        Dictionary with directory contents
    """
    if kwargs:
        logger.debug(f"list_directory ignoring extra kwargs: {list(kwargs.keys())}")
    try:
        # Determine directory to list
        if path:
            list_dir = Path(working_dir) / path
        else:
            list_dir = Path(working_dir)

        list_dir = list_dir.resolve()

        if not list_dir.exists():
            return {
                "success": False,
                "error": f"Directory not found: {list_dir}",
                "path": path or ".",
            }

        if not list_dir.is_dir():
            return {
                "success": False,
                "error": f"Not a directory: {list_dir}",
                "path": path or ".",
            }

        items = []
        directories = []
        files = []

        for entry in sorted(list_dir.iterdir()):
            # Skip hidden files if not requested
            if not show_hidden and entry.name.startswith("."):
                continue

            try:
                stat = entry.stat()
                item = {
                    "name": entry.name,
                    "is_directory": entry.is_dir(),
                    "size": stat.st_size if entry.is_file() else None,
                }

                if entry.is_dir():
                    directories.append(item)
                else:
                    files.append(item)

                if len(directories) + len(files) >= max_items:
                    break

            except OSError:
                continue

        # Combine: directories first, then files
        items = directories + files
        truncated = len(items) >= max_items

        return {
            "success": True,
            "path": str(list_dir),
            "items": items,
            "directory_count": len(directories),
            "file_count": len(files),
            "total_count": len(items),
            "truncated": truncated,
        }

    except Exception as e:
        logger.error(f"Error listing directory {path}: {e}")
        return {
            "success": False,
            "error": f"Error listing directory: {e}",
            "path": path or ".",
        }


async def change_directory(
    path: str,
    working_dir: str,
    **kwargs,  # Accept extra kwargs to handle model hallucinations
) -> Dict[str, Any]:
    """
    Change the current working directory for the session.

    Note: This function validates the directory exists but doesn't actually
    change any global state. The caller (agent) is responsible for updating
    the session's working_directory based on the returned new_working_dir.

    Args:
        path: Directory path to change to (absolute or relative)
        working_dir: Current working directory
        **kwargs: Ignored (handles extra parameters from LLM)

    Returns:
        Dictionary with new working directory path if successful
    """
    if kwargs:
        logger.debug(f"change_directory ignoring extra kwargs: {list(kwargs.keys())}")

    try:
        # Resolve the new path
        if os.path.isabs(path):
            new_dir = Path(path)
        else:
            new_dir = Path(working_dir) / path

        new_dir = new_dir.resolve()

        # Validate directory exists
        if not new_dir.exists():
            return {
                "success": False,
                "error": f"Directory not found: {path}",
                "requested_path": path,
            }

        if not new_dir.is_dir():
            return {
                "success": False,
                "error": f"Not a directory: {path}",
                "requested_path": path,
            }

        # Return the new working directory
        return {
            "success": True,
            "previous_working_dir": working_dir,
            "new_working_dir": str(new_dir),
            "requested_path": path,
        }

    except Exception as e:
        logger.error(f"Error changing directory to {path}: {e}")
        return {
            "success": False,
            "error": f"Error changing directory: {e}",
            "requested_path": path,
        }
