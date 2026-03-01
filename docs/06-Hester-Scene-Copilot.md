# Hester Scene Copilot

> Scene authoring assistant with live perception - see what you're building as you build it.

## Overview

**Hester Scene Copilot** is a CLI tool for authoring and debugging Sybil scenes. It combines:

1. **HesterQA's multimodal perception** - Gemini 2.5 Flash analyzing live screenshots
2. **Scene editing tools** - Modify scene definitions, generate TTS, manage spotlights
3. **ReAct reasoning** - Conversational interface that can observe, reason, and act

The key insight: HesterQA already has sophisticated browser automation and Gemini vision. Scene Copilot exposes these as tools for an interactive authoring session.

## The Problem

Currently, scene authoring requires:

1. Edit scene JSON in Control Panel
2. Manually trigger scene in Frame
3. Watch it play, note issues mentally
4. Alt-tab back to Control Panel
5. Find the relevant stage/narration
6. Make edits
7. Invalidate cache
8. Repeat

This is slow and error-prone. Issues like "spotlight dismissed before audio finishes" require careful timing observation that's easy to miss.

## The Solution

```
$ hester scene console welcome

Hester Scene Copilot - welcome
Scene: Welcome Tour (LINEAR, 4 stages)
Chrome DevTools: Connected
Frame: http://localhost:8889

> play it

Playing scene 'welcome'...

[Turn 1] Stage: opening
  Screenshot → Gemini 2.5 Flash
  ✓ Audio playing: "Welcome to Coefficiency..." (3.2s)
  ✓ Spotlight on chat_panel
  ⚠️ Spotlight dismissed at 2.8s (audio still playing)

[Turn 2] Stage: chat_tour
  ✓ Audio: "This is where we'll talk..." (2.1s)
  ✓ Spotlight on chat_input
  ✓ Timing correct

[Turn 3] Stage: desk_tour
  ❌ No audio file - falling back to live TTS
  ✓ Spotlight on genome_card
  ⚠️ Genome card appears empty

Scene completed in 34s.

Issues:
1. opening: Spotlight shorter than audio (2.8s < 3.2s)
2. desk_tour: Missing pre-recorded audio
3. desk_tour: Genome card empty for demo user

> fix the spotlight timing

Reading current config...
spotlight_steps[0].duration = 2800ms
audio duration = 3200ms

Updating to 3500ms (audio + 300ms buffer)...
✓ Saved to database
✓ Invalidated cache

> generate tts for desk_tour

Stage desk_tour has 2 narrations:
  [0] "This is your desk, where insights live..." (no audio)
  [1] "The genome card shows your working style..." (no audio)

Generating TTS...
  [0] ✓ Generated (2.4s audio)
  [1] ✓ Generated (3.1s audio)

Save to storage? [y/n]: y

✓ Uploaded 2 audio files
✓ Updated scene definition with URLs
✓ Invalidated cache

> play desk_tour only

Playing stage 'desk_tour'...

  ✓ Audio playing from storage (not live TTS)
  ✓ Spotlight timing matches audio
  ⚠️ Genome card still empty

The genome card is empty because demo user has no genome_traits data.

> why is it empty?

Checking database...

SELECT genome_traits FROM profiles
WHERE user_id = 'demo-user-id';

Result: genome_traits = NULL

The genome card displays data from profiles.genome_traits, which is NULL
for the demo user. Options:

1. Add seed genome data for demo user
2. Skip genome_card spotlight when data is empty
3. Show placeholder content in genome_card component

Which approach?
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  hester scene console <slug>                                            │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                    Hester ReAct Agent                              │ │
│  │                                                                    │ │
│  │  System Prompt:                                                    │ │
│  │  "You are Hester, a scene authoring copilot. You can observe      │ │
│  │   Frame via screenshots, play scenes, and modify scene configs."  │ │
│  │                                                                    │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│          │                    │                      │                  │
│          ▼                    ▼                      ▼                  │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────────────┐│
│  │ Perception   │    │ Scene Edit   │    │ Database/Storage          ││
│  │ Tools        │    │ Tools        │    │ Tools                     ││
│  │              │    │              │    │                           ││
│  │ observe()    │    │ get_scene()  │    │ db_query()                ││
│  │ play_scene() │    │ update_stage │    │ check_demo_data()         ││
│  │ play_stage() │    │ add_spotlight│    │ storage_upload()          ││
│  │ screenshot() │    │ update_timing│    │                           ││
│  └──────────────┘    │ generate_tts │    └───────────────────────────┘│
│          │           │ save_tts     │                                  │
│          │           │ invalidate() │                                  │
│          │           └──────────────┘                                  │
│          ▼                                                             │
│  ┌───────────────────────────────────────────────────────────────────┐│
│  │                Chrome DevTools MCP                                 ││
│  │                                                                    ││
│  │  - take_screenshot() → Gemini 2.5 Flash perception                ││
│  │  - take_snapshot() → Accessibility tree for element detection     ││
│  │  - navigate(), click(), fill() → Browser automation               ││
│  │                                                                    ││
│  └───────────────────────────────────────────────────────────────────┘│
│                              │                                         │
│                              ▼                                         │
│                    ┌──────────────────┐                               │
│                    │  Frame @ :8889   │                               │
│                    │  (Flutter Web)   │                               │
│                    └──────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
```

## Tool Definitions

### Perception Tools (from HesterQA)

These tools reuse existing QA infrastructure:

```python
# Wraps ConversationDriver._perceive_and_think()
async def observe_frame(context: str = "") -> Dict[str, Any]:
    """
    Take screenshot + accessibility snapshot, analyze with Gemini 2.5 Flash.

    Returns:
        ui_state: Current UI state (thinking, message, component, complete, etc.)
        ui_description: What's visible on screen
        detected_components: Interactive elements found
        screenshot_path: Path to saved screenshot
        audio_playing: Whether audio is currently playing
        spotlight_visible: Current spotlight info if any
    """

async def play_scene(
    slug: str,
    max_turns: int = 30,
    stop_on_issue: bool = False,
) -> Dict[str, Any]:
    """
    Play entire scene, observing each stage transition.

    Returns:
        stages_observed: List of stage observations with timing
        issues: Detected problems (timing mismatches, missing audio, empty data)
        duration_ms: Total playback time
        screenshots: Paths to captured screenshots
    """

async def play_stage(slug: str, stage_name: str) -> Dict[str, Any]:
    """
    Play just one stage of a scene.

    Useful for testing specific changes without replaying entire scene.
    """

async def take_screenshot(label: str = "") -> Dict[str, Any]:
    """
    Capture current Frame state without perception analysis.

    Returns path to saved screenshot for user reference.
    """
```

### Scene Editing Tools

These tools interact with the database and Control Panel APIs:

```python
async def get_scene_definition(slug: str) -> Dict[str, Any]:
    """
    Load full scene definition from database.

    Returns the complete scene JSON including all stages,
    narrations, spotlights, and transitions.
    """

async def update_scene_definition(
    slug: str,
    updates: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Update top-level scene properties (name, goal, transitions_to, etc.)
    """

async def get_stage(slug: str, stage_name: str) -> Dict[str, Any]:
    """
    Get a specific stage definition.
    """

async def update_stage(
    slug: str,
    stage_name: str,
    updates: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Update stage properties.

    Supports:
    - prompt: Stage system prompt
    - behavior: linear, conversational, etc.
    - available_depths: [quick, standard, deep, reflective]
    - tools_focus: Comma-separated tool names
    - narration: List of narration objects
    - spotlight_steps: List of spotlight configs
    - ui_actions: List of UI action triggers
    """

async def update_spotlight_timing(
    slug: str,
    stage_name: str,
    spotlight_index: int,
    duration_ms: int,
) -> Dict[str, Any]:
    """
    Update spotlight duration for a specific stage.

    Common fix for "spotlight dismissed before audio finishes" issues.
    """

async def add_spotlight(
    slug: str,
    stage_name: str,
    target_region: str,
    title: str,
    description: str,
    duration_ms: int = 5000,
    position: str = "auto",
) -> Dict[str, Any]:
    """
    Add a new spotlight step to a stage.
    """

async def add_narration(
    slug: str,
    stage_name: str,
    text: str,
    index: int = -1,  # -1 = append
) -> Dict[str, Any]:
    """
    Add narration text to a stage.
    """

async def update_narration_text(
    slug: str,
    stage_name: str,
    narration_index: int,
    text: str,
) -> Dict[str, Any]:
    """
    Update narration text at a specific index.
    """
```

### TTS Tools

```python
async def generate_tts_preview(
    text: str,
    voice: str = "aura-asteria-en",
) -> Dict[str, Any]:
    """
    Generate TTS audio preview (returns base64, not saved).

    For quick iteration before committing to storage.
    """

async def generate_and_save_tts(
    slug: str,
    stage_name: str,
    narration_index: int,
    voice: str = "aura-asteria-en",
) -> Dict[str, Any]:
    """
    Generate TTS and save to Supabase storage.

    Updates scene definition with audio URL.
    """

async def generate_all_stage_tts(
    slug: str,
    stage_name: str,
    voice: str = "aura-asteria-en",
    skip_existing: bool = True,
) -> Dict[str, Any]:
    """
    Generate TTS for all narrations in a stage that don't have audio.
    """

async def generate_all_scene_tts(
    slug: str,
    voice: str = "aura-asteria-en",
    skip_existing: bool = True,
) -> Dict[str, Any]:
    """
    Generate TTS for all narrations in entire scene.
    """
```

### Cache/Admin Tools

```python
async def invalidate_scene_cache(slug: str) -> Dict[str, Any]:
    """
    Clear Redis cache for a scene.

    Required after making changes for Frame to pick them up.
    """

async def list_scenes() -> List[Dict[str, Any]]:
    """
    List all available scenes with basic info.
    """

async def check_demo_data(data_path: str) -> Dict[str, Any]:
    """
    Check if demo user has required data for a scene element.

    Useful for debugging "empty card" issues.

    Example: check_demo_data("profiles.genome_traits")
    """
```

## CLI Interface

### Commands

```bash
# Interactive copilot session (main interface)
hester scene console <slug>
  --frame-url URL       # Frame URL (default: http://localhost:8889)
  --screenshot-dir PATH # Where to save screenshots
  --no-browser          # Assume Chrome already running

# Quick commands (non-interactive)
hester scene list                           # List all scenes
hester scene show <slug>                    # Print scene definition
hester scene show <slug> --stage <name>     # Show specific stage
hester scene validate <slug>                # Check for common issues

hester scene play <slug>                    # Play and report observations
hester scene play <slug> --stage <name>     # Play single stage

hester scene tts <slug> --stage <name>      # Generate TTS for stage
hester scene tts <slug> --all               # Generate TTS for entire scene
hester scene tts <slug> --preview           # Preview without saving

hester scene invalidate <slug>              # Clear cache
hester scene invalidate --all               # Clear all scene caches
```

### Console Commands

Within `hester scene console`:

```
play [stage]          Play entire scene or specific stage
observe               Take screenshot and describe current state
screenshot [label]    Capture screenshot without analysis

show                  Show current scene definition
show stage <name>     Show specific stage
stages                List all stages

edit stage <name>     Open stage for editing (launches $EDITOR with JSON)
timing <stage> <ms>   Update spotlight timing
tts <stage> [index]   Generate TTS for stage/narration

save                  Save pending changes
invalidate            Clear scene cache
reload                Reload scene from database

help                  Show available commands
quit                  Exit console
```

## Implementation Plan

### Phase 1: Core Infrastructure

**Files to create:**

```
lee/hester/
├── scene/                      # New module
│   ├── __init__.py
│   ├── console.py              # Interactive console REPL
│   ├── tools.py                # Scene editing tools
│   ├── perception.py           # Wrappers around QA perception
│   └── prompts.py              # System prompts for copilot
```

**Tasks:**

1. [ ] Create `scene/perception.py` - Wrap QA's `ConversationDriver` perception
   - `observe_frame()` - Single screenshot + Gemini analysis
   - `play_scene()` - Full scene playback with observations
   - `play_stage()` - Single stage playback

2. [ ] Create `scene/tools.py` - Scene editing via Supabase
   - CRUD for scene definitions
   - Stage/narration/spotlight management
   - TTS generation (reuse Control Panel API logic)
   - Cache invalidation

3. [ ] Create `scene/console.py` - Interactive REPL
   - Session management
   - Command parsing
   - ReAct agent integration

4. [ ] Add CLI commands to `cli.py`
   - `hester scene console <slug>`
   - `hester scene list/show/validate`
   - `hester scene play`
   - `hester scene tts`

### Phase 2: ReAct Integration

**Tasks:**

1. [ ] Create `scene/prompts.py` - Copilot system prompt
   - Scene authoring context
   - Available tools documentation
   - Common patterns and fixes

2. [ ] Register scene tools with Hester daemon agent
   - Add to `HESTER_TOOLS` registry
   - Create tool handlers

3. [ ] Wire ReAct loop into console
   - Natural language commands → tool calls
   - Observation → reasoning → action cycle

### Phase 3: Polish

**Tasks:**

1. [ ] Add `--watch` mode for live feedback during manual testing
2. [ ] Timing analysis - detect audio/spotlight mismatches automatically
3. [ ] Data validation - check demo user has required data for scene
4. [ ] Diff view - show what changed before saving
5. [ ] Undo support - revert last change

## Example Session: Complete Workflow

```
$ hester scene console investor_demo

Hester Scene Copilot - investor_demo
Scene: Investor Demo (LINEAR, 6 stages)
Chrome DevTools: Connected ✓
Frame: http://localhost:8889 ✓

Loading scene definition...
✓ 6 stages: opening, value_prop, demo_genome, demo_matching, social_proof, cta

> validate

Validating scene 'investor_demo'...

Stage Analysis:
  opening:       ✓ 2 narrations, 2 have audio, 1 spotlight
  value_prop:    ✓ 3 narrations, 3 have audio, 0 spotlights
  demo_genome:   ⚠️ 2 narrations, 0 have audio, 2 spotlights
  demo_matching: ⚠️ 2 narrations, 1 has audio, 1 spotlight
  social_proof:  ✓ 1 narration, 1 has audio, 0 spotlights
  cta:           ✓ 1 narration, 1 has audio, 1 spotlight

Issues:
1. demo_genome: Missing audio for 2 narrations
2. demo_matching: Missing audio for 1 narration

> generate tts for demo_genome

Generating TTS for demo_genome...
  [0] "Let me show you the Genome..." ✓ (4.2s)
  [1] "These traits are extracted..." ✓ (3.8s)

Previewing...
  [Playing audio 0]
  [Playing audio 1]

Save to storage? [y/n]: y

✓ Uploaded 2 files to storage/audio/investor_demo/
✓ Updated scene definition
✓ Invalidated cache

> play demo_genome

Playing stage 'demo_genome'...

[Observation 1]
  Screenshot: Genome card visible with trait bars
  Audio: "Let me show you the Genome..." (4.2s) ✓
  Spotlight: genome_card, duration=5000ms ✓
  Timing: spotlight visible through audio ✓

[Observation 2]
  Screenshot: Spotlight moved to trait details
  Audio: "These traits are extracted..." (3.8s) ✓
  Spotlight: trait_list, duration=4000ms ✓
  Timing: spotlight visible through audio ✓

Stage completed successfully. No issues detected.

> the spotlight on trait_list should highlight individual traits one by one

That's a good enhancement. Currently the spotlight targets the entire
trait_list region. To highlight individual traits sequentially, we'd need to:

1. Split into multiple spotlight_steps, one per trait
2. Or modify Frame's spotlight component to support list iteration

Option 1 is simpler. Would you like me to:
A) Add 3 sequential spotlights for the top 3 traits
B) Keep single spotlight but extend duration

> A

Adding sequential trait spotlights...

Current spotlight_steps[1]:
  target_region: trait_list
  duration: 4000ms

Replacing with 3 spotlights:
  [1] target: trait_item_0, duration: 1500ms
  [2] target: trait_item_1, duration: 1500ms
  [3] target: trait_item_2, duration: 1500ms

Note: This assumes Frame supports trait_item_N targeting.
Let me check the Frame component...

Hmm, Frame's spotlight_overlay.dart uses region names, not dynamic indices.
We'd need to add support for indexed trait targeting.

Alternative: I can add spotlight targets for the trait categories instead:
  - trait_category_thinking
  - trait_category_working
  - trait_category_relating

These are already defined in Frame. Use these instead? [y/n]: y

Updated spotlight_steps:
  [1] trait_category_thinking, 1500ms
  [2] trait_category_working, 1500ms
  [3] trait_category_relating, 1500ms

✓ Saved to database
✓ Invalidated cache

> play demo_genome

Playing stage 'demo_genome'...

[Observation 1] Audio + genome_card spotlight ✓
[Observation 2] Spotlight on "Thinking Style" ✓
[Observation 3] Spotlight on "Working Style" ✓
[Observation 4] Spotlight on "Relating Style" ✓

Looks great! The traits now highlight sequentially.

> save and quit

All changes already saved. Exiting copilot.

Session summary:
- Generated 2 TTS audio files
- Modified 1 spotlight configuration (split into 3 sequential)
- Cache invalidated 2 times

$
```

## Dependencies

**Existing (no new deps):**
- `lee/hester/qa/driver.py` - ConversationDriver with Gemini perception
- `lee/hester/qa/mcp_client.py` - Chrome DevTools MCP client
- `lee/hester/daemon/agent.py` - ReAct loop infrastructure
- `frontend/controlpanel/views.py` - Scene/TTS API endpoints

**Database:**
- `scenes` table - Scene definitions
- `supabase.storage` - Audio file storage

**External:**
- Chrome with DevTools (already required for HesterQA)
- Frame running locally (typically port 8889)
- Deepgram API (for TTS, already configured)

## Security Considerations

- Scene Copilot only modifies `scenes` table (admin data, not user data)
- No access to production user data
- TTS generation uses existing Deepgram integration
- All changes logged in console session
- Cache invalidation is idempotent

## Future Enhancements

1. **Scene Templates** - Start new scenes from templates
2. **A/B Testing** - Create scene variants for testing
3. **Analytics Integration** - View scene completion rates
4. **Collaborative Editing** - Lock scenes during editing
5. **Version Control** - Scene definition history/rollback
6. **Export/Import** - Scene definitions as YAML files
