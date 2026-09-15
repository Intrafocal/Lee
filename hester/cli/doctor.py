"""
Hester CLI - `hester doctor`.

One command that answers "why isn't Hester working?": config precedence, API key
source, Ollama and Gemini reachability, venv deps, Redis mode, daemon health,
the Lee API token, and log sizes.

Exits non-zero if any check fails.
"""

import importlib
import os
import socket
from pathlib import Path
from typing import List, Optional

import click
from rich.console import Console

console = Console()

PASS = "[green]PASS[/green]"
WARN = "[yellow]WARN[/yellow]"
FAIL = "[red]FAIL[/red]"


class Report:
    """Collects pass/warn/fail lines and tracks whether anything failed."""

    def __init__(self) -> None:
        self.failures = 0
        self.warnings = 0

    def _emit(self, tag: str, title: str, detail: str, fix: Optional[str]) -> None:
        console.print(f"  {tag}  [bold]{title}[/bold] — {detail}")
        if fix:
            console.print(f"        [dim]fix: {fix}[/dim]")

    def ok(self, title: str, detail: str) -> None:
        self._emit(PASS, title, detail, None)

    def warn(self, title: str, detail: str, fix: Optional[str] = None) -> None:
        self.warnings += 1
        self._emit(WARN, title, detail, fix)

    def fail(self, title: str, detail: str, fix: Optional[str] = None) -> None:
        self.failures += 1
        self._emit(FAIL, title, detail, fix)

    def section(self, name: str) -> None:
        console.print(f"\n[bold cyan]{name}[/bold cyan]")


def _human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"


def _check_config(report: Report, workspace: Path) -> dict:
    from ..shared.config import config_paths, find_key_source, load_merged_config_with_sources

    report.section("Config")
    config, sources = load_merged_config_with_sources(workspace)

    for path in config_paths(workspace):
        if path in sources:
            report.ok("config file", f"{path}")
        else:
            console.print(f"  [dim]----[/dim]  config file — {path} (not present)")

    if not sources:
        report.fail(
            "config precedence",
            "no config.yaml found anywhere",
            "create ~/.lee/config.yaml with a `hester:` block",
        )
    else:
        order = " < ".join(str(p) for p in sources)
        report.ok("config precedence", f"merged (later wins): {order}")

    # API key source
    key_source = find_key_source("hester.google_api_key", workspace)
    env_key = os.environ.get("GOOGLE_API_KEY")
    if key_source:
        report.ok("GOOGLE_API_KEY", f"from config: {key_source}")
    elif env_key:
        report.ok("GOOGLE_API_KEY", "from process environment")
    else:
        report.fail(
            "GOOGLE_API_KEY",
            "not set in any config file or the environment",
            "set hester.google_api_key in ~/.lee/config.yaml, or export GOOGLE_API_KEY",
        )

    return config


def _check_deps(report: Report) -> None:
    report.section("Python dependencies")
    required = [
        ("fastapi", "daemon HTTP server"),
        ("uvicorn", "daemon HTTP server"),
        ("httpx", "HTTP client"),
        ("redis", "session storage"),
        ("websockets", "Lee context stream"),
        ("yaml", "config parsing"),
        ("numpy", "prompt/agent registries, semantic router"),
        ("google.genai", "Gemini API"),
        ("pydantic_settings", "daemon settings"),
    ]
    for module, why in required:
        try:
            importlib.import_module(module)
            report.ok(f"import {module}", why)
        except Exception as e:
            report.fail(
                f"import {module}",
                f"{why} — {e}",
                f"pip install -e . (or pip install {module.split('.')[0]})",
            )


def _check_ollama(report: Report, config: dict, deep: bool) -> None:
    import httpx

    report.section("Ollama (local models)")
    hester_cfg = (config.get("hester") or {}) if isinstance(config, dict) else {}
    url = (
        os.environ.get("HESTER_OLLAMA_URL")
        or hester_cfg.get("ollama_url")
        or "http://localhost:11434"
    )

    try:
        response = httpx.get(f"{url}/api/tags", timeout=2.0)
    except Exception as e:
        report.warn(
            "ollama reachable",
            f"{url} — {e}",
            "start Ollama, or set hester.ollama_enabled: false to skip the prepare step",
        )
        return

    if response.status_code != 200:
        report.warn("ollama reachable", f"{url} returned {response.status_code}")
        return

    installed = [m.get("name", "") for m in response.json().get("models", [])]
    report.ok("ollama reachable", f"{url} — {len(installed)} model(s) installed")

    wanted = {
        "prepare model": os.environ.get("HESTER_PREPARE_MODEL")
        or hester_cfg.get("prepare_model")
        or "functiongemma",
        "local model": os.environ.get("HESTER_LOCAL_MODEL")
        or hester_cfg.get("local_model")
        or "gemma4:e4b",
    }
    for label, model in wanted.items():
        base = model.split(":")[0]
        if any(n == model or n.split(":")[0] == base for n in installed):
            report.ok(label, f"{model} installed")
        else:
            report.warn(
                label,
                f"{model} not installed — that step is skipped (no timeout cost)",
                f"ollama pull {model}, or set hester.{label.split()[0]}_model to one you have",
            )


def _check_gemini(report: Report, config: dict, deep: bool) -> None:
    report.section("Gemini")
    if not deep:
        console.print("  [dim]----[/dim]  reachability — skipped (use --deep to make one live call)")
        return

    hester_cfg = (config.get("hester") or {}) if isinstance(config, dict) else {}
    api_key = os.environ.get("GOOGLE_API_KEY") or hester_cfg.get("google_api_key")
    model = os.environ.get("HESTER_GEMINI_MODEL") or hester_cfg.get("model") or "gemini-3-flash-preview"
    if not api_key:
        report.fail("reachability", "no API key to test with")
        return

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
        result = client.models.generate_content(model=model, contents="Reply with OK.")
        text = (getattr(result, "text", "") or "").strip()[:20]
        report.ok("reachability", f"{model} responded: {text!r}")
    except Exception as e:
        report.fail("reachability", f"{model} — {e}", "check the API key and network")


def _check_redis(report: Report, config: dict) -> None:
    report.section("Redis")
    hester_cfg = (config.get("hester") or {}) if isinstance(config, dict) else {}
    external_url = (
        os.environ.get("HESTER_REDIS_URL")
        or hester_cfg.get("redis_url")
        or "redis://localhost:6379"
    )

    def ping(host: str, port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=1.0) as sock:
                sock.sendall(b"PING\r\n")
                return b"PONG" in sock.recv(64)
        except Exception:
            return False

    host, _, port_str = external_url.rsplit("/", 1)[-1].partition(":")
    try:
        external_port = int(port_str or 6379)
    except ValueError:
        external_port = 6379
    external_host = host.replace("redis://", "") or "localhost"

    if ping(external_host, external_port):
        report.ok("mode", f"external Redis at {external_host}:{external_port}")
        return

    port_file = Path.home() / ".lee" / "redis" / "managed.port"
    if port_file.exists():
        try:
            managed_port = int(port_file.read_text().strip())
        except ValueError:
            report.warn("mode", f"managed port file is unreadable: {port_file}")
            return
        if ping("127.0.0.1", managed_port):
            report.ok("mode", f"managed Redis at 127.0.0.1:{managed_port}")
        else:
            report.warn(
                "mode",
                f"managed port file says {managed_port} but nothing answers there",
                "stale state file; the daemon will start a fresh managed redis",
            )
        return

    report.warn(
        "mode",
        "no Redis reachable — the daemon will fall back to in-memory sessions "
        "(knowledge engine stays off)",
        "install redis-server, or let the daemon start its bundled one",
    )


def _check_daemon(report: Report, port: int) -> None:
    import httpx

    report.section("Daemon")
    url = f"http://127.0.0.1:{port}/health"
    try:
        response = httpx.get(url, timeout=3.0)
    except Exception as e:
        report.warn(
            "daemon on :%d" % port,
            f"not responding ({e})",
            "start Lee, or run `hester daemon start`",
        )
        return

    if response.status_code != 200:
        report.fail(f"daemon on :{port}", f"/health returned {response.status_code}")
        return

    health = response.json()
    report.ok(
        f"daemon on :{port}",
        f"status={health.get('status')} model={(health.get('components') or {}).get('agent', {}).get('model')} "
        f"workspace={health.get('workspace')}",
    )

    auth_mode = health.get("auth")
    if auth_mode == "bearer":
        report.ok("daemon auth", "bearer token required")
    elif auth_mode == "disabled":
        report.warn(
            "daemon auth",
            "DISABLED (HESTER_AUTH_DISABLED) — the API is open on every bound interface",
            "unset HESTER_AUTH_DISABLED",
        )
    else:
        report.warn("daemon auth", "daemon predates auth reporting; restart it to pick up auth")


def _check_token(report: Report) -> None:
    from ..shared.auth import LEE_TOKEN_PATH, lee_api_token

    report.section("Lee API token")
    if lee_api_token():
        report.ok("token", f"present at {LEE_TOKEN_PATH}")
    else:
        report.fail(
            "token",
            f"missing or empty at {LEE_TOKEN_PATH}",
            "start Lee once — its api-server generates and persists the token",
        )


def _check_logs(report: Report) -> None:
    report.section("Logs")
    log_dir = Path.home() / ".lee" / "logs"
    if not log_dir.is_dir():
        report.warn("log directory", f"{log_dir} does not exist")
        return
    for name in ("hester.log", "lee.log"):
        path = log_dir / name
        if not path.exists():
            console.print(f"  [dim]----[/dim]  {name} — not created yet")
            continue
        size = path.stat().st_size
        if size > 20 * 1024 * 1024:
            report.warn(
                name,
                f"{_human_size(size)} — larger than the 10 MB rotation threshold",
                "restart the daemon / Lee to pick up rotation, or delete the old file",
            )
        else:
            report.ok(name, _human_size(size))


@click.command("doctor")
@click.option("--dir", "-d", "working_dir", default=None, help="Workspace to check (default: cwd)")
@click.option("--port", "-p", default=9000, help="Daemon port to probe (default: 9000)")
@click.option("--deep", is_flag=True, help="Also make one live Gemini call")
def doctor(working_dir: Optional[str], port: int, deep: bool):
    """Diagnose the Hester/Lee setup. Exits non-zero if any check fails."""
    workspace = Path(working_dir).expanduser().resolve() if working_dir else Path.cwd()
    console.print(f"[bold]hester doctor[/bold]  [dim]workspace: {workspace}[/dim]")

    report = Report()
    config = _check_config(report, workspace)
    _check_deps(report)
    _check_ollama(report, config, deep)
    _check_gemini(report, config, deep)
    _check_redis(report, config)
    _check_token(report)
    _check_daemon(report, port)
    _check_logs(report)

    console.print()
    if report.failures:
        console.print(
            f"[red]{report.failures} check(s) failed[/red], "
            f"[yellow]{report.warnings} warning(s)[/yellow]"
        )
        raise SystemExit(1)
    if report.warnings:
        console.print(f"[yellow]{report.warnings} warning(s)[/yellow], no failures")
    else:
        console.print("[green]All checks passed[/green]")
