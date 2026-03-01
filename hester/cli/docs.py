"""
Hester CLI - Documentation validation and search commands (HesterDocs).

Usage:
    hester docs check README.md
    hester docs query "How does authentication work?"
    hester docs index --all
"""

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

import click
from rich.console import Console

console = Console()


@click.group()
def docs():
    """Documentation validation and search commands (HesterDocs)."""
    pass


@docs.command("check")
@click.argument("doc_path", required=False)
@click.option(
    "--all", "-a",
    "check_all",
    is_flag=True,
    help="Check all documentation files"
)
@click.option(
    "--threshold", "-t",
    default=0.7,
    type=float,
    help="Confidence threshold for valid claims (default: 0.7)"
)
@click.option(
    "--output", "-o",
    type=click.Path(),
    help="Output file for report (JSON)"
)
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show detailed claim information"
)
def check_docs(
    doc_path: Optional[str],
    check_all: bool,
    threshold: float,
    output: Optional[str],
    verbose: bool,
):
    """Validate documentation against code.

    Checks documentation files for drift - claims that no longer
    match the actual code implementation.

    Examples:
        hester docs check README.md
        hester docs check --all
        hester docs check docs/api.md --threshold 0.8 --verbose
    """
    from hester.docs import HesterDocsAgent
    from hester.shared.surfaces import format_drift_report, format_docs_check_result

    if not doc_path and not check_all:
        console.print("[red]Error: Specify a doc path or use --all[/red]")
        console.print("  hester docs check README.md")
        console.print("  hester docs check --all")
        sys.exit(1)

    working_dir = os.getcwd()
    agent = HesterDocsAgent(working_dir=working_dir)

    console.print("[bold]HesterDocs[/bold] - Documentation Validator")
    console.print(f"[dim]Working directory: {working_dir}[/dim]")
    console.print(f"[dim]Threshold: {threshold}[/dim]")
    console.print()

    try:
        if check_all:
            console.print("[cyan]Checking all documentation files...[/cyan]")
            result = asyncio.run(agent.check_all(threshold=threshold))
            format_docs_check_result(result, verbose=verbose)

            if output:
                import json
                with open(output, "w") as f:
                    json.dump({
                        "success": result.success,
                        "total_files": result.total_files,
                        "healthy_files": result.healthy_files,
                        "drifted_files": result.drifted_files,
                        "reports": [
                            {
                                "file": r.file_path,
                                "total_claims": r.total_claims,
                                "valid_claims": r.valid_claims,
                                "drift_percentage": r.drift_percentage,
                                "is_healthy": r.is_healthy,
                            }
                            for r in result.reports
                        ]
                    }, f, indent=2)
                console.print(f"\n[dim]Report saved to: {output}[/dim]")

            sys.exit(0 if result.drifted_files == 0 else 1)

        else:
            console.print(f"[cyan]Checking: {doc_path}[/cyan]")
            report = asyncio.run(agent.check_file(doc_path, threshold=threshold))
            format_drift_report(report, verbose=verbose)

            if output:
                import json
                with open(output, "w") as f:
                    json.dump({
                        "file": report.file_path,
                        "total_claims": report.total_claims,
                        "valid_claims": report.valid_claims,
                        "drift_percentage": report.drift_percentage,
                        "is_healthy": report.is_healthy,
                        "drifted_claims": [
                            {
                                "claim": c.claim,
                                "type": c.claim_type,
                                "reason": c.reason,
                            }
                            for c in report.drifted_claims
                        ]
                    }, f, indent=2)
                console.print(f"\n[dim]Report saved to: {output}[/dim]")

            sys.exit(0 if report.is_healthy else 1)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        if verbose:
            import traceback
            console.print(traceback.format_exc())
        sys.exit(1)


@docs.command("query")
@click.argument("question")
@click.option(
    "--limit", "-l",
    default=5,
    type=int,
    help="Maximum results to return (default: 5)"
)
@click.option(
    "--verbose", "-v",
    is_flag=True,
    help="Show full excerpts"
)
def query_docs(question: str, limit: int, verbose: bool):
    """Semantic search over documentation.

    Ask natural language questions about the codebase documentation.

    Examples:
        hester docs query "How does authentication work?"
        hester docs query "What is the matching algorithm?" --limit 10
    """
    from hester.docs import HesterDocsAgent
    from hester.shared.surfaces import format_doc_search_results

    working_dir = os.getcwd()
    agent = HesterDocsAgent(working_dir=working_dir)

    console.print("[bold]HesterDocs[/bold] - Documentation Search")
    console.print(f"[dim]Query: {question}[/dim]")
    console.print()

    try:
        results = asyncio.run(agent.search(query=question, limit=limit))

        if not results:
            console.print("[yellow]No relevant documentation found.[/yellow]")
            sys.exit(0)

        format_doc_search_results(results, verbose=verbose)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        if verbose:
            import traceback
            console.print(traceback.format_exc())
        sys.exit(1)


@docs.command("drift")
@click.option(
    "--output", "-o",
    type=click.Path(),
    help="Output file for drift report"
)
@click.option(
    "--threshold", "-t",
    default=0.7,
    type=float,
    help="Confidence threshold (default: 0.7)"
)
def docs_drift(output: Optional[str], threshold: float):
    """Generate a drift report for all documentation.

    Scans all documentation and reports which files have drifted
    from the actual code implementation.

    Examples:
        hester docs drift
        hester docs drift --output drift-report.json
    """
    from hester.docs import HesterDocsAgent
    from hester.shared.surfaces import format_drift_summary

    working_dir = os.getcwd()
    agent = HesterDocsAgent(working_dir=working_dir)

    console.print("[bold]HesterDocs[/bold] - Drift Report")
    console.print(f"[dim]Scanning documentation in: {working_dir}[/dim]")
    console.print()

    try:
        result = asyncio.run(agent.check_all(threshold=threshold))
        format_drift_summary(result)

        if output:
            import json
            with open(output, "w") as f:
                json.dump({
                    "checked_at": result.checked_at.isoformat(),
                    "total_files": result.total_files,
                    "healthy_files": result.healthy_files,
                    "drifted_files": result.drifted_files,
                    "files": [
                        {
                            "path": r.file_path,
                            "total_claims": r.total_claims,
                            "valid_claims": r.valid_claims,
                            "drift_percentage": r.drift_percentage,
                            "is_healthy": r.is_healthy,
                            "drifted": [c.claim for c in r.drifted_claims],
                        }
                        for r in result.reports
                    ]
                }, f, indent=2)
            console.print(f"\n[dim]Report saved to: {output}[/dim]")

        sys.exit(0 if result.drifted_files == 0 else 1)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@docs.command("claims")
@click.argument("doc_path")
@click.option(
    "--types", "-t",
    multiple=True,
    help="Claim types to extract (function, api, config, flow, schema)"
)
def extract_claims(doc_path: str, types: tuple):
    """Extract claims from a documentation file.

    Shows what verifiable claims exist in a doc file without
    validating them against code.

    Examples:
        hester docs claims README.md
        hester docs claims docs/api.md --types function --types api
    """
    from hester.docs import HesterDocsAgent
    from hester.shared.surfaces import format_doc_claims

    working_dir = os.getcwd()
    agent = HesterDocsAgent(working_dir=working_dir)

    console.print("[bold]HesterDocs[/bold] - Claim Extraction")
    console.print(f"[dim]File: {doc_path}[/dim]")
    console.print()

    try:
        claim_types = list(types) if types else None
        claims = asyncio.run(agent.extract_claims(doc_path, claim_types=claim_types))

        if not claims:
            console.print("[yellow]No verifiable claims found.[/yellow]")
            sys.exit(0)

        format_doc_claims(claims)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@docs.command("index")
@click.argument("paths", nargs=-1)
@click.option(
    "--all", "-a",
    "index_all",
    is_flag=True,
    help="Index all documentation files"
)
@click.option(
    "--clear",
    is_flag=True,
    help="Clear existing index before indexing"
)
def index_docs(paths: tuple, index_all: bool, clear: bool):
    """Index documentation for semantic search.

    Creates vector embeddings for documentation files and stores
    them in Supabase for fast semantic search.

    Accepts files or directories. Directories are scanned for markdown files.

    Examples:
        hester docs index README.md
        hester docs index docs/ src/
        hester docs index README.md CHANGELOG.md docs/
        hester docs index --all
        hester docs index --all --clear
    """
    import glob
    from hester.docs.embeddings import DocEmbeddingService

    if not paths and not index_all:
        console.print("[red]Error: Specify file/directory paths or use --all[/red]")
        console.print("  hester docs index README.md")
        console.print("  hester docs index docs/ src/")
        console.print("  hester docs index --all")
        sys.exit(1)

    working_dir = os.getcwd()

    console.print("[bold]HesterDocs[/bold] - Embedding Index")
    console.print(f"[dim]Working directory: {working_dir}[/dim]")
    console.print()

    async def run_index():
        service = DocEmbeddingService(working_dir)

        if clear:
            console.print("[yellow]Clearing existing index...[/yellow]")
            deleted = await service.clear_index()
            console.print(f"[dim]Removed {deleted} embeddings[/dim]")
            console.print()

        if index_all:
            console.print("[cyan]Indexing all documentation files...[/cyan]")
            return await service.index_directory()

        # Expand paths - handle files, directories, and globs
        files_to_index = []
        for path in paths:
            full_path = Path(working_dir) / path if not Path(path).is_absolute() else Path(path)

            if full_path.is_file():
                files_to_index.append(str(full_path))
            elif full_path.is_dir():
                # Find markdown files in directory
                for pattern in ["**/*.md", "**/README*"]:
                    matches = glob.glob(str(full_path / pattern), recursive=True)
                    files_to_index.extend(matches)
            else:
                # Try as glob pattern
                matches = glob.glob(str(full_path), recursive=True)
                if matches:
                    files_to_index.extend(matches)
                else:
                    console.print(f"[yellow]Warning: {path} not found, skipping[/yellow]")

        # Deduplicate and filter
        files_to_index = list(set(files_to_index))
        files_to_index = [
            f for f in files_to_index
            if not any(skip in f for skip in [
                "node_modules", ".git", "venv", "__pycache__",
                ".egg-info", "build/", "dist/"
            ])
        ]

        if not files_to_index:
            return {"success": False, "error": "No files to index"}

        console.print(f"[cyan]Indexing {len(files_to_index)} file(s)...[/cyan]")

        # Index each file and aggregate results
        results = {
            "success": True,
            "files_processed": 0,
            "files_skipped": 0,
            "total_chunks": 0,
            "chunks_indexed": 0,
            "chunks_skipped": 0,
        }

        for file_path in files_to_index:
            rel_path = Path(file_path).relative_to(service.repo_root) if Path(file_path).is_absolute() else file_path
            console.print(f"  [dim]{rel_path}[/dim]")
            try:
                result = await service.index_file(file_path)
                if result.get("success"):
                    results["files_processed"] += 1
                    results["total_chunks"] += result.get("total_chunks", 0)
                    results["chunks_indexed"] += result.get("chunks_indexed", 0)
                    results["chunks_skipped"] += result.get("chunks_skipped", 0)
                else:
                    results["files_skipped"] += 1
                    console.print(f"    [yellow]Skipped: {result.get('error', 'unknown error')}[/yellow]")
            except Exception as e:
                results["files_skipped"] += 1
                console.print(f"    [yellow]Error: {e}[/yellow]")

        return results

    try:
        result = asyncio.run(run_index())

        if result.get("success"):
            console.print()
            console.print(f"[green]Indexing complete![/green]")
            console.print(f"  Files processed: {result.get('files_processed', 0)}")
            if result.get('files_skipped', 0) > 0:
                console.print(f"  Files skipped: {result.get('files_skipped', 0)}")
            console.print(f"  Total chunks: {result.get('total_chunks', 0)}")
            console.print(f"  New/updated: {result.get('chunks_indexed', 0)}")
            console.print(f"  Unchanged: {result.get('chunks_skipped', 0)}")
        else:
            console.print(f"[red]Error: {result.get('error')}[/red]")
            sys.exit(1)

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)


@docs.command("index-status")
def index_status():
    """Show status of the documentation index.

    Lists indexed files and embedding counts.
    """
    from hester.docs.embeddings import DocEmbeddingService

    working_dir = os.getcwd()

    console.print("[bold]HesterDocs[/bold] - Index Status")
    console.print()

    async def get_status():
        service = DocEmbeddingService(working_dir)
        files = await service.get_indexed_files()
        return files, service.repo_name

    try:
        files, repo_name = asyncio.run(get_status())

        console.print(f"[dim]Repository: {repo_name}[/dim]")
        console.print(f"[dim]Indexed files: {len(files)}[/dim]")
        console.print()

        if files:
            for f in sorted(files)[:20]:
                console.print(f"  {f}")
            if len(files) > 20:
                console.print(f"  [dim]... and {len(files) - 20} more[/dim]")
        else:
            console.print("[yellow]No files indexed yet.[/yellow]")
            console.print("[dim]Run 'hester docs index --all' to index documentation.[/dim]")

    except Exception as e:
        console.print(f"\n[red]Error: {e}[/red]")
        import traceback
        console.print(traceback.format_exc())
        sys.exit(1)
