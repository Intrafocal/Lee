# Hester Context Bundles

> Reusable, AI-synthesized context packages for rapid knowledge injection.

## Overview

**Context Bundles** are dynamic, AI-synthesized markdown documents that aggregate relevant information from multiple sources (files, grep patterns, semantic search, database schemas) into portable knowledge packages. They solve the problem of repeatedly gathering the same context when working on related tasks.

### Key Properties

| Property | Description |
|----------|-------------|
| **Dynamic** | Sources are specifications, not snapshots—bundles can be refreshed |
| **Synthesized** | AI summarizes raw sources into scannable reference material |
| **Local** | Stored in `.hester/context/`, not version controlled |
| **TTL-based** | Bundles go stale and prompt user for refresh/prune decisions |
| **Portable** | Plain markdown files usable in any editor or AI tool |

### Use Cases

1. **Repeated Context**: "I keep explaining the auth system to Claude"
2. **Onboarding**: "New dev needs to understand matching service"
3. **Cross-cutting Concerns**: "Security patterns across all services"
4. **Investigation Aid**: "Everything related to this bug"

## Architecture

### File Structure

```
.hester/
├── context/
│   ├── bundles/                    # Synthesized markdown (portable)
│   │   ├── matching-algo.md
│   │   ├── auth-flow.md
│   │   └── deploy-pipeline.md
│   └── .meta/                      # Source specs + hashes (machinery)
│       ├── matching-algo.yaml
│       ├── auth-flow.yaml
│       └── deploy-pipeline.yaml
└── tasks/                          # Existing task system
    └── ...
```

### Bundle Markdown Format

```markdown
---
id: matching-algo
title: Matching Algorithm Context
created: 2026-01-03T10:00:00Z
updated: 2026-01-03T12:30:00Z
ttl_hours: 24
tags: [matching, embeddings, vector-search]
---

# Matching Algorithm

## Summary
[AI-synthesized 2-3 sentence overview]

## Key Files
- `services/matching/src/embeddings.py` - Embedding generation
- `services/matching/src/search.py` - Vector similarity search

## Architecture
[How components connect]

## Patterns
[Common patterns found in the code]

## Gotchas
[Non-obvious things to know]
```

### Meta File Format

```yaml
# .hester/context/.meta/matching-algo.yaml
id: matching-algo
title: Matching Algorithm Context
created: 2026-01-03T10:00:00Z
updated: 2026-01-03T12:30:00Z
ttl_hours: 24
tags:
  - matching
  - embeddings
  - vector-search

sources:
  - type: file
    path: services/matching/src/embeddings.py
    content_hash: a1b2c3d4...

  - type: glob
    pattern: "services/matching/**/*.py"
    exclude: ["**/test_*", "**/__pycache__"]
    paths_hash: e5f6g7h8...

  - type: grep
    pattern: "cosine_similarity|vector_search"
    paths: ["services/", "shared/"]
    context_lines: 2
    matches_hash: i9j0k1l2...

  - type: semantic
    query: "How does the matching algorithm work?"
    limit: 5
    min_similarity: 0.6
    results_hash: m3n4o5p6...

  - type: db_schema
    tables: ["matches", "profiles"]
    include_rls: false
    schema_hash: q7r8s9t0...

bundle_content_hash: u1v2w3x4...
```

## Source Types

| Type | Spec Fields | Evaluation | Change Detection |
|------|-------------|------------|------------------|
| `file` | `path` | Read single file | SHA256 of content |
| `glob` | `pattern`, `exclude` | Expand pattern, read all | Hash of sorted paths + contents |
| `grep` | `pattern`, `paths`, `context_lines` | Run grep tool | Hash of match count + content |
| `semantic` | `query`, `limit`, `min_similarity` | Search doc_embeddings | Hash of result IDs + scores |
| `db_schema` | `tables`, `include_rls` | Query table structure via MCP | Hash of schema JSON |
| `web` | `url`, `selector` (future) | Fetch + extract | Hash of extracted content |

## Refresh Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     BUNDLE REFRESH FLOW                          │
│                                                                  │
│  1. EVALUATE SOURCES                                             │
│     ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│     │  file    │  │   glob   │  │   grep   │  │ semantic │     │
│     │  read    │  │  expand  │  │  search  │  │  search  │     │
│     └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│          │             │             │             │            │
│          └─────────────┴──────┬──────┴─────────────┘            │
│                               ▼                                  │
│  2. DETECT CHANGES                                               │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │  Compare content hashes from meta file                  │ │
│     │  • New files found in glob?                             │ │
│     │  • File contents changed?                               │ │
│     │  • Grep matches different?                              │ │
│     │  • Semantic results shifted?                            │ │
│     └────────────────────────┬────────────────────────────────┘ │
│                              │                                   │
│             ┌────────────────┴────────────────┐                 │
│             │ Changes detected?               │                 │
│             └────────────────┬────────────────┘                 │
│                        yes   │   no                              │
│                  ┌───────────┴────────┐                         │
│                  ▼                    ▼                          │
│  3. RE-SYNTHESIZE          (update timestamp only)              │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │  Collect all source content                             │ │
│     │  Pass to summarize tool with synthesis prompt           │ │
│     │  Generate new markdown body                             │ │
│     └────────────────────────┬────────────────────────────────┘ │
│                              ▼                                   │
│  4. UPDATE FILES                                                 │
│     ┌─────────────────────────────────────────────────────────┐ │
│     │  • Write bundles/<id>.md with new content               │ │
│     │  • Update .meta/<id>.yaml with new hashes               │ │
│     │  • Re-index bundle in doc_embeddings                    │ │
│     └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Staleness & TTL

### TTL Behavior

| `ttl_hours` | Behavior |
|-------------|----------|
| `0` | Manual refresh only, never marked stale |
| `24` (default) | Stale after 24 hours since last refresh |
| `168` | Stale after 1 week |

### Staleness States

```python
@dataclass
class BundleStatus:
    id: str
    title: str
    updated: datetime
    ttl_hours: int

    @property
    def age_hours(self) -> float:
        delta = datetime.utcnow() - self.updated
        return delta.total_seconds() / 3600

    @property
    def is_stale(self) -> bool:
        if self.ttl_hours == 0:
            return False
        return self.age_hours > self.ttl_hours

    @property
    def staleness_label(self) -> str:
        if not self.is_stale:
            return "OK"
        age = self.age_hours
        if age < 48:
            return f"STALE {int(age)}h"
        return f"STALE {int(age / 24)}d"
```

## Lee Integration

### Staleness Notification

When opening a stale bundle in Lee, show an action bar:

```
┌─────────────────────────────────────────────────────────────────┐
│  matching-algo.md                               [STALE 2d]  ◉   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  # Matching Algorithm                                            │
│                                                                  │
│  ## Summary                                                      │
│  The matching service uses 768-dimensional embeddings...         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  ⚠ Bundle is 2 days old. Sources may have changed.              │
│                                                                  │
│  [R]efresh   [P]rune   [I]gnore   [D]isable TTL                 │
└─────────────────────────────────────────────────────────────────┘
```

### Actions

| Key | Action | Description |
|-----|--------|-------------|
| `R` | Refresh | Re-evaluate sources, re-synthesize if changed |
| `P` | Prune | Delete this bundle entirely |
| `I` | Ignore | Dismiss notification, ask again next session |
| `D` | Disable TTL | Set `ttl_hours: 0`, manual refresh only |

### Bundle Browser (`Ctrl+B`)

Quick access to browse and inject bundles:

```
┌─────────────────────────────────────────────────────────────────┐
│  Context Bundles                                        [?] Help │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  > matching-algo      [OK]       Matching Algorithm Context     │
│    auth-flow          [STALE 1d] Authentication Flow            │
│    deploy-pipeline    [STALE 7d] CI/CD Pipeline                 │
│    frontend-arch      [OK]       Frontend Architecture          │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  [Enter] Open   [C]opy to clipboard   [I]nject to Hester        │
│  [N]ew bundle   [R]efresh selected    [D]elete                  │
└─────────────────────────────────────────────────────────────────┘
```

### Context Injection

When user presses `I` (Inject), the bundle content is added to the current Hester context, similar to `Ctrl+S` for code selection.

## CLI Commands

### Bundle Management

```bash
# Create bundle interactively (guided prompts)
hester context create

# Create bundle with name
hester context create matching-algo

# Create with sources in one command
hester context create auth-flow \
  --file "services/api/src/auth/*.py" \
  --grep "verify_token|refresh_token" \
  --semantic "authentication flow" \
  --ttl 48

# List all bundles with status
hester context list
# Output:
#   ID                 STATUS      SOURCES  UPDATED
#   matching-algo      [OK]        5        2026-01-03 12:30
#   auth-flow          [STALE 1d]  3        2026-01-02 08:00
#   deploy-pipeline    [STALE 7d]  2        2025-12-27 14:00

# Show bundle content
hester context show matching-algo

# Show bundle metadata (sources, hashes)
hester context show matching-algo --meta
```

### Source Management

```bash
# Add sources to existing bundle
hester context add matching-algo --file "shared/embeddings/*.py"
hester context add matching-algo --grep "vector" --paths "services/"
hester context add matching-algo --semantic "embedding generation"
hester context add matching-algo --db-schema matches,profiles

# Remove a source (by index from --meta output)
hester context remove-source matching-algo 2
```

### Refresh & Maintenance

```bash
# Refresh specific bundle
hester context refresh matching-algo

# Refresh all stale bundles
hester context refresh --stale

# Refresh all bundles (force)
hester context refresh --all

# Check staleness without refreshing
hester context status

# Prune (delete) a bundle
hester context prune matching-algo

# Prune all bundles older than N days
hester context prune --older-than 30
```

### Export & Clipboard

```bash
# Copy bundle content to clipboard
hester context copy matching-algo

# Export to file
hester context export matching-algo -o ./context-for-claude.md

# Export as JSON (for programmatic use)
hester context export matching-algo --format json
```

### Daemon Integration

```bash
# In daemon chat mode, bundles are available as tools
hester daemon chat

> build a context bundle for the auth system
# Hester uses build_context_bundle tool

> what bundles do I have?
# Hester uses list_context_bundles tool

> inject the matching-algo bundle
# Hester uses get_context_bundle tool, adds to conversation context
```

## Synthesis Strategy

### Prompt Template

```python
BUNDLE_SYNTHESIS_PROMPT = """You are creating a Context Bundle—a concise reference document for developers.

**Bundle Title:** {title}

**Sources Collected:**

{sources_content}

---

**Instructions:**

Create a markdown document optimized for:
1. Quick scanning (busy developers)
2. Copy-paste into AI tools (Claude, ChatGPT, Cursor)
3. Understanding unfamiliar code areas

**Required Sections:**

## Summary
2-3 sentences. What is this? Why does it matter?

## Key Files
Bullet list of most important files with one-line descriptions.
Format: `path/to/file.py` - What it does

## Architecture
How do the components connect? Include a simple ASCII diagram if helpful.

## Patterns
Common patterns, conventions, or idioms found in this code.

## Gotchas
Non-obvious things. Edge cases. "I wish someone told me this."

---

**Style Guidelines:**
- Be concise. This is reference material, not documentation.
- Use code formatting for paths, functions, classes.
- Prefer bullet points over paragraphs.
- Include actual code snippets only if they're essential patterns.
- Skip sections if not applicable (e.g., no Gotchas found).
"""
```

### Source Content Formatting

Each source type formats its content for the synthesis prompt:

```python
def format_file_source(path: str, content: str) -> str:
    return f"""### File: `{path}`

```
{content[:2000]}{"..." if len(content) > 2000 else ""}
```
"""

def format_grep_source(pattern: str, matches: List[GrepMatch]) -> str:
    formatted = f"### Grep: `{pattern}`\n\n"
    for match in matches[:20]:
        formatted += f"**{match.file}:{match.line}**\n```\n{match.context}\n```\n\n"
    return formatted

def format_semantic_source(query: str, results: List[SearchResult]) -> str:
    formatted = f"### Semantic Search: \"{query}\"\n\n"
    for result in results:
        formatted += f"**{result.file_path}** (similarity: {result.similarity:.2f})\n"
        formatted += f"> {result.chunk_text[:500]}...\n\n"
    return formatted

def format_db_schema_source(tables: List[str], schema: Dict) -> str:
    formatted = "### Database Schema\n\n"
    for table in tables:
        formatted += f"**{table}**\n```sql\n{schema[table]}\n```\n\n"
    return formatted
```

## Data Models

### Core Models

```python
# lee/hester/context/models.py

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel

class SourceType(str, Enum):
    FILE = "file"
    GLOB = "glob"
    GREP = "grep"
    SEMANTIC = "semantic"
    DB_SCHEMA = "db_schema"
    WEB = "web"  # Future

class FileSource(BaseModel):
    type: SourceType = SourceType.FILE
    path: str
    content_hash: str = ""

class GlobSource(BaseModel):
    type: SourceType = SourceType.GLOB
    pattern: str
    exclude: List[str] = []
    paths_hash: str = ""

class GrepSource(BaseModel):
    type: SourceType = SourceType.GREP
    pattern: str
    paths: List[str] = ["."]
    context_lines: int = 2
    matches_hash: str = ""

class SemanticSource(BaseModel):
    type: SourceType = SourceType.SEMANTIC
    query: str
    limit: int = 5
    min_similarity: float = 0.6
    results_hash: str = ""

class DbSchemaSource(BaseModel):
    type: SourceType = SourceType.DB_SCHEMA
    tables: List[str]
    include_rls: bool = False
    schema_hash: str = ""

SourceSpec = Union[FileSource, GlobSource, GrepSource, SemanticSource, DbSchemaSource]

class BundleMetadata(BaseModel):
    id: str
    title: str
    created: datetime
    updated: datetime
    ttl_hours: int = 24
    tags: List[str] = []
    sources: List[SourceSpec] = []
    bundle_content_hash: str = ""

class ContextBundle(BaseModel):
    """Full bundle with metadata and content."""
    metadata: BundleMetadata
    content: str  # Synthesized markdown body

    def to_markdown(self) -> str:
        """Render full markdown file with frontmatter."""
        ...

    @classmethod
    def from_markdown(cls, content: str, meta_path: Path) -> "ContextBundle":
        """Parse bundle from markdown + meta file."""
        ...
```

## Service Layer

```python
# lee/hester/context/service.py

class ContextBundleService:
    """
    Service for managing Context Bundles.

    Coordinates:
    - Source evaluation (file reads, grep, semantic search)
    - Change detection via content hashing
    - AI synthesis via summarize tool
    - Persistence to .hester/context/
    - Embedding indexing via DocEmbeddingService
    """

    def __init__(
        self,
        working_dir: Path,
        summarize_fn: Callable[[str], Awaitable[str]],
        doc_embedding_service: Optional[DocEmbeddingService] = None,
    ):
        self.working_dir = working_dir
        self.bundles_dir = working_dir / ".hester" / "context" / "bundles"
        self.meta_dir = working_dir / ".hester" / "context" / ".meta"
        self.summarize = summarize_fn
        self.doc_service = doc_embedding_service

    async def create(
        self,
        bundle_id: str,
        title: str,
        sources: List[SourceSpec],
        ttl_hours: int = 24,
        tags: List[str] = [],
    ) -> ContextBundle:
        """Create a new bundle from source specifications."""
        ...

    async def refresh(
        self,
        bundle_id: str,
        force: bool = False,
    ) -> RefreshResult:
        """
        Refresh a bundle by re-evaluating sources.

        Returns:
            RefreshResult with changed=True if content was updated
        """
        ...

    async def refresh_stale(self) -> List[RefreshResult]:
        """Refresh all stale bundles."""
        ...

    def get(self, bundle_id: str) -> Optional[ContextBundle]:
        """Load a bundle by ID."""
        ...

    def list_all(self) -> List[BundleStatus]:
        """List all bundles with staleness status."""
        ...

    def delete(self, bundle_id: str) -> bool:
        """Delete a bundle and its metadata."""
        ...

    async def add_source(
        self,
        bundle_id: str,
        source: SourceSpec,
    ) -> ContextBundle:
        """Add a source to existing bundle and refresh."""
        ...

    async def _evaluate_source(
        self,
        source: SourceSpec,
    ) -> Tuple[str, str]:
        """
        Evaluate a source specification.

        Returns:
            Tuple of (formatted_content, content_hash)
        """
        ...

    async def _synthesize(
        self,
        title: str,
        sources_content: str,
    ) -> str:
        """Generate synthesized markdown via summarize tool."""
        ...

    async def _index_bundle(self, bundle: ContextBundle) -> None:
        """Index bundle in doc_embeddings for semantic search."""
        ...
```

## Implementation Plan

### Phase 1: Core Bundle System

**Files to create:**
- `lee/hester/context/__init__.py`
- `lee/hester/context/models.py` - Data models
- `lee/hester/context/service.py` - Core service
- `lee/hester/context/sources.py` - Source evaluators

**CLI commands:**
- `hester context create`
- `hester context list`
- `hester context show`
- `hester context refresh`
- `hester context prune`
- `hester context copy`

**Integration:**
- Wire up to existing `summarize` tool
- Add to CLI in `lee/hester/cli.py`

### Phase 2: Daemon Tools

**Files to modify:**
- `lee/hester/daemon/tools/` - Add context bundle tools

**Tools to add:**
- `build_context_bundle` - Create bundle via ReAct
- `get_context_bundle` - Retrieve bundle content
- `list_context_bundles` - List available bundles
- `refresh_context_bundle` - Refresh specific bundle

### Phase 3: Lee Integration

**Files to modify:**
- `lee/editor/` - Add bundle browser widget
- `lee/editor/` - Add staleness indicator

**Features:**
- `Ctrl+B` - Bundle browser popup
- Staleness notification bar
- Inject to Hester action

### Phase 4: Auto-refresh & Notifications

**Features:**
- Background refresh of stale bundles (optional daemon task)
- Lee notification when bundle is refreshed
- Configurable auto-refresh behavior

## Testing Strategy

### Unit Tests

```python
# tests/unit/test_context_bundles.py

class TestSourceEvaluation:
    async def test_file_source_hash_changes_on_content_change(self):
        ...

    async def test_glob_source_detects_new_files(self):
        ...

    async def test_grep_source_hash_changes_on_match_change(self):
        ...

class TestBundleRefresh:
    async def test_refresh_skips_when_unchanged(self):
        ...

    async def test_refresh_resynthesizes_when_changed(self):
        ...

    async def test_staleness_calculation(self):
        ...

class TestBundlePersistence:
    async def test_roundtrip_markdown_meta(self):
        ...

    async def test_handles_missing_meta_file(self):
        ...
```

### Integration Tests

```python
# tests/integration/test_context_bundles.py

class TestContextBundleWorkflow:
    async def test_create_refresh_prune_lifecycle(self):
        ...

    async def test_semantic_source_uses_doc_embeddings(self):
        ...

    async def test_bundle_indexed_for_search(self):
        ...
```

## Configuration

### Default Settings

```yaml
# .hester/config.yaml (future)

context:
  default_ttl_hours: 24
  auto_refresh: false  # If true, daemon refreshes stale bundles
  max_sources_per_bundle: 20
  max_source_content_chars: 50000
  synthesis_model: "gemini-2.5-flash"  # For summarize tool
```

## Security Considerations

1. **Local Only**: Bundles stored in `.hester/` which should be gitignored
2. **No Secrets**: Sources should not include `.env`, credentials, etc.
3. **Content Limits**: Max content size to prevent memory issues
4. **Path Validation**: Source paths validated to stay within repo

## Claude Code Skill Integration

A Claude Code skill (`/bundle`) enables users to create and use context bundles directly from Claude Code, with Claude orchestrating the bundle creation through Hester.

### Skill Commands

| Command | Description |
|---------|-------------|
| `/bundle create [name]` | Create a new bundle interactively |
| `/bundle use <name>` | Load bundle into conversation context |
| `/bundle list` | List all bundles with status |
| `/bundle show <name>` | Display bundle content |
| `/bundle refresh [name\|--stale]` | Refresh bundle(s) |
| `/bundle save` | Save current conversation context as bundle |
| `/bundle copy <name>` | Copy bundle to clipboard |

### Interactive Bundle Creation

```
> /bundle create auth-system

Claude: I'll help you create a context bundle for the auth system. Let me
        explore the codebase to find relevant sources...

        [Searches for auth-related files, patterns, docs]

        I found these potential sources:

        **Files (12 matches):**
        - services/api/src/auth/*.py
        - frontend/auth_utils.py
        - shared/auth/jwt.py

        **Grep matches (8):**
        - Pattern: "JWT|verify_token|refresh_token"

        **Semantic matches (3):**
        - "authentication flow" in docs/

        **Database tables:**
        - auth.users, public.profiles

        Should I include all of these, or would you like to refine?

> Include files and grep, skip semantic, add the user_api_keys table

Claude: Got it. Creating bundle with:
        - 12 files matching auth patterns
        - 8 grep matches for JWT/token patterns
        - Tables: auth.users, public.profiles, public.user_api_keys

        TTL: 24 hours (default). Change? [Enter to accept]

> 48

Claude: Creating auth-system bundle with 48-hour TTL...

        [Evaluates sources]
        [Synthesizes with AI]
        [Writes to .hester/context/bundles/auth-system.md]

        Done! Bundle created with:
        - 5 key files identified
        - 3 architectural patterns documented
        - 2 gotchas noted

        Use `/bundle use auth-system` to load it, or
        `/bundle show auth-system` to preview.
```

### Using Bundles in Conversation

```
> /bundle use matching-algo

Claude: [Loads bundle content into conversation context]

        I've loaded the **Matching Algorithm** context. Key points:

        - Uses 768-dimensional embeddings via text-embedding-004
        - Vector similarity search with pgvector
        - Key files: services/matching/src/embeddings.py, search.py
        - Gotcha: Batch size limit of 100 for embedding generation

        What would you like to know or work on?

> Why is the matching slow for large result sets?

Claude: Based on the matching-algo context, there are a few likely causes...
        [Uses bundle context to give informed answer]
```

### Saving Conversation Context

The `/bundle save` command extracts context from the current conversation:

```
> [After 30 minutes working on auth system]

> /bundle save

Claude: Based on our conversation, I can create a bundle capturing:

        **Files Discussed:**
        - `services/api/src/auth/jwt.py` - JWT generation/verification
        - `services/api/src/auth/middleware.py` - Auth middleware
        - `frontend/auth_utils.py` - Session helpers
        - `shared/database/client.py` - RLS enforcement

        **Patterns Identified:**
        - ES256 JWT with Supabase Auth ID as `sub` claim
        - 1-hour token expiration, no refresh tokens
        - RLS policy enforcement via `request.jwt.claims`
        - Profile created on-demand, not at signup

        **Key Decisions Made:**
        - No HS256 fallback (security requirement)
        - Django User syncs with Supabase Auth User
        - JWT validation happens at API Gateway level

        **Gotchas Noted:**
        - Local Supabase keys change on restart
        - Must use service key for RLS bypass in tests

        ---

        Suggested name: `auth-jwt-implementation`
        TTL: 48 hours

        Create this bundle? [Y/n]

> y

Claude: Bundle saved to `.hester/context/bundles/auth-jwt-implementation.md`

        This captures our session's context for future reference.
        Use `/bundle use auth-jwt-implementation` to reload it.
```

### Skill Implementation

The skill calls Hester's CLI under the hood:

```markdown
# .claude/skills/bundle.md

name: bundle
description: Create and use Hester context bundles for reusable knowledge

commands:
  create:
    description: Create a new context bundle
    usage: /bundle create [name]

  use:
    description: Load bundle into conversation
    usage: /bundle use <name>

  list:
    description: List all bundles
    usage: /bundle list

  show:
    description: Display bundle content
    usage: /bundle show <name>

  refresh:
    description: Refresh bundle(s)
    usage: /bundle refresh [name|--stale]

  save:
    description: Save conversation context as bundle
    usage: /bundle save

  copy:
    description: Copy bundle to clipboard
    usage: /bundle copy <name>
```

### Implementation Notes

**For CREATE:**
1. Explore codebase to suggest relevant sources
2. Present findings and ask user to confirm/refine
3. Run: `hester context create <name> --file "..." --grep "..." --ttl N`
4. Report success and bundle summary

**For USE:**
1. Run: `hester context show <name>`
2. Parse the markdown content
3. Include as system context for remainder of conversation
4. Summarize key points for user

**For SAVE:**
1. Analyze conversation history for:
   - Files read or discussed
   - Code patterns identified
   - Decisions made
   - Problems solved
2. Generate source specs from conversation artifacts
3. Suggest bundle name and TTL
4. Run: `hester context create <name> ...`

**For LIST/SHOW/REFRESH/COPY:**
1. Direct passthrough to `hester context <command>`
2. Format output nicely for conversation

### Cross-Tool Workflow

Context bundles bridge multiple tools:

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONTEXT BUNDLE ECOSYSTEM                      │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Claude Code  │    │     Lee      │    │   Hester     │      │
│  │              │    │              │    │   Daemon     │      │
│  │ /bundle use  │    │   Ctrl+B     │    │              │      │
│  │ /bundle save │    │   browser    │    │  ReAct tools │      │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘      │
│         │                   │                   │               │
│         └───────────────────┼───────────────────┘               │
│                             │                                    │
│                             ▼                                    │
│              ┌─────────────────────────────┐                    │
│              │   .hester/context/bundles/  │                    │
│              │                             │                    │
│              │   matching-algo.md          │                    │
│              │   auth-system.md            │                    │
│              │   deploy-pipeline.md        │                    │
│              └─────────────────────────────┘                    │
│                             │                                    │
│                             ▼                                    │
│              ┌─────────────────────────────┐                    │
│              │  Portable Markdown Files    │                    │
│              │                             │                    │
│              │  • Copy to any AI tool      │                    │
│              │  • Open in any editor       │                    │
│              │  • Share via file transfer  │                    │
│              └─────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 5: Claude Code Skill

**Files to create:**
- `.claude/skills/bundle.md` - Skill definition
- `lee/hester/context/conversation.py` - Conversation context extraction

**Features:**
- `/bundle create` - Interactive bundle creation with codebase exploration
- `/bundle use` - Load bundle into Claude conversation
- `/bundle save` - Extract and save conversation context
- `/bundle list|show|refresh|copy` - Passthrough to Hester CLI

**Integration:**
- Parse conversation history for file references
- Generate source specs from discussed patterns
- Format bundle content for Claude context injection

## Future Enhancements

1. **Web Sources**: Fetch external documentation, API docs
2. **Bundle Sharing**: Export/import bundles between team members
3. **Bundle Templates**: Pre-defined source patterns for common contexts
4. **Smart Suggestions**: "You often search for X, create a bundle?"
5. **Version History**: Track bundle changes over time
6. **Conditional Sources**: Sources that only evaluate under certain conditions
7. **Claude Memory Integration**: Auto-suggest bundles based on Claude's memory of past sessions
