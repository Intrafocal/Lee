"""
TUI prompt session - prompt_toolkit configuration and key bindings.
"""

from typing import TYPE_CHECKING, Callable, List

from prompt_toolkit import PromptSession
from prompt_toolkit.history import InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.keys import Keys
from prompt_toolkit.filters import completion_is_selected
from prompt_toolkit.styles import Style as PTStyle

from ..completers import HesterCompleter
from ..constants import SLASH_COMMANDS
from ..models import PendingImage
from ..utils import get_clipboard_image

if TYPE_CHECKING:
    from ..runner import HesterChatRunner


def create_prompt_session(
    runner: "HesterChatRunner",
    working_dir_getter: Callable[[], str],
) -> PromptSession:
    """
    Create a prompt_toolkit session with history and key bindings.

    Args:
        runner: The HesterChatRunner instance (for state access)
        working_dir_getter: Callable that returns the current working directory

    Returns:
        Configured PromptSession instance
    """
    # Custom key bindings
    bindings = KeyBindings()

    # Track if we should show command menu on next down arrow
    runner._at_history_end = True

    @bindings.add(Keys.Down)
    def handle_down(event):
        """Handle down arrow - show command menu at end of history."""
        buffer = event.app.current_buffer
        # If completion menu is showing, let default handler navigate it
        if event.app.current_buffer.complete_state:
            # Move to next completion
            event.app.current_buffer.complete_next()
        elif not buffer.text and runner._at_history_end:
            # Empty buffer at end of history - trigger command completion
            buffer.insert_text("/")
            buffer.start_completion()
        else:
            # Normal history navigation
            event.app.current_buffer.history_forward()
            runner._at_history_end = not bool(buffer.text)

    @bindings.add(Keys.Up)
    def handle_up(event):
        """Handle up arrow - navigate history or completion menu."""
        buffer = event.app.current_buffer
        # If completion menu is showing, navigate it
        if buffer.complete_state:
            buffer.complete_previous()
        else:
            # Normal history navigation
            buffer.history_backward()
            runner._at_history_end = False

    @bindings.add(Keys.Enter, filter=completion_is_selected)
    def handle_enter_completion(event):
        """Accept selected completion with Enter."""
        event.app.current_buffer.complete_state = None

    @bindings.add(Keys.ControlV)
    def handle_paste(event):
        """Handle Ctrl+V - check for image in clipboard."""
        # Try to get image from clipboard
        img_data = get_clipboard_image()

        if img_data:
            data, mime_type, width, height = img_data

            # Add to pending images
            runner.tui.state.pending_images.append(
                PendingImage(
                    data=data,
                    mime_type=mime_type,
                    source="clipboard",
                    width=width,
                    height=height,
                )
            )

            # Show feedback - insert indicator in buffer
            buffer = event.app.current_buffer
            size_kb = len(data) / 1024
            buffer.insert_text(f"[image {width}x{height} {size_kb:.1f}KB] ")
        else:
            # No image - let normal paste happen
            # Get text from clipboard and insert it
            try:
                data = event.app.clipboard.get_data()
                if data and data.text:
                    event.app.current_buffer.insert_text(data.text)
            except Exception:
                pass

    # Style for the prompt with input box
    style = PTStyle.from_dict({
        'prompt': 'cyan bold',
        'input-box': 'bg:#1a1a1a',
        'input-box.border': '#3a3a3a',
        'completion-menu': 'bg:#1e2d26 #ffffff',
        'completion-menu.completion': '',
        'completion-menu.completion.current': 'bg:#4a9977 #000000',
        'completion-menu.meta': 'bg:#1a2822 #888888 italic',
        'completion-menu.meta.current': 'bg:#4a9977 #000000',
        'scrollbar.background': 'bg:#1a2822',
        'scrollbar.button': 'bg:#3a5a4a',
    })

    # Use HesterCompleter for both slash commands and task ID completion
    completer = HesterCompleter(
        commands=SLASH_COMMANDS,
        working_dir_getter=working_dir_getter,
    )

    return PromptSession(
        history=InMemoryHistory(),
        completer=completer,
        key_bindings=bindings,
        style=style,
        complete_while_typing=True,  # Show completions as user types /
        enable_history_search=True,
        complete_in_thread=True,  # Non-blocking completion
        reserve_space_for_menu=8,  # Reserve space for completion menu
    )
