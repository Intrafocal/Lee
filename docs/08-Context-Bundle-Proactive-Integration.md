# Context Bundle Proactive Integration Plan

> Integrating context bundle lifecycle management into the proactive watcher system.

## Current State Analysis

### What Exists

**Context Bundle System** (`lee/hester/context/`):
- `service.py` - BundleService with create, refresh, list, delete, add_source
- `models.py` - BundleMetadata, BundleStatus, SourceSpec types
- TTL-based staleness tracking with `is_stale` property
- Source change detection via content hashing

**Proactive Watcher** (`lee/hester/daemon/knowledge/proactive_watcher.py`):
- Background loops for docs indexing, drift analysis, devops, tests
- Status message pushing to Lee via `push_status_message()`
- Failure tracking to avoid notification spam

**Knowledge Engine** (`lee/hester/daemon/knowledge/engine.py`):
- Watches Lee context for file/tab changes
- Pre-loads relevant bundles into warm context buffer
- Semantic matching against bundles via SemanticRouter

**Knowledge Store** (`lee/hester/daemon/knowledge/store.py`):
- `sync_bundles_to_redis()` - syncs bundle embeddings for fast matching
- Redis storage with `hester:bundle:{id}:*` keys

### The Gap

The proactive watcher monitors docs, services, and tests, but **doesn't monitor bundle staleness**. Users must manually check `hester context list` to find stale bundles.

## Integration Design

### New Proactive Watcher Capabilities

Add bundle management to `ProactiveWatcher`:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PROACTIVE WATCHER EXPANDED                               │
│                                                                              │
│   Existing Loops:                    New Loops:                             │
│   ┌──────────────────┐               ┌──────────────────────┐               │
│   │ Docs Index (30m) │               │ Bundle Staleness (5m) │              │
│   │ Drift Check (20m)│               │ Bundle Sync (10m)     │              │
│   │ DevOps (10m)     │               │ Bundle Suggest (idle) │              │
│   │ Tests (60m)      │               └──────────────────────┘               │
│   └──────────────────┘                                                      │
│                                                                              │
│   All push status messages to Lee when issues detected                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1. Bundle Staleness Monitoring

**Interval:** Every 5 minutes (bundles are frequently used, staleness matters more)

**Logic:**
```python
async def check_bundle_staleness(self) -> None:
    """Check for stale bundles and notify user."""
    service = ContextBundleService(working_dir=self._working_dir)
    statuses = service.list_all()

    stale_bundles = [s for s in statuses if s.is_stale]

    # Track which bundles we've already notified about
    new_stale = [s for s in stale_bundles if s.id not in self._notified_stale]

    if new_stale:
        names = [s.id for s in new_stale[:3]]
        more = len(new_stale) - 3 if len(new_stale) > 3 else 0

        await self._push_status(
            message=f"Bundles stale: {', '.join(names)}{f' +{more}' if more else ''}",
            message_type="hint",
            prompt="refresh stale context bundles",
            ttl=300,  # 5 minutes
        )

        self._notified_stale.update(s.id for s in new_stale)

    # Clear notifications for bundles that are no longer stale
    current_stale_ids = {s.id for s in stale_bundles}
    self._notified_stale &= current_stale_ids
```

### 2. Auto-Refresh Stale Bundles (Optional)

**Interval:** Same as staleness check, but only if `auto_refresh_bundles: true` in config

**Logic:**
```python
async def auto_refresh_bundles(self) -> None:
    """Auto-refresh stale bundles if enabled."""
    if not self._auto_refresh_bundles:
        return

    service = ContextBundleService(working_dir=self._working_dir)

    # Only refresh bundles that:
    # 1. Are stale
    # 2. Have TTL > 0 (not manual-only)
    # 3. Haven't failed refresh recently

    results = await service.refresh_stale()

    refreshed = [r for r in results if r.success and r.changed]
    if refreshed:
        names = [r.bundle_id for r in refreshed[:3]]
        await self._push_status(
            message=f"Auto-refreshed: {', '.join(names)}",
            message_type="success",
            ttl=30,
        )
```

### 3. Bundle Sync to Redis

**Interval:** Every 10 minutes (after any refresh, sync to Redis)

**Logic:**
```python
async def sync_bundles_to_redis(self) -> None:
    """Sync bundle embeddings to Redis for semantic matching."""
    if not self._knowledge_store or not self._knowledge_store.is_available:
        return

    count = await self._knowledge_store.sync_bundles_to_redis()

    if count > 0:
        logger.info(f"Synced {count} bundles to Redis")
```

### 4. Bundle Suggestion (Idle-Based)

**Trigger:** User idle on undocumented code area for 30s+

This already exists in `KnowledgeEngine._check_doc_gap()`. We enhance it to suggest bundle creation instead of just docs:

```python
async def suggest_bundle_creation(self, context: LeeContext) -> None:
    """Suggest creating a bundle when user works in undocumented area."""
    if not context.editor:
        return

    file_path = context.editor.file_path
    if not file_path:
        return

    # Check if any bundle covers this file
    service = ContextBundleService(working_dir=self._working_dir)
    statuses = service.list_all()

    # Check if file is in any bundle's sources
    file_in_bundle = False
    for status in statuses:
        bundle = service.get(status.id)
        if bundle and self._file_in_bundle_sources(file_path, bundle):
            file_in_bundle = True
            break

    if not file_in_bundle and context.activity.idle_seconds >= 30:
        dir_name = Path(file_path).parent.name
        await self._push_status(
            message=f"No context for {dir_name}/. Create bundle?",
            message_type="hint",
            prompt=f"create context bundle for {dir_name}",
            ttl=90,
        )
```

## Implementation Plan

### Phase 1: Add Bundle Staleness Loop to ProactiveWatcher

**Files to modify:**
- `lee/hester/daemon/knowledge/proactive_watcher.py`

**Changes:**
1. Add `_bundle_staleness_interval` config (default: 300s = 5 min)
2. Add `_notified_stale: Set[str]` for dedup
3. Add `_bundle_staleness_loop()` method
4. Add `check_bundle_staleness()` method
5. Start loop in `start()`
6. Add to `ProactiveStatus` dataclass

### Phase 2: Add Optional Auto-Refresh

**Files to modify:**
- `lee/hester/daemon/knowledge/proactive_watcher.py`
- `lee/hester/daemon/settings.py` (if exists)

**Changes:**
1. Add `auto_refresh_bundles: bool = False` config
2. Add `auto_refresh_bundles()` method
3. Call from staleness loop if enabled
4. Track refresh failures to avoid retry spam

### Phase 3: Integrate Bundle Sync

**Files to modify:**
- `lee/hester/daemon/knowledge/proactive_watcher.py`
- `lee/hester/daemon/knowledge/engine.py`

**Changes:**
1. Add `_knowledge_store` reference to ProactiveWatcher
2. Add sync after any bundle refresh
3. Coordinate with KnowledgeEngine startup sync

### Phase 4: Bundle Suggestion Enhancement

**Files to modify:**
- `lee/hester/daemon/knowledge/engine.py`

**Changes:**
1. Enhance `_check_doc_gap()` to check bundle coverage
2. Add `_file_in_bundle_sources()` helper
3. Differentiate "no docs" vs "no bundle" suggestions

### Phase 5: Claude Code Skill Integration

**Files to modify:**
- `.claude/skills/bundle/SKILL.md`

**Changes:**
1. Add section on proactive notifications
2. Document `hester context refresh --all` for responding to notifications
3. Add `/bundle watch` command to check what's being monitored

## Configuration

Add to `.hester/config.yaml`:

```yaml
proactive:
  bundles:
    staleness_check_interval: 300    # 5 minutes
    auto_refresh: false              # Don't auto-refresh by default
    sync_to_redis_interval: 600      # 10 minutes
    suggestion_idle_threshold: 30    # seconds idle before suggesting
    max_stale_notifications: 3       # Max bundles to mention in one notification
```

## Status Messages

| Event | Message | Type | Prompt |
|-------|---------|------|--------|
| Bundles stale | "Bundles stale: auth-system, matching +2" | `hint` | `"refresh stale context bundles"` |
| Auto-refreshed | "Auto-refreshed: auth-system, matching" | `success` | - |
| Bundle suggested | "No context for services/. Create bundle?" | `hint` | `"create context bundle for services"` |
| Sync complete | (logged only, no status push) | - | - |

## Metrics

Add to `ProactiveStatus`:

```python
@dataclass
class ProactiveStatus:
    # ... existing fields ...

    # Bundle monitoring
    last_bundle_check: Optional[datetime] = None
    bundles_stale_count: int = 0
    bundles_auto_refreshed: int = 0
    bundle_check_failures: int = 0
    last_bundle_sync: Optional[datetime] = None
```

## Testing Strategy

### Unit Tests

```python
# tests/unit/test_proactive_watcher_bundles.py

class TestBundleStalenessCheck:
    async def test_notifies_on_first_stale_bundle(self):
        """Should notify when bundle becomes stale."""
        ...

    async def test_deduplicates_notifications(self):
        """Should not re-notify for same stale bundle."""
        ...

    async def test_clears_notification_after_refresh(self):
        """Should re-notify if bundle goes stale again after refresh."""
        ...

class TestBundleAutoRefresh:
    async def test_respects_disabled_flag(self):
        """Should not auto-refresh when disabled."""
        ...

    async def test_skips_manual_only_bundles(self):
        """Should not auto-refresh bundles with TTL=0."""
        ...

    async def test_tracks_refresh_failures(self):
        """Should stop retrying after max failures."""
        ...
```

### Integration Tests

```python
# tests/integration/test_proactive_bundle_integration.py

class TestProactiveBundleIntegration:
    async def test_full_staleness_notification_flow(self):
        """
        1. Create bundle with short TTL
        2. Start watcher
        3. Wait for staleness
        4. Verify notification pushed
        """
        ...

    async def test_bundle_sync_after_refresh(self):
        """
        1. Create bundle
        2. Verify in Redis
        3. Refresh bundle
        4. Verify updated in Redis
        """
        ...
```

## Rollout

1. **Phase 1** (immediate): Bundle staleness monitoring - low risk, high value
2. **Phase 2** (optional): Auto-refresh - behind flag, user must enable
3. **Phase 3** (after Redis stable): Redis sync integration
4. **Phase 4** (after usage feedback): Bundle suggestion enhancement

## Open Questions

1. **Notification frequency**: Should we rate-limit bundle staleness notifications? (Current: every 5 min if still stale)

2. **Auto-refresh scope**: Should auto-refresh be per-bundle opt-in via a flag in metadata?

3. **Redis sync timing**: Sync immediately after refresh, or batch on interval?

4. **Bundle suggestion heuristics**: How do we avoid suggesting bundles for every directory?

## Related Documentation

- `02-Hester-Context-Bundles.md` - Context bundle specification
- `05-Hester-Proactive-Knowledge-Management.md` - Proactive engine design
- `lee/hester/CLAUDE.md` - Hester CLI and daemon reference
