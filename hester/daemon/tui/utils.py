"""
TUI utilities - clipboard and helper functions.
"""

import io
import os
from typing import Optional, Tuple


def get_clipboard_image() -> Optional[Tuple[bytes, str, int, int]]:
    """
    Get image from system clipboard.

    Returns:
        Tuple of (image_bytes, mime_type, width, height) or None if no image
    """
    try:
        from PIL import Image, ImageGrab

        # Try to get image from clipboard
        img = ImageGrab.grabclipboard()

        if img is None:
            return None

        # Handle different return types
        if isinstance(img, Image.Image):
            # Convert to PNG bytes
            buffer = io.BytesIO()
            # Convert to RGB if necessary (e.g., RGBA with transparency)
            if img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info):
                # Keep PNG for transparency support
                img.save(buffer, format='PNG')
                mime_type = "image/png"
            else:
                # Use JPEG for smaller size
                img = img.convert('RGB')
                img.save(buffer, format='JPEG', quality=85)
                mime_type = "image/jpeg"
            buffer.seek(0)
            return (buffer.read(), mime_type, img.width, img.height)

        elif isinstance(img, list):
            # On some systems, clipboard returns list of file paths
            # Try to load first image file
            for path in img:
                if isinstance(path, str) and os.path.isfile(path):
                    try:
                        with Image.open(path) as file_img:
                            buffer = io.BytesIO()
                            # Determine format
                            fmt = file_img.format or 'PNG'
                            mime_map = {
                                'PNG': 'image/png',
                                'JPEG': 'image/jpeg',
                                'JPG': 'image/jpeg',
                                'GIF': 'image/gif',
                                'WEBP': 'image/webp',
                            }
                            mime_type = mime_map.get(fmt.upper(), 'image/png')
                            file_img.save(buffer, format=fmt)
                            buffer.seek(0)
                            return (buffer.read(), mime_type, file_img.width, file_img.height)
                    except Exception:
                        continue
            return None

        return None

    except ImportError:
        # PIL not available
        return None
    except Exception:
        # Clipboard access failed (e.g., no display, permission denied)
        return None
