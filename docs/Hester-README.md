# Hester

The Internal Daemon for Coefficiency. Sybil's infrastructure, applied to the system domain.

Watchful, practical, no BS.

## Capabilities

- **HesterQA** (Phase 1): Scene testing via simulated conversation
- **HesterIdeas** (Phase 3): Idea capture from any format
- **HesterBrief** (Phase 4): Daily summaries for business team
- **HesterDocs** (Phase 5): Documentation sync and semantic search

## Installation

```bash
pip install -e ./hester
```

## Usage

```bash
# Test a scene
hester qa scene welcome --verbose

# Start Chrome for testing
hester qa start-browser

# List available scenes
hester qa list-scenes

# List test personas
hester qa list-personas
```

## Development

Requires Chrome installed for browser automation testing.
