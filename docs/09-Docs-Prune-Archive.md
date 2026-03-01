# Docs Prune and Archive Plan

> Automated archival of drifted documentation with exclusion from future analysis.

## Problem Statement

Documentation drift accumulates over time. Currently:
- Drifted docs continue to appear in drift analysis forever
- No automated way to archive out-of-date docs
- `docs/archive/` exists but isn't respected by drift analysis
- Manual archival requires remembering to move files

## Current State

### Existing Archive Structure

```
docs/
├── Auth.md                    # Active docs
├── API.md
├── Genome.md
└── archive/                   # Already exists!
    ├── misc/
    ├── circles/
    ├── old-architecture/
    ├── corbusier/
    ├── genome/
    └── legacy-services/
```

### Current Drift Analysis

**Thresholds (`lee/hester/docs/models.py`):**
- Claim confidence threshold: `0.7` (below = drifted)
- File health threshold: `drift_percentage < 20.0%` (above = unhealthy)

**No exclusions currently:**
- `hester docs check --all` scans ALL markdown files
- Archive directory is not excluded
- No `.hesterignore` or similar pattern support

### Proactive Watcher

**Current behavior (`lee/hester/daemon/knowledge/proactive_watcher.py`):**
- Drift check every 20 minutes
- Parses JSON output for `drift_score > 0.7`
- Notifies on new drift issues
- No auto-archival capability

## Design Goals

1. **Automatic exclusion**: `docs/archive/**` excluded from drift analysis
2. **CLI prune command**: `hester docs prune` moves badly drifted docs to archive
3. **Proactive archival**: Watcher suggests archival when docs stay drifted
4. **Audit trail**: Record why/when docs were archived
5. **Configurable thresholds**: Control what qualifies as "badly drifted"

## Implementation Design

### 1. Archive Exclusion Pattern

Add exclusion support to drift analysis:

```python
# Default exclusions (always applied)
DEFAULT_EXCLUDE_PATTERNS = [
    "**/archive/**",      # docs/archive/ and any nested archive/
    "**/node_modules/**",
    "**/.git/**",
    "**/venv/**",
]

# User-configurable exclusions in .hester/config.yaml
# docs:
#   exclude:
#     - "**/deprecated/**"
#     - "docs/legacy/**"
```

**Files to modify:**
- `lee/hester/daemon/tools/doc_tools.py` - Add exclusion filtering
- `lee/hester/cli.py` - Add `--exclude` flag to `hester docs check`
- `lee/hester/docs/embeddings.py` - Respect exclusions in indexing

### 2. Archive Manifest

Create manifest tracking archived docs:

```yaml
# docs/archive/.manifest.yaml
version: 1
archived:

  - file: "Genome Onboarding.md"
    original_path: "docs/Genome Onboarding.md"
    archived_at: "2026-01-05T14:30:00Z"
    archived_by: "hester docs prune"
    reason: "drift"
    drift_report:
      drift_percentage: 45.2
      total_claims: 12
      drifted_claims: 5
      last_check: "2026-01-05T14:28:00Z"

  - file: "genome/Genome Sequence.md"
    original_path: "docs/Genome Sequence.md"
    archived_at: "2025-12-15T10:00:00Z"
    archived_by: "manual"
    reason: "superseded"
    notes: "Replaced by Genome.md"
```

### 3. CLI Commands

#### `hester docs prune`

Archive badly drifted docs:

```bash
# Preview what would be archived (dry run)
hester docs prune --dry-run
# Output:
#   Would archive:
#   - docs/Genome Onboarding.md (45.2% drift)
#   - docs/Session Cache.md (38.0% drift)

# Archive docs with >30% drift
hester docs prune --threshold 30
# Output:
#   Archived 2 files to docs/archive/

# Archive specific file
hester docs prune docs/Legacy.md --reason "superseded by New.md"

# Archive with custom destination
hester docs prune --threshold 40 --dest docs/archive/2026-01

# Interactive mode - confirm each file
hester docs prune --interactive

# Force archive (no confirmation)
hester docs prune --threshold 30 --yes
```

**Flags:**
| Flag | Description |
|------|-------------|
| `--dry-run` | Show what would be archived without doing it |
| `--threshold N` | Archive files with drift > N% (default: 40) |
| `--dest PATH` | Custom archive destination (default: `docs/archive/`) |
| `--reason TEXT` | Reason for archival (recorded in manifest) |
| `--interactive, -i` | Confirm each file before archiving |
| `--yes, -y` | Skip confirmation prompts |
| `--category CAT` | Subdirectory within archive (e.g., `legacy-services`) |

#### `hester docs check` Enhancements

```bash
# Exclude patterns
hester docs check --all --exclude "**/archive/**" --exclude "**/deprecated/**"

# Show only unhealthy (for CI)
hester docs check --all --unhealthy-only

# Output includes archive suggestion
hester docs check docs/Old.md
# Output:
#   docs/Old.md: 45.2% drift (UNHEALTHY)
#   5 of 12 claims drifted
#
#   Consider archiving: hester docs prune docs/Old.md
```

#### `hester docs list-archived`

```bash
# List archived docs
hester docs list-archived
# Output:
#   ARCHIVED DOCUMENTS
#
#   docs/archive/genome/Genome Onboarding.md
#     Archived: 2026-01-05 (drift: 45.2%)
#     Original: docs/Genome Onboarding.md
#
#   docs/archive/misc/Session Cache.md
#     Archived: 2025-12-15 (superseded)
#     Original: docs/Session Cache.md

# Filter by reason
hester docs list-archived --reason drift
```

#### `hester docs restore`

```bash
# Restore archived doc to original location
hester docs restore "docs/archive/genome/Genome Onboarding.md"
# Output:
#   Restored to: docs/Genome Onboarding.md
#   Removed from archive manifest

# Restore to different location
hester docs restore "docs/archive/Old.md" --to "docs/legacy/Old.md"
```

### 4. Proactive Watcher Integration

Add archive suggestion to watcher:

```python
# In proactive_watcher.py

async def check_docs_drift(self) -> None:
    """Check for documentation drift with archive suggestions."""
    # ... existing drift check ...

    # Track persistently drifted files
    persistent_drift = self._get_persistent_drift_files()

    for file_path, drift_info in persistent_drift.items():
        days_drifted = drift_info["days_since_first_detection"]
        drift_pct = drift_info["drift_percentage"]

        # Suggest archival if:
        # - Drifted for 7+ days
        # - Drift percentage > 40%
        if days_drifted >= 7 and drift_pct > 40:
            await self._push_status(
                message=f"{Path(file_path).name} drifted {days_drifted}d. Archive?",
                message_type="hint",
                prompt=f"archive {file_path} due to persistent drift",
                ttl=300,
            )
```

**New tracking state:**
```python
@dataclass
class ProactiveStatus:
    # ... existing fields ...

    # Drift persistence tracking
    drift_first_detected: Dict[str, datetime] = field(default_factory=dict)
    drift_archive_suggested: Set[str] = field(default_factory=set)
```

### 5. Data Models

Add to `lee/hester/docs/models.py`:

```python
@dataclass
class ArchiveEntry:
    """Record of an archived document."""

    file: str                      # Filename in archive
    original_path: str             # Original location
    archived_at: datetime
    archived_by: str               # "hester docs prune", "manual", "proactive"
    reason: str                    # "drift", "superseded", "deprecated", "manual"
    drift_report: Optional[DriftReport] = None
    notes: Optional[str] = None


@dataclass
class ArchiveManifest:
    """Manifest of all archived documents."""

    version: int = 1
    archived: List[ArchiveEntry] = field(default_factory=list)

    def add(self, entry: ArchiveEntry) -> None:
        """Add entry to manifest."""
        self.archived.append(entry)

    def remove(self, file_path: str) -> Optional[ArchiveEntry]:
        """Remove and return entry by file path."""
        for i, entry in enumerate(self.archived):
            archive_path = f"docs/archive/{entry.file}"
            if archive_path == file_path or entry.file == file_path:
                return self.archived.pop(i)
        return None

    def find_original(self, original_path: str) -> Optional[ArchiveEntry]:
        """Find entry by original path."""
        for entry in self.archived:
            if entry.original_path == original_path:
                return entry
        return None

    @classmethod
    def load(cls, path: Path) -> "ArchiveManifest":
        """Load manifest from YAML file."""
        ...

    def save(self, path: Path) -> None:
        """Save manifest to YAML file."""
        ...
```

### 6. Archive Service

Create `lee/hester/docs/archive.py`:

```python
class DocsArchiveService:
    """Service for managing documentation archival."""

    def __init__(self, working_dir: Path, archive_dir: Optional[Path] = None):
        self.working_dir = working_dir
        self.docs_dir = working_dir / "docs"
        self.archive_dir = archive_dir or self.docs_dir / "archive"
        self.manifest_path = self.archive_dir / ".manifest.yaml"

    def archive(
        self,
        doc_path: Path,
        reason: str = "drift",
        category: Optional[str] = None,
        drift_report: Optional[DriftReport] = None,
        notes: Optional[str] = None,
    ) -> ArchiveEntry:
        """
        Archive a document.

        Args:
            doc_path: Path to document to archive
            reason: Why archived (drift, superseded, deprecated, manual)
            category: Subdirectory within archive (e.g., "legacy-services")
            drift_report: Associated drift report if reason is "drift"
            notes: Additional notes

        Returns:
            ArchiveEntry recording the archival
        """
        ...

    def restore(
        self,
        archive_path: Path,
        restore_to: Optional[Path] = None,
    ) -> Path:
        """
        Restore an archived document.

        Args:
            archive_path: Path within archive
            restore_to: Optional custom restore location

        Returns:
            Path where document was restored
        """
        ...

    def list_archived(
        self,
        reason: Optional[str] = None,
    ) -> List[ArchiveEntry]:
        """List archived documents, optionally filtered by reason."""
        ...

    def get_exclude_patterns(self) -> List[str]:
        """Get patterns to exclude from drift analysis."""
        patterns = list(DEFAULT_EXCLUDE_PATTERNS)

        # Add archive directory
        archive_relative = self.archive_dir.relative_to(self.working_dir)
        patterns.append(f"{archive_relative}/**")

        # Load user config
        config_path = self.working_dir / ".hester" / "config.yaml"
        if config_path.exists():
            config = yaml.safe_load(config_path.read_text())
            user_excludes = config.get("docs", {}).get("exclude", [])
            patterns.extend(user_excludes)

        return patterns

    def should_suggest_archive(
        self,
        drift_report: DriftReport,
        days_drifted: int,
        threshold: float = 40.0,
        min_days: int = 7,
    ) -> bool:
        """
        Check if a document should be suggested for archival.

        Args:
            drift_report: Latest drift report
            days_drifted: Days since first drift detection
            threshold: Drift percentage threshold
            min_days: Minimum days drifted before suggesting

        Returns:
            True if should suggest archival
        """
        return (
            days_drifted >= min_days
            and drift_report.drift_percentage > threshold
            and not drift_report.is_healthy
        )
```

## Implementation Plan

### Phase 1: Exclusion Support

**Goal:** `docs/archive/` excluded from drift analysis

**Files to modify:**
1. `lee/hester/daemon/tools/doc_tools.py`
   - Add `DEFAULT_EXCLUDE_PATTERNS`
   - Filter files in `find_doc_drift()` using `fnmatch`

2. `lee/hester/cli.py`
   - Add `--exclude` flag to `hester docs check`
   - Load user excludes from `.hester/config.yaml`

3. `lee/hester/docs/embeddings.py`
   - Apply same exclusion patterns to indexing

**Test:** `hester docs check --all` should not include `docs/archive/**`

### Phase 2: Archive Manifest

**Goal:** Track archived docs with metadata

**Files to create:**
1. `lee/hester/docs/models.py` - Add `ArchiveEntry`, `ArchiveManifest`
2. `lee/hester/docs/archive.py` - Create `DocsArchiveService`

**Test:** Can load/save manifest, add/remove entries

### Phase 3: Prune CLI Command

**Goal:** `hester docs prune` command

**Files to modify:**
1. `lee/hester/cli.py` - Add `prune` subcommand under `docs`

**Test:**
- `hester docs prune --dry-run` shows candidates
- `hester docs prune --threshold 30` archives files
- Manifest updated correctly

### Phase 4: Restore CLI Command

**Goal:** `hester docs restore` command

**Files to modify:**
1. `lee/hester/cli.py` - Add `restore` subcommand

**Test:**
- Can restore archived doc to original location
- Manifest updated on restore

### Phase 5: Proactive Watcher Integration

**Goal:** Suggest archival for persistently drifted docs

**Files to modify:**
1. `lee/hester/daemon/knowledge/proactive_watcher.py`
   - Add drift persistence tracking
   - Add archive suggestion logic

**Test:**
- Watcher tracks days since first drift detection
- Suggests archival after 7 days at >40% drift

### Phase 6: List Archived Command

**Goal:** `hester docs list-archived` command

**Files to modify:**
1. `lee/hester/cli.py` - Add `list-archived` subcommand

**Test:** Shows all archived docs with metadata

## Configuration

Add to `.hester/config.yaml`:

```yaml
docs:
  # Exclude patterns from drift analysis
  exclude:
    - "**/archive/**"
    - "**/deprecated/**"
    - "docs/internal/**"

  # Archive settings
  archive:
    # Default archive location (relative to docs/)
    path: "archive"

    # Auto-archive thresholds
    drift_threshold: 40.0      # Archive if drift > 40%
    days_before_suggest: 7     # Days drifted before suggesting

    # Categories for organization
    categories:
      - legacy-services
      - old-architecture
      - deprecated
      - misc
```

## CLI Reference

```bash
# Check drift (excludes archive by default)
hester docs check --all
hester docs check docs/Auth.md
hester docs check --all --exclude "**/draft/**"

# Prune drifted docs
hester docs prune --dry-run
hester docs prune --threshold 30
hester docs prune docs/Old.md --reason "superseded"
hester docs prune --interactive
hester docs prune --category legacy-services

# List archived
hester docs list-archived
hester docs list-archived --reason drift

# Restore archived
hester docs restore docs/archive/Old.md
hester docs restore docs/archive/Old.md --to docs/legacy/Old.md
```

## Status Messages

| Event | Message | Type | Prompt |
|-------|---------|------|--------|
| Persistent drift | "Auth.md drifted 7d. Archive?" | `hint` | `"archive docs/Auth.md due to persistent drift"` |
| Auto-archive done | "Archived 2 drifted docs" | `success` | - |
| Archive suggested | "3 docs ready for archive. Review?" | `hint` | `"review docs ready for archive"` |

## Testing Strategy

### Unit Tests

```python
# tests/unit/test_docs_archive.py

class TestExclusionPatterns:
    def test_archive_excluded_by_default(self):
        """docs/archive/** should be excluded."""
        ...

    def test_user_exclusions_loaded(self):
        """Custom exclusions from config should apply."""
        ...

class TestArchiveManifest:
    def test_add_entry(self):
        """Can add entry to manifest."""
        ...

    def test_remove_entry(self):
        """Can remove entry by path."""
        ...

    def test_roundtrip(self):
        """Can save and load manifest."""
        ...

class TestDocsArchiveService:
    def test_archive_creates_entry(self):
        """Archiving creates manifest entry."""
        ...

    def test_archive_moves_file(self):
        """Archiving moves file to archive dir."""
        ...

    def test_restore_removes_entry(self):
        """Restoring removes manifest entry."""
        ...
```

### Integration Tests

```python
# tests/integration/test_docs_prune.py

class TestDocsPruneCommand:
    def test_dry_run_no_changes(self):
        """Dry run doesn't modify files."""
        ...

    def test_prune_moves_file(self):
        """Prune moves file and updates manifest."""
        ...

    def test_exclude_respects_archive(self):
        """Archived files not included in drift check."""
        ...
```

## Rollout Plan

1. **Phase 1** (immediate): Add exclusion support - blocks archive from analysis
2. **Phase 2**: Archive manifest - tracks what's archived and why
3. **Phase 3**: Prune command - manual archival with audit trail
4. **Phase 4**: Restore command - recover archived docs
5. **Phase 5**: Proactive suggestions - notify about persistently drifted docs
6. **Phase 6**: List command - view all archived docs

## Open Questions

1. **Auto-archive**: Should watcher auto-archive after N days, or only suggest?
   - **Recommendation**: Suggest only, let user decide

2. **Archive categories**: Should categories be auto-detected from content?
   - **Recommendation**: Start with manual, add auto-categorization later

3. **Manifest location**: In archive dir or `.hester/`?
   - **Recommendation**: In archive dir (`docs/archive/.manifest.yaml`) for portability

4. **Git integration**: Should archival create a commit?
   - **Recommendation**: No, let user commit separately

## Related Documentation

- `02-Hester-Context-Bundles.md` - Similar pruning for bundles
- `05-Hester-Proactive-Knowledge-Management.md` - Watcher patterns
- `08-Context-Bundle-Proactive-Integration.md` - Integration patterns
