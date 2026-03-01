# Hester Proactive Knowledge Management

> Anticipatory context loading - Hester prepares knowledge before you ask.

## Overview

**Proactive Knowledge Management** transforms Hester from a reactive assistant into an anticipatory one. Instead of loading context when a request comes in, Hester continuously watches Lee context and conversation history, pre-loading relevant knowledge so it's instantly available when needed.

### Core Principle

```
Traditional:  User asks → Search for context → Load → Respond (slow)
Proactive:    Context shifts → Pre-load knowledge → User asks → Respond (instant)
```

### Key Properties

| Property | Description |
|----------|-------------|
| **Anticipatory** | Context loaded before requests, based on Lee state |
| **Redis-backed** | Sub-millisecond access to embeddings and content |
| **Dual-source** | Searches both context bundles (curated) and docs (auto-indexed) |
| **Status-bar driven** | All notifications via Lee status bar |
| **Non-blocking** | Background processing, never interrupts user flow |

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROACTIVE KNOWLEDGE ENGINE                           │
│                                                                              │
│   ┌──────────────────┐                                                       │
│   │ Lee Context      │──┐                                                    │
│   │ (WebSocket)      │  │                                                    │
│   └──────────────────┘  │    ┌────────────────────┐                         │
│                         ├───►│  Context Watcher   │                         │
│   ┌──────────────────┐  │    │  (debounced)       │                         │
│   │ Conversation     │──┘    └─────────┬──────────┘                         │
│   │ History          │                 │                                     │
│   └──────────────────┘                 ▼                                     │
│                              ┌─────────────────────┐                        │
│   ┌──────────────────┐       │  Embed current      │                        │
│   │ Git Watcher      │──────►│  context/query      │                        │
│   │ (10 min poll)    │       └─────────┬───────────┘                        │
│   └──────────────────┘                 │                                     │
│                                        ▼                                     │
│   ┌──────────────────┐       ┌─────────────────────┐                        │
│   │ Task Watcher     │──────►│   Redis Knowledge   │◄──── Bundle embeddings │
│   │ (ClaudeDelegate) │       │   Store             │◄──── Doc embeddings    │
│   └──────────────────┘       └─────────┬───────────┘      (synced at start) │
│                                        │                                     │
│                           ┌────────────┴────────────┐                       │
│                           ▼                         ▼                        │
│                 ┌─────────────────┐       ┌─────────────────┐               │
│                 │  Bundle Match   │       │   Doc Match     │               │
│                 │  (high conf)    │       │   (fallback)    │               │
│                 └────────┬────────┘       └────────┬────────┘               │
│                          │                         │                         │
│                          ▼                         ▼                         │
│                 ┌─────────────────────────────────────────┐                 │
│                 │            Warm Context Buffer          │                 │
│                 │  hester:session:{id}:warm               │                 │
│                 └────────────────────┬────────────────────┘                 │
│                                      │                                       │
│                                      ▼                                       │
│                          ┌─────────────────────┐                            │
│                          │   Status Bar Push   │                            │
│                          │   "Loaded: auth..." │                            │
│                          └─────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
daemon/
├── knowledge/
│   ├── __init__.py
│   ├── engine.py           # Main orchestrator - watches triggers, coordinates loading
│   ├── store.py            # Redis-backed unified knowledge store
│   ├── router.py           # Semantic matching against bundles and docs
│   ├── buffer.py           # Warm context buffer management
│   ├── git_watcher.py      # 10-min git status polling
│   └── task_watcher.py     # ClaudeDelegate completion hooks
```

## Triggers

The Knowledge Engine responds to these triggers (no user request needed):

| Trigger | Source | Action |
|---------|--------|--------|
| **File opened** | Lee WebSocket | Match file path + content against bundles/docs |
| **Tab switched** | Lee WebSocket | Re-evaluate based on new tab type (git, docker, etc.) |
| **Idle 30s on file** | Lee WebSocket | Check if file has docs, suggest creation if not |
| **Conversation shift** | Chat history | Detect topic change, pre-load relevant context |
| **Git poll (10 min)** | Background task | Detect new code, suggest docs/commits |
| **Task complete** | ClaudeDelegate | Detect significant new code, suggest documentation |

### Trigger Debouncing

To avoid thrashing, triggers are debounced:

```python
DEBOUNCE_CONFIG = {
    "file_open": 500,       # ms - wait for file to settle
    "tab_switch": 300,      # ms - rapid switching ignored
    "conversation": 2000,   # ms - wait for typing to finish
    "idle_check": 30000,    # ms - 30s idle before doc suggestion
}
```

## Redis Knowledge Store

### Why Redis?

| Concern | File/Supabase | Redis |
|---------|---------------|-------|
| **Lookup speed** | 10-200ms | <1ms |
| **Embedding search** | Network round-trip | In-memory NumPy |
| **Cross-session** | Reload each time | Persistent, instant |
| **TTL/expiry** | Manual | Native support |

### Schema

```python
# ═══════════════════════════════════════════════════════════════════════════
# CONTEXT BUNDLES (user-curated knowledge packages)
# ═══════════════════════════════════════════════════════════════════════════

hester:bundle:{id}:meta       → JSON {
                                  id: str,
                                  title: str,
                                  tags: List[str],
                                  ttl_hours: int,
                                  created: ISO timestamp,
                                  updated: ISO timestamp,
                                  sources: List[SourceSpec],
                                  content_hash: str,
                                }

hester:bundle:{id}:content    → String (synthesized markdown body)

hester:bundle:{id}:embedding  → Binary (768-dim float32 vector)

hester:bundles:index          → Set of all bundle IDs


# ═══════════════════════════════════════════════════════════════════════════
# DOC EMBEDDINGS (auto-indexed documentation, synced from Supabase)
# ═══════════════════════════════════════════════════════════════════════════

hester:doc:{hash}:meta        → JSON {
                                  repo_name: str,
                                  file_path: str,
                                  chunk_index: int,
                                  heading: str,
                                  content_hash: str,
                                }

hester:doc:{hash}:chunk       → String (chunk text, ~500 tokens)

hester:doc:{hash}:embedding   → Binary (768-dim float32 vector)

hester:docs:index             → Set of all chunk hashes

hester:docs:by_file:{path}    → Set of chunk hashes for that file path

hester:docs:last_sync         → ISO timestamp of last Supabase sync


# ═══════════════════════════════════════════════════════════════════════════
# WARM CONTEXT BUFFER (per-session pre-loaded context)
# ═══════════════════════════════════════════════════════════════════════════

hester:session:{id}:warm      → JSON {
                                  bundles: [
                                    {id: str, score: float, loaded_at: ISO}
                                  ],
                                  docs: [
                                    {hash: str, file_path: str, score: float}
                                  ],
                                  trigger: str,  # "file:auth.py" or "topic:authentication"
                                  updated: ISO timestamp,
                                }


# ═══════════════════════════════════════════════════════════════════════════
# GIT WATCHER STATE
# ═══════════════════════════════════════════════════════════════════════════

hester:git:last_poll          → ISO timestamp

hester:git:last_status        → JSON {
                                  files_changed: List[str],
                                  files_added: List[str],
                                  uncommitted_count: int,
                                  last_commit: str,
                                  last_commit_time: ISO timestamp,
                                }
```

### Sync Strategies

**Bundle Sync (File → Redis):**
```python
# On daemon startup
async def sync_bundles_to_redis():
    bundles_dir = Path(".hester/context/bundles/")
    for md_file in bundles_dir.glob("*.md"):
        bundle = load_bundle_from_file(md_file)

        # Generate embedding if not cached or content changed
        cached_hash = redis.hget(f"hester:bundle:{bundle.id}:meta", "content_hash")
        if cached_hash != bundle.content_hash:
            embedding = await generate_embedding(bundle.content)
            redis.set(f"hester:bundle:{bundle.id}:embedding", embedding.tobytes())

        redis.set(f"hester:bundle:{bundle.id}:meta", bundle.meta.json())
        redis.set(f"hester:bundle:{bundle.id}:content", bundle.content)
        redis.sadd("hester:bundles:index", bundle.id)
```

**Doc Sync (Supabase → Redis):**
```python
# On daemon startup + every 30 minutes
async def sync_docs_from_supabase():
    last_sync = redis.get("hester:docs:last_sync") or "1970-01-01"

    # Incremental sync - only fetch updated docs
    docs = supabase.schema("hester").table("doc_embeddings") \
        .select("*") \
        .gt("updated_at", last_sync) \
        .execute()

    for doc in docs.data:
        hash_key = f"{doc['repo_name']}:{doc['file_path']}:{doc['chunk_index']}"
        hash_id = hashlib.md5(hash_key.encode()).hexdigest()

        redis.set(f"hester:doc:{hash_id}:meta", json.dumps({
            "repo_name": doc["repo_name"],
            "file_path": doc["file_path"],
            "chunk_index": doc["chunk_index"],
        }))
        redis.set(f"hester:doc:{hash_id}:chunk", doc["chunk_text"])
        redis.set(f"hester:doc:{hash_id}:embedding", bytes(doc["embedding"]))
        redis.sadd("hester:docs:index", hash_id)
        redis.sadd(f"hester:docs:by_file:{doc['file_path']}", hash_id)

    redis.set("hester:docs:last_sync", datetime.utcnow().isoformat())
```

## Semantic Router

### Matching Algorithm

```python
class SemanticRouter:
    """Routes context queries to relevant bundles and docs."""

    BUNDLE_THRESHOLD = 0.80   # High confidence for curated bundles
    DOC_THRESHOLD = 0.70      # Lower threshold for auto-indexed docs
    MAX_BUNDLES = 3           # Max bundles to load
    MAX_DOCS = 5              # Max doc chunks to load

    def __init__(self, store: KnowledgeStore):
        self.store = store
        self._bundle_embeddings: Dict[str, np.ndarray] = {}
        self._doc_embeddings: Dict[str, np.ndarray] = {}

    async def load_embeddings(self):
        """Load all embeddings into memory for fast search."""
        # Bundles: ~50 × 768 × 4 bytes = 150KB
        for bundle_id in self.store.list_bundles():
            emb = self.store.get_bundle_embedding(bundle_id)
            if emb is not None:
                self._bundle_embeddings[bundle_id] = emb

        # Docs: ~1000 × 768 × 4 bytes = 3MB
        for doc_hash in self.store.list_docs():
            emb = self.store.get_doc_embedding(doc_hash)
            if emb is not None:
                self._doc_embeddings[doc_hash] = emb

    async def match(self, context: str) -> MatchResult:
        """
        Find matching bundles and docs for the given context.

        Args:
            context: Combined context string (file path, content preview,
                     recent conversation, etc.)

        Returns:
            MatchResult with matched bundles and docs above threshold
        """
        query_embedding = await generate_embedding(context)

        # Search bundles (prioritized - user curated)
        bundle_scores = {
            bid: cosine_similarity(query_embedding, emb)
            for bid, emb in self._bundle_embeddings.items()
        }
        matched_bundles = [
            (bid, score) for bid, score in bundle_scores.items()
            if score >= self.BUNDLE_THRESHOLD
        ]
        matched_bundles.sort(key=lambda x: x[1], reverse=True)
        matched_bundles = matched_bundles[:self.MAX_BUNDLES]

        # Search docs (fallback if no bundle match)
        matched_docs = []
        if not matched_bundles:
            doc_scores = {
                did: cosine_similarity(query_embedding, emb)
                for did, emb in self._doc_embeddings.items()
            }
            matched_docs = [
                (did, score) for did, score in doc_scores.items()
                if score >= self.DOC_THRESHOLD
            ]
            matched_docs.sort(key=lambda x: x[1], reverse=True)
            matched_docs = matched_docs[:self.MAX_DOCS]

        return MatchResult(
            bundles=matched_bundles,
            docs=matched_docs,
            query_embedding=query_embedding,
        )
```

### Context Building

When building the context string for matching:

```python
def build_match_context(lee_context: LeeContext, conversation: List[Message]) -> str:
    """Build context string for semantic matching."""
    parts = []

    # Current file context
    if lee_context.editor:
        parts.append(f"File: {lee_context.editor.file_path}")
        parts.append(f"Language: {lee_context.editor.language}")
        if lee_context.editor.selection:
            parts.append(f"Selected: {lee_context.editor.selection[:200]}")

    # Open tabs context
    tab_types = [t.type for t in lee_context.tabs]
    if "git" in tab_types:
        parts.append("Working with: git version control")
    if "docker" in tab_types:
        parts.append("Working with: Docker containers")

    # Recent conversation topics (last 3 messages)
    for msg in conversation[-3:]:
        if msg.role == "user":
            parts.append(f"Topic: {msg.content[:100]}")

    return "\n".join(parts)
```

## Warm Context Buffer

The warm context buffer holds pre-loaded content ready for the next query:

```python
@dataclass
class WarmContext:
    """Pre-loaded context ready for immediate use."""

    bundles: List[LoadedBundle]      # Full content loaded
    docs: List[LoadedDocChunk]       # Chunk text loaded
    trigger: str                      # What caused this load
    updated: datetime

    def to_prompt_section(self) -> str:
        """Format warm context for system prompt injection."""
        sections = []

        if self.bundles:
            sections.append("## Relevant Context (from your knowledge bundles)\n")
            for bundle in self.bundles:
                sections.append(f"### {bundle.title}\n{bundle.content}\n")

        if self.docs:
            sections.append("## Related Documentation\n")
            for doc in self.docs:
                sections.append(f"**{doc.file_path}**\n{doc.chunk_text}\n")

        return "\n".join(sections)

    @property
    def token_estimate(self) -> int:
        """Estimate tokens in warm context."""
        total_chars = sum(len(b.content) for b in self.bundles)
        total_chars += sum(len(d.chunk_text) for d in self.docs)
        return total_chars // 4  # Rough estimate
```

### Buffer Updates

```python
class WarmContextBuffer:
    """Manages the warm context buffer in Redis."""

    MAX_TOKENS = 8000  # Don't overload the prompt

    async def update(
        self,
        session_id: str,
        match_result: MatchResult,
        trigger: str,
    ) -> WarmContext:
        """Update warm context based on match results."""

        bundles = []
        docs = []
        total_tokens = 0

        # Load bundles first (higher priority)
        for bundle_id, score in match_result.bundles:
            content = self.store.get_bundle_content(bundle_id)
            meta = self.store.get_bundle_meta(bundle_id)

            tokens = len(content) // 4
            if total_tokens + tokens > self.MAX_TOKENS:
                break

            bundles.append(LoadedBundle(
                id=bundle_id,
                title=meta["title"],
                content=content,
                score=score,
            ))
            total_tokens += tokens

        # Load docs if room remains
        for doc_hash, score in match_result.docs:
            chunk = self.store.get_doc_chunk(doc_hash)
            meta = self.store.get_doc_meta(doc_hash)

            tokens = len(chunk) // 4
            if total_tokens + tokens > self.MAX_TOKENS:
                break

            docs.append(LoadedDocChunk(
                hash=doc_hash,
                file_path=meta["file_path"],
                chunk_text=chunk,
                score=score,
            ))
            total_tokens += tokens

        warm = WarmContext(
            bundles=bundles,
            docs=docs,
            trigger=trigger,
            updated=datetime.utcnow(),
        )

        # Persist to Redis
        self.redis.set(
            f"hester:session:{session_id}:warm",
            warm.to_json(),
            ex=3600,  # 1 hour TTL
        )

        return warm
```

## Knowledge Engine

The main orchestrator that ties everything together:

```python
class KnowledgeEngine:
    """
    Proactive knowledge management engine.

    Watches Lee context and conversation history, pre-loads relevant
    knowledge, and notifies via status bar.
    """

    def __init__(
        self,
        store: KnowledgeStore,
        router: SemanticRouter,
        buffer: WarmContextBuffer,
        lee_client: LeeContextClient,
        status_pusher: StatusMessagePusher,
    ):
        self.store = store
        self.router = router
        self.buffer = buffer
        self.lee_client = lee_client
        self.status = status_pusher

        self._last_context_hash: Optional[str] = None
        self._debounce_task: Optional[asyncio.Task] = None

    async def start(self):
        """Start the knowledge engine."""
        # Sync data to Redis
        await self.store.sync_bundles()
        await self.store.sync_docs()

        # Load embeddings into memory
        await self.router.load_embeddings()

        # Register Lee context callback
        self.lee_client.on_context_update = self._on_lee_context

        # Start git watcher
        asyncio.create_task(self._git_watch_loop())

        logger.info("Knowledge engine started")

    async def _on_lee_context(self, context: LeeContext):
        """Handle Lee context updates (debounced)."""
        # Cancel pending debounce
        if self._debounce_task:
            self._debounce_task.cancel()

        # Debounce - wait for context to settle
        self._debounce_task = asyncio.create_task(
            self._process_context_debounced(context, delay_ms=500)
        )

    async def _process_context_debounced(self, context: LeeContext, delay_ms: int):
        """Process context after debounce delay."""
        await asyncio.sleep(delay_ms / 1000)

        # Build context string
        context_str = build_match_context(context, self._recent_conversation)
        context_hash = hashlib.md5(context_str.encode()).hexdigest()

        # Skip if unchanged
        if context_hash == self._last_context_hash:
            return
        self._last_context_hash = context_hash

        # Match against knowledge store
        match_result = await self.router.match(context_str)

        # Update warm buffer
        trigger = f"file:{context.editor.file_path}" if context.editor else "context"
        warm = await self.buffer.update(
            session_id=self._session_id,
            match_result=match_result,
            trigger=trigger,
        )

        # Notify via status bar
        if warm.bundles:
            bundle_names = ", ".join(b.title for b in warm.bundles[:3])
            await self.status.push(
                message=f"Loaded: {bundle_names}",
                type="info",
                ttl=5,
            )
        elif not warm.docs:
            # No matches - check if file needs documentation
            await self._check_doc_gap(context)

    async def _check_doc_gap(self, context: LeeContext):
        """Check if current file lacks documentation, suggest creation."""
        if not context.editor:
            return

        file_path = context.editor.file_path

        # Check if file is indexed
        indexed_files = self.store.get_indexed_files()
        if file_path in indexed_files:
            return  # Already documented

        # Only suggest for code files
        if not any(file_path.endswith(ext) for ext in [".py", ".ts", ".js", ".dart"]):
            return

        # Check idle time before suggesting
        if context.activity and context.activity.idle_seconds < 30:
            return

        await self.status.push(
            message=f"No docs for {Path(file_path).name}. Create?",
            type="hint",
            prompt=f"document {file_path}",
            ttl=30,
        )

    async def _git_watch_loop(self):
        """Background loop polling git status every 10 minutes."""
        while True:
            await asyncio.sleep(600)  # 10 minutes
            await self._check_git_status()

    async def _check_git_status(self):
        """Check git status for documentation/commit suggestions."""
        try:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                cwd=self._working_dir,
            )

            if result.returncode != 0:
                return

            lines = result.stdout.strip().split("\n")
            modified = [l[3:] for l in lines if l.startswith(" M ") or l.startswith("M  ")]
            added = [l[3:] for l in lines if l.startswith("?? ") or l.startswith("A  ")]

            # Check for undocumented new files
            code_files = [f for f in added if any(f.endswith(e) for e in [".py", ".ts", ".js"])]
            if code_files:
                await self.status.push(
                    message=f"{len(code_files)} new files. Document?",
                    type="hint",
                    prompt=f"document new files: {', '.join(code_files[:3])}",
                    ttl=60,
                )

            # Suggest commit if many uncommitted changes
            uncommitted = len(modified) + len(added)
            if uncommitted >= 3:
                await self.status.push(
                    message=f"{uncommitted} uncommitted changes. Commit?",
                    type="hint",
                    prompt="commit the current changes with a descriptive message",
                    ttl=60,
                )

            # Store state
            self.redis.set("hester:git:last_status", json.dumps({
                "files_modified": modified,
                "files_added": added,
                "uncommitted_count": uncommitted,
                "checked_at": datetime.utcnow().isoformat(),
            }))

        except Exception as e:
            logger.warning(f"Git status check failed: {e}")
```

## Task Watcher

Monitors ClaudeDelegate task completions for documentation suggestions:

```python
class TaskWatcher:
    """Watches ClaudeDelegate task completions for doc suggestions."""

    SIGNIFICANT_LINES = 50  # Suggest docs if task adds this many lines

    def __init__(self, status_pusher: StatusMessagePusher):
        self.status = status_pusher
        self._documented_files: Set[str] = set()  # Avoid repeat suggestions

    async def on_task_complete(self, task: CompletedTask):
        """Called when a ClaudeDelegate task completes."""
        if not task.files_changed:
            return

        # Analyze changes
        new_files = []
        significant_changes = []

        for file_change in task.files_changed:
            if file_change.path in self._documented_files:
                continue

            if file_change.is_new:
                new_files.append(file_change.path)
            elif file_change.lines_added >= self.SIGNIFICANT_LINES:
                significant_changes.append(file_change.path)

        # Suggest documentation
        files_to_document = new_files + significant_changes
        if files_to_document:
            file_list = ", ".join(Path(f).name for f in files_to_document[:3])
            more = f" +{len(files_to_document) - 3} more" if len(files_to_document) > 3 else ""

            await self.status.push(
                message=f"New code: {file_list}{more}. Document?",
                type="hint",
                prompt=f"document the new code in: {', '.join(files_to_document)}",
                ttl=120,
            )

            # Mark as suggested (avoid repeats this session)
            self._documented_files.update(files_to_document)
```

## Integration with Agent

The warm context is injected into the ReAct loop automatically:

```python
# In agent.py process_context()

async def process_context(self, request: ContextRequest, ...):
    # ... existing code ...

    # Get warm context from buffer
    warm_context = await self.knowledge_engine.buffer.get(session_id)

    if warm_context:
        # Inject into system prompt
        warm_section = warm_context.to_prompt_section()
        system_prompt = self._build_system_prompt(session)
        system_prompt += f"\n\n{warm_section}"

        # Log what was loaded
        logger.info(f"Injected warm context: {len(warm_context.bundles)} bundles, "
                    f"{len(warm_context.docs)} docs, trigger={warm_context.trigger}")
```

## Status Bar Notifications

All proactive notifications use the status bar API:

| Event | Message | Type | Prompt |
|-------|---------|------|--------|
| Context loaded | "Loaded: auth-system, jwt-flow" | `info` | - |
| Doc gap detected | "No docs for router.py. Create?" | `hint` | `"document {file}"` |
| New code detected | "New code: matching.py. Document?" | `hint` | `"document new code in..."` |
| Git changes | "5 uncommitted changes. Commit?" | `hint` | `"commit with message"` |
| Bundle refresh needed | "auth-system is stale. Refresh?" | `hint` | `"refresh context bundle auth-system"` |

## Implementation Plan

### Phase 1: Redis Knowledge Store
- [ ] Create `daemon/knowledge/store.py` with Redis operations
- [ ] Add bundle embedding generation on create/refresh
- [ ] Implement Supabase → Redis doc sync
- [ ] Add sync on daemon startup

### Phase 2: Semantic Router
- [ ] Create `daemon/knowledge/router.py`
- [ ] In-memory embedding cache with NumPy
- [ ] Dual-source search (bundles + docs)
- [ ] Configurable thresholds

### Phase 3: Warm Context Buffer
- [ ] Create `daemon/knowledge/buffer.py`
- [ ] Token budget management
- [ ] Redis persistence with TTL
- [ ] Format for prompt injection

### Phase 4: Knowledge Engine
- [ ] Create `daemon/knowledge/engine.py`
- [ ] Lee context watcher with debounce
- [ ] Conversation topic detection
- [ ] Status bar integration

### Phase 5: Background Watchers
- [ ] Git status polling (10 min)
- [ ] ClaudeDelegate task completion hooks
- [ ] Doc gap detection

### Phase 6: Agent Integration
- [ ] Inject warm context into system prompt
- [ ] Bypass context loading if warm buffer fresh
- [ ] Metrics/logging for cache hits

## Configuration

```yaml
# .hester/config.yaml

knowledge:
  # Semantic matching
  bundle_threshold: 0.80        # Min similarity for bundle match
  doc_threshold: 0.70           # Min similarity for doc match
  max_bundles: 3                # Max bundles to load
  max_docs: 5                   # Max doc chunks to load
  max_warm_tokens: 8000         # Token budget for warm context

  # Debounce timing (ms)
  debounce_file_open: 500
  debounce_tab_switch: 300
  debounce_conversation: 2000

  # Background tasks
  git_poll_interval: 600        # seconds (10 min)
  doc_sync_interval: 1800       # seconds (30 min)
  idle_doc_suggestion: 30       # seconds idle before suggesting

  # Task watcher
  significant_lines: 50         # Lines added to trigger doc suggestion
```

## Metrics

Track knowledge engine effectiveness:

```python
@dataclass
class KnowledgeMetrics:
    context_updates: int = 0          # Lee context changes received
    matches_found: int = 0            # Successful semantic matches
    bundles_loaded: int = 0           # Bundles loaded into warm buffer
    docs_loaded: int = 0              # Doc chunks loaded
    cache_hits: int = 0               # Requests served from warm buffer
    cache_misses: int = 0             # Requests requiring fresh search
    doc_suggestions: int = 0          # Doc creation hints pushed
    commit_suggestions: int = 0       # Commit hints pushed
```

## Security Considerations

1. **Redis access**: Local Redis only, no remote connections
2. **Embedding content**: Only index repo-local files
3. **Status bar prompts**: User must click/confirm before action
4. **No auto-execution**: Suggestions only, never automatic changes

## Related Documentation

- `02-Hester-Context-Bundles.md` - Context bundle system
- `03-Hester-Lee-Context.md` - Lee integration
- `04-Hester-Subagents.md` - ClaudeDelegate system
- `hester/docs/embeddings.py` - Doc embedding service
