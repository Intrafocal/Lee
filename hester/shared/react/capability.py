"""
ReAct Capability - Core tool-calling support for the ReAct loop.

Provides the base mixin class for agents that need tool/function calling.
Currently uses Gemini as the cloud inference backend.
"""

import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, TYPE_CHECKING

from google import genai
from google.genai import types

from .models import ReActPhase, PhaseUpdate, PhaseCallback, ToolResult

if TYPE_CHECKING:
    from ...daemon.models import InferenceBudget, ObservationResult
    from ...daemon.prepare import PrepareResult, OllamaGemmaClient

logger = logging.getLogger("hester.shared.react.capability")


class ReActCapability:
    """
    Mixin providing ReAct loop capabilities with tool/function calling.

    Uses Gemini as the cloud inference backend with tiered model selection:
    - Quick (Tier 0): gemini-2.5-flash-lite - Simple tasks
    - Standard (Tier 1): gemini-2.5-flash - Normal tasks
    - Deep (Tier 2): gemini-3-flash-preview - Complex analysis
    - Reasoning (Tier 3): gemini-3.1-pro-preview - Deep reasoning

    Usage:
        class MyAgent(ReActCapability):
            def __init__(self):
                super().__init__(
                    api_key="your-key",
                    model="gemini-2.5-flash"  # Default model
                )
                self.register_tools([...])

            async def process(self, prompt: str):
                return await self.generate_with_tools(prompt, messages)
    """

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-2.5-flash",
        **kwargs
    ):
        """
        Initialize ReAct capability.

        Args:
            api_key: Google API key for Gemini
            model: Default model to use
        """
        super().__init__(**kwargs)

        self._gemini_client = genai.Client(api_key=api_key)
        self._default_model = model
        self._tool_definitions: List[Dict[str, Any]] = []
        self._tool_handlers: Dict[str, Callable[..., Awaitable[Any]]] = {}

    def register_tool(
        self,
        name: str,
        description: str,
        parameters: Dict[str, Any],
        handler: Callable[..., Awaitable[Any]],
    ) -> None:
        """
        Register a tool for use in the ReAct loop.

        Args:
            name: Tool name for invocation
            description: What the tool does
            parameters: JSON Schema for parameters
            handler: Async function to handle tool calls
        """
        self._tool_definitions.append({
            "name": name,
            "description": description,
            "parameters": parameters,
        })
        self._tool_handlers[name] = handler
        logger.debug(f"Registered tool: {name}")

    def register_tools(
        self,
        tools: List[Dict[str, Any]],
        handlers: Dict[str, Callable[..., Awaitable[Any]]],
    ) -> None:
        """
        Register multiple tools at once.

        Args:
            tools: List of tool definitions (name, description, parameters)
            handlers: Dict mapping tool names to handler functions
        """
        for tool in tools:
            name = tool["name"]
            if name not in handlers:
                logger.warning(f"No handler for tool: {name}")
                continue

            self.register_tool(
                name=name,
                description=tool["description"],
                parameters=tool["parameters"],
                handler=handlers[name],
            )

    def _build_tool_declarations(
        self,
        tool_filter: Optional[List[str]] = None,
    ) -> List[types.Tool]:
        """
        Build tool declarations for the inference backend.

        Args:
            tool_filter: Optional list of tool names to include. If provided,
                        only tools with names in this list are included.

        Returns:
            List of Tool objects with function declarations.
        """
        if not self._tool_definitions:
            return []

        function_declarations = []
        for tool_def in self._tool_definitions:
            # Apply filter if provided
            if tool_filter is not None and tool_def["name"] not in tool_filter:
                continue

            function_declarations.append(
                types.FunctionDeclaration(
                    name=tool_def["name"],
                    description=tool_def["description"],
                    parameters=tool_def["parameters"],
                )
            )

        if not function_declarations:
            return []

        return [types.Tool(function_declarations=function_declarations)]

    async def generate_with_tools(
        self,
        system_prompt: str,
        messages: List[Dict[str, str]],
        max_iterations: int = 5,
        model: Optional[str] = None,
        phase_callback: Optional[PhaseCallback] = None,
        tool_filter: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Run the ReAct loop: generate a response, handling any tool calls.

        Args:
            system_prompt: System instructions
            messages: Conversation history
            max_iterations: Maximum tool call iterations
            model: Optional model override (for thinking depth)
            phase_callback: Optional callback for real-time phase updates
            tool_filter: Optional list of tool names to include (filters out others)

        Returns:
            Dict with response text, tool calls made, and full trace
        """
        tools = self._build_tool_declarations(tool_filter=tool_filter)
        tool_calls_made: List[ToolResult] = []
        iterations = 0
        active_model = model or self._default_model

        # Token tracking
        total_prompt_tokens = 0
        total_completion_tokens = 0

        # Build initial content
        contents = self._messages_to_contents(messages)

        logger.debug(f"Using model: {active_model}")

        # Check if using Gemini 3 model (requires thinking_config for function calling)
        is_gemini_3 = "gemini-3" in active_model

        # Helper to send phase updates
        async def notify_phase(phase: ReActPhase, tool_name: str = None, tool_context: str = None):
            if phase_callback:
                await phase_callback(PhaseUpdate(
                    phase=phase,
                    tool_name=tool_name,
                    tool_context=tool_context,
                    iteration=iterations,
                    model_used=active_model,
                ))

        while iterations < max_iterations:
            iterations += 1

            # THINK phase - model is generating
            await notify_phase(ReActPhase.THINK)

            try:
                # Build config - Gemini 3 models require thinking_config for function calling
                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    tools=tools if tools else None,
                    temperature=0.7,
                )
                if is_gemini_3:
                    config.thinking_config = types.ThinkingConfig(thinking_level="low")

                response = await self._gemini_client.aio.models.generate_content(
                    model=active_model,
                    contents=contents,
                    config=config,
                )
            except Exception as e:
                logger.error(f"Inference API error: {e}")
                return {
                    "success": False,
                    "error": str(e),
                    "text": None,
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                }

            # Track token usage
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                total_prompt_tokens += getattr(response.usage_metadata, 'prompt_token_count', 0) or 0
                total_completion_tokens += getattr(response.usage_metadata, 'candidates_token_count', 0) or 0

            # Check for function calls
            function_calls = self._extract_function_calls(response)

            if not function_calls:
                # RESPOND phase - no more tool calls, generating final response
                await notify_phase(ReActPhase.RESPOND)
                text = self._extract_text(response)
                return {
                    "success": True,
                    "text": text,
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "model_used": active_model,
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                }

            # Execute tool calls and add results to conversation
            function_responses = []
            for fc in function_calls:
                tool_name = fc.name
                arguments = dict(fc.args) if fc.args else {}

                # ACT phase - about to execute a tool
                # Extract context from arguments for display
                tool_context = self._extract_tool_context(tool_name, arguments)
                await notify_phase(ReActPhase.ACT, tool_name=tool_name, tool_context=tool_context)

                logger.info(f"Executing tool: {tool_name} with args: {arguments}")

                result = await self._execute_tool(tool_name, arguments)
                tool_calls_made.append(result)

                # OBSERVE phase - tool execution complete
                await notify_phase(ReActPhase.OBSERVE, tool_name=tool_name)

                # Format result for the model
                if result.success:
                    # Check for image data in result (from read_file on images)
                    result_dict = result.result if isinstance(result.result, dict) else {}
                    image_data = result_dict.pop("_image_data", None) if isinstance(result_dict, dict) else None
                    image_mime_type = result_dict.pop("_image_mime_type", "image/png") if isinstance(result_dict, dict) else "image/png"

                    result_content = json.dumps(result.result, default=str)
                else:
                    image_data = None
                    image_mime_type = None
                    result_content = json.dumps({"error": result.error})

                # Add function response
                function_responses.append(
                    types.Part.from_function_response(
                        name=tool_name,
                        response={"result": result_content},
                    )
                )

                # If there's image data, add it as a separate Part so the model can see it
                if image_data:
                    logger.info(f"Injecting image from {tool_name} result ({len(image_data)} bytes)")
                    function_responses.append(
                        types.Part.from_bytes(data=image_data, mime_type=image_mime_type)
                    )

            # Add assistant's function call and our responses to contents
            contents.append(response.candidates[0].content)
            contents.append(types.Content(role="user", parts=function_responses))

        # Max iterations reached - return state for potential continuation
        logger.warning(f"Max iterations ({max_iterations}) reached")
        return {
            "success": True,
            "text": None,  # No final text yet - user may want to continue
            "tool_calls": tool_calls_made,
            "iterations": iterations,
            "max_iterations_reached": True,
            "model_used": active_model,
            "prompt_tokens": total_prompt_tokens,
            "completion_tokens": total_completion_tokens,
            # Include continuation state
            "_continuation_state": {
                "contents": contents,
                "system_prompt": system_prompt,
            },
        }

    async def continue_with_tools(
        self,
        continuation_state: Dict[str, Any],
        max_iterations: int = 5,
        model: Optional[str] = None,
        phase_callback: Optional[PhaseCallback] = None,
        previous_tool_calls: Optional[List[ToolResult]] = None,
        previous_iterations: int = 0,
        previous_prompt_tokens: int = 0,
        previous_completion_tokens: int = 0,
    ) -> Dict[str, Any]:
        """
        Continue a previous ReAct session that hit max iterations.

        Args:
            continuation_state: The _continuation_state from a previous result
            max_iterations: Additional iterations to allow
            model: Optional model override (for depth escalation)
            phase_callback: Optional callback for phase updates
            previous_tool_calls: Tool calls from previous session to accumulate
            previous_iterations: Iteration count from previous session
            previous_prompt_tokens: Prompt tokens from previous session
            previous_completion_tokens: Completion tokens from previous session

        Returns:
            Dict with response text, accumulated tool calls, and trace
        """
        tools = self._build_tool_declarations()
        tool_calls_made = list(previous_tool_calls) if previous_tool_calls else []
        iterations = previous_iterations
        active_model = model or self._default_model

        # Token tracking (accumulate from previous)
        total_prompt_tokens = previous_prompt_tokens
        total_completion_tokens = previous_completion_tokens

        # Restore conversation state
        contents = continuation_state["contents"]
        system_prompt = continuation_state["system_prompt"]

        logger.info(f"Continuing with model: {active_model}, additional iterations: {max_iterations}")

        # Check if using Gemini 3 model (requires thinking_config for function calling)
        is_gemini_3 = "gemini-3" in active_model

        # Helper to send phase updates
        async def notify_phase(phase: ReActPhase, tool_name: str = None, tool_context: str = None):
            if phase_callback:
                await phase_callback(PhaseUpdate(
                    phase=phase,
                    tool_name=tool_name,
                    tool_context=tool_context,
                    iteration=iterations,
                    model_used=active_model,
                ))

        max_total_iterations = iterations + max_iterations

        while iterations < max_total_iterations:
            iterations += 1

            # THINK phase
            await notify_phase(ReActPhase.THINK)

            try:
                # Build config - Gemini 3 models require thinking_config for function calling
                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    tools=tools if tools else None,
                    temperature=0.7,
                )
                if is_gemini_3:
                    config.thinking_config = types.ThinkingConfig(thinking_level="low")

                response = await self._gemini_client.aio.models.generate_content(
                    model=active_model,
                    contents=contents,
                    config=config,
                )
            except Exception as e:
                logger.error(f"Inference API error during continuation: {e}")
                return {
                    "success": False,
                    "error": str(e),
                    "text": None,
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                }

            # Track token usage
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                total_prompt_tokens += getattr(response.usage_metadata, 'prompt_token_count', 0) or 0
                total_completion_tokens += getattr(response.usage_metadata, 'candidates_token_count', 0) or 0

            # Check for function calls
            function_calls = self._extract_function_calls(response)

            if not function_calls:
                # RESPOND phase - done!
                await notify_phase(ReActPhase.RESPOND)
                text = self._extract_text(response)
                return {
                    "success": True,
                    "text": text,
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "model_used": active_model,
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                }

            # Execute tool calls
            function_responses = []
            for fc in function_calls:
                tool_name = fc.name
                arguments = dict(fc.args) if fc.args else {}

                # ACT phase
                tool_context = self._extract_tool_context(tool_name, arguments)
                await notify_phase(ReActPhase.ACT, tool_name=tool_name, tool_context=tool_context)

                logger.info(f"Executing tool: {tool_name} with args: {arguments}")

                result = await self._execute_tool(tool_name, arguments)
                tool_calls_made.append(result)

                # OBSERVE phase
                await notify_phase(ReActPhase.OBSERVE, tool_name=tool_name)

                # Format result for the model
                if result.success:
                    # Check for image data in result (from read_file on images)
                    result_dict = result.result if isinstance(result.result, dict) else {}
                    image_data = result_dict.pop("_image_data", None) if isinstance(result_dict, dict) else None
                    image_mime_type = result_dict.pop("_image_mime_type", "image/png") if isinstance(result_dict, dict) else "image/png"

                    result_content = json.dumps(result.result, default=str)
                else:
                    image_data = None
                    image_mime_type = None
                    result_content = json.dumps({"error": result.error})

                # Add function response
                function_responses.append(
                    types.Part.from_function_response(
                        name=tool_name,
                        response={"result": result_content},
                    )
                )

                # If there's image data, add it as a separate Part so the model can see it
                if image_data:
                    logger.info(f"Injecting image from {tool_name} result ({len(image_data)} bytes)")
                    function_responses.append(
                        types.Part.from_bytes(data=image_data, mime_type=image_mime_type)
                    )

            # Add to conversation
            contents.append(response.candidates[0].content)
            contents.append(types.Content(role="user", parts=function_responses))

        # Max iterations reached again
        logger.warning(f"Max iterations ({max_total_iterations}) reached during continuation")
        return {
            "success": True,
            "text": None,
            "tool_calls": tool_calls_made,
            "iterations": iterations,
            "max_iterations_reached": True,
            "model_used": active_model,
            "prompt_tokens": total_prompt_tokens,
            "completion_tokens": total_completion_tokens,
            "_continuation_state": {
                "contents": contents,
                "system_prompt": system_prompt,
            },
        }

    async def _execute_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> ToolResult:
        """Execute a registered tool."""
        handler = self._tool_handlers.get(tool_name)

        if handler is None:
            logger.error(f"Unknown tool: {tool_name}")
            return ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=None,
                success=False,
                error=f"Unknown tool: {tool_name}",
            )

        try:
            result = await handler(**arguments)
            return ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=result,
                success=True,
            )
        except Exception as e:
            logger.error(f"Tool execution error for {tool_name}: {e}")
            return ToolResult(
                tool_name=tool_name,
                arguments=arguments,
                result=None,
                success=False,
                error=str(e),
            )

    def _messages_to_contents(
        self,
        messages: List[Dict[str, Any]],
    ) -> List[types.Content]:
        """Convert message dicts to Content objects for the model.

        Messages can contain:
        - role: "user", "assistant", "system"
        - content: text content
        - images: list of image dicts with {data: bytes, mime_type: str}
        """
        contents = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            images = msg.get("images", [])

            # Map roles to model format
            if role == "system":
                # System messages are handled via system_instruction
                continue
            elif role == "assistant":
                model_role = "model"
            else:
                model_role = "user"

            # Build parts list - images first, then text
            parts = []

            # Add images if present
            for img in images:
                if isinstance(img, dict) and "data" in img:
                    mime_type = img.get("mime_type", "image/png")
                    parts.append(
                        types.Part.from_bytes(data=img["data"], mime_type=mime_type)
                    )

            # Add text content
            if content:
                parts.append(types.Part.from_text(text=content))

            # Only add if we have parts
            if parts:
                contents.append(
                    types.Content(
                        role=model_role,
                        parts=parts,
                    )
                )

        return contents

    def _extract_function_calls(self, response) -> List[Any]:
        """Extract function calls from model response."""
        function_calls = []

        if not response.candidates:
            return function_calls

        # Check if content and parts exist
        content = response.candidates[0].content
        if not content or not content.parts:
            return function_calls

        for part in content.parts:
            if hasattr(part, "function_call") and part.function_call:
                function_calls.append(part.function_call)

        return function_calls

    def _extract_text(self, response) -> Optional[str]:
        """Extract text content from model response."""
        if not response.candidates:
            return None

        # Check if content and parts exist
        content = response.candidates[0].content
        if not content or not content.parts:
            return None

        text_parts = []
        for part in content.parts:
            if hasattr(part, "text") and part.text:
                text_parts.append(part.text)

        return "\n".join(text_parts) if text_parts else None

    def _extract_tool_context(self, tool_name: str, arguments: Dict[str, Any]) -> Optional[str]:
        """
        Extract a concise context string from tool arguments for display.

        Args:
            tool_name: Name of the tool
            arguments: Tool arguments

        Returns:
            Short context string (e.g., file path, pattern, table name)
        """
        # File-related tools - show file path or pattern
        if "file_path" in arguments:
            return arguments["file_path"]
        if "pattern" in arguments:
            return arguments["pattern"]
        if "path" in arguments:
            return arguments["path"]

        # Database tools - show table name or query
        if "table_name" in arguments:
            return arguments["table_name"]
        if "query" in arguments:
            query = arguments["query"]
            # Truncate long queries
            if len(query) > 40:
                return query[:37] + "..."
            return query

        # Search tools
        if "file_pattern" in arguments:
            return arguments["file_pattern"]

        return None

    async def simple_generate(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
    ) -> Optional[str]:
        """
        Simple text generation without tools.

        Args:
            prompt: User prompt
            system_prompt: Optional system instructions

        Returns:
            Generated text or None on error
        """
        try:
            config = types.GenerateContentConfig(
                temperature=0.7,
            )
            if system_prompt:
                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=0.7,
                )

            response = await self._gemini_client.aio.models.generate_content(
                model=self._default_model,
                contents=prompt,
                config=config,
            )

            return self._extract_text(response)

        except Exception as e:
            logger.error(f"Simple generate error: {e}")
            return None


# Backwards compatibility alias
GeminiToolCapability = ReActCapability
