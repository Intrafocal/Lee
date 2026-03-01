"""
File Read Tool - Read file contents with optional line ranges.

Supports both text files and images. For images, returns the binary data
with metadata so the ReAct loop can include it in the conversation.
"""

import logging
from pathlib import Path
from typing import Optional, Dict, Any

import aiofiles

logger = logging.getLogger("hester.daemon.tools.file_read")

# Supported image extensions and their MIME types
IMAGE_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


def _is_image_file(path: Path) -> bool:
    """Check if a file is a supported image format."""
    return path.suffix.lower() in IMAGE_EXTENSIONS


def _get_image_mime_type(path: Path) -> str:
    """Get MIME type for an image file."""
    return IMAGE_EXTENSIONS.get(path.suffix.lower(), "image/png")


async def _read_image_file(path: Path) -> Dict[str, Any]:
    """
    Read an image file and return its data with metadata.

    Args:
        path: Path to the image file

    Returns:
        Dictionary with image data and metadata, including _image_data
        for the ReAct loop to inject into the conversation.
    """
    try:
        # Read binary data
        async with aiofiles.open(path, "rb") as f:
            image_data = await f.read()

        # Get image dimensions using PIL
        width, height = None, None
        try:
            from PIL import Image
            import io
            with Image.open(io.BytesIO(image_data)) as img:
                width, height = img.size
        except ImportError:
            logger.debug("PIL not available, skipping image dimension detection")
        except Exception as e:
            logger.debug(f"Could not get image dimensions: {e}")

        mime_type = _get_image_mime_type(path)
        file_size = len(image_data)

        return {
            "success": True,
            "file_path": str(path),
            "file_type": "image",
            "mime_type": mime_type,
            "size_bytes": file_size,
            "width": width,
            "height": height,
            # Special field for ReAct loop to detect and inject as image Part
            "_image_data": image_data,
            "_image_mime_type": mime_type,
        }

    except Exception as e:
        logger.error(f"Error reading image file {path}: {e}")
        return {
            "success": False,
            "error": f"Error reading image: {e}",
            "file_path": str(path),
        }


async def read_file(
    file_path: str,
    working_dir: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None,
    max_lines: int = 500,
    **kwargs,  # Accept extra kwargs to handle model hallucinations
) -> Dict[str, Any]:
    """
    Read file contents with optional line range. Supports both text and images.

    For text files, returns the content with line numbers.
    For images (png, jpg, gif, webp, bmp), returns the image data for visual analysis.

    Args:
        file_path: Path to the file (absolute or relative)
        working_dir: Working directory for relative paths
        start_line: Optional start line (1-indexed, inclusive) - text files only
        end_line: Optional end line (1-indexed, inclusive) - text files only
        max_lines: Maximum lines to return (default: 500) - text files only
        **kwargs: Ignored (handles extra parameters from LLM)

    Returns:
        Dictionary with file content and metadata
    """
    if kwargs:
        logger.debug(f"read_file ignoring extra kwargs: {list(kwargs.keys())}")
    try:
        # Resolve path
        path = Path(file_path)
        if not path.is_absolute():
            path = Path(working_dir) / path

        path = path.resolve()

        # Security check - don't allow reading outside working directory
        working_path = Path(working_dir).resolve()
        try:
            path.relative_to(working_path)
        except ValueError:
            # Also allow reading from common system paths
            allowed_prefixes = [
                "/usr/",
                "/opt/",
                str(Path.home()),
            ]
            if not any(str(path).startswith(p) for p in allowed_prefixes):
                return {
                    "success": False,
                    "error": f"Access denied: {path} is outside working directory",
                    "file_path": str(path),
                }

        # Check file exists
        if not path.exists():
            return {
                "success": False,
                "error": f"File not found: {path}",
                "file_path": str(path),
            }

        if not path.is_file():
            return {
                "success": False,
                "error": f"Not a file: {path}",
                "file_path": str(path),
            }

        # Check file size
        file_size = path.stat().st_size
        if file_size > 10 * 1024 * 1024:  # 10MB limit
            return {
                "success": False,
                "error": f"File too large: {file_size} bytes (max 10MB)",
                "file_path": str(path),
            }

        # Check if it's an image file - handle specially
        if _is_image_file(path):
            logger.info(f"Reading image file: {path}")
            return await _read_image_file(path)

        # Read text file
        async with aiofiles.open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = await f.readlines()

        total_lines = len(lines)

        # Apply line range
        if start_line is not None or end_line is not None:
            start_idx = (start_line - 1) if start_line else 0
            end_idx = end_line if end_line else total_lines

            # Clamp to valid range
            start_idx = max(0, min(start_idx, total_lines))
            end_idx = max(0, min(end_idx, total_lines))

            lines = lines[start_idx:end_idx]
            line_offset = start_idx + 1
        else:
            line_offset = 1

        # Limit lines
        truncated = False
        if len(lines) > max_lines:
            lines = lines[:max_lines]
            truncated = True

        # Format with line numbers
        formatted_lines = []
        for i, line in enumerate(lines):
            line_num = line_offset + i
            # Remove trailing newline for cleaner output
            line_content = line.rstrip("\n\r")
            formatted_lines.append(f"{line_num:5d} | {line_content}")

        content = "\n".join(formatted_lines)

        # Detect language from extension
        language = _detect_language(path.suffix)

        result = {
            "success": True,
            "file_path": str(path),
            "content": content,
            "total_lines": total_lines,
            "lines_returned": len(formatted_lines),
            "start_line": line_offset,
            "end_line": line_offset + len(formatted_lines) - 1,
            "language": language,
            "truncated": truncated,
        }

        if truncated:
            result["note"] = f"Output truncated to {max_lines} lines"

        return result

    except PermissionError:
        return {
            "success": False,
            "error": f"Permission denied: {file_path}",
            "file_path": str(path) if "path" in dir() else file_path,
        }
    except UnicodeDecodeError as e:
        return {
            "success": False,
            "error": f"Cannot read binary file: {e}",
            "file_path": str(path) if "path" in dir() else file_path,
        }
    except Exception as e:
        logger.error(f"Error reading file {file_path}: {e}")
        return {
            "success": False,
            "error": f"Error reading file: {e}",
            "file_path": file_path,
        }


def _detect_language(suffix: str) -> str:
    """Detect programming language from file extension."""
    language_map = {
        ".py": "python",
        ".js": "javascript",
        ".ts": "typescript",
        ".tsx": "typescript",
        ".jsx": "javascript",
        ".dart": "dart",
        ".java": "java",
        ".kt": "kotlin",
        ".swift": "swift",
        ".go": "go",
        ".rs": "rust",
        ".rb": "ruby",
        ".php": "php",
        ".c": "c",
        ".cpp": "cpp",
        ".h": "c",
        ".hpp": "cpp",
        ".cs": "csharp",
        ".sql": "sql",
        ".html": "html",
        ".css": "css",
        ".scss": "scss",
        ".sass": "sass",
        ".less": "less",
        ".json": "json",
        ".yaml": "yaml",
        ".yml": "yaml",
        ".toml": "toml",
        ".xml": "xml",
        ".md": "markdown",
        ".sh": "bash",
        ".bash": "bash",
        ".zsh": "zsh",
        ".fish": "fish",
        ".ps1": "powershell",
        ".dockerfile": "dockerfile",
        ".tf": "terraform",
        ".vue": "vue",
        ".svelte": "svelte",
    }

    suffix_lower = suffix.lower()
    return language_map.get(suffix_lower, "text")
