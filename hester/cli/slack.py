"""
Hester CLI - Slack bot commands.

Usage:
    hester slack start
    hester slack status
"""

import os
import sys

import click
from rich.console import Console

console = Console()


@click.group()
def slack():
    """Slack bot commands (HesterSlack)."""
    pass


@slack.command("start")
@click.option(
    "--port", "-p",
    default=3000,
    help="Port for health check endpoint (default: 3000)"
)
def slack_start(port: int):
    """Start the Slack bot with Socket Mode.

    Connects to Slack using Socket Mode for real-time messaging.
    Requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.

    Examples:
        hester slack start
        hester slack start --port 3000
    """
    # Check for required tokens
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    app_token = os.environ.get("SLACK_APP_TOKEN")

    if not bot_token:
        console.print("[red]Error: SLACK_BOT_TOKEN environment variable required[/red]")
        sys.exit(1)
    if not app_token:
        console.print("[red]Error: SLACK_APP_TOKEN environment variable required[/red]")
        sys.exit(1)

    console.print("[bold cyan]Starting Hester Slack Bot[/bold cyan]")
    console.print(f"[dim]Socket Mode: enabled[/dim]")
    console.print(f"[dim]Health port: {port}[/dim]")
    console.print()

    try:
        from hester.slack.app import run
        run()
    except KeyboardInterrupt:
        console.print("\n[yellow]Slack bot stopped.[/yellow]")
    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@slack.command("status")
def slack_status():
    """Check Slack bot connection status.

    Verifies the Slack bot can connect with the configured tokens.
    """
    from slack_sdk import WebClient
    from slack_sdk.errors import SlackApiError

    bot_token = os.environ.get("SLACK_BOT_TOKEN")

    if not bot_token:
        console.print("[red]Error: SLACK_BOT_TOKEN not configured[/red]")
        sys.exit(1)

    console.print("[cyan]Checking Slack connection...[/cyan]")

    try:
        client = WebClient(token=bot_token)
        response = client.auth_test()

        if response.get("ok"):
            console.print("[green]Slack connection successful![/green]")
            console.print(f"[dim]Bot: {response.get('user')}[/dim]")
            console.print(f"[dim]Team: {response.get('team')}[/dim]")
            console.print(f"[dim]URL: {response.get('url')}[/dim]")
        else:
            console.print("[red]Connection failed[/red]")
            sys.exit(1)

    except SlackApiError as e:
        console.print(f"[red]Slack API error: {e.response['error']}[/red]")
        sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)
