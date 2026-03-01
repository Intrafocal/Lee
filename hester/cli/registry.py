"""
Hester CLI - Registry inspection commands.

Provides commands for inspecting and testing the bespoke agent registries:
- List prompts, agents, and toolsets
- Show details for individual items
- Test routing with a message

Usage:
    hester registry list-prompts
    hester registry list-agents
    hester registry list-toolsets
    hester registry show <name>
    hester registry test-routing "What tables exist?"
"""

import asyncio
import sys
from typing import Optional

import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.markdown import Markdown

console = Console()


@click.group()
def registry():
    """Inspect bespoke agent registries (prompts, agents, toolsets)."""
    pass


@registry.command("list-prompts")
def list_prompts():
    """List all available prompts in the registry.

    Examples:
        hester registry list-prompts
    """
    try:
        from hester.daemon.registries import get_prompt_registry

        reg = get_prompt_registry()
        prompts = reg.list_prompts()

        if not prompts:
            console.print("[yellow]No prompts found in registry.[/yellow]")
            return

        table = Table(title="Prompts Registry")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Description", style="white")
        table.add_column("Keywords", style="dim")
        table.add_column("Tier Range", style="green")

        for prompt in prompts:
            keywords = ", ".join(prompt.keywords[:5])
            if len(prompt.keywords) > 5:
                keywords += f" (+{len(prompt.keywords) - 5})"

            tier_range = f"{prompt.min_tier.value}-{prompt.max_tier.value}"

            table.add_row(
                prompt.name,
                prompt.description[:50] + "..." if len(prompt.description) > 50 else prompt.description,
                keywords,
                tier_range,
            )

        console.print(table)
        console.print(f"\n[dim]Total: {len(prompts)} prompts[/dim]")

    except ImportError as e:
        console.print(f"[red]Registries not available: {e}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@registry.command("list-agents")
def list_agents():
    """List all pre-bundled agents in the registry.

    Examples:
        hester registry list-agents
    """
    try:
        from hester.daemon.registries import get_agent_registry

        reg = get_agent_registry()
        agents = reg.list_agents()

        if not agents:
            console.print("[yellow]No agents found in registry.[/yellow]")
            return

        table = Table(title="Agents Registry")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Description", style="white")
        table.add_column("Prompt", style="green")
        table.add_column("Toolset", style="blue")
        table.add_column("Tier", style="yellow")
        table.add_column("Max Iter", style="dim")

        for agent in agents:
            table.add_row(
                agent.name,
                agent.description[:40] + "..." if len(agent.description) > 40 else agent.description,
                agent.prompt,
                agent.toolset,
                agent.model_tier.value,
                str(agent.max_iterations),
            )

        console.print(table)
        console.print(f"\n[dim]Total: {len(agents)} agents[/dim]")

    except ImportError as e:
        console.print(f"[red]Registries not available: {e}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@registry.command("list-toolsets")
def list_toolsets():
    """List all toolsets with their resolved tool counts.

    Examples:
        hester registry list-toolsets
    """
    try:
        from hester.daemon.registries import get_agent_registry

        reg = get_agent_registry()
        toolsets = reg.list_toolsets()

        if not toolsets:
            console.print("[yellow]No toolsets found in registry.[/yellow]")
            return

        table = Table(title="Toolsets Registry")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Description", style="white")
        table.add_column("Categories", style="blue")
        table.add_column("Tools", style="green")

        for toolset in toolsets:
            # Resolve tool count
            tools = reg.resolve_tools(toolset.name)
            categories = ", ".join(toolset.categories)

            table.add_row(
                toolset.name,
                toolset.description[:40] + "..." if len(toolset.description) > 40 else toolset.description,
                categories,
                str(len(tools)),
            )

        console.print(table)
        console.print(f"\n[dim]Total: {len(toolsets)} toolsets[/dim]")

    except ImportError as e:
        console.print(f"[red]Registries not available: {e}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@registry.command("show")
@click.argument("name")
@click.option(
    "--type", "-t",
    type=click.Choice(["auto", "prompt", "agent", "toolset"]),
    default="auto",
    help="Type of item to show (auto-detect by default)"
)
def show_item(name: str, type: str):
    """Show detailed information about a registry item.

    Examples:
        hester registry show code_analysis
        hester registry show db_explorer --type agent
        hester registry show research --type toolset
    """
    try:
        from hester.daemon.registries import get_prompt_registry, get_agent_registry

        prompt_reg = get_prompt_registry()
        agent_reg = get_agent_registry()

        found = False

        # Auto-detect or search by type
        if type in ("auto", "prompt"):
            prompt = prompt_reg.get(name)
            if prompt:
                found = True
                console.print(Panel(f"[bold cyan]Prompt: {name}[/bold cyan]"))
                console.print(f"[bold]Description:[/bold] {prompt.description}")
                console.print(f"[bold]Keywords:[/bold] {', '.join(prompt.keywords)}")
                console.print(f"[bold]Tier Range:[/bold] {prompt.min_tier.value} → {prompt.preferred_tier.value} → {prompt.max_tier.value}")

                # Show template content
                content = prompt_reg.get_content(name)
                if content:
                    console.print("\n[bold]Template Preview:[/bold]")
                    # Truncate for display
                    preview = content[:500] + "..." if len(content) > 500 else content
                    console.print(Panel(preview, title="Template", border_style="dim"))

        if not found and type in ("auto", "agent"):
            agent = agent_reg.get_agent(name)
            if agent:
                found = True
                console.print(Panel(f"[bold cyan]Agent: {name}[/bold cyan]"))
                console.print(f"[bold]Description:[/bold] {agent.description}")
                console.print(f"[bold]Prompt:[/bold] {agent.prompt}")
                console.print(f"[bold]Toolset:[/bold] {agent.toolset}")
                console.print(f"[bold]Model Tier:[/bold] {agent.model_tier.value}")
                console.print(f"[bold]Max Iterations:[/bold] {agent.max_iterations}")
                console.print(f"[bold]Keywords:[/bold] {', '.join(agent.keywords)}")

                # Show resolved tools
                tools = agent_reg.resolve_tools(agent.toolset)
                console.print(f"\n[bold]Resolved Tools ({len(tools)}):[/bold]")
                for tool in sorted(tools):
                    console.print(f"  - {tool}")

        if not found and type in ("auto", "toolset"):
            toolset = agent_reg.get_toolset(name)
            if toolset:
                found = True
                console.print(Panel(f"[bold cyan]Toolset: {name}[/bold cyan]"))
                console.print(f"[bold]Description:[/bold] {toolset.description}")
                console.print(f"[bold]Categories:[/bold] {', '.join(toolset.categories)}")

                # Show resolved tools
                tools = agent_reg.resolve_tools(name)
                console.print(f"\n[bold]Resolved Tools ({len(tools)}):[/bold]")
                for tool in sorted(tools):
                    console.print(f"  - {tool}")

        if not found:
            console.print(f"[yellow]No item found with name '{name}'[/yellow]")
            sys.exit(1)

    except ImportError as e:
        console.print(f"[red]Registries not available: {e}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)


@registry.command("test-routing")
@click.argument("message")
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show detailed routing information"
)
def test_routing(message: str, verbose: bool):
    """Test routing with a message (without executing).

    Shows which prompt and agent would be matched for a given message.

    Examples:
        hester registry test-routing "What tables exist in the database?"
        hester registry test-routing "Fix the authentication bug" -v
        hester registry test-routing "How does the matching algorithm work?"
    """
    async def _test_routing():
        try:
            from hester.daemon.registries import get_prompt_registry, get_agent_registry
            from hester.daemon.semantic.embeddings import EmbeddingService
            from hester.daemon.settings import get_settings

            # Initialize embedding service
            settings = get_settings()
            embedding_service = EmbeddingService(
                api_key=settings.google_api_key,
                redis_client=None,  # No caching for test
            )

            prompt_reg = get_prompt_registry()
            agent_reg = get_agent_registry()

            console.print(f"[bold]Testing routing for:[/bold] {message}\n")

            # Test agent matching
            console.print("[cyan]Agent Matching:[/cyan]")
            agent_match = await agent_reg.match(message, embedding_service)
            if agent_match:
                agent = agent_reg.get_agent(agent_match.agent_id)
                console.print(f"  [green]✓ Matched:[/green] {agent_match.agent_id}")
                console.print(f"  [dim]Confidence: {agent_match.confidence:.3f}[/dim]")
                if agent:
                    console.print(f"  [dim]Toolset: {agent.toolset}[/dim]")
                    console.print(f"  [dim]Prompt: {agent.prompt}[/dim]")
            else:
                console.print(f"  [yellow]No agent match (below threshold)[/yellow]")

            # Test prompt matching
            console.print("\n[cyan]Prompt Matching:[/cyan]")
            prompt_match = await prompt_reg.match(message, embedding_service)
            console.print(f"  [green]✓ Matched:[/green] {prompt_match.prompt_id}")
            console.print(f"  [dim]Score: {prompt_match.score:.3f}[/dim]")

            if verbose:
                # Show all similarity scores
                console.print("\n[cyan]All Prompt Scores:[/cyan]")
                msg_embedding = await embedding_service.embed(message)

                # Ensure embeddings are initialized
                await prompt_reg.initialize_embeddings(embedding_service)

                for prompt_id, embedding in prompt_reg._embeddings.items():
                    score = embedding_service.cosine_similarity(msg_embedding, embedding)
                    indicator = "→" if prompt_id == prompt_match.prompt_id else " "
                    console.print(f"  {indicator} {prompt_id}: {score:.3f}")

        except ImportError as e:
            console.print(f"[red]Required modules not available: {e}[/red]")
            sys.exit(1)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            import traceback
            if verbose:
                traceback.print_exc()
            sys.exit(1)

    asyncio.run(_test_routing())


@registry.command("categories")
def list_categories():
    """List all tool categories and their tools.

    Examples:
        hester registry categories
    """
    try:
        from hester.daemon.tools.definitions import TOOL_CATEGORIES

        table = Table(title="Tool Categories")
        table.add_column("Category", style="cyan", no_wrap=True)
        table.add_column("Tool Count", style="green")
        table.add_column("Tools", style="dim")

        for category, tools in sorted(TOOL_CATEGORIES.items()):
            tools_preview = ", ".join(tools[:4])
            if len(tools) > 4:
                tools_preview += f" (+{len(tools) - 4})"

            table.add_row(category, str(len(tools)), tools_preview)

        console.print(table)

        # Total unique tools
        all_tools = set()
        for tools in TOOL_CATEGORIES.values():
            all_tools.update(tools)
        console.print(f"\n[dim]Total: {len(TOOL_CATEGORIES)} categories, {len(all_tools)} unique tools[/dim]")

    except ImportError as e:
        console.print(f"[red]Tool definitions not available: {e}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
