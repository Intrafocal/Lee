"""
Hester CLI - Daily brief commands.

Usage:
    hester brief generate
    hester brief show
    hester brief post
"""

import asyncio
import sys
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def brief():
    """Daily brief commands (HesterBrief)."""
    pass


@brief.command("generate")
@click.option(
    "--date", "-d",
    "target_date",
    default=None,
    help="Date for brief (default: today)"
)
@click.option(
    "--lookback", "-l",
    default=24,
    type=int,
    help="Hours to look back (default: 24)"
)
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show detailed output"
)
def brief_generate(target_date: Optional[str], lookback: int, verbose: bool):
    """Generate a daily development brief.

    Pulls from GitHub, Linear, and Slack to create a summary
    of what happened in the last 24 hours.

    Examples:
        hester brief generate
        hester brief generate --date 2024-01-15
        hester brief generate --lookback 48 --verbose
    """
    from datetime import date
    from hester.brief import BriefAgent

    # Parse date
    if target_date:
        try:
            brief_date = date.fromisoformat(target_date)
        except ValueError:
            console.print(f"[red]Invalid date format: {target_date}[/red]")
            console.print("[dim]Use ISO format: YYYY-MM-DD[/dim]")
            sys.exit(1)
    else:
        brief_date = date.today()

    console.print("[bold cyan]Generating Daily Brief[/bold cyan]")
    console.print(f"[dim]Date: {brief_date}[/dim]")
    console.print(f"[dim]Lookback: {lookback} hours[/dim]")
    console.print()

    try:
        agent = BriefAgent()
        brief_result = asyncio.run(agent.generate(
            brief_date=brief_date,
            lookback_hours=lookback,
        ))

        # Display brief
        console.print("[bold]Big Picture[/bold]")
        console.print(brief_result.big_picture)
        console.print()

        if brief_result.shipped:
            console.print("[bold green]Shipped[/bold green]")
            for item in brief_result.shipped:
                console.print(f"  • {item}")
            console.print()

        if brief_result.in_progress:
            console.print("[bold yellow]In Progress[/bold yellow]")
            for item in brief_result.in_progress:
                console.print(f"  • {item}")
            console.print()

        if brief_result.decisions_made:
            console.print("[bold blue]Decisions Made[/bold blue]")
            for item in brief_result.decisions_made:
                console.print(f"  • {item}")
            console.print()

        if brief_result.questions_for_business:
            console.print("[bold magenta]Questions for Business[/bold magenta]")
            for item in brief_result.questions_for_business:
                console.print(f"  • {item}")
            console.print()

        if verbose and brief_result.sources:
            console.print("[dim]Sources:[/dim]")
            console.print(f"  GitHub: {len(brief_result.sources.github.prs)} PRs, {len(brief_result.sources.github.commits)} commits")
            console.print(f"  Linear: {len(brief_result.sources.linear.issues)} issues")
            console.print(f"  Slack: {len(brief_result.sources.slack.messages)} messages")

        console.print(f"\n[dim]Brief ID: {brief_result.id}[/dim]")
        console.print(f"[dim]Generated in {brief_result.generation_duration_ms}ms[/dim]")

        # Cleanup
        asyncio.run(agent.close())

    except Exception as e:
        console.print(f"[red]Error generating brief: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@brief.command("show")
@click.option(
    "--date", "-d",
    "target_date",
    default="today",
    help="Date to show (today, yesterday, or YYYY-MM-DD)"
)
def brief_show(target_date: str):
    """Show a stored brief.

    Examples:
        hester brief show
        hester brief show --date yesterday
        hester brief show --date 2024-01-15
    """
    from hester.brief import BriefAgent

    console.print(f"[cyan]Loading brief for: {target_date}[/cyan]")
    console.print()

    try:
        agent = BriefAgent()
        brief_result = agent.get(target_date)

        if not brief_result:
            console.print(f"[yellow]No brief found for {target_date}[/yellow]")
            console.print("[dim]Generate one with: hester brief generate[/dim]")
            return

        console.print(f"[bold]Daily Brief - {brief_result.brief_date}[/bold]")
        console.print()
        console.print(brief_result.big_picture)

        if brief_result.posted_to_slack:
            console.print()
            console.print(f"[dim]Posted to Slack: {brief_result.slack_channel}[/dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@brief.command("post")
@click.option(
    "--date", "-d",
    "target_date",
    default="today",
    help="Date of brief to post (default: today)"
)
@click.option(
    "--channel", "-c",
    default=None,
    help="Slack channel (default: from settings)"
)
def brief_post(target_date: str, channel: Optional[str]):
    """Post a brief to Slack.

    Requires the brief to already be generated.

    Examples:
        hester brief post
        hester brief post --date yesterday
        hester brief post --channel "#daily-brief"
    """
    console.print("[cyan]Posting brief to Slack...[/cyan]")

    try:
        from hester.slack.handlers.brief import post_brief_to_slack
        from hester.brief import BriefAgent

        agent = BriefAgent()
        brief_result = agent.get(target_date)

        if not brief_result:
            console.print(f"[yellow]No brief found for {target_date}[/yellow]")
            console.print("[dim]Generate one first: hester brief generate[/dim]")
            sys.exit(1)

        result = asyncio.run(post_brief_to_slack(brief_result, channel=channel))

        if result.get("ok"):
            console.print("[green]Brief posted to Slack![/green]")
            console.print(f"[dim]Channel: {result.get('channel')}[/dim]")
        else:
            console.print(f"[red]Failed to post: {result.get('error')}[/red]")
            sys.exit(1)

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)
