# ReAct Backend Abstraction

## Overview

Refactor the ReAct loop implementation to support multiple inference providers (Gemini, Claude, OpenAI, local models) through a backend abstraction layer.

## Current State

The `ReActCapability` class in `lee/hester/shared/react/capability.py` is tightly coupled to Google Gemini:

- Direct `google.genai` imports
- Gemini-specific types (`types.Content`, `types.Part`, `types.Tool`)
- Hardcoded Gemini API calls
- Gemini response parsing

## Goals

1. **Provider Agnostic**: Core ReAct loop logic independent of inference provider
2. **Easy Extension**: Add new providers with minimal code changes
3. **Runtime Swappable**: Switch backends for cost optimization or testing
4. **Backwards Compatible**: Existing code continues to work

## Architecture

### Directory Structure

```
lee/hester/shared/react/
├── __init__.py              # Package exports
├── models.py                # ReActPhase, PhaseUpdate, ToolResult (unchanged)
├── capability.py            # ReActCapability - orchestration only
├── hybrid.py                # HybridReActCapability - local/cloud routing
└── backends/
    ├── __init__.py          # Backend exports
    ├── base.py              # Protocol/interface definitions
    ├── gemini.py            # GeminiBackend implementation
    ├── anthropic.py         # AnthropicBackend implementation (future)
    └── types.py             # Shared backend types
```

### Core Types

```python
# react/backends/types.py

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
from enum import Enum

class MessageRole(Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL_RESULT = "tool_result"

@dataclass
class Message:
    """Provider-agnostic message representation."""
    role: MessageRole
    content: str
    images: Optional[List[bytes]] = None
    tool_call_id: Optional[str] = None  # For tool results
    tool_calls: Optional[List["ToolCall"]] = None  # For assistant messages

@dataclass
class ToolCall:
    """A tool/function call from the model."""
    id: str
    name: str
    arguments: Dict[str, Any]

@dataclass
class ToolDefinition:
    """Provider-agnostic tool definition."""
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema

@dataclass
class InferenceResponse:
    """Standardized response from any backend."""
    text: Optional[str]
    tool_calls: List[ToolCall]
    prompt_tokens: int
    completion_tokens: int
    raw_response: Any  # Original provider response for debugging
```

### Backend Protocol

```python
# react/backends/base.py

from typing import Protocol, List, Optional, Any
from .types import Message, ToolDefinition, InferenceResponse

class InferenceBackend(Protocol):
    """Protocol defining the interface for inference backends."""

    @property
    def model_name(self) -> str:
        """Current model identifier."""
        ...

    async def generate(
        self,
        messages: List[Message],
        system_prompt: str,
        tools: Optional[List[ToolDefinition]] = None,
        temperature: float = 0.7,
    ) -> InferenceResponse:
        """
        Generate a response, potentially with tool calls.

        Args:
            messages: Conversation history
            system_prompt: System instructions
            tools: Available tools (None = no tool use)
            temperature: Sampling temperature

        Returns:
            InferenceResponse with text and/or tool calls
        """
        ...

    def format_tool_result(
        self,
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> Message:
        """
        Format a tool result for inclusion in the conversation.

        Different providers have different formats for tool results.
        This method handles the provider-specific formatting.
        """
        ...
```

### Gemini Backend

```python
# react/backends/gemini.py

from google import genai
from google.genai import types
from .base import InferenceBackend
from .types import Message, ToolDefinition, InferenceResponse, ToolCall, MessageRole

class GeminiBackend(InferenceBackend):
    """Gemini inference backend."""

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash"):
        self._client = genai.Client(api_key=api_key)
        self._model = model

    @property
    def model_name(self) -> str:
        return self._model

    async def generate(
        self,
        messages: List[Message],
        system_prompt: str,
        tools: Optional[List[ToolDefinition]] = None,
        temperature: float = 0.7,
    ) -> InferenceResponse:
        # Convert messages to Gemini format
        contents = self._to_gemini_contents(messages)
        gemini_tools = self._to_gemini_tools(tools) if tools else None

        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                tools=gemini_tools,
                temperature=temperature,
            ),
        )

        return self._parse_response(response)

    def format_tool_result(
        self,
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> Message:
        # Gemini uses function_response parts
        return Message(
            role=MessageRole.TOOL_RESULT,
            content=json.dumps(result, default=str),
            tool_call_id=tool_call_id,
        )

    def _to_gemini_contents(self, messages: List[Message]) -> List[types.Content]:
        """Convert generic messages to Gemini Content objects."""
        ...

    def _to_gemini_tools(self, tools: List[ToolDefinition]) -> List[types.Tool]:
        """Convert generic tool definitions to Gemini Tool objects."""
        ...

    def _parse_response(self, response) -> InferenceResponse:
        """Parse Gemini response into standardized format."""
        ...
```

### Anthropic Backend (Future)

```python
# react/backends/anthropic.py

import anthropic
from .base import InferenceBackend
from .types import Message, ToolDefinition, InferenceResponse, ToolCall, MessageRole

class AnthropicBackend(InferenceBackend):
    """Anthropic Claude inference backend."""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-20250514"):
        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self._model = model

    @property
    def model_name(self) -> str:
        return self._model

    async def generate(
        self,
        messages: List[Message],
        system_prompt: str,
        tools: Optional[List[ToolDefinition]] = None,
        temperature: float = 0.7,
    ) -> InferenceResponse:
        # Convert messages to Anthropic format
        anthropic_messages = self._to_anthropic_messages(messages)
        anthropic_tools = self._to_anthropic_tools(tools) if tools else None

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=4096,
            system=system_prompt,
            messages=anthropic_messages,
            tools=anthropic_tools,
            temperature=temperature,
        )

        return self._parse_response(response)

    def format_tool_result(
        self,
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> Message:
        # Anthropic uses tool_result content blocks
        return Message(
            role=MessageRole.TOOL_RESULT,
            content=json.dumps(result, default=str),
            tool_call_id=tool_call_id,
        )

    def _to_anthropic_messages(self, messages: List[Message]) -> List[dict]:
        """Convert generic messages to Anthropic message format."""
        ...

    def _to_anthropic_tools(self, tools: List[ToolDefinition]) -> List[dict]:
        """Convert generic tool definitions to Anthropic tool format."""
        ...

    def _parse_response(self, response) -> InferenceResponse:
        """Parse Anthropic response into standardized format."""
        ...
```

### Updated ReActCapability

```python
# react/capability.py

from .backends.base import InferenceBackend
from .backends.types import Message, ToolDefinition, InferenceResponse, MessageRole
from .models import ReActPhase, PhaseUpdate, PhaseCallback, ToolResult

class ReActCapability:
    """
    ReAct loop capability - provider agnostic.

    Usage:
        from lee.hester.shared.react.backends.gemini import GeminiBackend

        class MyAgent(ReActCapability):
            def __init__(self):
                backend = GeminiBackend(api_key="...", model="gemini-2.5-flash")
                super().__init__(backend=backend)
                self.register_tools([...])
    """

    def __init__(self, backend: InferenceBackend, **kwargs):
        super().__init__(**kwargs)
        self._backend = backend
        self._tool_definitions: List[ToolDefinition] = []
        self._tool_handlers: Dict[str, Callable] = {}

    async def generate_with_tools(
        self,
        system_prompt: str,
        messages: List[Dict[str, str]],
        max_iterations: int = 5,
        phase_callback: Optional[PhaseCallback] = None,
        tool_filter: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Run the ReAct loop using the configured backend."""

        # Convert to generic Message format
        conversation = self._to_messages(messages)
        tools = self._get_filtered_tools(tool_filter)

        tool_calls_made: List[ToolResult] = []
        iterations = 0
        total_prompt_tokens = 0
        total_completion_tokens = 0

        while iterations < max_iterations:
            iterations += 1

            # THINK phase
            await self._notify_phase(phase_callback, ReActPhase.THINK, iterations)

            response = await self._backend.generate(
                messages=conversation,
                system_prompt=system_prompt,
                tools=tools,
            )

            total_prompt_tokens += response.prompt_tokens
            total_completion_tokens += response.completion_tokens

            if not response.tool_calls:
                # RESPOND phase - done
                await self._notify_phase(phase_callback, ReActPhase.RESPOND, iterations)
                return {
                    "success": True,
                    "text": response.text,
                    "tool_calls": tool_calls_made,
                    "iterations": iterations,
                    "model_used": self._backend.model_name,
                    "prompt_tokens": total_prompt_tokens,
                    "completion_tokens": total_completion_tokens,
                }

            # Execute tool calls
            for tc in response.tool_calls:
                # ACT phase
                await self._notify_phase(
                    phase_callback, ReActPhase.ACT, iterations,
                    tool_name=tc.name
                )

                result = await self._execute_tool(tc.name, tc.arguments)
                tool_calls_made.append(result)

                # OBSERVE phase
                await self._notify_phase(
                    phase_callback, ReActPhase.OBSERVE, iterations,
                    tool_name=tc.name
                )

                # Add tool result to conversation
                tool_message = self._backend.format_tool_result(
                    tool_call_id=tc.id,
                    tool_name=tc.name,
                    result=result.result if result.success else {"error": result.error},
                )
                conversation.append(tool_message)

        # Max iterations
        return {
            "success": True,
            "text": None,
            "tool_calls": tool_calls_made,
            "iterations": iterations,
            "max_iterations_reached": True,
            ...
        }
```

## Implementation Steps

### Phase 1: Backend Infrastructure

1. Create `react/backends/` directory
2. Create `types.py` with shared types
3. Create `base.py` with `InferenceBackend` protocol
4. Create `__init__.py` with exports

### Phase 2: Gemini Backend

1. Create `gemini.py` implementing `InferenceBackend`
2. Move Gemini-specific code from `capability.py`
3. Implement message/tool conversion methods
4. Add response parsing

### Phase 3: Update ReActCapability

1. Modify `__init__` to accept backend
2. Replace direct Gemini calls with backend methods
3. Use generic Message types internally
4. Update tool result formatting

### Phase 4: Backwards Compatibility

1. Create factory function for easy migration:
   ```python
   def create_gemini_react(api_key: str, model: str = "gemini-2.5-flash"):
       backend = GeminiBackend(api_key=api_key, model=model)
       return ReActCapability(backend=backend)
   ```
2. Update existing usages in daemon/agent.py

### Phase 5: Hybrid Capability

1. Update `HybridReActCapability` to use backend
2. Local model routing remains unchanged (Ollama)
3. Cloud fallback uses configured backend

### Phase 6: Anthropic Backend (Future)

1. Create `anthropic.py` implementing `InferenceBackend`
2. Map Claude tool_use/tool_result format
3. Handle Claude-specific response structure
4. Test with existing ReAct loops

## Provider Differences

| Aspect | Gemini | Claude |
|--------|--------|--------|
| Tool format | `FunctionDeclaration` | `tools` array with `input_schema` |
| Tool calls | `function_call` parts | `tool_use` content blocks |
| Tool results | `function_response` parts | `tool_result` content blocks |
| System prompt | `system_instruction` param | `system` param |
| Response structure | `candidates[0].content.parts` | `content` blocks |
| Token tracking | `usage_metadata` | `usage` |

## Testing Strategy

1. **Unit tests per backend**: Mock API responses
2. **Integration tests**: Real API calls with simple prompts
3. **ReAct loop tests**: Verify tool calling works end-to-end
4. **Regression tests**: Ensure existing Hester functionality unchanged

## Migration Path

1. Implement backend abstraction (no behavior change)
2. Migrate daemon/agent.py to use new API
3. Verify all existing functionality works
4. Add Anthropic backend when needed
5. Allow runtime backend selection via config

## Future Extensions

- **OpenAI Backend**: GPT-4 with function calling
- **Local Backend**: Ollama/llama.cpp for fully local inference
- **Mock Backend**: For testing without API calls
- **Multi-Backend**: Route different query types to different providers
