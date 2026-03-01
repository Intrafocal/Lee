"""
TUI message processor - handles message processing via direct agent or HTTP.
"""

import os
import sys
from typing import TYPE_CHECKING, Optional

from rich.console import Console

from ...thinking_depth import ThinkingDepth
from ....shared.gemini_tools import PhaseUpdate, ReActPhase
from ..selectors import DepthSelector

if TYPE_CHECKING:
    from ..runner import HesterChatRunner


class MessageProcessor:
    """Handles message processing for the TUI runner."""

    def __init__(self, runner: "HesterChatRunner"):
        self.runner = runner
        self.console = Console()

        # Agent for direct mode (no daemon)
        self._agent = None
        self._session_manager = None

    async def init_direct_agent(self):
        """Initialize the agent for direct mode (no daemon server)."""
        # Check for required environment variables early
        google_api_key = os.environ.get("GOOGLE_API_KEY")
        if not google_api_key:
            raise ValueError(
                "GOOGLE_API_KEY environment variable is required.\n"
                "Set it with: export GOOGLE_API_KEY=your_key\n"
                "Or add it to your .env.local file."
            )

        from ...agent import HesterDaemonAgent
        from ...session import SessionManager, InMemorySessionManager
        from ...settings import HesterDaemonSettings

        settings = HesterDaemonSettings()

        # Try Redis first, fall back to in-memory for TUI mode
        redis_client = None
        try:
            import redis.asyncio as redis

            redis_client = redis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            # Test connection
            await redis_client.ping()

            self._session_manager = SessionManager(
                redis_client=redis_client,
                ttl_seconds=settings.session_ttl_seconds,
            )
            self.console.print("[dim]Using Redis for session storage[/dim]")

        except Exception as e:
            # Fall back to in-memory session manager
            self.console.print(f"[dim]Redis unavailable ({e}), using in-memory sessions[/dim]")
            self._session_manager = InMemorySessionManager(
                ttl_seconds=settings.session_ttl_seconds,
            )
            redis_client = None

        # Initialize embedding service for semantic routing (requires Redis)
        embedding_service = None
        if redis_client:
            try:
                from ...semantic import EmbeddingService
                embedding_service = EmbeddingService(
                    api_key=google_api_key,
                    redis_client=redis_client,
                )
                self.console.print("[dim]Semantic routing enabled[/dim]")
            except Exception as e:
                self.console.print(f"[dim]Semantic routing unavailable ({e})[/dim]")

        self._agent = HesterDaemonAgent(
            settings=settings,
            session_manager=self._session_manager,
            embedding_service=embedding_service,
        )

    async def load_session_history(self):
        """Load and display session history when resuming a session."""
        session_id = self.runner.tui.session_id

        if self.runner.daemon_url:
            # Fetch from daemon API
            try:
                import httpx
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        f"{self.runner.daemon_url}/session/{session_id}/history",
                        timeout=10.0,
                    )
                    if response.status_code == 200:
                        data = response.json()
                        messages = data.get("conversation_history", [])
                        restored = self.runner.tui.restore_conversation_history(messages)
                        if restored > 0:
                            self.console.print(f"[green]Resumed session with {restored} messages[/green]")
                            self.console.print()
                            # Display the conversation history
                            self.runner.tui.print_messages()
                    elif response.status_code == 404:
                        self.console.print(f"[yellow]Session {session_id} not found, starting fresh[/yellow]")
                    else:
                        self.console.print(f"[yellow]Could not load session: {response.status_code}[/yellow]")
            except Exception as e:
                self.console.print(f"[yellow]Could not load session history: {e}[/yellow]")
        else:
            # Direct mode - initialize agent and try to get session from session manager
            try:
                if not self._agent:
                    await self.init_direct_agent()

                if self._session_manager:
                    session = await self._session_manager.get(session_id)
                    if session:
                        # Convert session messages to dict format
                        messages = [
                            {
                                "role": msg.role,
                                "content": msg.content,
                                "timestamp": msg.timestamp.isoformat(),
                            }
                            for msg in session.conversation_history
                        ]
                        restored = self.runner.tui.restore_conversation_history(messages)
                        if restored > 0:
                            self.console.print(f"[green]Resumed session with {restored} messages[/green]")
                            self.console.print()
                            # Display the conversation history
                            self.runner.tui.print_messages()
                    else:
                        self.console.print(f"[yellow]Session {session_id} not found, starting fresh[/yellow]")
            except Exception as e:
                self.console.print(f"[yellow]Could not load session history: {e}[/yellow]")

    async def process_message(self, message: str) -> str:
        """
        Process a user message and return Hester's response.

        Args:
            message: User's message

        Returns:
            Hester's response text
        """
        if self.runner.daemon_url:
            # Use HTTP API
            return await self._process_via_http(message)
        else:
            # Use direct agent
            return await self._process_direct(message)

    async def _process_direct(self, message: str) -> str:
        """Process message directly via agent."""
        from ...models import ContextRequest, EditorState, ImageData

        if not self._agent:
            await self.init_direct_agent()

        # Collect pending images
        images = None
        if self.runner.tui.state.pending_images:
            images = [
                ImageData(
                    data=img.data,
                    mime_type=img.mime_type,
                    source=img.source,
                )
                for img in self.runner.tui.state.pending_images
            ]
            # Clear pending images after collecting
            self.runner.tui.state.pending_images.clear()

        request = ContextRequest(
            session_id=self.runner.tui.session_id,
            message=message,
            images=images,
            editor_state=EditorState(
                working_directory=self.runner.tui.working_directory,
            ),
        )

        # Create phase callback for real-time updates
        async def on_phase_update(phase_update: PhaseUpdate) -> None:
            self.runner.tui.state.update_from_phase(phase_update)
            self._refresh_display()

        # Show initial thinking status
        self.runner.tui.set_thinking(True)
        self._print_status_line()

        # Set processing flag for interrupt handling
        self.runner._is_processing = True

        try:
            response = await self._agent.process_context(
                request,
                phase_callback=on_phase_update,
            )

            # Handle max iterations - offer depth escalation
            while response.status == "max_iterations":
                # Update state from trace
                if response.trace:
                    self.runner.tui.state.thinking_depth = response.trace.thinking_depth
                    self.runner.tui.state.model_used = response.trace.model_used
                    self.runner.tui.state.prompt_tokens = response.trace.prompt_tokens
                    self.runner.tui.state.completion_tokens = response.trace.completion_tokens
                    self.runner.tui.state.total_tokens = response.trace.total_tokens_used

                # Get current depth
                current_depth = getattr(response, '_current_depth', ThinkingDepth.STANDARD)

                # Check if we can escalate (not already at max)
                if current_depth == ThinkingDepth.REASONING:
                    # Already at max depth, can't escalate further
                    self.runner.tui.set_ready()
                    self.runner._is_processing = False
                    return "I've reached the maximum iterations at the highest reasoning depth. Here's what I found so far based on my analysis."

                # Show depth selector
                self._refresh_display()  # Clear status line
                selector = DepthSelector(self.console, current_depth)
                new_depth = await selector.select()

                if new_depth is None:
                    # User cancelled - return what we have
                    self.runner.tui.set_ready()
                    self.runner._is_processing = False
                    return "Stopping here. Based on my analysis so far, I wasn't able to complete the task within the iteration limit."

                # Continue with new depth
                self.runner.tui.state.thinking_depth = new_depth.name
                self.runner.tui.state.model_used = None
                self._print_status_line()

                response = await self._agent.continue_with_depth(
                    response,
                    new_depth,
                    phase_callback=on_phase_update,
                )

            # Update thinking depth and token info from trace
            if response.trace:
                self.runner.tui.state.thinking_depth = response.trace.thinking_depth
                self.runner.tui.state.model_used = response.trace.model_used
                self.runner.tui.state.prompt_tokens = response.trace.prompt_tokens
                self.runner.tui.state.completion_tokens = response.trace.completion_tokens
                self.runner.tui.state.total_tokens = response.trace.total_tokens_used

                # Log tool calls
                for obs in response.trace.observations:
                    self.runner.tui.add_tool_call(
                        obs.tool_name,
                        {"success": obs.success, "error": obs.error},
                    )

            self.runner.tui.set_ready()
            self.runner._is_processing = False
            return response.response or "I couldn't generate a response."

        except KeyboardInterrupt:
            # Task interrupted - return to ready state without exiting
            self.runner._is_processing = False
            self.runner.tui.set_ready()
            raise

        except Exception as e:
            self.runner._is_processing = False
            self.runner.tui.set_ready()
            raise

    async def _process_via_http(self, message: str) -> str:
        """Process message via HTTP daemon API with SSE streaming for real-time phase updates."""
        import base64
        import json
        import httpx

        self.runner.tui.set_thinking(True)
        self._print_status_line()

        # Set processing flag for interrupt handling
        self.runner._is_processing = True

        # Collect pending images and serialize for JSON transport
        images_payload = None
        if self.runner.tui.state.pending_images:
            self.console.print(f"[dim]Collecting {len(self.runner.tui.state.pending_images)} pending image(s)...[/dim]")
            images_payload = [
                {
                    "data": base64.b64encode(img.data).decode("ascii"),
                    "mime_type": img.mime_type,
                    "source": img.source,
                }
                for img in self.runner.tui.state.pending_images
            ]
            # Clear pending images after collecting
            self.runner.tui.state.pending_images.clear()

        try:
            # Use streaming endpoint for real-time phase updates
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
                request_payload = {
                    "session_id": self.runner.tui.session_id,
                    "message": message,
                    "images": images_payload,
                    "editor_state": {
                        "working_directory": self.runner.tui.working_directory,
                    },
                }

                response_text = None
                response_data = None

                async with client.stream(
                    "POST",
                    f"{self.runner.daemon_url}/context/stream",
                    json=request_payload,
                ) as response:
                    response.raise_for_status()

                    # Parse SSE events
                    event_type = None
                    event_data = ""

                    async for line in response.aiter_lines():
                        line = line.strip()

                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            event_data = line[5:].strip()
                        elif line == "" and event_type and event_data:
                            # End of event - process it
                            try:
                                data = json.loads(event_data)

                                if event_type == "phase":
                                    # Update TUI state from phase event
                                    self._handle_phase_event(data)
                                    self._refresh_display()

                                elif event_type == "response":
                                    # Final response received
                                    response_text = data.get("text")
                                    response_data = data

                                    # Update trace info if present
                                    if data.get("trace"):
                                        trace = data["trace"]
                                        self.runner.tui.state.thinking_depth = trace.get("thinking_depth")
                                        self.runner.tui.state.model_used = trace.get("model_used")
                                        self.runner.tui.state.prompt_tokens = trace.get("prompt_tokens", 0)
                                        self.runner.tui.state.completion_tokens = trace.get("completion_tokens", 0)
                                        self.runner.tui.state.total_tokens = trace.get("total_tokens_used", 0)

                                elif event_type == "error":
                                    # Handle error event
                                    error_msg = data.get("error", "Unknown error")
                                    self.runner.tui.set_ready()
                                    self.runner._is_processing = False
                                    return f"Error: {error_msg}"

                                elif event_type == "done":
                                    # Processing complete
                                    pass

                            except json.JSONDecodeError:
                                pass  # Skip malformed events

                            # Reset for next event
                            event_type = None
                            event_data = ""

                # Handle max_iterations - offer depth escalation
                if response_data and response_data.get("status") == "max_iterations":
                    current_depth_str = response_data.get("current_depth", "STANDARD")
                    try:
                        current_depth = ThinkingDepth[current_depth_str]
                    except KeyError:
                        current_depth = ThinkingDepth.STANDARD

                    # Check if we can escalate (not already at max)
                    if current_depth == ThinkingDepth.REASONING:
                        self.runner.tui.set_ready()
                        self.runner._is_processing = False
                        return "I've reached the maximum iterations at the highest reasoning depth. Here's what I found so far based on my analysis."

                    # Show depth selector
                    self._refresh_display()
                    selector = DepthSelector(self.console, current_depth)
                    new_depth = await selector.select()

                    if new_depth is None:
                        self.runner.tui.set_ready()
                        self.runner._is_processing = False
                        return "Stopping here. Based on my analysis so far, I wasn't able to complete the task within the iteration limit."

                    # Continue with new depth via HTTP (non-streaming for continuation)
                    self.runner.tui.state.thinking_depth = new_depth.name
                    self.runner.tui.state.model_used = None
                    self._print_status_line()

                    continue_response = await client.post(
                        f"{self.runner.daemon_url}/context/continue",
                        json={
                            "session_id": self.runner.tui.session_id,
                            "new_depth": new_depth.name,
                        },
                    )
                    continue_response.raise_for_status()
                    data = continue_response.json()

                    if data.get("trace"):
                        trace = data["trace"]
                        self.runner.tui.state.thinking_depth = trace.get("thinking_depth")
                        self.runner.tui.state.model_used = trace.get("model_used")
                        self.runner.tui.state.prompt_tokens = trace.get("prompt_tokens", 0)
                        self.runner.tui.state.completion_tokens = trace.get("completion_tokens", 0)
                        self.runner.tui.state.total_tokens = trace.get("total_tokens_used", 0)

                    response_text = data.get("response")

                self.runner.tui.set_ready()
                self.runner._is_processing = False
                return response_text or "I couldn't generate a response."

        except KeyboardInterrupt:
            self.runner._is_processing = False
            self.runner.tui.set_ready()
            raise

        except Exception as e:
            self.runner._is_processing = False
            self.runner.tui.set_ready()
            raise

    def _handle_phase_event(self, data: dict) -> None:
        """Handle a phase event from SSE stream and update TUI state."""
        phase_str = data.get("phase", "")

        # Map phase string to enum
        try:
            phase = ReActPhase(phase_str)
        except ValueError:
            return  # Unknown phase, skip

        # Create PhaseUpdate and update state
        update = PhaseUpdate(
            phase=phase,
            iteration=data.get("iteration", 0),
            tool_name=data.get("tool_name"),
            tool_context=data.get("tool_context"),
            model_used=data.get("model_used"),
            is_local=data.get("is_local", False),
            tools_selected=data.get("tools_selected"),
            prepare_time_ms=data.get("prepare_time_ms"),
            # Semantic routing fields
            prompt_id=data.get("prompt_id"),
            agent_id=data.get("agent_id"),
            routing_reason=data.get("routing_reason"),
        )
        self.runner.tui.state.update_from_phase(update)

    def _print_status_line(self):
        """Print the status line (initial print, leaves cursor on next line)."""
        self.console.print(self.runner.tui._create_status_line())

    def _refresh_display(self):
        """Refresh the display by overwriting the current status line."""
        # Move cursor up one line, clear it, return to start
        sys.stdout.write("\033[1A\033[2K\r")
        sys.stdout.flush()
        # Print new status line
        self.console.print(self.runner.tui._create_status_line())
