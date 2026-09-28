"""
Hester CLI - Voice: the transcription the mic in Lee, Aeronaut and the T-Deck uses.

No daemon needed. ``setup`` is the one network fetch for local Whisper, and
only when you run it.

Usage:
    hester voice status             # config, provider and whether the mic would show (GET /voice)
    hester voice setup              # download the Whisper model (provider: whisper)
    hester voice test FILE.wav      # transcribe a 16 kHz mono 16-bit WAV, as POST /voice/transcribe would
"""

import asyncio
import json
import sys
import time
from pathlib import Path

import click
from rich.console import Console

console = Console()

_dir = click.option("--dir", "-d", "directory", default=".", type=click.Path(file_okay=False), help="Workspace directory")


def _setup(directory: str):
    from hester.daemon.voice.config import load_voice_config
    from hester.daemon.voice.providers import get_provider

    ws = Path(directory).expanduser().resolve()
    config = load_voice_config(ws)
    return ws, config, get_provider(config, ws)


@click.group()
def voice():
    """Voice input: transcription status, Whisper setup and a test transcription."""


@voice.command("status")
@_dir
@click.option("--json", "as_json", is_flag=True, help="JSON instead of text")
def voice_status(directory: str, as_json: bool):
    """What GET /voice would say for this workspace."""
    from hester.daemon.voice.routes import capabilities

    _, config, provider = _setup(directory)
    caps = capabilities(config, provider)
    if as_json:
        click.echo(json.dumps(caps, indent=2))
        return
    state = "[green]available[/green]" if caps["available"] else f"[yellow]unavailable[/yellow] ({caps.get('reason')})"
    console.print(f"Voice: {'on' if config.enabled else 'off'} · {state}")
    console.print(f"Provider: {caps['provider']} · {caps['model']} ({caps['location']})")
    console.print(f"Limits: {caps['max_seconds']} s, {caps['max_bytes']} bytes, {config.timeout_s:g} s timeout")
    if caps.get("reason") == "disabled":
        console.print("[dim]Turn it on with hester.voice.enabled: true in ~/.lee/config.yaml.[/dim]")
    elif caps.get("reason") == "whisper_not_installed":
        console.print("[dim]pip install 'lee-tools[voice-local]', then hester voice setup.[/dim]")
    elif caps.get("reason") == "whisper_model_missing":
        console.print("[dim]Run hester voice setup to download the model.[/dim]")
    elif caps.get("reason") == "no_api_key":
        console.print("[dim]Set hester.google_api_key in ~/.lee/config.yaml, or export GOOGLE_API_KEY.[/dim]")


@voice.command("setup")
@_dir
def voice_setup(directory: str):
    """Download the Whisper model (the only network fetch for local transcription)."""
    from hester.daemon.voice.providers import whisper

    _, config, _ = _setup(directory)
    if config.provider != "whisper":
        console.print(f"The provider is {config.provider}; nothing to download (set hester.voice.provider: whisper for local).")
        return
    if not whisper.installed():
        console.print("[red]faster-whisper isn't installed:[/red] pip install 'lee-tools[voice-local]'")
        sys.exit(1)
    console.print(f"Downloading Whisper {config.whisper_model}…")
    path = whisper.download(config.whisper_model)
    console.print(f"[green]Ready[/green] {path}")


@voice.command("test")
@click.argument("wav_file", type=click.Path(exists=True, dir_okay=False))
@_dir
def voice_test(wav_file: str, directory: str):
    """Transcribe FILE.wav with the configured provider (a model call you asked for)."""
    from hester.daemon.copilot.model_log import trigger
    from hester.daemon.voice.audio import AudioError, parse_wav, validate
    from hester.daemon.voice.providers import ProviderError

    _, config, provider = _setup(directory)
    reason = provider.availability()
    if reason:
        console.print(f"[red]{provider.name} is unavailable:[/red] {reason} (hester voice status)")
        sys.exit(1)
    data = Path(wav_file).read_bytes()
    try:
        info = parse_wav(data)
        validate(info, config.max_seconds)
    except AudioError as e:
        console.print(f"[red]{e.code}:[/red] {e}")
        sys.exit(1)
    started = time.monotonic()
    try:
        with trigger("user", surface="cli"):
            text = asyncio.run(asyncio.wait_for(provider.transcribe(data, info, []), timeout=config.timeout_s))
    except (ProviderError, asyncio.TimeoutError) as e:
        console.print(f"[red]Failed:[/red] {type(e).__name__} {e}")
        sys.exit(1)
    ms = int((time.monotonic() - started) * 1000)
    console.print(f"[dim]{provider.name} · {provider.model} · {info.duration_ms} ms of audio in {ms} ms[/dim]")
    click.echo(" ".join(text.split()))
