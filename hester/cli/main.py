"""
Hester CLI - Main entry point with all command groups.

Usage:
    hester qa scene <scene_slug> [--persona <name>] [--verbose]
    hester db tables
    hester redis keys
    hester devops status
    ...

Examples:
    hester qa scene onboarding --persona engaged_user --verbose
    hester db tables --schema public
    hester redis keys --env production
"""

import os
from pathlib import Path

import click


def _load_env():
    """Load environment from .env.local file."""
    # Look in multiple locations for .env.local
    possible_paths = [
        Path(__file__).parent.parent / ".env.local",  # lee/hester/.env.local
        Path(__file__).parent.parent.parent / ".env.local",  # lee/.env.local
        Path(__file__).parent.parent.parent.parent / ".env.local",  # coefficiency/.env.local
    ]

    for env_file in possible_paths:
        if env_file.exists():
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, value = line.split("=", 1)
                        os.environ.setdefault(key.strip(), value.strip())
            break  # Use first found


_load_env()


@click.group()
@click.version_option(version="0.1.0", prog_name="hester")
def cli():
    """Hester - The Internal Daemon for Coefficiency.

    Watchful, practical, no BS.
    """
    pass


# Import and register all command groups
# These imports are done here to avoid circular imports and to ensure
# the environment is loaded before any command code runs

def _register_commands():
    """Register all command groups with the CLI.

    Note: qa, aura, session, memory, intel, audio, bugs are loaded
    dynamically from the Coefficiency plugin via _register_plugin_commands().
    """
    from .chat import chat
    from .agent import agent
    from .daemon import daemon
    from .db import db
    from .redis import redis
    from .ask import ask
    from .devops import devops
    from .slack import slack
    from .ideas import ideas
    from .brief import brief
    from .docs import docs
    from .context import context
    from .git import git
    from .registry import registry
    from .mcp import mcp_server
    from .orchestrate import orchestrate
    from .workstream import workstream

    cli.add_command(chat)
    cli.add_command(agent)
    cli.add_command(daemon)
    cli.add_command(db)
    cli.add_command(redis)
    cli.add_command(ask)
    cli.add_command(devops)
    cli.add_command(slack)
    cli.add_command(ideas)
    cli.add_command(brief)
    cli.add_command(docs)
    cli.add_command(context)
    cli.add_command(git)
    cli.add_command(registry)
    cli.add_command(mcp_server)
    cli.add_command(orchestrate)
    cli.add_command(workstream)


_register_commands()


def _register_plugin_commands():
    """Discover and register plugin CLI commands."""
    try:
        import yaml
        from hester.daemon.plugins.loader import PluginLoader
    except ImportError:
        return  # Plugin module not available

    # Determine workspace: use HESTER_WORKSPACE env var or cwd
    workspace = Path(os.environ.get("HESTER_WORKSPACE", os.getcwd()))

    # Load workspace config (consistent with daemon's _load_workspace_config)
    config = None
    for config_path in [
        workspace / ".lee" / "config.yaml",
        workspace / "lee.yaml",
    ]:
        if config_path.exists():
            try:
                with open(config_path) as f:
                    config = yaml.safe_load(f) or {}
            except Exception:
                return
            break

    if config is None:
        return  # No config found

    plugin_paths = config.get("plugins", [])
    if not plugin_paths:
        return

    loader = PluginLoader(workspace=workspace)
    for manifest in loader.discover(config):
        # Resolve plugin dir by matching manifest name to config path
        for rel_path in plugin_paths:
            candidate = (workspace / rel_path).resolve()
            manifest_file = candidate / "plugin.yaml"
            if manifest_file.exists():
                try:
                    with open(manifest_file) as f:
                        raw = yaml.safe_load(f)
                    if raw.get("name") == manifest.name:
                        commands = loader.load_commands(manifest, candidate)
                        for cmd in commands:
                            cli.add_command(cmd)
                        break
                except Exception:
                    continue


_register_plugin_commands()


def main():
    """Main entry point."""
    cli()


if __name__ == "__main__":
    main()
