# Copilot v3: Explore absorbs the Library

> **Status:** Contract, 2026-09-26
> **Spec:** [`docs/13-Copilot.md`](../13-Copilot.md) §2.1, §7.2 (escalate), §7.5, §12, §14, §15 v3 · **Goals:** [`GOALS.md`](../../GOALS.md)
> **Builds on:** the v2 contracts and their 2026-09-26 addenda (Explore v-now: `.hester/explore/<id>.md`, `ExplorationStore`, `/cockpit/explorations*`).
> **Branch:** `copilot-spec`. Two packages: **P** (Python: `hester/`, `tests/`) and **R** (Electron: `electron/`). They share only this document.

## 0. Decisions (2026-09-26, the user)

- **Explore absorbs the Library.** There is one store for open-ended work: `.hester/explore/<id>.md`. The Library pane stays as a **tree view onto the same files**. Its Redis tree sessions (`ExplorationSessionManager`, `InMemoryExplorationSessionManager`, 2 h TTL) are deleted. Nothing about an exploration expires.
- Explorations become a **node tree**. The root node is the exploration itself (its Seed and `## Log`, unchanged). Nodes can be branches (Library nodes), **decision** nodes, **spike** nodes and **evidence** nodes.
- Everything stays deterministic except the per-node chats, which the user triggers (C2). Promotes, decisions, evidence capture and archive-as-knowledge involve no model.

GOALS check (two-sided): moves G2 `lost_threads` ↓ (nothing expires, and pruning or promoting records an outcome) and G1 `tool_failures` ↓ (the broken promote and the TTL loss are fixed). It costs nothing new for the operator: no required fields, and reasons are optional.

## 1. File format (P)

`<ws>/.hester/explore/<id>.md`. Only additive changes, so v-now files still load.

### 1.1 Frontmatter

The fields from v-now stay. New fields:

```yaml
nodes:                     # ordered; absent in v-now files => just the root
  - id: root               # always present, always first; the exploration itself
    parent: null
    label: <title>         # kept equal to the exploration title
    kind: thought
    mode: ideate           # Library agent mode, see 1.3
    created_at: ...
  - id: n-1a2b3c4d         # "n-" + 8 hex
    parent: root
    label: Try a file-first store
    kind: thought | source_file | source_web | source_db | decision | spike | evidence
    mode: explore          # thought/source nodes only
    collapsed: false
    pruned: false          # set by a prune; a pruned node stays in the file
    created_at: ...
    turns: 0               # exchanges in this node's log
    # decision nodes
    decision: { text: "...", chosen: [n-..], pruned: [n-..], reason: null }
    # spike nodes
    spike: { prompt: "...", task_id: task-.., status: pending|running|review|done|discarded|failed,
             timebox_min: 30, worktree: { slug, path, branch } | null, started_at, ended_at }
    # evidence nodes (child of a spike)
    evidence: { task_id, summary, lee_status, files: [..], diffstat: "...", diff_path: ".hester/explore/evidence/<exp>-<node>.diff" | null,
                commits: [sha..], captured_at, claim: true }
active_node: root
serves: []                 # optional goal ids (G1..), used by promotes
promoted: []               # [{to: task|workstream|goal, ref, at, node_ids}]
knowledge_path: null       # set by archive-as-knowledge
```

`origin.kind` gains `library` (created from the Library pane) and `task` (escalated from a task, ref = task id).

### 1.2 Body

```
# <title>

## Seed

<seed>

## Log                                   <- root node's conversation (unchanged)

### You · 2026-09-26T10:00:00Z
...
### Hester · 2026-09-26T10:00:05Z
...

## Node n-1a2b3c4d · Try a file-first store      <- one section per non-root node that has a log
### You · 2026-09-26T10:03:00Z
...
```

- Message headings match exactly `^### (You|Hester) · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`. Node section headings match exactly `^## Node (n-[0-9a-f]{8}) · .*$`. Content between headings is the message, trimmed. The parser splits only on these exact patterns, so markdown headings inside answers are safe.
- Appending to the root log inserts before the first `## Node` section. Appending to a node appends to its section, creating the section at the end of the file on first use.
- Decision, spike and evidence nodes have no log. Their text lives in frontmatter, and the Library/Explore views render it.
- A node rename rewrites its section heading. Renaming the root renames the exploration (title plus `# <title>`).

### 1.3 Library compatibility

Library `node_type` maps to `kind`, and `agent_mode` maps to `mode` (`ideate|explore|learn|brainstorm|visualize|search`). A node's `conversation_history` is its parsed log: `[{role: user|assistant, content, timestamp, metadata: {}}]`. For the root, that is the `## Log`.

## 2. Store API (P, `hester/daemon/cockpit/explorations.py`)

Extend `ExplorationStore`. Callers serialise writes (`ctx.lock`), as today.

- `nodes(exp_id) -> list`, `conversation(exp_id, node_id) -> [msg]`
- `add_node(exp_id, parent, label, kind='thought', mode=None, extra=None) -> node`: the parent must exist and must not be a spike or evidence node, except that evidence goes under a spike.
- `rename_node(exp_id, node_id, label)`, `set_collapsed(...)`
- `record_turn(exp_id, user, assistant, node_id='root')`. The existing signature keeps working. It bumps the node's `turns` and the exploration's `turns`.
- `decide(exp_id, {text, parent?, chosen?, pruned?, reason?}) -> decision node`: marks `pruned` nodes. `prune(exp_id, node_id, reason=None)` is `decide` with `pruned=[node_id]`, `parent = node.parent` and text `Pruned: <label>`. `reason` is optional everywhere and can be set later with `PATCH` on the decision node (`{reason}`).
- `add_spike(exp_id, {parent?, prompt, title?, timebox_min=30}) -> spike node` (status `pending`)
- `update_spike(exp_id, node_id, {task_id?, status?, worktree?, started_at?, ended_at?})`
- `add_evidence(exp_id, spike_node_id, evidence) -> evidence node`. When the spike's evidence changes, the existing evidence node is replaced rather than duplicated (one per spike).
- `outline(exp_id) -> str`: a deterministic markdown outline of the tree, listing decisions, spikes with status, and evidence summaries. Used by promotes and archive.

## 3. HTTP (P)

All under the existing cockpit router, with workspace resolution (`context_for`) and the `_ok`/`_err` envelope as for `/cockpit/explorations`. `Exploration` responses now include `nodes`, `active_node`, `serves`, `promoted` and `knowledge_path`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/cockpit/explorations/{id}` | | adds `nodes` (each with `conversation` for thought/source nodes) |
| POST | `/cockpit/explorations/{id}/nodes` | `{parent, label, kind?, mode?}` | node (201) |
| PATCH | `/cockpit/explorations/{id}/nodes/{nid}` | `{label?, collapsed?, reason?}` (`reason` only on decisions) | node |
| POST | `/cockpit/explorations/{id}/nodes/{nid}/prune` | `{reason?}` | `{node, decision}` |
| POST | `/cockpit/explorations/{id}/decisions` | `{text, parent?, chosen?, pruned?, reason?}` | decision node (201) |
| POST | `/cockpit/explorations/{id}/spikes` | `{parent?, prompt, title?, timebox_min?}` | spike node (201) |
| PATCH | `/cockpit/explorations/{id}/spikes/{nid}` | `{task_id?, status?, worktree?}` | spike node |
| POST | `/cockpit/explorations/{id}/promote` | `{to: task\|workstream\|goal, node_ids?, title?}` | see §5 |
| POST | `/cockpit/explorations/{id}/archive` | `{as_knowledge?: bool}` | `{exploration, knowledge_path?}` |
| PATCH | `/cockpit/explorations/{id}` | also `{serves?}` | |
| POST | `/cockpit/tasks/{id}/escalate` | `{}` | `{task, exploration}` (§6) |

## 4. Spikes (P + R)

A spike runs an agent in a git worktree as a task with `delegate` lead and a timebox. Its summary and diff come back as an evidence node.

**Launch (R).** "Spike…" (from the Explore section or a Library node) asks for a prompt (prefilled with the node label) and then:
1. `POST …/spikes {parent, prompt, title}` gives the spike node.
2. `launch({workspace, lead:'delegate', kind:'prototype', worktree:true, prompt, title, name: 'Spike: <title>', origin:{kind:'explore', ref:'<exp id>/<node id>'}})`.
3. `PATCH …/spikes/{nid} {task_id, status:'running'}`.

**Worktree metadata (R, `launcher.ts`).** When `plan.worktree` is true for claude, add to the `task.launch` event data `worktree: {slug, path: <ws>/.claude/worktrees/<slug>, branch: 'worktree-<slug>'}` (`worktree` stays a truthy object; code that tested `data.worktree` as a boolean still works). Carry the same object on the relayed `TaskRecord` as `worktree`. `TaskOriginKind` gains `'explore'` in `shared/cockpit.ts` and in `validOrigin()`.

**Hester (P).**
- `tasks.py`: `ORIGIN_KINDS` gains `explore`, and the task record gains `worktree` (null by default; set from the relay or the `task.launch` event).
- `follower.py`: on `task.launch` with `origin_kind == 'explore'`, and whenever a task with `origin.kind == 'explore'` changes status (see below), call `spikes.sync(ctx, task)` (new module `hester/daemon/cockpit/spikes.py`, which never raises):
  - It maps the task's status to the spike status: running/waiting/idle/queued → `running`, review → `review`, done → `done`, discarded → `discarded`.
  - On the first move to `review` or a closed status, and again on each later `agent.turn_end` while in review, it captures evidence:
    - `summary` and `lee_status` are the agent's words and are labelled `claim: true`.
    - `files` are the task's files.
    - `diffstat` and the diff come from `git -C <worktree.path> diff <merge-base>` against the workspace's default branch. The merge base is `git merge-base HEAD <default>`. The diff is taken against the working tree, so it includes both committed and uncommitted changes. Untracked files are listed but their contents are not included.
    - The diff is written to `.hester/explore/evidence/<exp>-<node>.diff` (0600, capped at 512 KB with a truncation line).
    - `commits` are `git log <merge-base>..HEAD` in the worktree, capped at 20.
    - If the worktree is missing, it records the evidence without a diff.
  - The `task.launch` event and the relayed record both carry the origin ref `exp-…/n-…`. The spike's `task_id` is set from whichever arrives first, if the renderer's PATCH hasn't done it already.
- Timebox: the spike node shows `timebox_min`. Enforcement is v4's `time/timebox-exceeded`.

## 5. Promotes (P)

`POST /cockpit/explorations/{id}/promote {to, node_ids?, title?}`. `node_ids` defaults to the whole tree. What is carried is `outline()` restricted to those nodes and their decisions and evidence, **not a transcript dump**.

| `to` | Does | Returns |
|---|---|---|
| `task` | `ctx.tasks().upsert({title: title or exploration title (≤ 80), status:'queued', lead:'delegate', kind:'unknown', confirmed:true, serves: exploration.serves, origin:{kind:'explore', ref:<exp id>}, note: <outline>})` | `{exploration, task}` |
| `workstream` | `WorkstreamOrchestrator(ctx.ws_store()).promote_from_idea(session_id=<exp id>, title, objective=<outline ≤ 4000>)`, then sets `serves` from the exploration. Each decision node becomes a `DesignDecision` (question = decision text, decision = chosen labels or "pruned: …", rationale = reason or "") through the orchestrator's `record_decision`, or directly on the design doc if the orchestrator rejects it in the current phase. | `{exploration, workstream_id, title, phase}` |
| `goal` | Writes a **draft**, never GOALS.md: `.hester/goals/drafts/<exp id>.md`, holding a `### G<next> <title>` block (next = max existing G number + 1), the seed as prose, the decisions as bullets, and a `- metric: **<name>**: …` skeleton with `kind`, `signal`, `available`, `target` and `guard` placeholders per GOALS.md's format rules. Only the human edits GOALS.md (§7.3). | `{exploration, draft_path}` |

Every promote appends `{to, ref, at, node_ids}` to `promoted`, adds a decision node `Promoted to <to>: <ref>`, and logs nothing else. A promoted exploration stays active.

**Library route.** `POST /library/sessions/{sid}/promote-to-workstream {node_ids}` becomes a thin call to the same promote (`to: 'workstream'`) and keeps its response shape `{workstream_id, title, phase}`.

## 6. Escalate a task (P)

`POST /cockpit/tasks/{id}/escalate` creates an exploration:
- `title`: the task title
- `seed`: the title, a blank line, then `lee_status.summary` or `summary` (the agent's words, labelled), then `Files: …` (≤ 20)
- `origin: {kind:'task', ref: task id}`, `serves`: the task's

It sets the task's `note` to `explore:<exp id>`, and the task stays open. Returns `{task, exploration}`.

## 7. Archive as knowledge (P)

`POST …/archive {as_knowledge: true}` sets status `archived` and writes `.hester/knowledge/explore-<id>.md`: title, dates, seed, `outline()`, promoted links, and the last Hester answer of each unpruned thought node (≤ 1500 chars each). The note is deterministic and uses no model. `knowledge_path` is recorded. Without `as_knowledge` it is the plain archive of v-now.

**Hester can draw on it:** add a read-only tool `knowledge_notes` (in `hester/daemon/tools/definitions/cockpit_tools.py` + handler in `cockpit_tools.py`, in the same toolset as `cockpit_tasks`). With no `name` it lists the notes (name, title, archived_at); with `name` it reads one note.

## 8. The Library re-pointed (P routes, R pane)

The routes keep their paths and response shapes so that `LibraryPane` needs only small changes. `session_id` **is the exploration id**, and node ids are `root` or `n-…`. Workspace resolution follows `context_for` (the pane now sends `X-Lee-Workspace`).

| Route | New behaviour |
|---|---|
| `POST /library/sessions {title, working_directory?}` | `create({title, origin:{kind:'library'}})` returns `{session_id, title, root_id:'root', nodes}` |
| `GET /library/sessions` | active explorations as `{session_id, title, node_count, created_at, last_activity: last_touched_at}` |
| `GET /library/sessions/{sid}` | `{session_id, title, root_id, active_node_id, nodes: {id: {id, parent_id, label, node_type, agent_mode, conversation_history, children, collapsed, created_at, pruned, kind, decision?, spike?, evidence?}}, created_at, last_activity}` |
| `DELETE /library/sessions/{sid}` | **archives** (a file is never deleted): `{status:'archived', session_id}` |
| `POST /library/sessions/{sid}/nodes`, `PATCH …/nodes/{nid}` | `add_node` / `rename_node` |
| `POST …/nodes/{nid}/chat`, `…/continue` | Same SSE and agents as today. The per-node Hester session `library-{sid}-{nid}` is seeded from the file when missing (system message: breadcrumb plus the node's log tail ≤ 12 000 chars). The finished exchange is appended to the node's log in the file, instead of to Redis. |
| `POST …/save` | Saves to **Someday** instead of the plugin `idea_push`: `ctx.someday()` capture with text = the rendered subtree (≤ 4000 chars), `as: 'explore'`, source `lee`. Returns `{success:true, idea_id:<someday id>}`. |
| `POST …/synthesize`, `…/visualize` | Unchanged, except that nodes and results are read from and written to the file |
| `POST …/promote-to-workstream` | §5 |

Delete `ExplorationSessionManager`, `InMemoryExplorationSessionManager`, `ExplorationNode`, `ExplorationSession`, their exports, `app_state.exploration_sessions`, its startup and reconnect wiring, and `get_exploration_sessions`.

`record_session_turn` (the `explore-<id>` deep dive) is unchanged and writes to the root log.

## 9. Renderer (R)

**`lib/hesterCockpit.ts`:** types `ExploreNode` and `Exploration` (with nodes), plus client functions for every route in §3.

**`ExploreSection.tsx`:** the expanded row shows the tree as an indented outline:
- Nodes show their label and kind. A pruned node is struck through, a decision shows its text with an optional reason (with an "add reason" inline edit), a spike shows its status, elapsed time vs timebox and task link, and evidence shows the summary labelled "agent's claim", the diffstat and **Open diff** (opens the `.diff` file in the Workbench editor).
- Actions:
  - **Dive in** (unchanged)
  - **Open tree** (opens the Library tab on this exploration)
  - **Spike…** (§4)
  - **Decide…** (one text field, optional reason)
  - **Promote ▾** (Task / Workstream / Goal draft). A workstream opens its tab, and a goal draft opens the draft file in the editor.
  - **Archive ▾** (Archive / Archive as knowledge)
- Per-node actions (on hover): Prune, Spike from here.
- No action requires a reason.

**Tasks section:** a new "Escalate → Explore" action on a task calls `/escalate` and selects the new exploration.

**`LibraryPane.tsx` and `components/library/*`:**
- Send `X-Lee-Workspace: encodeURIComponent(workspace)` on every call; follow the existing header helper in `hesterCockpit.ts`.
- Accept an optional `openSessionId` prop that selects that exploration on mount or change.
- "Delete" becomes "Archive".
- Render decision, spike and evidence nodes read-only in `ExplorationTree` with a distinct icon; chat input is disabled on them.
- Add context-menu items: Prune, Spike from here, Promote → Task / Workstream / Goal.
- Fix promote-to-workstream: replace `window.lee.sendCommand` with a new prop `onOpenWorkstream(id, title)`, which `App.tsx` wires to `handleWorkstreamSelect`.
- The Library tab title stays "Library".

**Opening the tree from the Cockpit:** `CockpitHost` gets a prop `onOpenLibrary(expId)`. `App.tsx` implements it by opening or refocusing the Library tab and setting its `openSessionId` (store `librarySessionId` on the tab's data, as `workstreamId` is stored).

**Opening files:** use the Cockpit's existing open-file path, the one the Files section uses.

## 10. Tests

- **P:** extend `tests/copilot/test_explorations.py` and add `test_explore_tree.py`:
  - the parser round-trips, including markdown headings inside answers
  - a v-now file loads unchanged
  - add, rename and prune nodes
  - decision with and without a reason
  - spike sync status mapping, and evidence with a real temp git repo and worktree (diff and commits captured)
  - the three promotes: task fields, workstream brief and decisions, goal draft with the next G id and GOALS.md untouched
  - escalate
  - archive as knowledge, and the `knowledge_notes` tool
  - the Library routes' shapes (create, get, nodes, archive-on-delete, save → Someday, promote)
  - chat write-back with `process_context` stubbed
- **R:**
  - `npm run typecheck` is clean
  - extend `electron/scripts/cockpit-explore-smoke.mjs` for the new client functions (against a stub server, as it does today)
  - add a `launcher.ts` unit check (in `cockpit-tab-smoke.js` or a new script) that `task.launch` carries the `worktree` object and that `origin.kind: 'explore'` validates

## 11. Docs

- Update `docs/13-Copilot.md`: §7.5 moves "Later" items to done, §12 says Explorations live at `.hester/explore/`, §14 marks the Library rows fixed.
- Update the `explorations.py` docstring and `CLAUDE.md`/`hester/CLAUDE.md` wherever the Library is described.
