"""
Output formatting for Hester surfaces (CLI, Slack, etc.)

Phase 1: CLI output only
Phase 2: Slack notifications
"""

from __future__ import annotations

from typing import Optional, TYPE_CHECKING

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

# Lazy imports to avoid pulling in heavy dependencies (mcp, etc.) in Slack environment
if TYPE_CHECKING:
    from hester.qa.models import HesterQAResult
    from hester.docs.models import DocClaim, DriftReport, DocSearchResult, DocsCheckResult

console = Console()


def format_qa_result(result: HesterQAResult, verbose: bool = False) -> None:
    """
    Format and print QA result for CLI output.

    Args:
        result: The QA test result
        verbose: Whether to show transcript details
    """
    # Status indicator
    if result.passed:
        status = Text("PASS", style="bold green")
        border_style = "green"
    else:
        status = Text("FAIL", style="bold red")
        border_style = "red"

    # Build summary table
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Field", style="dim", width=15)
    table.add_column("Value")

    table.add_row("Scene", result.scene_slug)
    table.add_row("Persona", result.persona_name)
    table.add_row("Status", status)
    table.add_row("Turns", str(result.turn_count))
    table.add_row(
        "Stages",
        ", ".join(result.stages_completed) if result.stages_completed else "none"
    )
    table.add_row(
        "Components",
        ", ".join(result.components_rendered[:5]) if result.components_rendered else "none"
    )

    if result.error_message:
        table.add_row("Error", Text(result.error_message, style="red"))

    if result.duration_ms:
        duration_sec = result.duration_ms / 1000
        table.add_row("Duration", f"{duration_sec:.2f}s")

    if result.evaluation and result.evaluation.semantic_verification:
        table.add_row("Verification", result.evaluation.semantic_verification[:60])

    # Create panel
    title = f"HesterQA: {result.scene_slug}"
    panel = Panel(table, title=title, border_style=border_style)
    console.print(panel)

    # Verbose mode: show transcript
    if verbose and result.transcript:
        console.print()
        console.print("[dim]Transcript:[/dim]")

        for i, turn in enumerate(result.transcript):
            turn_type = turn.get("turn_type", "unknown")
            data = turn.get("data", {})

            if turn_type == "user":
                message = data.get("message", "")
                console.print(f"  [blue]User:[/blue] {message[:100]}")

            elif turn_type == "assistant":
                perception = data.get("perception", {})
                if perception:
                    title = perception.get("title", "")
                    desc = perception.get("description", "")[:80]
                    console.print(f"  [green]Sybil:[/green] {title or desc}")

            elif turn_type == "system":
                event = data.get("event", "")
                if event:
                    console.print(f"  [yellow]System:[/yellow] {event}")

            # Limit transcript display
            if i >= 10 and not verbose:
                remaining = len(result.transcript) - i - 1
                if remaining > 0:
                    console.print(f"  [dim]... {remaining} more turns[/dim]")
                break

    # Screenshots
    if verbose and result.screenshot_urls:
        console.print()
        console.print(f"[dim]Screenshots ({len(result.screenshot_urls)}):[/dim]")
        for path in result.screenshot_urls[:5]:
            console.print(f"  {path}")


def format_qa_summary(results: list[HesterQAResult]) -> None:
    """
    Format summary of multiple QA results.

    Args:
        results: List of QA test results
    """
    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed

    # Header
    if failed == 0:
        header_style = "bold green"
        header = f"All {passed} tests passed"
    else:
        header_style = "bold red"
        header = f"{passed} passed, {failed} failed"

    console.print()
    console.print(f"[{header_style}]{header}[/{header_style}]")
    console.print()

    # Results table
    table = Table(show_header=True)
    table.add_column("Scene", style="cyan")
    table.add_column("Persona")
    table.add_column("Status")
    table.add_column("Turns", justify="right")
    table.add_column("Duration", justify="right")

    for result in results:
        status = Text("PASS", style="green") if result.passed else Text("FAIL", style="red")
        duration = f"{result.duration_ms / 1000:.2f}s" if result.duration_ms else "-"

        table.add_row(
            result.scene_slug,
            result.persona_name,
            status,
            str(result.turn_count),
            duration,
        )

    console.print(table)


def print_scene_list(scenes: list[dict]) -> None:
    """Print list of available scenes."""
    console.print()
    console.print("[bold]Available Scenes:[/bold]")
    console.print()

    table = Table(show_header=True)
    table.add_column("Slug", style="cyan")
    table.add_column("Name")
    table.add_column("Active")

    for scene in scenes:
        active = "Yes" if scene.get("is_active", True) else "No"
        table.add_row(scene["slug"], scene.get("name", ""), active)

    console.print(table)


def print_persona_list(personas: list[str]) -> None:
    """Print list of available personas."""
    from hester.qa.personas import PERSONAS

    console.print()
    console.print("[bold]Available Personas:[/bold]")
    console.print()

    table = Table(show_header=True)
    table.add_column("Name", style="cyan")
    table.add_column("Type")
    table.add_column("Max Turns", justify="right")
    table.add_column("Description")

    for name, persona in PERSONAS.items():
        # Extract first line of system prompt as description
        desc = persona.system_prompt.split("\n")[0][:50]
        table.add_row(
            name,
            persona.persona_type.value,
            str(persona.max_turns),
            desc,
        )

    console.print(table)


# =============================================================================
# HesterDocs output formatting
# =============================================================================


def format_drift_report(report: DriftReport, verbose: bool = False) -> None:
    """
    Format and print a drift report for a single file.

    Args:
        report: The drift report
        verbose: Whether to show all claims
    """
    # Status indicator
    if report.is_healthy:
        status = Text("HEALTHY", style="bold green")
        border_style = "green"
    else:
        status = Text("DRIFTED", style="bold red")
        border_style = "red"

    # Build summary table
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Field", style="dim", width=18)
    table.add_column("Value")

    table.add_row("File", report.file_path)
    table.add_row("Status", status)
    table.add_row("Total Claims", str(report.total_claims))
    table.add_row("Valid Claims", str(report.valid_claims))
    table.add_row("Drift", f"{report.drift_percentage:.1f}%")
    table.add_row("Threshold", f"{report.threshold * 100:.0f}%")

    # Create panel
    panel = Panel(table, title="Drift Report", border_style=border_style)
    console.print(panel)

    # Show drifted claims
    if report.drifted_claims:
        console.print()
        console.print(f"[red]Drifted Claims ({len(report.drifted_claims)}):[/red]")

        for claim in report.drifted_claims:
            console.print(f"  [dim]•[/dim] {claim.claim[:80]}")
            if verbose and claim.reason:
                console.print(f"    [dim]{claim.reason}[/dim]")

    # Show unverifiable claims if verbose
    if verbose and report.unverifiable_claims:
        console.print()
        console.print(f"[yellow]Unverifiable Claims ({len(report.unverifiable_claims)}):[/yellow]")

        for claim in report.unverifiable_claims:
            console.print(f"  [dim]•[/dim] {claim.claim[:80]}")
            if claim.reason:
                console.print(f"    [dim]{claim.reason}[/dim]")


def format_docs_check_result(result: DocsCheckResult, verbose: bool = False) -> None:
    """
    Format and print results from checking multiple docs.

    Args:
        result: The docs check result
        verbose: Whether to show details for each file
    """
    # Header
    if result.drifted_files == 0:
        header_style = "bold green"
        header = f"All {result.healthy_files} files healthy"
    else:
        header_style = "bold red"
        header = f"{result.healthy_files} healthy, {result.drifted_files} drifted"

    console.print()
    console.print(f"[{header_style}]{header}[/{header_style}]")
    console.print()

    if result.error:
        console.print(f"[yellow]Note: {result.error}[/yellow]")
        console.print()

    # Results table
    if result.reports:
        table = Table(show_header=True)
        table.add_column("File", style="cyan")
        table.add_column("Claims", justify="right")
        table.add_column("Valid", justify="right")
        table.add_column("Drift %", justify="right")
        table.add_column("Status")

        for report in result.reports:
            status = Text("OK", style="green") if report.is_healthy else Text("DRIFT", style="red")

            table.add_row(
                report.file_path[:50],
                str(report.total_claims),
                str(report.valid_claims),
                f"{report.drift_percentage:.1f}%",
                status,
            )

        console.print(table)

    # Verbose: show drifted claims per file
    if verbose:
        for report in result.reports:
            if report.drifted_claims:
                console.print()
                console.print(f"[red]{report.file_path}:[/red]")
                for claim in report.drifted_claims:
                    console.print(f"  [dim]•[/dim] {claim.claim[:70]}")


def format_drift_summary(result: DocsCheckResult) -> None:
    """
    Format a summary drift report.

    Args:
        result: The docs check result
    """
    # Summary stats
    console.print("[bold]Documentation Drift Summary[/bold]")
    console.print()

    if result.total_files == 0:
        console.print("[yellow]No documentation files found.[/yellow]")
        return

    # Overall health
    health_pct = (result.healthy_files / result.total_files) * 100 if result.total_files > 0 else 0

    if result.drifted_files == 0:
        console.print(f"[green]All documentation is up to date![/green]")
    else:
        console.print(f"[red]{result.drifted_files} of {result.total_files} files have drifted ({100 - health_pct:.0f}%)[/red]")

    console.print()

    # Stats table
    table = Table(show_header=False, box=None)
    table.add_column("Metric", style="dim", width=20)
    table.add_column("Value")

    table.add_row("Total Files", str(result.total_files))
    table.add_row("Healthy Files", Text(str(result.healthy_files), style="green"))
    table.add_row("Drifted Files", Text(str(result.drifted_files), style="red" if result.drifted_files > 0 else "dim"))
    table.add_row("Checked At", result.checked_at.strftime("%Y-%m-%d %H:%M"))

    console.print(table)

    # List drifted files
    if result.drifted_files > 0:
        console.print()
        console.print("[red]Files needing attention:[/red]")

        for report in result.reports:
            if not report.is_healthy:
                console.print(f"  [dim]•[/dim] {report.file_path} ({report.drift_percentage:.1f}% drift)")


def format_doc_search_results(results: list[DocSearchResult], verbose: bool = False) -> None:
    """
    Format semantic search results.

    Args:
        results: List of search results
        verbose: Whether to show full excerpts
    """
    console.print(f"[bold]Found {len(results)} relevant sections:[/bold]")
    console.print()

    for i, result in enumerate(results, 1):
        relevance_color = "green" if result.relevance > 0.8 else "yellow" if result.relevance > 0.5 else "dim"

        console.print(f"[{relevance_color}]{i}. {result.path}[/{relevance_color}]")
        console.print(f"   [dim]Relevance: {result.relevance:.2f}[/dim]")

        if result.reason:
            console.print(f"   [cyan]{result.reason}[/cyan]")

        if result.excerpt:
            excerpt = result.excerpt if verbose else result.excerpt[:200]
            if len(result.excerpt) > 200 and not verbose:
                excerpt += "..."
            console.print(f"   [dim]{excerpt}[/dim]")

        console.print()


def format_doc_claims(claims: list[DocClaim]) -> None:
    """
    Format extracted claims from a documentation file.

    Args:
        claims: List of extracted claims
    """
    console.print(f"[bold]Found {len(claims)} verifiable claims:[/bold]")
    console.print()

    # Group by type
    by_type: dict[str, list[DocClaim]] = {}
    for claim in claims:
        claim_type = claim.claim_type or "unknown"
        if claim_type not in by_type:
            by_type[claim_type] = []
        by_type[claim_type].append(claim)

    # Display by type
    type_colors = {
        "function": "cyan",
        "api": "green",
        "config": "yellow",
        "flow": "magenta",
        "schema": "blue",
        "unknown": "dim",
    }

    for claim_type, type_claims in by_type.items():
        color = type_colors.get(claim_type, "dim")
        console.print(f"[{color}]{claim_type.upper()} ({len(type_claims)}):[/{color}]")

        for claim in type_claims:
            console.print(f"  [dim]•[/dim] {claim.claim[:80]}")
            if claim.location:
                console.print(f"    [dim]@ {claim.location}[/dim]")
            if claim.references:
                refs = ", ".join(claim.references[:3])
                console.print(f"    [dim]refs: {refs}[/dim]")

        console.print()
