"""
Hester CLI - Agent command for headless automated queries.

Usage:
    hester agent code_explorer "Find all usages of EncryptionService"
    hester agent web_researcher "Best practices for pgvector indexes"
    hester agent db_explorer "What vector columns exist in profiles?"
    hester agent test_runner --test-path services/api/tests/
"""

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

import click
from rich.console import Console

console = Console()

AGENT_TYPES = ["code_explorer", "web_researcher", "docs_manager", "db_explorer", "test_runner", "route"]


@click.command("agent")
@click.argument("agent_type", type=click.Choice(AGENT_TYPES), required=True)
@click.argument("prompt", required=False)
@click.option(
    "--context", "-c",
    default=None,
    help="Path to context bundle file to include"
)
@click.option(
    "--plan", "-p",
    default=None,
    help="Path to plan file (markdown with structured prompt)"
)
@click.option(
    "--toolset", "-t",
    type=click.Choice(["observe", "research", "develop", "full"]),
    default="observe",
    help="Tool scope level for code_explorer (default: observe)"
)
@click.option(
    "--tools",
    default=None,
    help="Comma-separated list of specific tools (overrides --toolset)"
)
@click.option(
    "--output", "-o",
    type=click.Choice(["text", "json", "markdown"]),
    default="text",
    help="Output format (default: text)"
)
@click.option(
    "--max-steps", "-m",
    default=10,
    help="Maximum ReAct iterations (default: 10)"
)
@click.option(
    "--quiet", "-q",
    is_flag=True,
    help="Suppress progress output, only print final result"
)
@click.option(
    "--dir", "-d",
    "working_dir",
    default=None,
    help="Working directory (default: current directory)"
)
# test_runner specific options
@click.option(
    "--test-path",
    default=None,
    help="[test_runner] Path to tests (file or directory)"
)
@click.option(
    "--framework", "-f",
    type=click.Choice(["auto", "pytest", "flutter", "jest"]),
    default="auto",
    help="[test_runner] Test framework (default: auto-detect)"
)
@click.option(
    "--test-args",
    default=None,
    help="[test_runner] Additional test arguments (e.g., '-v --tb=short')"
)
def agent(
    agent_type: str,
    prompt: Optional[str],
    context: Optional[str],
    plan: Optional[str],
    toolset: str,
    tools: Optional[str],
    output: str,
    max_steps: int,
    quiet: bool,
    working_dir: Optional[str],
    test_path: Optional[str],
    framework: str,
    test_args: Optional[str],
):
    """Run a headless agent for automated queries.

    AGENT_TYPE is the type of agent to run:

    \b
      code_explorer  - Search and analyze codebase files
      web_researcher - Research topics using Google Search
      docs_manager   - Documentation search, drift check, write/update
      db_explorer    - Natural language database exploration
      test_runner    - Run test suites (pytest, flutter, jest)
      route          - Get routing recommendations (for orchestration)

    PROMPT is the query or task for the agent.

    Examples:

    \b
        # Explore codebase for patterns
        hester agent code_explorer "Find all usages of EncryptionService"

        # Research with web search
        hester agent web_researcher "Best practices for pgvector indexes"

        # Search documentation
        hester agent docs_manager "How does authentication work?"

        # Explore database schema
        hester agent db_explorer "What vector columns exist in profiles?"

        # Run tests
        hester agent test_runner --path services/api/tests/

        # Get routing recommendations
        hester agent route "How does matching work?"

        # Use context bundle
        hester agent code_explorer "Explain this service" -c .hester/contexts/api.md

        # Use a plan file instead of inline prompt
        hester agent code_explorer --plan .hester/plans/research.md

        # JSON output for programmatic use
        hester agent code_explorer "What does auth.py do?" -o json -q

        # Expanded toolset for code_explorer
        hester agent code_explorer "Check database schema" -t research
    """
    # Check for required API key
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        if not quiet:
            console.print("[red]Error: GOOGLE_API_KEY environment variable is required.[/red]")
        sys.exit(1)

    # Load prompt from plan file if provided
    if plan:
        plan_path = Path(plan)
        if plan_path.exists():
            prompt = plan_path.read_text().strip()
            if not quiet:
                console.print(f"[dim]Loaded plan from: {plan}[/dim]")
        else:
            console.print(f"[red]Error: Plan file not found: {plan}[/red]")
            sys.exit(1)

    # Get prompt from stdin if not provided
    if not prompt:
        if not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        else:
            console.print("[red]Error: Prompt is required. Provide as argument, --plan file, or pipe via stdin.[/red]")
            console.print()
            console.print("Usage:")
            console.print(f'  hester agent {agent_type} "Your query here"')
            console.print(f'  hester agent {agent_type} --plan plan.md')
            console.print(f'  echo "Your query" | hester agent {agent_type}')
            sys.exit(1)

    if not prompt:
        console.print("[red]Error: Empty prompt provided.[/red]")
        sys.exit(1)

    working_dir = working_dir or os.getcwd()

    # Load context bundle if provided
    context_content = None
    if context:
        context_path = Path(context)
        if context_path.exists():
            context_content = context_path.read_text()
            if not quiet:
                console.print(f"[dim]Loaded context from: {context}[/dim]")
        else:
            console.print(f"[yellow]Warning: Context file not found: {context}[/yellow]")

    try:
        if agent_type == "code_explorer":
            result = _run_code_explorer(
                prompt=prompt,
                context=context_content,
                toolset=toolset,
                tools=tools,
                max_steps=max_steps,
                quiet=quiet,
                working_dir=working_dir,
            )
        elif agent_type == "web_researcher":
            result = _run_web_researcher(
                prompt=prompt,
                context=context_content,
                quiet=quiet,
            )
        elif agent_type == "docs_manager":
            result = _run_docs_manager(
                prompt=prompt,
                quiet=quiet,
                working_dir=working_dir,
            )
        elif agent_type == "db_explorer":
            result = _run_db_explorer(
                prompt=prompt,
                context=context_content,
                quiet=quiet,
            )
        elif agent_type == "test_runner":
            result = _run_test_runner(
                test_path=test_path,
                framework=framework,
                test_args=test_args,
                quiet=quiet,
                working_dir=working_dir,
            )
        elif agent_type == "route":
            result = _run_route(
                prompt=prompt,
                quiet=quiet,
                working_dir=working_dir,
            )
        else:
            console.print(f"[red]Error: Unknown agent type: {agent_type}[/red]")
            sys.exit(1)

        # Output result based on format
        _output_result(result, output, quiet)

        # Exit with appropriate code
        sys.exit(0 if result.get("success", True) else 1)

    except KeyboardInterrupt:
        if not quiet:
            console.print("\n[dim]Agent interrupted.[/dim]")
        sys.exit(130)
    except Exception as e:
        if not quiet:
            console.print(f"\n[red]Error: {e}[/red]")
        if output == "json":
            import json as json_module
            console.print(json_module.dumps({"success": False, "error": str(e)}))
        sys.exit(1)


def _run_code_explorer(
    prompt: str,
    context: Optional[str],
    toolset: str,
    tools: Optional[str],
    max_steps: int,
    quiet: bool,
    working_dir: str,
) -> dict:
    """Run the code explorer agent."""
    from hester.daemon.tasks.code_explorer_delegate import CodeExplorerDelegate

    # Parse explicit tools if provided
    scoped_tools = None
    if tools:
        scoped_tools = [t.strip() for t in tools.split(",") if t.strip()]

    if not quiet:
        console.print(f"[bold green]Code Explorer[/bold green]")
        console.print(f"[dim]Toolset: {toolset}[/dim]")
        if scoped_tools:
            console.print(f"[dim]Tools: {', '.join(scoped_tools)}[/dim]")
        console.print(f"[dim]Working directory: {working_dir}[/dim]")
        console.print()

    delegate = CodeExplorerDelegate(
        working_dir=Path(working_dir),
        toolset=toolset,
        scoped_tools=scoped_tools,
        max_steps=max_steps,
        quiet=quiet,
    )

    return asyncio.run(delegate.execute(prompt=prompt, context=context))


def _run_web_researcher(
    prompt: str,
    context: Optional[str],
    quiet: bool,
) -> dict:
    """Run the web researcher agent."""
    from hester.daemon.tasks.web_researcher_delegate import WebResearcherDelegate

    if not quiet:
        console.print(f"[bold blue]Web Researcher[/bold blue]")
        console.print()

    delegate = WebResearcherDelegate()

    return asyncio.run(delegate.execute(prompt=prompt, context=context))


def _run_docs_manager(
    prompt: str,
    quiet: bool,
    working_dir: str,
) -> dict:
    """Run the docs manager agent for documentation search."""
    from hester.daemon.tasks.docs_manager_delegate import DocsManagerDelegate, DocsAction

    if not quiet:
        console.print(f"[bold blue]Docs Manager[/bold blue]")
        console.print()

    delegate = DocsManagerDelegate(working_dir=Path(working_dir))

    # Default to search action with the prompt as query
    result = asyncio.run(delegate.execute(
        action=DocsAction.SEARCH,
        query=prompt,
    ))

    # Format result for output
    if result.get("success"):
        if result.get("results"):
            # Build response from search results
            lines = [f"Found {result.get('count', 0)} relevant documentation sections:\n"]
            for r in result.get("results", []):
                lines.append(f"**{r.get('path', 'Unknown')}** (relevance: {r.get('relevance', 0):.2f})")
                if r.get("excerpt"):
                    lines.append(f"> {r['excerpt'][:200]}...")
                if r.get("reason"):
                    lines.append(f"*{r['reason']}*")
                lines.append("")
            result["response"] = "\n".join(lines)
        else:
            result["response"] = "No matching documentation found. The docs index may be empty - try running `hester docs index --all` first."
    else:
        result["response"] = f"Search failed: {result.get('error', 'Unknown error')}"

    return result


def _run_db_explorer(
    prompt: str,
    context: Optional[str],
    quiet: bool,
) -> dict:
    """Run the database explorer agent."""
    from hester.daemon.tasks.db_explorer_delegate import DbExplorerDelegate

    if not quiet:
        console.print(f"[bold blue]Database Explorer[/bold blue]")
        console.print()

    delegate = DbExplorerDelegate()

    return asyncio.run(delegate.execute(prompt=prompt, context=context or ""))


def _run_test_runner(
    test_path: Optional[str],
    framework: str,
    test_args: Optional[str],
    quiet: bool,
    working_dir: str,
) -> dict:
    """Run the test runner agent."""
    from hester.daemon.tasks.test_runner_delegate import TestRunnerDelegate, TestFramework

    if not quiet:
        console.print(f"[bold blue]Test Runner[/bold blue]")
        console.print()

    delegate = TestRunnerDelegate(working_dir=Path(working_dir))

    # Use test_path or default to working directory
    path = test_path or "."

    # Parse framework
    try:
        fw = TestFramework(framework)
    except ValueError:
        fw = TestFramework.AUTO

    # Parse test args
    args = test_args.split() if test_args else []

    # Execute tests
    result = asyncio.run(delegate.execute(path=path, framework=fw, args=args))

    # Convert TestSuiteResult to dict with response for _output_result
    result_dict = result.to_dict()

    # Build a nice response summary
    if result.passed + result.failed + result.skipped > 0:
        summary_lines = [
            f"**{result.framework}** test results:",
            f"  Passed: {result.passed}",
            f"  Failed: {result.failed}",
            f"  Skipped: {result.skipped}",
            f"  Duration: {result.duration:.2f}s",
        ]
        if result.failed > 0:
            summary_lines.append("\n**Failed tests:**")
            for test in result.tests:
                if test.status == "failed":
                    summary_lines.append(f"  - {test.name}")
                    if test.message:
                        summary_lines.append(f"    {test.message[:200]}")
        result_dict["response"] = "\n".join(summary_lines)
    else:
        result_dict["response"] = f"No tests found at path: {path}"

    return result_dict


def _run_route(
    prompt: str,
    quiet: bool,
    working_dir: str,
) -> dict:
    """Run the prepare step and return routing recommendations.

    This uses the existing prepare_request() infrastructure to determine
    which agents and tools are most relevant for a given query.
    """
    from hester.daemon.prepare import prepare_request
    from hester.daemon.semantic.embeddings import EmbeddingService
    from hester.daemon.semantic import SemanticRouter

    if not quiet:
        console.print("[bold cyan]Routing[/bold cyan]")
        console.print(f"[dim]Working directory: {working_dir}[/dim]")
        console.print()

    # Initialize services for semantic routing
    embedding_service = EmbeddingService()
    semantic_router = SemanticRouter(embedding_service)

    # Call existing prepare_request() - this does ALL the routing work:
    # - Bespoke agent/prompt routing via embeddings
    # - Tool pre-filtering via SemanticRouter
    # - FunctionGemma classification for depth/tools
    prepare_result = asyncio.run(prepare_request(
        message=prompt,
        embedding_service=embedding_service,
        semantic_router=semantic_router,
        use_bespoke_routing=True,
    ))

    # Generate command recommendations based on routing results
    commands = _generate_commands_from_prepare(prepare_result, prompt)

    # Build response summary
    response_lines = [
        f"**Routing**: {prepare_result.routing_reason}",
        f"**Depth**: {prepare_result.thinking_depth.name}",
        f"**Confidence**: {prepare_result.confidence:.2f}",
        "",
        "**Recommended commands:**",
    ]
    for cmd in commands:
        response_lines.append(f"  - `hester agent {cmd['agent']} \"{cmd['prompt'][:50]}...\"` ({cmd['relevance']})")
        response_lines.append(f"    {cmd['why']}")

    return {
        "success": True,
        "routing": {
            "prompt_id": prepare_result.prompt_id,
            "agent_id": prepare_result.agent_id,
            "toolset_id": prepare_result.toolset_id,
            "thinking_depth": prepare_result.thinking_depth.name,
            "relevant_tools": prepare_result.relevant_tools,
            "routing_reason": prepare_result.routing_reason,
            "confidence": prepare_result.confidence,
            "prepare_time_ms": prepare_result.prepare_time_ms,
        },
        "commands": commands,
        "response": "\n".join(response_lines),
    }


def _generate_commands_from_prepare(prepare, message: str) -> list:
    """Generate recommended agent commands from PrepareResult."""
    commands = []

    # Primary: matched agent or code_explorer fallback
    agent = prepare.agent_id or "code_explorer"
    toolset = prepare.toolset_id or "observe"

    commands.append({
        "agent": agent,
        "prompt": message,
        "toolset": toolset,
        "relevance": "high",
        "why": f"Primary match: {prepare.routing_reason}",
    })

    # Add complementary agents based on tools
    relevant_tools = prepare.relevant_tools or []

    if any(t.startswith("db_") for t in relevant_tools) and agent != "db_explorer":
        commands.append({
            "agent": "db_explorer",
            "prompt": f"Describe relevant database schema for: {message}",
            "relevance": "high" if prepare.prompt_id in ("database", "data_analysis") else "medium",
            "why": "Database tools detected in routing",
        })

    if "semantic_doc_search" in relevant_tools and agent != "docs_manager":
        commands.append({
            "agent": "docs_manager",
            "prompt": message,
            "relevance": "medium",
            "why": "Documentation search tool detected",
        })

    if "web_search" in relevant_tools and agent != "web_researcher":
        commands.append({
            "agent": "web_researcher",
            "prompt": message,
            "relevance": "medium",
            "why": "Web search tool detected",
        })

    return commands


def _output_result(result: dict, output: str, quiet: bool) -> None:
    """Output the agent result in the specified format."""
    if output == "json":
        import json as json_module
        console.print(json_module.dumps(result, indent=2))
    elif output == "markdown":
        # Handle different result formats
        response = result.get("response") or result.get("answer", "")
        console.print(f"# Agent Result\n\n{response}")
        if result.get("findings"):
            console.print("\n## Findings\n")
            for finding in result["findings"]:
                console.print(f"- {finding}")
        if result.get("sources"):
            console.print("\n## Sources\n")
            for src in result["sources"]:
                title = src.get("title", "Link")
                uri = src.get("uri", "")
                if uri:
                    console.print(f"- [{title}]({uri})")
    else:
        # Text output
        response = result.get("response") or result.get("answer", "No response generated")
        if not quiet:
            console.print("\n[bold]Response:[/bold]")
        console.print(response)
        # Show sources for web researcher
        if result.get("sources") and not quiet:
            console.print("\n[dim]Sources:[/dim]")
            for src in result["sources"][:5]:
                title = src.get("title", "Link")
                uri = src.get("uri", "")
                if uri:
                    console.print(f"  [dim]- {title}: {uri}[/dim]")
