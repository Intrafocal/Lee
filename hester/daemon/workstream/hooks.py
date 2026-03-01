"""
Claude Code Hook Configuration Generator.

Generates .claude/settings.local.json and hook scripts that send
telemetry to the existing Hester daemon endpoints.

Claude Code hooks receive JSON via stdin (not env vars), so we need
small scripts to parse the input and forward to Hester.
"""

import json
from pathlib import Path
from typing import Any, Dict


# Hook script that parses stdin JSON and sends telemetry
TELEMETRY_HOOK_SCRIPT = '''#!/usr/bin/env python3
"""Claude Code hook script for Workstream telemetry."""
import sys
import json
import urllib.request

HESTER_URL = "{hester_url}"
WORKSTREAM_ID = "{workstream_id}"
TASK_ID = "{task_id}"

def send_telemetry(action: str, data: dict):
    """Send telemetry to Hester daemon."""
    payload = json.dumps({{
        "action": action,
        **data,
        "workstream_id": WORKSTREAM_ID,
        "metadata": {{
            "task_id": TASK_ID,
            **(data.get("metadata") or {{}})
        }}
    }}).encode()

    req = urllib.request.Request(
        f"{{HESTER_URL}}/orchestrate/telemetry",
        data=payload,
        headers={{"Content-Type": "application/json"}},
        method="POST"
    )
    try:
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # Don't let telemetry failures break Claude Code

def main():
    # Read JSON from stdin
    input_data = json.load(sys.stdin)

    session_id = input_data.get("session_id", "unknown")
    event = input_data.get("hook_event_name", "unknown")
    tool_name = input_data.get("tool_name")
    tool_input = input_data.get("tool_input", {{}})

    if event == "SessionStart":
        send_telemetry("register", {{
            "session_id": session_id,
            "agent_type": "claude_code",
            "status": "starting",
            "focus": "Starting Claude Code session",
        }})

    elif event == "PreToolUse":
        file_path = None
        if isinstance(tool_input, dict):
            file_path = tool_input.get("file_path") or tool_input.get("path")

        send_telemetry("update", {{
            "session_id": session_id,
            "status": "working",
            "tool": tool_name,
            "active_file": file_path,
            "metadata": {{
                "tool_input_preview": str(tool_input)[:200] if tool_input else None
            }}
        }})

    elif event == "PostToolUse":
        send_telemetry("update", {{
            "session_id": session_id,
            "status": "active",
            "tool": None,
            "metadata": {{
                "last_tool": tool_name,
            }}
        }})

    elif event == "Stop":
        send_telemetry("complete", {{
            "session_id": session_id,
            "status": "completed",
        }})

    # Output empty JSON to continue normally
    print(json.dumps({{"continue": True}}))

if __name__ == "__main__":
    main()
'''


def generate_hook_script(
    workstream_id: str,
    task_id: str,
    hester_url: str = "http://localhost:9000",
) -> str:
    """Generate the telemetry hook script content."""
    return TELEMETRY_HOOK_SCRIPT.format(
        hester_url=hester_url,
        workstream_id=workstream_id,
        task_id=task_id,
    )


def generate_claude_code_hooks(
    workstream_id: str,
    task_id: str,
) -> Dict[str, Any]:
    """
    Generate Claude Code hook configuration for Workstream telemetry.

    Returns a dict suitable for writing to .claude/settings.local.json.
    """
    hook_script = "$CLAUDE_PROJECT_DIR/.claude/hooks/workstream_telemetry.py"

    return {
        "hooks": {
            "SessionStart": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f'python3 "{hook_script}"',
                            "timeout": 5,
                        }
                    ]
                }
            ],
            "PreToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f'python3 "{hook_script}"',
                            "timeout": 5,
                        }
                    ]
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f'python3 "{hook_script}"',
                            "timeout": 5,
                        }
                    ]
                }
            ],
            "Stop": [
                {
                    "hooks": [
                        {
                            "type": "command",
                            "command": f'python3 "{hook_script}"',
                            "timeout": 5,
                        }
                    ]
                }
            ],
        }
    }


def setup_workstream_hooks(
    project_dir: Path,
    workstream_id: str,
    task_id: str,
    hester_url: str = "http://localhost:9000",
) -> None:
    """
    Set up Claude Code hooks for a Workstream task.

    Creates:
    - .claude/hooks/workstream_telemetry.py script
    - .claude/settings.local.json with hook configuration

    Uses settings.local.json so it doesn't get committed.
    """
    project_dir = Path(project_dir)
    claude_dir = project_dir / ".claude"
    hooks_dir = claude_dir / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)

    # Write hook script
    script_path = hooks_dir / "workstream_telemetry.py"
    script_content = generate_hook_script(workstream_id, task_id, hester_url)
    script_path.write_text(script_content)
    script_path.chmod(0o755)

    # Write settings (local only, not committed)
    settings_path = claude_dir / "settings.local.json"
    settings = generate_claude_code_hooks(workstream_id, task_id)
    settings_path.write_text(json.dumps(settings, indent=2))
