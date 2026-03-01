"""Plugin manifest and loaded plugin models."""

from pathlib import Path
from typing import Any, Dict, List

from pydantic import BaseModel, Field


class PluginManifest(BaseModel):
    """Parsed plugin.yaml manifest."""

    name: str
    version: str = "0.0.0"
    description: str = ""
    dependencies: Dict[str, Any] = Field(default_factory=dict)
    tools: List[str] = Field(default_factory=list)
    categories: Dict[str, List[str]] = Field(default_factory=dict)
    commands: List[str] = Field(default_factory=list)
    prompts: List[str] = Field(default_factory=list)
    agents: List[str] = Field(default_factory=list)
    python_paths: List[str] = Field(default_factory=list)


class LoadedPlugin(BaseModel):
    """A fully loaded plugin with resolved definitions and handlers."""

    model_config = {"arbitrary_types_allowed": True}

    manifest: PluginManifest
    plugin_dir: Path
    tool_definitions: List[Any] = Field(default_factory=list)  # list[ToolDefinition]
    tool_handlers: Dict[str, Any] = Field(default_factory=dict)  # name -> callable
    categories: Dict[str, List[str]] = Field(default_factory=dict)
    prompt_configs: Dict[str, Any] = Field(default_factory=dict)  # prompt_id -> config dict
    prompt_templates: Dict[str, str] = Field(default_factory=dict)  # prompt_id -> md content
    agent_configs: Dict[str, Any] = Field(default_factory=dict)  # agent_id -> config dict
    toolset_configs: Dict[str, Any] = Field(default_factory=dict)  # toolset_id -> config dict
    click_commands: List[Any] = Field(default_factory=list)  # list[click.BaseCommand]
