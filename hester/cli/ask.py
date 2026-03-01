"""
Hester CLI - Ask commands using Gemini with web search.

Usage:
    hester ask gemini "What is the current Bitcoin price?"
    hester ask gemini "Explain photosynthesis" --no-search
"""

import asyncio
import os
import sys

import click
from rich.console import Console

console = Console()


@click.group()
def ask():
    """Ask questions using Gemini with web search."""
    pass


@ask.command("gemini")
@click.argument("question", nargs=-1, required=True)
@click.option(
    "--model", "-m",
    default="gemini-2.5-flash",
    help="Gemini model to use (default: gemini-2.5-flash)"
)
@click.option(
    "--no-search",
    is_flag=True,
    help="Disable Google Search grounding"
)
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show sources and detailed output"
)
def ask_gemini(question: tuple, model: str, no_search: bool, verbose: bool):
    """Ask Gemini a question with Google Search grounding.

    Uses Gemini with real-time Google Search for up-to-date information.
    Includes source citations in the response.

    Examples:
        hester ask gemini "Who won the Super Bowl?"
        hester ask gemini "Current Bitcoin price"
        hester ask gemini "Explain photosynthesis" --no-search
        hester ask gemini "Latest AI news" --verbose
    """
    question_text = " ".join(question)

    if not question_text:
        console.print("[red]Error: Please provide a question[/red]")
        sys.exit(1)

    # Check for API key
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        console.print("[red]Error: GOOGLE_API_KEY environment variable is required.[/red]")
        sys.exit(1)

    try:
        asyncio.run(_run_ask_gemini(question_text, model, not no_search, verbose))
    except KeyboardInterrupt:
        console.print("\n[dim]Interrupted.[/dim]")
    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        if verbose:
            import traceback
            console.print(traceback.format_exc())
        sys.exit(1)


async def _run_ask_gemini(question: str, model: str, use_search: bool, verbose: bool):
    """Run ask gemini with optional grounded search."""
    from google import genai
    from google.genai import types

    client = genai.Client()

    # Show question
    console.print(f"[cyan bold]You:[/cyan bold] {question}")
    console.print()
    console.print("[magenta bold]Gemini:[/magenta bold] ", end="")

    try:
        # Configure with or without grounding
        config = None
        if use_search:
            grounding_tool = types.Tool(google_search=types.GoogleSearch())
            config = types.GenerateContentConfig(tools=[grounding_tool])

        response = client.models.generate_content(
            model=model,
            contents=question,
            config=config,
        )

        # Print response
        if response.text:
            console.print(response.text)
        else:
            console.print("[dim]No response generated.[/dim]")

        # Extract and show sources if verbose
        if use_search and verbose:
            sources = []
            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'grounding_metadata') and candidate.grounding_metadata:
                    metadata = candidate.grounding_metadata

                    # Show search queries used
                    if hasattr(metadata, 'web_search_queries') and metadata.web_search_queries:
                        console.print("\n[dim]Search queries:[/dim]")
                        for q in metadata.web_search_queries:
                            console.print(f"  [dim]• {q}[/dim]")

                    # Show sources
                    if hasattr(metadata, 'grounding_chunks') and metadata.grounding_chunks:
                        console.print("\n[dim]Sources:[/dim]")
                        for chunk in metadata.grounding_chunks[:10]:
                            if hasattr(chunk, 'web') and chunk.web:
                                title = getattr(chunk.web, 'title', 'Untitled')
                                uri = getattr(chunk.web, 'uri', '')
                                if uri:
                                    console.print(f"  [dim]• {title}[/dim]")
                                    console.print(f"    [blue dim]{uri}[/blue dim]")

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise
