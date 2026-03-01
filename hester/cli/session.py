"""
Hester CLI - Session inspection commands for TriState sessions.

Usage:
    hester session <session_id> [--user-id UUID]
    hester session list [--user-id UUID]

Provides debug inspection of Frame/Stanley conversation state including:
- Scene state (current stage, stage order, progress)
- Scene data (completion paths, form responses)
- Recent messages
- Session metadata

Reads from the Redis cache tier of TriStateSession (tristate:{session_id}).
Decryption uses LocalDecryptor (local Supabase DEKs).
Data is available while the Redis cache is warm (1hr TTL from last write).
"""

import asyncio
import json
import sys
from datetime import datetime
from typing import Any, Dict, Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

console = Console()

# Redis key prefix used by TriStateSession
TRISTATE_PREFIX = "tristate:"


@click.group()
def session():
    """Session inspection commands for TriState sessions.

    Inspect Frame/Stanley conversation state including scene progress,
    stage data, and debug information.
    """
    pass


@session.command("show")
@click.argument("session_id")
@click.option(
    "--user-id", "-u",
    "user_id",
    default=None,
    help="User UUID for decryption"
)
@click.option(
    "--email", "-e",
    "email",
    default=None,
    help="User email (looks up UUID from Supabase)"
)
@click.option(
    "--json", "-j",
    "as_json",
    is_flag=True,
    help="Output as JSON"
)
@click.option(
    "--full", "-f",
    is_flag=True,
    help="Show full state including messages"
)
def session_show(session_id: str, user_id: str, email: str, as_json: bool, full: bool):
    """Inspect a TriState session.

    Shows scene state, current stage, and progress data.

    Examples:
        hester session show abc-123 --user-id UUID
        hester session show abc-123 --email user@example.com
        hester session show abc-123 -e user@example.com --json
    """
    # Resolve user_id from email if provided
    if not user_id and not email:
        if as_json:
            print(json.dumps({"error": "Either --user-id or --email is required"}))
        else:
            console.print("[red]Error: Either --user-id or --email is required[/red]")
        sys.exit(1)

    if email and not user_id:
        user_id = asyncio.run(_lookup_user_id_by_email(email))
        if not user_id:
            if as_json:
                print(json.dumps({"error": f"User not found for email: {email}"}))
            else:
                console.print(f"[red]Error: User not found for email: {email}[/red]")
            sys.exit(1)

    result = asyncio.run(_get_session_state(session_id, user_id))

    if not result["success"]:
        if as_json:
            print(json.dumps({"error": result["error"]}))
        else:
            console.print(f"[red]Error: {result['error']}[/red]")
        sys.exit(1)

    state = result["state"]

    if as_json:
        # For JSON output, include everything
        output = {
            "session_id": session_id,
            "user_id": user_id,
            **_extract_session_summary(state, full=full),
        }
        print(json.dumps(output, indent=2, default=str))
        return

    # Rich console output
    _display_session_state(session_id, user_id, state, full=full)


@session.command("list")
@click.option(
    "--user-id", "-u",
    "user_id",
    default=None,
    help="User UUID to list sessions for"
)
@click.option(
    "--email", "-e",
    "email",
    default=None,
    help="User email (looks up UUID from Supabase)"
)
@click.option(
    "--limit", "-l",
    default=10,
    help="Maximum sessions to show (default: 10)"
)
def session_list(user_id: str, email: str, limit: int):
    """List active sessions for a user.

    Shows session IDs from Redis cache (active within last hour).

    Examples:
        hester session list --user-id UUID
        hester session list --email user@example.com
        hester session list -e user@example.com --limit 5
    """
    # Resolve user_id from email if provided
    if not user_id and not email:
        console.print("[red]Error: Either --user-id or --email is required[/red]")
        sys.exit(1)

    if email and not user_id:
        user_id = asyncio.run(_lookup_user_id_by_email(email))
        if not user_id:
            console.print(f"[red]Error: User not found for email: {email}[/red]")
            sys.exit(1)

    result = asyncio.run(_list_sessions(user_id, limit))

    if not result["success"]:
        console.print(f"[red]Error: {result['error']}[/red]")
        sys.exit(1)

    sessions = result["sessions"]

    if not sessions:
        console.print("[yellow]No active sessions found in Redis cache.[/yellow]")
        console.print("[dim]Sessions are cached for 1 hour after last activity.[/dim]")
        return

    console.print(f"[bold]Active Sessions for {user_id[:8]}...[/bold]")
    console.print()

    for sess in sessions:
        console.print(f"  {sess['session_id']}")

    console.print()
    console.print(f"[dim]Total: {len(sessions)} sessions[/dim]")


@session.command("scene")
@click.argument("session_id")
@click.option(
    "--user-id", "-u",
    "user_id",
    default=None,
    help="User UUID for decryption"
)
@click.option(
    "--email", "-e",
    "email",
    default=None,
    help="User email (looks up UUID from Supabase)"
)
@click.option(
    "--json", "-j",
    "as_json",
    is_flag=True,
    help="Output as JSON"
)
def session_scene(session_id: str, user_id: str, email: str, as_json: bool):
    """Show detailed scene state for a session.

    Focuses on scene debugging: current stage, stage requirements,
    scene_data progress, and stage configuration.

    Examples:
        hester session scene abc-123 --user-id UUID
        hester session scene abc-123 --email user@example.com
        hester session scene abc-123 -e user@example.com --json
    """
    # Resolve user_id from email if provided
    if not user_id and not email:
        if as_json:
            print(json.dumps({"error": "Either --user-id or --email is required"}))
        else:
            console.print("[red]Error: Either --user-id or --email is required[/red]")
        sys.exit(1)

    if email and not user_id:
        user_id = asyncio.run(_lookup_user_id_by_email(email))
        if not user_id:
            if as_json:
                print(json.dumps({"error": f"User not found for email: {email}"}))
            else:
                console.print(f"[red]Error: User not found for email: {email}[/red]")
            sys.exit(1)

    result = asyncio.run(_get_session_state(session_id, user_id))

    if not result["success"]:
        if as_json:
            print(json.dumps({"error": result["error"]}))
        else:
            console.print(f"[red]Error: {result['error']}[/red]")
        sys.exit(1)

    state = result["state"]
    scene_info = _extract_scene_info(state)
    ui_state_info = _extract_ui_state_info(state)

    if as_json:
        output = {
            "scene": scene_info,
            "ui_state": ui_state_info,
        }
        print(json.dumps(output, indent=2, default=str))
        return

    _display_scene_info(session_id, scene_info)
    _display_ui_state_info(ui_state_info)


# =============================================================================
# Internal Functions
# =============================================================================


async def _lookup_user_id_by_email(email: str) -> Optional[str]:
    """Look up Supabase auth user ID by email address.

    Queries auth.users table to find the user UUID for a given email.
    Uses a direct asyncpg connection to avoid pool conflicts.
    """
    import os
    import asyncpg

    # Build database URL
    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        host = os.getenv("POSTGRES_HOST", "127.0.0.1")
        port = os.getenv("POSTGRES_PORT", "54322")
        database = os.getenv("POSTGRES_DATABASE", "postgres")
        user = os.getenv("POSTGRES_USER", "postgres")
        password = os.getenv("POSTGRES_PASSWORD", "postgres")
        database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

    try:
        # Use a direct connection instead of the pool
        conn = await asyncpg.connect(database_url)
        try:
            # Query auth.users table for the email
            result = await conn.fetchrow(
                """
                SELECT id FROM auth.users
                WHERE email = $1
                LIMIT 1
                """,
                email.lower()
            )

            if result:
                return str(result["id"])

            return None
        finally:
            await conn.close()

    except Exception as e:
        console.print(f"[dim]Debug: Email lookup error: {e}[/dim]")
        return None


async def _get_session_state(session_id: str, user_id: str) -> Dict[str, Any]:
    """Get and decrypt session state from Redis.

    Uses the same decryption flow as `hester redis get --decrypt`.
    """
    from hester.daemon.tools.redis_tools import redis_get_key
    from hester.cli.redis import _decrypt_redis_value

    # Construct Redis key
    redis_key = f"{TRISTATE_PREFIX}{session_id}"

    # Get raw value from Redis
    result = await redis_get_key(redis_key, "local")

    if not result.success:
        return {"success": False, "error": result.error}

    if result.data["value"] is None:
        return {
            "success": False,
            "error": f"Session not found in Redis cache: {session_id}"
        }

    value = result.data["value"]

    # The value should be a dict with encrypted_state
    if not isinstance(value, dict):
        return {
            "success": False,
            "error": f"Unexpected value type: {type(value)}"
        }

    # Check for encrypted state
    encrypted_state = value.get("encrypted_state")
    if not encrypted_state:
        return {
            "success": False,
            "error": "No encrypted_state found in checkpoint"
        }

    # Decrypt the state
    ciphertext = encrypted_state.get("ciphertext")
    state_hash = encrypted_state.get("hash")

    if not ciphertext:
        return {
            "success": False,
            "error": "No ciphertext in encrypted_state"
        }

    # Use LocalDecryptor to decrypt
    import os
    from hester.cli.crypto_utils import LocalDecryptor, LocalDecryptionError
    from hester.daemon.tools.db_tools import get_db

    database_url = os.getenv("DATABASE_URL", "")
    if not database_url:
        host = os.getenv("POSTGRES_HOST", "127.0.0.1")
        port = os.getenv("POSTGRES_PORT", "54322")
        database = os.getenv("POSTGRES_DATABASE", "postgres")
        user = os.getenv("POSTGRES_USER", "postgres")
        password = os.getenv("POSTGRES_PASSWORD", "postgres")
        database_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"

    try:
        decryptor = LocalDecryptor(database_url)
        db = await get_db()
        deks = await decryptor.get_user_deks(user_id, db.pool)

        if not deks:
            return {
                "success": False,
                "error": f"No DEKs found for user {user_id}"
            }

        plaintext = decryptor.decrypt_value(ciphertext, deks, state_hash)

        if plaintext.startswith("[decrypt failed"):
            return {
                "success": False,
                "error": f"Decryption failed: {plaintext}"
            }

        # Parse JSON state
        state = json.loads(plaintext) if isinstance(plaintext, str) else plaintext

        return {
            "success": True,
            "state": state,
            "timestamp": value.get("timestamp"),
        }

    except LocalDecryptionError as e:
        return {"success": False, "error": str(e)}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"Failed to parse state JSON: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def _list_sessions(user_id: str, limit: int) -> Dict[str, Any]:
    """List sessions from Redis cache matching user pattern."""
    from hester.daemon.tools.redis_tools import redis_list_keys

    # List all tristate session keys
    result = await redis_list_keys(f"{TRISTATE_PREFIX}*", "local")

    if not result.success:
        return {"success": False, "error": result.error}

    # Filter to just session IDs
    keys = result.data.get("keys", [])
    sessions = []

    for key in keys[:limit]:
        session_id = key.replace(TRISTATE_PREFIX, "")
        sessions.append({"session_id": session_id})

    return {"success": True, "sessions": sessions}


def _extract_session_summary(state: Dict[str, Any], full: bool = False) -> Dict[str, Any]:
    """Extract summary info from conversation state."""
    summary = {
        "session_title": state.get("session_title"),
        "user_id": state.get("user_id"),
        "message_count": len(state.get("messages", [])),
        "session_traces_count": len(state.get("session_traces", [])),
    }

    # Scene info - "context" is the actual SydneyState field name (TriState),
    # fall back to legacy "context_state" / "sydney_context" for old checkpoints
    sydney_context = state.get("context") or state.get("context_state") or state.get("sydney_context", {})
    if sydney_context:
        scene = sydney_context.get("scene")
        if scene:
            summary["scene"] = {
                "slug": scene.get("slug"),
                "name": scene.get("name"),
                "current_stage": scene.get("current_stage"),
                "stage_order": scene.get("stage_order", []),
                "stage_index": _get_stage_index(scene),
                "scene_data": scene.get("data", {}),
            }

        summary["active_topics"] = sydney_context.get("active_topics", [])

    # UI state
    ui_state = state.get("ui_state", {})
    if ui_state:
        summary["ui_state"] = {
            "current_panel": ui_state.get("current_panel"),
            "message_count": ui_state.get("message_count"),
        }

    if full:
        # Include messages
        messages = state.get("messages", [])
        summary["messages"] = [
            {
                "role": m.get("role") if isinstance(m, dict) else getattr(m, "role", "?"),
                "content": (m.get("content") if isinstance(m, dict) else getattr(m, "content", ""))[:200],
            }
            for m in messages[-10:]  # Last 10 messages
        ]

    return summary


def _extract_ui_state_info(state: Dict[str, Any]) -> Dict[str, Any]:
    """Extract UIState info for debugging.

    UIState is the shared UI state between Stanley and Frame containing:
    - chat: ChatSurface (components, typing, hints, chips)
    - desk: DeskSurface (components, views, is_open)
    - scene: SceneSurface (spotlight, narration, overlays)
    - profile: ProfileSurface (evidence, patterns, journals, documents, graph)
    - topics, voice state, user profile, etc.
    """
    ui_state = state.get("ui_state", {})

    if not ui_state:
        return {"error": "No ui_state in checkpoint"}

    info = {
        "version": ui_state.get("version"),
        "updated_at": ui_state.get("updated_at"),
        "session_id": ui_state.get("session_id"),
        "session_title": ui_state.get("session_title"),
    }

    # === Chat Surface ===
    chat = ui_state.get("chat", {})
    if chat:
        info["chat"] = {
            "components_count": len(chat.get("components", [])),
            "typing_indicator": chat.get("typing_indicator", False),
            "typing_placeholder": chat.get("typing_placeholder"),
            "input_hints_count": len(chat.get("input_hints", [])),
            "input_hints": chat.get("input_hints", [])[:3],  # First 3
            "input_prefill": chat.get("input_prefill"),
            "suggested_chips_count": len(chat.get("suggested_chips", [])),
            "suggested_chips": [
                {"label": c.get("label"), "action": c.get("action")}
                for c in chat.get("suggested_chips", [])[:5]
            ],
        }

    # === Desk Surface ===
    desk = ui_state.get("desk", {})
    if desk:
        info["desk"] = {
            "is_open": desk.get("is_open", False),
            "components_count": len(desk.get("components", [])),
            "views_count": len(desk.get("views", {})),
            "view_ids": list(desk.get("views", {}).keys()),
            "active_view_id": desk.get("active_view_id"),
            "active_view_title": desk.get("active_view_title"),
            "view_stack_depth": len(desk.get("view_stack", [])),
        }

    # === Scene Surface ===
    scene = ui_state.get("scene", {})
    if scene:
        info["scene_surface"] = {
            "has_spotlight": scene.get("spotlight") is not None,
            "spotlight": scene.get("spotlight"),
            "narration_queue_length": len(scene.get("narration_queue", [])),
            "has_presentation": scene.get("presentation") is not None,
            "welcome_overlay_visible": scene.get("welcome_overlay_visible", False),
        }

    # === Profile Surface ===
    profile = ui_state.get("profile", {})
    if profile:
        info["profile"] = {
            "evidence_count": profile.get("evidence_count", 0),
            "patterns_count": profile.get("patterns_count", 0),
            "journals_count": profile.get("journals_count", 0),
            "documents_count": profile.get("documents_count", 0),
            "graph_nodes_count": profile.get("graph_nodes_count", 0),
            "has_graph_root": profile.get("graph_root") is not None,
        }
        # Background intelligence summary
        bg = profile.get("background_intelligence", {})
        if bg:
            info["profile"]["background_intelligence"] = {
                "total_unreviewed": bg.get("total_unreviewed", 0),
                "evidence_added": bg.get("evidence_added", 0),
                "patterns_formed": bg.get("patterns_formed", 0),
            }

    # === Navigation State ===
    topics = ui_state.get("topics", [])
    info["navigation"] = {
        "topics_count": len(topics),
        "topics": [
            {"id": t.get("id"), "title": t.get("title"), "locked": t.get("locked", False)}
            for t in topics[:10]
        ],
        "active_topic_id": ui_state.get("active_topic_id"),
        "can_switch_topics": ui_state.get("can_switch_topics", True),
        "locked_phase": ui_state.get("locked_phase"),
    }

    # === Voice State ===
    info["voice"] = {
        "voice_state": ui_state.get("voice_state", "asleep"),
        "voice_mode_active": ui_state.get("voice_mode_active", False),
    }

    # === User Profile/Plan ===
    user_profile = ui_state.get("user_profile")
    user_plan = ui_state.get("user_plan")
    if user_profile or user_plan:
        info["user"] = {
            "has_profile": user_profile is not None,
            "has_plan": user_plan is not None,
        }
        if user_profile:
            info["user"]["profile_keys"] = list(user_profile.keys())
        if user_plan:
            info["user"]["plan_keys"] = list(user_plan.keys())

    return info


def _extract_scene_info(state: Dict[str, Any]) -> Dict[str, Any]:
    """Extract detailed scene info for debugging.

    TriState Architecture (post-2026):
    - SydneyState.context is a ContextState with:
      - profile: ProfileContext (user identity, preferences)
      - scene: SceneContext (current scene/stage state)
      - intelligence: IntelligenceContext (evidence, patterns)
    - scene has stage_config (SceneStageConfig) with conversation_ref, etc.

    The LangGraph state field is "context" (SydneyState.context: Optional[ContextState]).
    Legacy checkpoints may use "context_state" or "sydney_context".
    """
    # "context" is the actual SydneyState field; legacy fallbacks for old checkpoints
    sydney_context = state.get("context") or state.get("context_state") or state.get("sydney_context", {})

    if not sydney_context:
        return {"error": "No context in state (checked: context, context_state, sydney_context)"}

    # ContextState.scene is SceneContext
    scene = sydney_context.get("scene")

    if not scene:
        return {"error": "No active scene in context"}

    # SceneContext fields (TriState)
    info = {
        "slug": scene.get("slug"),
        "name": scene.get("name"),
        "instance_id": scene.get("instance_id"),
        "status": scene.get("status", "unknown"),
        "current_stage": scene.get("current_stage") or scene.get("stage"),
        "stage_order": scene.get("stage_order", []),
        "stage_index": scene.get("stage_index", 0),
        "total_stages": scene.get("total_stages") or len(scene.get("stage_order", [])),
        "progress": scene.get("progress", 0.0),
    }

    # Scene data (completion progress, collected data)
    scene_data = scene.get("scene_data", {})
    info["scene_data"] = scene_data

    # Current stage details from stage_config (SceneStageConfig)
    stage_config = scene.get("stage_config", {})
    current_stage_name = info["current_stage"]

    if stage_config:
        info["stage_config"] = {
            "name": stage_config.get("name") or current_stage_name,
            "prompt": stage_config.get("prompt", "")[:100] + "..." if stage_config.get("prompt") else None,
            "goal": stage_config.get("goal"),
            "tools_list": stage_config.get("tools_list", []),
            "ui_state_ref": stage_config.get("ui_state_ref"),
            "conversation_ref": stage_config.get("conversation_ref"),
            "silent": stage_config.get("silent", False),
            "auto_advance_to": stage_config.get("auto_advance_to"),
            "transition_to_scene": stage_config.get("transition_to_scene"),
            "context": stage_config.get("context", {}),
        }
    else:
        info["stage_config"] = {"error": "No stage_config - stage may not be loaded"}

    # Stage progression status (based on stage_order)
    info["stage_status"] = []
    stage_order = scene.get("stage_order", [])
    current_idx = scene.get("stage_index", 0)

    for i, stage_name in enumerate(stage_order):
        is_current = (stage_name == current_stage_name) or (i == current_idx)
        is_complete = i < current_idx

        info["stage_status"].append({
            "stage": stage_name,
            "index": i,
            "is_current": is_current,
            "is_complete": is_complete,
        })

    # Profile context summary
    profile = sydney_context.get("profile", {})
    if profile:
        info["profile_summary"] = {
            "preferred_name": profile.get("preferred_name"),
            "current_milestone": profile.get("current_milestone"),
            "genome_completion": profile.get("genome_completion", 0.0),
            "portfolio_items_count": profile.get("portfolio_items_count", 0),
            "arc_defined": profile.get("arc_defined", False),
            "completed_scenes": profile.get("completed_scenes", []),
        }

    # Intelligence context summary
    intelligence = sydney_context.get("intelligence", {})
    if intelligence:
        info["intelligence_summary"] = {
            "evidence_count": intelligence.get("evidence_count", 0),
            "patterns_count": intelligence.get("patterns_count", 0),
            "documents_count": intelligence.get("documents_count", 0),
        }

    # ContextState metadata
    info["context_metadata"] = {
        "source_config": sydney_context.get("source_config"),
        "version": sydney_context.get("version"),
        "loaded_at": sydney_context.get("loaded_at"),
        "topic_context_summary": sydney_context.get("topic_context_summary"),
    }

    # Stage feedback from top-level state (if present)
    if state.get("stage_feedback"):
        info["stage_feedback"] = state.get("stage_feedback")
    if state.get("stage_pacing_mode"):
        info["stage_pacing_mode"] = state.get("stage_pacing_mode")

    return info


def _get_stage_index(scene: Dict[str, Any]) -> Optional[int]:
    """Get current stage index (1-based for display).

    TriState SceneContext stores stage_index directly.
    Falls back to computing from stage_order if not present.
    """
    # Prefer direct stage_index from SceneContext
    if "stage_index" in scene:
        return scene["stage_index"] + 1  # 1-based for display

    # Fallback: compute from stage_order
    stage_order = scene.get("stage_order", [])
    current_stage = scene.get("current_stage") or scene.get("stage")

    if current_stage and stage_order:
        try:
            return stage_order.index(current_stage) + 1
        except ValueError:
            return None
    return None


def _get_nested_value(data: Dict, path: Optional[str]) -> Any:
    """Get nested value from dict using dot notation path."""
    if not path or not data:
        return None

    parts = path.split(".")
    current = data

    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None

    return current


def _display_session_state(
    session_id: str,
    user_id: str,
    state: Dict[str, Any],
    full: bool = False
):
    """Display session state with Rich formatting."""
    summary = _extract_session_summary(state, full=full)

    # Header
    console.print(Panel(
        f"[bold]Session:[/bold] {session_id}\n"
        f"[dim]User: {user_id}[/dim]",
        title="TriState Session",
        expand=False,
    ))
    console.print()

    # Session info
    console.print(f"[cyan]Title:[/cyan] {summary.get('session_title', 'Untitled')}")
    console.print(f"[cyan]Messages:[/cyan] {summary.get('message_count', 0)}")
    console.print(f"[cyan]Traces:[/cyan] {summary.get('session_traces_count', 0)}")
    console.print()

    # Scene info
    scene = summary.get("scene")
    if scene:
        console.print("[bold]Scene State[/bold]")
        console.print(f"  Slug: [green]{scene.get('slug')}[/green]")
        console.print(f"  Stage: [yellow]{scene.get('current_stage')}[/yellow] ({scene.get('stage_index')}/{len(scene.get('stage_order', []))})")
        console.print(f"  Stage Order: {' → '.join(scene.get('stage_order', []))}")

        if scene.get("scene_data"):
            console.print()
            console.print("  [dim]Scene Data:[/dim]")
            for key, value in scene["scene_data"].items():
                if isinstance(value, list):
                    console.print(f"    {key}: [{len(value)} items]")
                elif isinstance(value, dict):
                    console.print(f"    {key}: {json.dumps(value, default=str)[:80]}...")
                else:
                    console.print(f"    {key}: {value}")
    else:
        console.print("[yellow]No active scene[/yellow]")

    # Messages (if full)
    if full and summary.get("messages"):
        console.print()
        console.print("[bold]Recent Messages[/bold]")
        for msg in summary["messages"]:
            role = msg.get("role", "?")
            content = msg.get("content", "")[:100]
            if role == "user":
                console.print(f"  [blue]User:[/blue] {content}...")
            elif role == "assistant":
                console.print(f"  [green]Assistant:[/green] {content}...")
            else:
                console.print(f"  [dim]{role}:[/dim] {content}...")


def _display_scene_info(session_id: str, scene_info: Dict[str, Any]):
    """Display detailed scene info with Rich formatting (TriState)."""
    if scene_info.get("error"):
        console.print(f"[red]{scene_info['error']}[/red]")
        return

    # Header
    status = scene_info.get("status", "unknown")
    status_color = {"active": "green", "ready": "cyan", "completed": "dim"}.get(status, "yellow")
    console.print(Panel(
        f"[bold]Scene:[/bold] {scene_info.get('name', scene_info.get('slug'))}\n"
        f"[dim]Session: {session_id}[/dim]\n"
        f"Status: [{status_color}]{status}[/{status_color}]",
        title="Scene Debug (TriState)",
        expand=False,
    ))
    console.print()

    # Current stage
    current = scene_info.get("current_stage")
    idx = scene_info.get("stage_index", 0) + 1  # 1-based for display
    total = scene_info.get("total_stages", "?")
    progress = scene_info.get("progress", 0.0)
    console.print(f"[bold]Current Stage:[/bold] [yellow]{current}[/yellow] ({idx}/{total}) - {progress:.0%} complete")
    console.print()

    # Stage progression table
    table = Table(title="Stage Progression")
    table.add_column("#", style="dim")
    table.add_column("Stage", style="cyan")
    table.add_column("Status", style="green")

    for status in scene_info.get("stage_status", []):
        stage = status["stage"]
        idx_display = str(status.get("index", "?"))
        if status["is_current"]:
            stage = f"→ {stage}"
            style = "yellow bold"
        elif status["is_complete"]:
            style = "green"
        else:
            style = "dim"

        status_str = "✓" if status["is_complete"] else ("◉" if status["is_current"] else "○")

        table.add_row(idx_display, stage, status_str, style=style)

    console.print(table)
    console.print()

    # Stage config (SceneStageConfig)
    stage_config = scene_info.get("stage_config", {})
    if stage_config and not stage_config.get("error"):
        console.print("[bold]Stage Config (SceneStageConfig)[/bold]")
        console.print(f"  Name: {stage_config.get('name', '—')}")

        # Key fields for debugging
        conversation_ref = stage_config.get("conversation_ref")
        if conversation_ref:
            console.print(f"  [cyan]conversation_ref:[/cyan] [green]{conversation_ref}[/green]")
        else:
            console.print(f"  [cyan]conversation_ref:[/cyan] [dim]None[/dim]")

        ui_state_ref = stage_config.get("ui_state_ref")
        if ui_state_ref:
            console.print(f"  ui_state_ref: {ui_state_ref}")

        if stage_config.get("goal"):
            console.print(f"  Goal: {stage_config['goal'][:80]}...")

        if stage_config.get("tools_list"):
            console.print(f"  Tools: {', '.join(stage_config['tools_list'])}")

        if stage_config.get("silent"):
            console.print(f"  [yellow]Silent stage (no Sybil response)[/yellow]")

        if stage_config.get("auto_advance_to"):
            console.print(f"  Auto-advance to: {stage_config['auto_advance_to']}")

        if stage_config.get("transition_to_scene"):
            console.print(f"  [magenta]Transition to scene: {stage_config['transition_to_scene']}[/magenta]")

        console.print()
    elif stage_config.get("error"):
        console.print(f"[yellow]Stage Config: {stage_config['error']}[/yellow]")
        console.print()

    # Profile summary
    profile = scene_info.get("profile_summary", {})
    if profile:
        console.print("[bold]Profile Context[/bold]")
        console.print(f"  Name: {profile.get('preferred_name', '—')}")
        console.print(f"  Milestone: {profile.get('current_milestone', 'M0')}")
        console.print(f"  Genome: {profile.get('genome_completion', 0):.0%}")
        console.print(f"  Portfolio: {profile.get('portfolio_items_count', 0)} items")
        console.print(f"  Arc defined: {'✓' if profile.get('arc_defined') else '○'}")
        completed = profile.get("completed_scenes", [])
        if completed:
            console.print(f"  Completed scenes: {', '.join(completed)}")
        console.print()

    # Context metadata
    ctx_meta = scene_info.get("context_metadata", {})
    if ctx_meta.get("source_config"):
        console.print("[bold]Context Metadata[/bold]")
        console.print(f"  Source: {ctx_meta['source_config']}")
        console.print(f"  Version: {ctx_meta.get('version', '?')}")
        if ctx_meta.get("topic_context_summary"):
            console.print(f"  Topic summary: {ctx_meta['topic_context_summary'][:100]}...")
        console.print()

    # Stage feedback (actionable guidance for Sybil)
    if scene_info.get("stage_feedback"):
        console.print("[bold]Stage Feedback for Sybil[/bold]")
        console.print(f"  [cyan]{scene_info['stage_feedback']}[/cyan]")
        console.print()

    # Scene data
    scene_data = scene_info.get("scene_data", {})
    if scene_data:
        console.print("[bold]Scene Data (collected)[/bold]")
        tree = Tree("scene_data")
        _add_dict_to_tree(tree, scene_data)
        console.print(tree)


def _display_ui_state_info(ui_state_info: Dict[str, Any]):
    """Display UIState info with Rich formatting."""
    if ui_state_info.get("error"):
        console.print(f"[yellow]{ui_state_info['error']}[/yellow]")
        return

    console.print()
    console.print(Panel(
        f"[bold]UIState[/bold] v{ui_state_info.get('version', '?')}\n"
        f"[dim]Updated: {ui_state_info.get('updated_at', 'unknown')}[/dim]",
        title="Frame UI State",
        expand=False,
    ))
    console.print()

    # === Surfaces Summary Table ===
    table = Table(title="UI Surfaces")
    table.add_column("Surface", style="cyan")
    table.add_column("Status")
    table.add_column("Details")

    # Chat surface
    chat = ui_state_info.get("chat", {})
    chat_status = "✓ Active" if chat.get("components_count", 0) > 0 else "○ Empty"
    chat_details = f"{chat.get('components_count', 0)} components"
    if chat.get("typing_indicator"):
        chat_details += ", typing..."
    if chat.get("suggested_chips_count", 0) > 0:
        chat_details += f", {chat['suggested_chips_count']} chips"
    table.add_row("Chat", chat_status, chat_details)

    # Desk surface
    desk = ui_state_info.get("desk", {})
    desk_open = desk.get("is_open", False)
    desk_status = "[green]✓ Open[/green]" if desk_open else "[dim]○ Closed[/dim]"
    desk_details = f"{desk.get('components_count', 0)} components, {desk.get('views_count', 0)} views"
    if desk.get("active_view_title"):
        desk_details += f" (viewing: {desk['active_view_title']})"
    table.add_row("Desk", desk_status, desk_details)

    # Scene surface
    scene_surface = ui_state_info.get("scene_surface", {})
    scene_status = "○ Idle"
    scene_details = ""
    if scene_surface.get("has_spotlight"):
        scene_status = "[magenta]✓ Spotlight[/magenta]"
        spotlight = scene_surface.get("spotlight", {})
        if spotlight:
            scene_details = f"target: {spotlight.get('target', 'unknown')}"
    if scene_surface.get("narration_queue_length", 0) > 0:
        scene_status = "[cyan]✓ Narrating[/cyan]"
        scene_details = f"{scene_surface['narration_queue_length']} items in queue"
    if scene_surface.get("welcome_overlay_visible"):
        scene_details += " (welcome overlay)"
    table.add_row("Scene", scene_status, scene_details or "—")

    # Profile surface
    profile = ui_state_info.get("profile", {})
    profile_status = "✓ Loaded" if profile.get("evidence_count", 0) > 0 or profile.get("patterns_count", 0) > 0 else "○ Empty"
    profile_details = []
    if profile.get("evidence_count", 0) > 0:
        profile_details.append(f"{profile['evidence_count']} evidence")
    if profile.get("patterns_count", 0) > 0:
        profile_details.append(f"{profile['patterns_count']} patterns")
    if profile.get("journals_count", 0) > 0:
        profile_details.append(f"{profile['journals_count']} journals")
    if profile.get("documents_count", 0) > 0:
        profile_details.append(f"{profile['documents_count']} docs")
    table.add_row("Profile", profile_status, ", ".join(profile_details) if profile_details else "—")

    console.print(table)
    console.print()

    # === Navigation ===
    nav = ui_state_info.get("navigation", {})
    if nav.get("topics_count", 0) > 0:
        console.print("[bold]Navigation[/bold]")
        console.print(f"  Topics: {nav.get('topics_count', 0)}")
        console.print(f"  Active: [yellow]{nav.get('active_topic_id', 'none')}[/yellow]")
        if not nav.get("can_switch_topics", True):
            console.print(f"  [red]Topic switching disabled[/red]")
        if nav.get("locked_phase"):
            console.print(f"  Locked Phase: [cyan]{nav['locked_phase']}[/cyan]")

        # Show topic list
        topics = nav.get("topics", [])
        if topics:
            console.print("  Topics:")
            for t in topics[:5]:
                active = "→ " if t.get("id") == nav.get("active_topic_id") else "  "
                locked = " [locked]" if t.get("locked") else ""
                console.print(f"    {active}{t.get('title', t.get('id', '?'))}{locked}")
            if len(topics) > 5:
                console.print(f"    [dim]... and {len(topics) - 5} more[/dim]")
        console.print()

    # === Voice State ===
    voice = ui_state_info.get("voice", {})
    if voice:
        voice_state = voice.get("voice_state", "asleep")
        voice_active = voice.get("voice_mode_active", False)
        state_colors = {
            "asleep": "dim",
            "listening": "green",
            "speaking": "cyan",
            "thinking": "yellow",
            "error": "red",
        }
        console.print("[bold]Voice[/bold]")
        console.print(f"  State: [{state_colors.get(voice_state, 'dim')}]{voice_state}[/{state_colors.get(voice_state, 'dim')}]")
        console.print(f"  Voice Mode: {'[green]Active[/green]' if voice_active else '[dim]Inactive[/dim]'}")
        console.print()

    # === Suggested Chips ===
    chat = ui_state_info.get("chat", {})
    chips = chat.get("suggested_chips", [])
    if chips:
        console.print("[bold]Suggested Chips[/bold]")
        for chip in chips[:5]:
            label = chip.get("label", "?")
            action = chip.get("action", "")
            console.print(f"  • [cyan]{label}[/cyan] → {action}")
        console.print()

    # === Input Hints ===
    hints = chat.get("input_hints", [])
    if hints:
        console.print("[bold]Input Hints[/bold]")
        for hint in hints[:3]:
            console.print(f"  • {hint}")
        console.print()


def _add_dict_to_tree(tree: Tree, data: Dict[str, Any], max_depth: int = 3, depth: int = 0):
    """Recursively add dict contents to a Rich Tree."""
    if depth >= max_depth:
        tree.add("[dim]...[/dim]")
        return

    for key, value in data.items():
        if isinstance(value, dict):
            branch = tree.add(f"[cyan]{key}[/cyan]")
            _add_dict_to_tree(branch, value, max_depth, depth + 1)
        elif isinstance(value, list):
            branch = tree.add(f"[cyan]{key}[/cyan] [{len(value)} items]")
            for i, item in enumerate(value[:3]):  # Show first 3
                if isinstance(item, dict):
                    item_branch = branch.add(f"[{i}]")
                    _add_dict_to_tree(item_branch, item, max_depth, depth + 1)
                else:
                    branch.add(f"[{i}] {str(item)[:50]}")
            if len(value) > 3:
                branch.add(f"[dim]... and {len(value) - 3} more[/dim]")
        else:
            value_str = str(value)[:80]
            tree.add(f"[cyan]{key}:[/cyan] {value_str}")
