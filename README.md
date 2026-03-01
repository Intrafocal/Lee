# Lee Tools

Lee Editor and Hester AI Daemon - Terminal-native IDE with AI sidecar.

## Components

### Lee Editor (port 9001)
Terminal-native IDE built with Textual TUI framework.

- Code editor with syntax highlighting
- Terminal tabs
- DevOps dashboard for service management
- Git integration
- Diff view
- Hester AI integration

### Hester Daemon (port 9000)
AI-powered code exploration assistant using Gemini 3 Pro with a ReAct loop.

- File reading and searching
- Stateful sessions with Redis
- ReAct pattern for reasoning

## Installation

```bash
# Create/activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install in editable mode
pip install -e .
```

## Usage

```bash
# Start Hester daemon
hester daemon start

# Start Lee editor
lee

# Or with a workspace
lee --workspace ./myproject
```

## Configuration

Create `~/.config/lee/config.yaml` or `./lee.yaml`. See `lee/config.yaml` for an example.
