"""Plugin discovery and loading."""
import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

import yaml

from .models import LoadedPlugin, PluginManifest

logger = logging.getLogger("hester.daemon.plugins")


class PluginLoader:
    """Discovers and loads Hester plugins from workspace config."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.loaded: Dict[str, LoadedPlugin] = {}

    def discover(self, config: Dict[str, Any]) -> List[PluginManifest]:
        """Read plugins: from config, parse each plugin.yaml."""
        plugin_paths = config.get("plugins", [])
        manifests = []

        for rel_path in plugin_paths:
            plugin_dir = (self.workspace / rel_path).resolve()
            manifest_file = plugin_dir / "plugin.yaml"

            if not manifest_file.exists():
                logger.warning(f"Plugin not found: {manifest_file}")
                continue

            try:
                with open(manifest_file) as f:
                    raw = yaml.safe_load(f)
                manifest = PluginManifest(**raw)
                manifests.append(manifest)
                logger.info(f"Discovered plugin: {manifest.name} ({plugin_dir})")
            except Exception as e:
                logger.error(f"Failed to parse {manifest_file}: {e}")

        return manifests

    def load_tools(
        self, manifest: PluginManifest, plugin_dir: Path
    ) -> Tuple[List[Any], Dict[str, Callable]]:
        """Import TOOLS and HANDLERS from each tools/<name>.py."""
        all_defs: List[Any] = []
        all_handlers: Dict[str, Callable] = {}
        tools_dir = plugin_dir / "tools"

        for tool_module_name in manifest.tools:
            module_file = tools_dir / f"{tool_module_name}.py"
            if not module_file.exists():
                logger.warning(f"Tool module not found: {module_file}")
                continue

            try:
                module = self._import_file(
                    f"hester_plugin_{manifest.name}_{tool_module_name}",
                    module_file,
                )
                tools = getattr(module, "TOOLS", [])
                handlers = getattr(module, "HANDLERS", {})
                all_defs.extend(tools)
                all_handlers.update(handlers)
                logger.info(
                    f"Loaded {len(tools)} tools from {manifest.name}/{tool_module_name}"
                )
            except Exception as e:
                logger.error(f"Failed to load tool module {module_file}: {e}")

        return all_defs, all_handlers

    def load_prompts(
        self, manifest: PluginManifest, plugin_dir: Path
    ) -> Tuple[Dict[str, Any], Dict[str, str]]:
        """Parse prompts.yaml and load prompts/*.md templates."""
        configs: Dict[str, Any] = {}
        templates: Dict[str, str] = {}

        prompts_yaml = plugin_dir / "prompts.yaml"
        prompts_dir = plugin_dir / "prompts"

        if prompts_yaml.exists():
            try:
                with open(prompts_yaml) as f:
                    raw = yaml.safe_load(f) or {}
                all_prompts = raw.get("prompts", raw)
                for prompt_id in manifest.prompts:
                    if prompt_id in all_prompts:
                        configs[prompt_id] = all_prompts[prompt_id]
            except Exception as e:
                logger.error(f"Failed to parse {prompts_yaml}: {e}")

        if prompts_dir.exists():
            for prompt_id in manifest.prompts:
                md_file = prompts_dir / f"{prompt_id}.md"
                if md_file.exists():
                    templates[prompt_id] = md_file.read_text()

        return configs, templates

    def load_agents(
        self, manifest: PluginManifest, plugin_dir: Path
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """Parse agents.yaml, return agent configs and toolset configs."""
        agent_configs: Dict[str, Any] = {}
        toolset_configs: Dict[str, Any] = {}

        agents_yaml = plugin_dir / "agents.yaml"
        if not agents_yaml.exists():
            return agent_configs, toolset_configs

        try:
            with open(agents_yaml) as f:
                raw = yaml.safe_load(f) or {}

            all_agents = raw.get("agents", {})
            for agent_id in manifest.agents:
                if agent_id in all_agents:
                    agent_configs[agent_id] = all_agents[agent_id]

            toolset_configs = raw.get("toolsets", {})
        except Exception as e:
            logger.error(f"Failed to parse {agents_yaml}: {e}")

        return agent_configs, toolset_configs

    def load_commands(
        self, manifest: PluginManifest, plugin_dir: Path
    ) -> List[Any]:
        """Import Click groups from commands/<name>.py."""
        commands: List[Any] = []
        commands_dir = plugin_dir / "commands"

        for cmd_name in manifest.commands:
            module_file = commands_dir / f"{cmd_name}.py"
            if not module_file.exists():
                logger.warning(f"Command module not found: {module_file}")
                continue

            try:
                module = self._import_file(
                    f"hester_plugin_{manifest.name}_cmd_{cmd_name}",
                    module_file,
                )
                click_obj = getattr(module, cmd_name, None)
                if click_obj is None:
                    logger.warning(
                        f"No Click group '{cmd_name}' found in {module_file}"
                    )
                    continue
                commands.append(click_obj)
                logger.info(f"Loaded command '{cmd_name}' from {manifest.name}")
            except Exception as e:
                logger.error(f"Failed to load command {module_file}: {e}")

        return commands

    def load_plugin(self, manifest: PluginManifest, plugin_dir: Path) -> LoadedPlugin:
        """Fully load a plugin: tools, prompts, agents, commands."""
        # Add plugin python_paths to sys.path
        for rel_path in manifest.python_paths:
            abs_path = str((plugin_dir / rel_path).resolve())
            if abs_path not in sys.path:
                sys.path.insert(0, abs_path)
                logger.info(f"Added to sys.path: {abs_path}")

        tool_defs, tool_handlers = self.load_tools(manifest, plugin_dir)
        prompt_configs, prompt_templates = self.load_prompts(manifest, plugin_dir)
        agent_configs, toolset_configs = self.load_agents(manifest, plugin_dir)
        click_commands = self.load_commands(manifest, plugin_dir)

        plugin = LoadedPlugin(
            manifest=manifest,
            plugin_dir=plugin_dir,
            tool_definitions=tool_defs,
            tool_handlers=tool_handlers,
            categories=manifest.categories,
            prompt_configs=prompt_configs,
            prompt_templates=prompt_templates,
            agent_configs=agent_configs,
            toolset_configs=toolset_configs,
            click_commands=click_commands,
        )
        self.loaded[manifest.name] = plugin
        logger.info(
            f"Plugin '{manifest.name}' loaded: "
            f"{len(tool_defs)} tools, {len(click_commands)} commands, "
            f"{len(prompt_configs)} prompts, {len(agent_configs)} agents"
        )
        return plugin

    def load_all(self, config: Dict[str, Any]) -> Dict[str, LoadedPlugin]:
        """Discover and load all plugins from config."""
        plugin_paths = config.get("plugins", [])
        for manifest in self.discover(config):
            # Resolve plugin_dir by matching manifest name to config path
            plugin_dir = None
            for rel_path in plugin_paths:
                candidate = (self.workspace / rel_path).resolve()
                manifest_file = candidate / "plugin.yaml"
                if manifest_file.exists():
                    with open(manifest_file) as f:
                        raw = yaml.safe_load(f)
                    if raw.get("name") == manifest.name:
                        plugin_dir = candidate
                        break
            if plugin_dir:
                self.load_plugin(manifest, plugin_dir)
        return self.loaded

    @staticmethod
    def _import_file(module_name: str, file_path: Path):
        """Import a Python file as a module using importlib."""
        spec = importlib.util.spec_from_file_location(module_name, file_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot create module spec for {file_path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
