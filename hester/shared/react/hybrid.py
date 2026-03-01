"""
Hybrid ReAct Loop - Local/Cloud routing for tool calling.

Extends ReActCapability with hybrid local Gemma / cloud Gemini execution.
"""

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from google.genai import types

from .models import ReActPhase, PhaseUpdate, PhaseCallback, ToolResult
from .capability import ReActCapability

if TYPE_CHECKING:
    from ...daemon.models import InferenceBudget, ObservationResult
    from ...daemon.prepare import PrepareResult, OllamaGemmaClient

logger = logging.getLogger("hester.shared.react.hybrid")


class HybridReActCapability(ReActCapability):
    """
    Extension of ReActCapability with hybrid local/cloud ReAct loop.

    Uses local Gemma models (via Ollama) for OBSERVE phase and simple THINK phases,
    with cloud Gemini for complex reasoning and RESPOND.
    """

    async def generate_with_hybrid_tools(
        self,
        system_prompt: str,
        messages: List[Dict[str, str]],
        max_iterations: int = 5,
        model: Optional[str] = None,
        phase_callback: Optional[PhaseCallback] = None,
        tool_filter: Optional[List[str]] = None,
        budget: Optional["InferenceBudget"] = None,
        local_client: Optional["OllamaGemmaClient"] = None,
        prepare_result: Optional["PrepareResult"] = None,
        local_timeout_ms: float = 500.0,
        local_respond_confidence_threshold: float = 0.85,
    ) -> Dict[str, Any]:
        """
        Generate a response using hybrid local/cloud ReAct loop.

        Uses local Gemma models for OBSERVE phase and simple THINK phases,
        with cloud Gemini for complex reasoning and RESPOND.

        Args:
            system_prompt: System instructions
            messages: Conversation history
            max_iterations: Maximum tool call iterations
            model: Optional model override (for thinking depth)
            phase_callback: Optional callback for real-time phase updates
            tool_filter: Optional list of tool names to include
            budget: Inference budget for local/cloud routing
            local_client: OllamaGemmaClient for local inference
            prepare_result: PrepareResult with routing recommendations
            local_timeout_ms: Timeout for local model calls (ms)
            local_respond_confidence_threshold: Confidence threshold for local RESPOND

        Returns:
            Dict with response text, tool calls made, and full trace
        """
        # Import here to avoid circular imports
        from ...daemon.thinking_depth import refine_routing_decision, get_cloud_model_for_depth, is_local_depth
        from ...daemon.models import InferenceBudget, ModelRoutingDecision

        # Check if user explicitly requested local-only mode via /local or /deeplocal
        force_local_only = prepare_result and is_local_depth(prepare_result.thinking_depth)

        tools = self._build_tool_declarations(tool_filter=tool_filter)
        tool_calls_made: List[ToolResult] = []
        iterations = 0
        active_model = model or self._default_model

        # Token tracking
        total_prompt_tokens = 0
        total_completion_tokens = 0

        # Build initial content
        contents = self._messages_to_contents(messages)

        # Default budget if not provided
        if budget is None:
            budget = InferenceBudget(
                cloud_calls_remaining=10,
                cloud_tokens_remaining=50000,
                local_calls_remaining=20,
                local_time_budget_ms=10000.0,
            )

        # Track last observation for routing decisions
        last_observation: Optional["ObservationResult"] = None

        logger.debug(f"Hybrid loop starting with model: {active_model}, local_client: {local_client is not None}")

        # Check if using Gemini 3 model (requires thinking_config for function calling)
        is_gemini_3 = "gemini-3" in active_model

        # Helper to send phase updates with budget info
        async def notify_phase(
            phase: ReActPhase,
            tool_name: str = None,
            tool_context: str = None,
            is_local: bool = False,
            precision: str = None,
            local_model: str = None,
        ):
            if phase_callback:
                # Use local model name when running locally, cloud model otherwise
                display_model = local_model if is_local and local_model else active_model
                await phase_callback(PhaseUpdate(
                    phase=phase,
                    tool_name=tool_name,
                    tool_context=tool_context,
                    iteration=iterations,
                    model_used=display_model,
                    is_local=is_local,
                    precision=precision,
                    cloud_calls_remaining=budget.cloud_calls_remaining,
                    local_calls_remaining=budget.local_calls_remaining,
                ))

        while iterations < max_iterations:
            iterations += 1

            # 1. ROUTE: Refine prepare's decision based on runtime state
            routing: Optional[ModelRoutingDecision] = None
            if prepare_result and budget:
                routing = refine_routing_decision(
                    prepare_result, iterations, budget, last_observation
                )
                logger.debug(f"Routing decision: use_local={routing.use_local}, model={routing.model_name}")

            # 2. THINK phase - use local or cloud based on routing
            use_local_think = routing.use_local if routing else False

            logger.info(f"THINK routing: use_local_think={use_local_think}, local_client={local_client is not None}, can_use_local={budget.can_use_local()}")

            if use_local_think and local_client and budget.can_use_local():
                # Try local THINK
                local_think_model = routing.model_name if routing else "gemma3n-e4b"
                await notify_phase(
                    ReActPhase.THINK,
                    is_local=True,
                    precision=routing.precision if routing else "e4b",
                    local_model=local_think_model,
                )

                # Build state summary for local model
                state_summary = self._build_state_summary(contents, tool_calls_made)
                user_query = messages[-1].get("content", "") if messages else ""

                think_result = await self._local_think_with_fallback(
                    local_client=local_client,
                    model_key=routing.model_name if routing else "gemma3n-e4b",
                    state_summary=state_summary,
                    user_query=user_query,
                    available_tools=tool_filter or [t["name"] for t in self._tool_definitions],
                    timeout_ms=local_timeout_ms,
                    budget=budget,
                )

                if think_result is None:
                    # Fallback to cloud (unless force_local_only)
                    if force_local_only:
                        logger.debug("Local THINK failed but force_local_only, continuing local loop")
                        # Continue to next iteration, trying local again
                        continue
                    else:
                        logger.debug("Local THINK failed/escalated, falling back to cloud")
                        use_local_think = False

                elif "response" in think_result:
                    # Local model answered directly - go to RESPOND
                    await notify_phase(ReActPhase.RESPOND, is_local=True, precision="local", local_model=local_think_model)

                    # If user explicitly requested local (/local, /deeplocal), always use local response
                    # Otherwise, check confidence threshold for cloud synthesis
                    if force_local_only or (last_observation and last_observation.confidence >= local_respond_confidence_threshold):
                        return {
                            "success": True,
                            "text": think_result["response"],
                            "tool_calls": tool_calls_made,
                            "iterations": iterations,
                            "model_used": "local:" + (routing.model_name if routing else "gemma3n-e4b"),
                            "prompt_tokens": total_prompt_tokens,
                            "completion_tokens": total_completion_tokens,
                            "routing_used": "local",
                        }
                    # Otherwise, synthesize with cloud for better quality
                    use_local_think = False

                elif "tool_call" in think_result:
                    # Local model wants to call a tool
                    tc = think_result["tool_call"]
                    tool_name = tc["name"]
                    arguments = tc.get("args", {})

                    # Execute the tool
                    tool_context = self._extract_tool_context(tool_name, arguments)
                    await notify_phase(ReActPhase.ACT, tool_name=tool_name, tool_context=tool_context)

                    result = await self._execute_tool(tool_name, arguments)
                    tool_calls_made.append(result)

                    # OBSERVE with local model
                    local_observe_model = prepare_result.observe_model if prepare_result else "gemma3n-e2b"
                    last_observation = await self._local_observe(
                        local_client=local_client,
                        tool_name=tool_name,
                        tool_output=result.result if result.success else {"error": result.error},
                        context=system_prompt[:500],
                        model_key=local_observe_model,
                        budget=budget,
                    )

                    await notify_phase(
                        ReActPhase.OBSERVE,
                        tool_name=tool_name,
                        is_local=True,
                        precision="e2b",
                        local_model=local_observe_model,
                    )

                    # Check if observation says we're done
                    if last_observation and last_observation.is_sufficient and iterations > 1:
                        # If force_local_only, synthesize with local model
                        if force_local_only:
                            # Try to get local model to respond directly
                            local_response = await self._local_think_with_fallback(
                                local_client=local_client,
                                model_key=routing.model_name if routing else "gemma3n-e4b",
                                state_summary=self._build_state_summary(contents, tool_calls_made),
                                user_query=messages[-1].get("content", "") if messages else "",
                                available_tools=[],  # No tools for final response
                                timeout_ms=local_timeout_ms * 2,  # More time for synthesis
                                budget=budget,
                            )
                            if local_response and "response" in local_response:
                                await notify_phase(ReActPhase.RESPOND, is_local=True, precision="local", local_model=local_think_model)
                                return {
                                    "success": True,
                                    "text": local_response["response"],
                                    "tool_calls": tool_calls_made,
                                    "iterations": iterations,
                                    "model_used": "local:" + (routing.model_name if routing else "gemma3n-e4b"),
                                    "prompt_tokens": total_prompt_tokens,
                                    "completion_tokens": total_completion_tokens,
                                    "routing_used": "local",
                                }
                        elif last_observation.confidence >= local_respond_confidence_threshold:
                            # Synthesize final response with cloud for quality
                            break

                    # Continue loop
                    continue

            # Cloud THINK path - skip if force_local_only mode
            if not use_local_think and not force_local_only:
                await notify_phase(ReActPhase.THINK, is_local=False, precision="full")

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
                    budget.record_cloud_call(
                        getattr(response.usage_metadata, 'prompt_token_count', 0) or 0 +
                        getattr(response.usage_metadata, 'candidates_token_count', 0) or 0
                    )
                except Exception as e:
                    logger.error(f"Cloud inference API error: {e}")
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
                    # RESPOND phase - no more tool calls
                    await notify_phase(ReActPhase.RESPOND, is_local=False, precision="full")
                    text = self._extract_text(response)
                    if not text:
                        logger.warning(f"Model returned empty response after {iterations} iterations, {len(tool_calls_made)} tool calls")
                    return {
                        "success": True,
                        "text": text,
                        "tool_calls": tool_calls_made,
                        "iterations": iterations,
                        "model_used": active_model,
                        "prompt_tokens": total_prompt_tokens,
                        "completion_tokens": total_completion_tokens,
                        "routing_used": "cloud",
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

                    # OBSERVE with local model if available
                    if local_client and budget.can_use_local():
                        local_observe_model = prepare_result.observe_model if prepare_result else "gemma3n-e2b"
                        last_observation = await self._local_observe(
                            local_client=local_client,
                            tool_name=tool_name,
                            tool_output=result.result if result.success else {"error": result.error},
                            context=system_prompt[:500],
                            model_key=local_observe_model,
                            budget=budget,
                        )
                        await notify_phase(
                            ReActPhase.OBSERVE,
                            tool_name=tool_name,
                            is_local=True,
                            precision="e2b",
                            local_model=local_observe_model,
                        )
                    else:
                        await notify_phase(ReActPhase.OBSERVE, tool_name=tool_name)
                        last_observation = None

                    # Format result for the model
                    if result.success:
                        # Check for image data in result (from read_file on images, generate_image)
                        result_dict = result.result if isinstance(result.result, dict) else {}
                        image_data = result_dict.pop("_image_data", None) if isinstance(result_dict, dict) else None
                        image_mime_type = result_dict.pop("_image_mime_type", "image/png") if isinstance(result_dict, dict) else "image/png"

                        # Stash on ToolResult so callers can access after the pop
                        if image_data:
                            result._image_data = image_data
                            result._image_mime_type = image_mime_type

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

            elif force_local_only:
                # We're in force_local_only mode but fell through - try to get local response
                logger.debug("Force local only mode - attempting local synthesis")
                local_response = await self._local_think_with_fallback(
                    local_client=local_client,
                    model_key=routing.model_name if routing else "gemma3n-e4b",
                    state_summary=self._build_state_summary(contents, tool_calls_made),
                    user_query=messages[-1].get("content", "") if messages else "",
                    available_tools=[],  # No tools for final response
                    timeout_ms=local_timeout_ms * 2,
                    budget=budget,
                )
                if local_response and "response" in local_response:
                    await notify_phase(ReActPhase.RESPOND, is_local=True, precision="local")
                    return {
                        "success": True,
                        "text": local_response["response"],
                        "tool_calls": tool_calls_made,
                        "iterations": iterations,
                        "model_used": "local:" + (routing.model_name if routing else "gemma3n-e4b"),
                        "prompt_tokens": total_prompt_tokens,
                        "completion_tokens": total_completion_tokens,
                        "routing_used": "local",
                    }
                # If local synthesis failed, return what we have
                logger.warning("Force local only mode but local synthesis failed")
                return {
                    "success": True,
                    "text": "I couldn't generate a response using only local models.",
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "model_used": "local",
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                    "routing_used": "local",
                }

        # Max iterations reached
        logger.warning(f"Max iterations ({max_iterations}) reached in hybrid loop")
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

    async def _local_think_with_fallback(
        self,
        local_client: "OllamaGemmaClient",
        model_key: str,
        state_summary: str,
        user_query: str,
        available_tools: List[str],
        timeout_ms: float,
        budget: "InferenceBudget",
    ) -> Optional[Dict[str, Any]]:
        """
        Attempt local THINK with timeout and fallback.

        Returns:
            Dict with 'response' or 'tool_call', or None to escalate to cloud
        """
        try:
            result = await asyncio.wait_for(
                local_client.think_simple(
                    current_state=state_summary,
                    available_tools=available_tools,
                    user_query=user_query,
                    model_key=model_key,
                ),
                timeout=timeout_ms / 1000.0,
            )
            budget.record_local_call(timeout_ms)  # Approximate
            return result
        except asyncio.TimeoutError:
            logger.debug(f"Local THINK timed out after {timeout_ms}ms")
            return None
        except Exception as e:
            logger.debug(f"Local THINK error: {e}")
            return None

    async def _local_observe(
        self,
        local_client: "OllamaGemmaClient",
        tool_name: str,
        tool_output: Any,
        context: str,
        model_key: str,
        budget: "InferenceBudget",
    ) -> Optional["ObservationResult"]:
        """
        Parse tool output with local model.

        Returns:
            ObservationResult or None on failure
        """
        try:
            observation = await local_client.observe_tool_output(
                tool_name=tool_name,
                tool_output=tool_output,
                context=context,
                model_key=model_key,
            )
            budget.record_local_call(observation.parse_time_ms)
            return observation
        except Exception as e:
            logger.debug(f"Local OBSERVE error: {e}")
            return None

    def _build_state_summary(
        self,
        contents: List[types.Content],
        tool_calls: List[ToolResult],
    ) -> str:
        """Build a summary of current conversation state for local model."""
        summary_parts = []

        # Recent tool calls
        if tool_calls:
            recent_tools = tool_calls[-3:]  # Last 3 tool calls
            for tc in recent_tools:
                if tc.success:
                    result_preview = str(tc.result)[:200]
                    summary_parts.append(f"Tool {tc.tool_name}: {result_preview}")
                else:
                    summary_parts.append(f"Tool {tc.tool_name} FAILED: {tc.error}")

        # Content summary
        if contents:
            last_content = contents[-1]
            if hasattr(last_content, 'parts'):
                for part in last_content.parts[:2]:
                    if hasattr(part, 'text') and part.text:
                        summary_parts.append(f"Last message: {part.text[:300]}")

        return "\n".join(summary_parts) if summary_parts else "No previous context"


# Backwards compatibility alias
HybridGeminiCapability = HybridReActCapability
