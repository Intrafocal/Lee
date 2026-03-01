import pytest
import yaml
from pathlib import Path


def test_parse_minimal_manifest():
    """A plugin.yaml with just name parses without error."""
    from hester.daemon.plugins.models import PluginManifest

    m = PluginManifest(name="test-plugin")
    assert m.name == "test-plugin"
    assert m.version == "0.0.0"
    assert m.tools == []
    assert m.commands == []
    assert m.prompts == []
    assert m.agents == []
    assert m.categories == {}
    assert m.dependencies == {}


def test_parse_full_manifest():
    """A fully-populated plugin.yaml round-trips correctly."""
    from hester.daemon.plugins.models import PluginManifest

    m = PluginManifest(
        name="example-plugin",
        version="0.1.0",
        description="Example tools",
        dependencies={"pip": ["supabase>=2.0.0"], "local": ["../../shared"]},
        tools=["scene_tools", "audio_tools"],
        categories={"scene": ["scene_list", "scene_read"]},
        commands=["scene", "aura"],
        prompts=["scene", "bug_analysis"],
        agents=["scene_developer"],
    )
    assert m.tools == ["scene_tools", "audio_tools"]
    assert m.categories["scene"] == ["scene_list", "scene_read"]
    assert m.agents == ["scene_developer"]


def test_load_manifest_from_yaml(tmp_path):
    """Load a plugin.yaml from disk."""
    from hester.daemon.plugins.models import PluginManifest
    import yaml

    plugin_dir = tmp_path / "test-plugin"
    plugin_dir.mkdir()
    manifest_file = plugin_dir / "plugin.yaml"
    manifest_file.write_text(
        yaml.dump(
            {
                "name": "test-plugin",
                "version": "0.1.0",
                "tools": ["my_tools"],
                "commands": ["my_cmd"],
            }
        )
    )
    raw = yaml.safe_load(manifest_file.read_text())
    m = PluginManifest(**raw)
    assert m.name == "test-plugin"
    assert m.tools == ["my_tools"]


def test_discover_plugins_from_config(tmp_path):
    """Loader reads plugins: list from config and finds plugin.yaml files."""
    import yaml
    from hester.daemon.plugins.loader import PluginLoader

    # Create a plugin
    plugin_dir = tmp_path / ".hester" / "plugins" / "test-plugin"
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.yaml").write_text(yaml.dump({"name": "test-plugin"}))

    loader = PluginLoader(workspace=tmp_path)
    config = {"plugins": [".hester/plugins/test-plugin"]}
    manifests = loader.discover(config)
    assert len(manifests) == 1
    assert manifests[0].name == "test-plugin"


def test_discover_skips_missing_plugin(tmp_path):
    """Loader gracefully skips plugin paths that don't exist."""
    from hester.daemon.plugins.loader import PluginLoader

    loader = PluginLoader(workspace=tmp_path)
    config = {"plugins": [".hester/plugins/nonexistent"]}
    manifests = loader.discover(config)
    assert len(manifests) == 0


def test_load_tools_from_plugin(tmp_path):
    """Loader imports TOOLS and HANDLERS from a plugin's tools/ directory."""
    import yaml
    from hester.daemon.plugins.loader import PluginLoader
    from hester.daemon.plugins.models import PluginManifest

    # Create plugin structure
    plugin_dir = tmp_path / "my-plugin"
    plugin_dir.mkdir()
    tools_dir = plugin_dir / "tools"
    tools_dir.mkdir()

    # Write a minimal tool module
    (tools_dir / "greet_tools.py").write_text(
        '''
from hester.daemon.tools.definitions.models import ToolDefinition

GREET_TOOL = ToolDefinition(
    name="greet",
    description="Say hello",
    parameters={"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
)

TOOLS = [GREET_TOOL]

async def greet(name: str = "world"):
    return {"success": True, "data": f"Hello, {name}!"}

HANDLERS = {"greet": greet}
'''
    )

    manifest = PluginManifest(name="my-plugin", tools=["greet_tools"])
    loader = PluginLoader(workspace=tmp_path)
    tool_defs, handlers = loader.load_tools(manifest, plugin_dir)

    assert len(tool_defs) == 1
    assert tool_defs[0].name == "greet"
    assert "greet" in handlers


def test_register_plugin_tools_extends_global_registry():
    """register_plugin_tools adds tool defs and categories to the global registry."""
    from hester.daemon.tools.definitions import (
        register_plugin_tools,
        HESTER_TOOLS,
        TOOL_CATEGORIES,
    )
    from hester.daemon.tools.definitions.models import ToolDefinition

    initial_tool_count = len(HESTER_TOOLS)
    initial_cat_count = len(TOOL_CATEGORIES)

    test_tool = ToolDefinition(
        name="plugin_test_tool",
        description="A test tool from plugin",
        parameters={"type": "object", "properties": {}, "required": []},
    )
    register_plugin_tools(
        tool_defs=[test_tool],
        categories={"plugin_test_cat": ["plugin_test_tool"]},
    )

    assert len(HESTER_TOOLS) == initial_tool_count + 1
    assert HESTER_TOOLS[-1].name == "plugin_test_tool"
    assert "plugin_test_cat" in TOOL_CATEGORIES
    assert TOOL_CATEGORIES["plugin_test_cat"] == ["plugin_test_tool"]

    # Cleanup: remove the tool and category we added so we don't pollute other tests
    HESTER_TOOLS.pop()
    del TOOL_CATEGORIES["plugin_test_cat"]


def test_load_workspace_config_from_lee_dir(tmp_path):
    """_load_workspace_config reads .lee/config.yaml."""
    from hester.daemon.main import _load_workspace_config

    lee_dir = tmp_path / ".lee"
    lee_dir.mkdir()
    (lee_dir / "config.yaml").write_text(
        yaml.dump({"plugins": [".hester/plugins/my-plugin"]})
    )

    config = _load_workspace_config(tmp_path)
    assert config.get("plugins") == [".hester/plugins/my-plugin"]


def test_load_workspace_config_missing_returns_empty(tmp_path):
    """_load_workspace_config returns {} when no config file exists."""
    from hester.daemon.main import _load_workspace_config

    config = _load_workspace_config(tmp_path)
    assert config == {}


def test_full_plugin_wiring_end_to_end(tmp_path):
    """Full integration: load_all + register_plugin_tools wires tools into global registry."""
    from hester.daemon.plugins.loader import PluginLoader
    from hester.daemon.tools.definitions import (
        register_plugin_tools,
        HESTER_TOOLS,
        TOOL_CATEGORIES,
    )

    # Create plugin with a tool
    plugin_dir = tmp_path / ".hester" / "plugins" / "e2e-plugin"
    plugin_dir.mkdir(parents=True)
    tools_dir = plugin_dir / "tools"
    tools_dir.mkdir()

    (plugin_dir / "plugin.yaml").write_text(
        yaml.dump({
            "name": "e2e-plugin",
            "version": "0.1.0",
            "tools": ["e2e_tools"],
            "categories": {"e2e_cat": ["e2e_hello"]},
        })
    )
    (tools_dir / "e2e_tools.py").write_text(
        '''
from hester.daemon.tools.definitions.models import ToolDefinition

E2E_TOOL = ToolDefinition(
    name="e2e_hello",
    description="E2E test tool",
    parameters={"type": "object", "properties": {}, "required": []},
)

TOOLS = [E2E_TOOL]

async def e2e_hello():
    return {"success": True}

HANDLERS = {"e2e_hello": e2e_hello}
'''
    )

    initial_tool_count = len(HESTER_TOOLS)

    loader = PluginLoader(workspace=tmp_path)
    config = {"plugins": [".hester/plugins/e2e-plugin"]}
    plugins = loader.load_all(config)

    assert "e2e-plugin" in plugins
    plugin = plugins["e2e-plugin"]

    # Register into global registry
    register_plugin_tools(plugin.tool_definitions, plugin.categories)

    assert len(HESTER_TOOLS) == initial_tool_count + 1
    assert HESTER_TOOLS[-1].name == "e2e_hello"
    assert "e2e_cat" in TOOL_CATEGORIES

    # Verify handler is available
    assert "e2e_hello" in plugin.tool_handlers

    # Cleanup
    HESTER_TOOLS.pop()
    del TOOL_CATEGORIES["e2e_cat"]
