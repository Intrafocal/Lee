# Tether, Review and voice: plan and contract

> **Status:** Plan, 2026-09-28. Built by one workflow in parallel packages (§1), so the seams below are exact.
> **Supersedes:** `hester/docs/Multimodal.md` (RFC) and `hester/docs/VoicePlan.md`. Every VoicePlan decision is carried into §5; the RFC's parts not built are listed in §5.8.
> **Reads with:** `docs/16-Desk.md`, `docs/14-Deep-Work.md` §8.1 (Tether), `docs/13-Copilot.md` §15 (v6), and the Taxonomy Page on the Desk (`hester desk page taxonomy`).

## 0. What this round builds

Four parts, decided in conversation on 2026-09-28:

1. **Devices become Work · Review · Hester** (§3). Phone and T-Deck are good for reading and steering, not editing.
   - **Work** is Tether (the Cockpit on a device) with a **Pick up** block on top: your last card, its stopped-at line and open questions.
   - **Review** is read-only: the **Desk** (phone: Areas → Pages → a Page; T-Deck: Pages only, newest first), the **Drawer** (phone only: Stashed Areas and Ideas) and **Files**.
   - **Hester** is the chat, as today.
   - Capture stays a global action (phone: the capture button; T-Deck: `c`), landing in Ideas.
2. **Send to Lee** (§4): the phone and the T-Deck are input devices for Lee. A voice note (as its transcript), a photo, a screenshot, a scribble or text goes straight to Lee's focus (the Page you're on, Hester, a tab) or to the tab you're looking at. It's also the **compose** way to type into a tab from a device (§4.6), replacing keystroke-by-keystroke input for anything but TUI control, and the main way to steer a tab when you're away. Two modes: **Deliver** (into the input, not submitted) and **Send** (submitted).
3. **Voice** (§5): `VoicePlan.md` as written (Hester transcribes; Lee, Aeronaut and the T-Deck record), adapted to the renames.
4. **Renames and removals** (§2): Carry → Tether and Someday → Ideas in routes, types, stores, files and the CLI; Put away → Stashed in ids and routes; **Open next** and the pre-Desk routes are removed.

**Not this round:** a Desk canvas on devices; editing on devices; Board cards (a Board target is reserved in §4 but not built); native audio in the ReAct loop, server TTS, spoken alerts (§5.8); Dirigible over Tailscale (a research question); renaming the `deep.*` internals (events, the `deep` focus source, `DeepHost`), which run through G0's metrics and months of logs.

## 1. Packages and ownership

| Package | Owns | Summary |
|---|---|---|
| **Z** (first, alone, on `copilot-spec`) | `electron/src/shared/tether.ts` (new), `electron/src/shared/voice.ts` (new), additions to `shared/copilot.ts` and `shared/desk.ts`, compile fixes only elsewhere | The seam commit: every shared type in §2–§5 verbatim, so the builders type-check against the same code. Must pass `build:main`, `typecheck` and the smokes. The builders branch **after** it lands; none of them makes its own |
| **H** Hester | `hester/**`, `tests/**`, `pyproject.toml`, `docs/13…16`, `docs/plans/` updates, `GOALS.md` never | Renames (§2), Open next and pre-Desk routes removed, Page assets (§4.4), the voice package (§5.2), `hester ideas` and `hester desk` updates |
| **M** Lee main | `electron/src/main/**` (incl. `preload.ts`), `electron/package.json` (`build.mac`), `electron/build/entitlements.mac.plist` (new), main-side smokes, root `CLAUDE.md` | `/tether/*` routes (§3.3, §4.2), capture to `/ideas`, Send to Lee delivery over IPC, mic permission and entitlements (§5.3), event types |
| **R** Lee renderer | `electron/src/renderer/**`, renderer smokes, `design/icons.json` + generated icons | Renames in the clients, Send to Lee delivery (§4.3), Page images (§4.4), the palette taking images, voice UI (§5.3) |
| **A** Aeronaut | `aeronaut/**` | Work · Review · Hester, Pick up, Review, Send to Lee and compose in the tab view, voice and readback, renames |
| **D** Dirigible | `dirigible/**`, `docs/Dirigible.md` | Work with Pick up, Review (Pages + Files), compose in the tab view (§4.6), renames, voice input behind a build flag (§5.6) |

One owner per file. A package that must touch another's file keeps the change minimal and lists it as a deviation. Generated icon files belong to R (A and D consume them).

## 2. Renames and removals

No aliases: the phone, the T-Deck and Lee are installed together after this round, and an un-updated device simply stops talking to the new Lee.

### 2.1 Carry → Tether (M, A, D)

| Before | After |
|---|---|
| `GET /carry`, `POST /carry/capture` | `GET /tether`, `POST /tether/capture` |
| `electron/src/main/copilot/carry.ts`, `interface Carry`, `buildCarry`, `CARRY_*` | `tether.ts`, `interface Tether` (in `shared/tether.ts`), `buildTether`, `TETHER_*` |
| Aeronaut `models/carry.dart`, `CarryResult`, ValueKeys `carry-*` | `models/tether.dart`, `TetherResult`, `tether-*` |
| Dirigible `screen_carry.cpp`, `CarryState`, `core/.../carry.hpp` | `screen_tether.cpp`, `TetherState`, `tether.hpp` |
| `~/.lee/spool/someday.jsonl` | `~/.lee/spool/ideas.jsonl` |

`Tether` drops `open_next` and the `exploration_id` legacy alias (§3.3).

### 2.2 Someday → Ideas (H, M, R, A, D)

| Before | After |
|---|---|
| `POST/GET /someday`, `POST /someday/{id}/triage` | `POST/GET /ideas`, `POST /ideas/{id}/triage` |
| `hester/daemon/copilot/someday.py`, `SomedayStore`, `SomedayItem` | `ideas.py`, `IdeasStore`, `Idea` |
| `.hester/someday/sd_<stamp>_<hex>.md` | `.hester/ideas/idea_<stamp>_<hex>.md` |
| `hester someday capture|list` | `hester ideas capture|list` |
| Renderer `listSomeday`, `triageSomeday`, `captureSomeday`, `SomedayItem` | `listIdeas`, `triageIdea`, `captureIdea`, `Idea` |
| Events `someday.*` (whatever exists) | `idea.*`; metrics read both names so history counts |

**No data migration.** The user confirmed `.hester/someday/` holds nothing worth keeping; it was deleted on 2026-09-28. `IdeasStore` starts empty and never reads the old directory. The Desk's `ideas` Drawer and `/desk/ideas/{id}/page` keep their names; `/desk/ideas/{id}/page` takes the new ids.

### 2.3 Put away → Stashed (H, R)

- The Drawer id `put-away` becomes `stashed`. `DeskStore.load` rewrites it once in `desk.json` (Areas' `drawer_id`, the Drawer list); this one **is** migrated, since stashed Areas are real work.
- `POST /desk/areas/{id}/put-away` → `/stash`; `/take-out` → `/unstash`. `put_away_at` → `stashed_at` in the API and `desk.json`.
- Renderer constants `PUT_AWAY_DRAWER` → `STASHED_DRAWER`; `putAwayArea` → `stashArea`; `takeOutArea` → `unstashArea`.

### 2.4 Removed

- **Open next** (decided 2026-09-28: not useful): Hester `copilot/open_next.py`, `GET/POST/DELETE /copilot/open-next`, the opener's and `/desk/last`'s preference for it, `.hester/deep/open_next.json` (ignored, not migrated); Lee `POST /carry/open-next`; Aeronaut's Open next button; the T-Deck's Open next action; tests; docs (14 §8.1, 16, contracts).
- **Pre-Desk routes** nothing calls: `/cockpit/explorations/*` (incl. nodes, decisions, spikes, promote, archive, handoffs, draft-from-readme), `/library/sessions/*`. `ExplorationStore` stays as the read-only source of the Desk's one-time migration. `POST /cockpit/tasks/{id}/escalate` now makes a **Page card** from the task (origin `{kind: 'task', ref: <task id>}`, placed in the first Area) and returns `{card, area}`; R's caller follows.

## 3. Devices: Work · Review · Hester

### 3.1 Aeronaut

- **Tabs:** Work · Review · Hester (`root_shell.dart`). Library goes; its Tether tab's content becomes Work's Pick up block; its Ideas tab becomes Review › Drawer.
- **Work:** the **Pick up** block first (from `GET /tether`): last card title, Area, the stopped-at line in the writing font, up to 5 open questions. Tapping opens that Page in Review. Then Work as today. The capture button stays in Work's header (and anywhere it is today), sending to `/tether/capture`.
- **Review:** a segmented control **Desk · Drawer · Files**.
  - Desk: Areas (on the Desk) → their Pages → a Page, rendered as markdown (the app's existing markdown renderer), then its answers, hand-off results, open questions and references, collapsed by default.
  - Drawer: Stashed Areas → their Pages (read like Desk), and Ideas (read-only; triage stays in Lee).
  - Files: today's Files screen, moved here.
- **Hester:** as today, plus the mic (§5.5) and readback.
- **Send to Lee** (§4.5) is reached from Work's header and Hester's app bar; a tab's view opens in compose (§4.6).

### 3.2 Dirigible

- **Screens:** Work (Waiting / In flight as today, with Pick up on top), **Review** (Pages, then Files), Hester, Tabs. Library goes. Keys stay plain letters (§5.2 of 13): keep `w` Work, `i` In flight, `t` Tabs; **`v` Review** (replaces Library's key); `c` capture everywhere it works today.
- **Pick up:** one block: card title, stopped-at line (clipped to 2 lines), `n open questions`. Enter opens the Page in Review.
- **Review › Pages:** `GET /tether/pages` (newest first, 50), j/k to move, Enter opens the Page in the existing markdown viewer (the one Files uses), text only (`?text_only=1`). Files: today's Files screen.
- Strings: "Someday" → "Ideas" ("c captures a thought to Ideas"); "ball/tap a Lee" → "ball/tap a Machine"; the "Deep" title → "At the Desk". Screen text stays within today's widths.

### 3.3 Lee main routes for devices (M)

All on Lee's API (:9001), authenticated like `/fs/read` (shared or device token), `?workspace=` optional (default: the focused window's). They read Hester and trim for devices; 503 `{error: 'hester_offline'}` when Hester doesn't answer (except capture, which spools). Types in `shared/tether.ts` (Z):

```ts
export interface Tether {
  workspace: string;
  pick_up: {
    card_id: string; card_kind: DeskCardKind; title: string; area_name: string | null;
    stopped_at: string | null; stopped_line: number | null; last_touched_at: string | null;
  } | null;
  open_questions: Array<{ card_id: string; question_id: string; text: string }>; // ≤ 5
  captured_count: number;   // ideas captured away since the last Desk session
  spooled: number;          // captures waiting in Lee's spool for Hester
}
export interface TetherCard {
  id: string; kind: DeskCardKind; title: string; area_id: string | null; area_name: string | null;
  stashed: boolean; updated_at: string | null; chars: number; answers: number; open_questions: number;
}
export interface TetherDesk { workspace: string; areas: Array<{ id: string; name: string; cards: TetherCard[] }>; goals_card: TetherCard | null; last_card_id: string | null }
export interface TetherPage {
  card: TetherCard;
  text: string;                                   // ≤ 200 KB, cut at a line with "…" when longer
  answers: Array<{ id: string; question: string; answer: string | null; status: string }>;
  handoffs: Array<{ id: string; kind: string; provider: string | null; status: string; result: string | null }>;
  open_questions: Array<{ id: string; text: string }>;
  references: Array<{ title: string; where: string | null; quote: string | null }>;
}
export interface TetherDrawer {
  stashed: Array<{ id: string; name: string; stashed_at: string | null; cards: TetherCard[] }>;
  ideas: Array<{ id: string; text: string; created_at: string; surface: string | null }>;
}
```

| Route | Returns |
|---|---|
| `GET /tether` | `Tether` |
| `POST /tether/capture` `{workspace?, text, card_id?, input?: 'voice'}` | `{id}` or `{spooled: true}` (Hester offline); forwards to Hester `POST /ideas` |
| `GET /tether/desk` | `TetherDesk` (Areas on the Desk, not stashed) |
| `GET /tether/pages?limit=50` | `TetherCard[]`, every Page incl. stashed, newest first (the T-Deck's list) |
| `GET /tether/pages/:id[?text_only=1]` | `TetherPage` (`text_only`: `{card, text}`) |
| `GET /tether/drawer` | `TetherDrawer` |
| `GET /tether/targets` | `SendTargets` (§4.2) |
| `POST /tether/send` | §4.2 |

## 4. Send to Lee

### 4.1 What it is

The phone and the T-Deck are inputs for Lee: speak a note, take a photo, pick a screenshot, draw a scribble or type, and it lands where Lee's focus is or in the tab you choose. Next to you at the Machine it's a second input; away from it, it's how you steer a tab.

Two modes, chosen by the button you tap:
- **Deliver:** into the target's input, not submitted. You finish it (at the Machine, or with another send).
- **Send:** into the input, then submitted: Enter in a tab, the question asked in Hester's palette. A Page has only Deliver.

Send only ever comes from an explicit tap (or Enter on the T-Deck's compose line); voice fills the field and never submits. It never approves, denies or switches modes: approvals stay on their own buttons. It needs Lee running on the paired Machine; there's no queue.

### 4.2 Wire (M, types in `shared/tether.ts`)

```ts
export type SendTarget =
  | { kind: 'page'; card_id: string; title: string }
  | { kind: 'hester' }
  | { kind: 'tab'; pty_id: number; label: string; tab_kind: 'agent' | 'terminal' | 'tui'; provider: string | null }
  | { kind: 'board'; card_id: string; title: string }; // reserved: not built this round (no Board cards yet)
export interface SendTargets {
  /** What Lee's focused window has in front of it now, when it's a target: the zoomed Page, the palette, or the focused agent tab. */
  focus: SendTarget | null;
  /** Every other target: the open Pages this window has touched this session, Hester, each PTY tab (agents, terminals, TUIs). */
  targets: SendTarget[];
}
export type SendItem =
  | { kind: 'text'; text: string; input?: 'voice' }                        // a voice note arrives as its reviewed transcript (§5)
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; data_b64: string; caption?: string; source: 'photo' | 'screenshot' | 'scribble' };
export interface SendRequest {
  workspace?: string;
  target: SendTarget | 'focus';
  items: SendItem[];
  /** Send (true) or Deliver (false, the default). Tabs: Enter after the text; Hester: ask the question. Refused for Pages. Only from an explicit Send tap, never from voice. */
  submit?: boolean;
}
export interface SendResult { send_id: string; delivered_to: SendTarget }
```

- `POST /tether/send`: body ≤ 15 MB, ≤ 4 items, an image ≤ 10 MB decoded, text ≤ 20 000 chars. 400 on anything else; 409 `{error: 'no_target'}` when `focus` is asked for and nothing in front of you is a target; 503 `{error: 'no_window'}` when no Lee window has the workspace.
- `submit` is refused (400) for Page and Board targets and when the items hold no text.
- M validates, then sends IPC `tether:send` `{send_id, target, items}` to that window; R delivers (§4.3) and answers `tether:send-result` `{send_id, ok, error?}`; M returns 200 after the renderer's answer (timeout 10 s → 504).
- Event `tether.send` `{source_device, target_kind, items: [{kind, source?, input?, bytes}], ok}`: kinds and sizes only, never content.

### 4.3 Delivery in Lee (R)

| Target | Text | Image |
|---|---|---|
| **page** (zoomed or not) | Inserted as its own paragraph at the Page's cursor (the end when the Page isn't open), through the editor so it saves and undoes normally | Uploaded to the Page's assets (§4.4), then `![caption](assets/<file>)` inserted the same way |
| **hester** | Opens the palette with the text as the question; with `submit`, asks it (the answer appears in the palette as usual) | Attached to the palette's question (the palette sends `images` in its `ContextRequest`; add the attach UI if it lacks it) |
| **tab** (agent, terminal, TUI) | Pasted into the tab as one piece through xterm's `paste()`, which wraps it in bracketed paste when the program asked for it (Claude Code and zsh do), so a multi-line text doesn't submit line by line; then `\r` only when `submit` is true | Saved to `~/.lee/inbox/<send_id>-<n>.<ext>` (0600, pruned after 7 days), and its absolute path pasted the same way (Claude Code reads an image path) |

A quiet chip in the status bar: "From your phone: photo → Taxonomy · Undo" (or "From the T-Deck"). Undo removes a Page insertion while it's unchanged (a CodeMirror transaction). Tab and Hester targets have no undo; with Deliver, nothing was submitted. Compose sends to the tab you're viewing on the device (§4.6) don't show the chip, since you're watching that tab. The chip goes after 8 s.

### 4.4 Images on a Page (H, R)

- Hester: `POST /desk/pages/{id}/assets` (raw body, `Content-Type: image/png|image/jpeg`, ≤ 10 MB) → `{name: '<asset id>.<ext>', path: 'assets/<name>'}`, stored in `pages/<id>/assets/`; `GET /desk/pages/{id}/assets/{name}` serves it. Deleting a card deletes its assets. `hester desk page` lists a Page's images as paths.
- R: the Page renders `![...](assets/…)` as an image (fetched with auth into a blob URL; check the renderer CSP allows `blob:` for `img-src`), with the markdown shown on the cursor's line like other live markdown. `TetherPage.text` keeps the markdown; Aeronaut renders the image by fetching `GET /tether/pages/:id/assets/:name` (M proxies it, same auth).

### 4.5 On the phone (A)

A **Send to Lee** sheet: pick **Voice note** (records, transcribes via §5, shows the transcript to edit), **Photo** (camera), **Screenshot** (the photo library, most recent first), **Scribble** (a full-screen canvas: finger strokes, undo, clear, exports PNG) or **Text**. Several items can go in one send. The target defaults to Lee's focus from `GET /tether/targets`, shown as "To: Taxonomy (the Page you're on)", with a picker for the others. Send shows "Sent to Taxonomy" or the error. `Info.plist` gains camera and photo library usage strings.

### 4.6 Compose into a tab, from either device (A, D)

Direct tab input streams each keystroke, which is slow and awkward for anything longer than a few keys, and gets no autocorrect or dictation. It stays for driving TUIs; **compose** becomes the default for writing.

- **Aeronaut:** the tab view (`terminal_screen.dart`) opens in **Compose**: a native multi-line text field (autocorrect, iOS dictation, paste), the mic (§5.5), and attach (photo, screenshot, scribble). Two actions: **Deliver** (typed, no Enter) and **Send** (typed, then Enter). A **Keys** toggle switches to today's keystroke mode (arrows, Ctrl, Esc, Tab) for TUIs, and it's remembered per tab. The target is the tab itself (`{kind: 'tab', pty_id}`), through `POST /tether/send`.
- **Dirigible:** the Tabs screen's tab view gets a **compose line**: typing fills a local buffer (edit with backspace, ball to move, `Shift+Enter` for a new line), Enter sends it as one piece with Enter after (Send), `Alt+Enter` delivers it without Enter (Deliver); a key toggles to keystroke mode for TUIs (the agent picks a plain letter free on that screen, shown in the footer). Voice fills the buffer when `CONFIG_DIRIGIBLE_VOICE` is on.
- **From Work** (both devices): the Send to Lee entry opens the same composer, with Deliver and Send, aimed at Lee's focus, with the target picker. Replies to attention items keep their own Reply field (which already submits) and gain the mic.
- Voice never taps Send: a transcript fills the field, and you send it.

## 5. Voice (VoicePlan, carried over)

### 5.1 Decisions (fixed; from VoicePlan)

- Voice is **optional config**, off unless `hester.voice.enabled: true`. Off or unavailable, clients hide the mic and nothing breaks. The provider is **Gemini by default**, with **whisper** as a local alternative (an optional extra).
- A transcript **fills the text box it belongs to**; you review it and send. Approve and Deny are never voice-triggered (C3).
- TTS readback is **Aeronaut only**, uses on-device iOS TTS, behind a "Speak replies" toggle that **switches on when you send a voice message**.
- Dirigible comes **last**, voice input only.
- One shared architecture: Hester is the hub for transcription, one wire contract, each client a thin recorder.

### 5.2 Hester (H): `hester/daemon/voice/`

- **Wire format, everywhere:** 16 kHz, mono, 16-bit PCM WAV as the **raw request body** (not base64 JSON). Gemini doesn't list webm or m4a; the daemon validates with stdlib `wave`; whisper needs no ffmpeg; Dirigible can stream from PSRAM; 32 KB/s is 1.9 MB for 60 s.
- `GET /voice` → `{enabled, available, reason?, provider, model, location, accepts, sample_rate, channels, max_seconds, max_bytes}`; `reason` ∈ `disabled | no_api_key | whisper_not_installed | whisper_model_missing`.
- `POST /voice/transcribe?purpose=reply|capture|ask|send&item_id=&workspace=`: `Content-Type: audio/wav` → `{text, provider, model, location, audio_ms, latency_ms}`. Errors: 503 `voice_disabled` / `voice_unavailable:<reason>`, 415, 413 `too_large` (Content-Length checked before reading) or `too_long`, 422 `too_short`, 502, 504. Single pass, no ReAct loop, no session history; audio, hint and text are never persisted or logged.
- **Vocabulary hint** (deterministic, ≤ 40 terms and 1500 chars): the attention item's title and text (from Lee `GET /attention/:id`, as `fetch_attention_items` in `copilot/routes.py` does), tab labels and open file basenames from `app_state.lee_client.context`, the workspace name, and for `purpose=send` the target Page's title and headings.
- **Providers** (`STTProvider`: `availability()`, `async transcribe(wav, info, hint)`):
  - Gemini: `genai.Client().aio.models.generate_content` with `Part.from_bytes(wav, 'audio/wav')`, a "transcribe verbatim, do not answer" instruction with the preferred spellings, JSON schema `{text}`, temperature 0 (config pattern: `hester/daemon/workstream/gemini.py`). Logged by the existing wrap (`copilot/model_log.py`) with `trigger=user`.
  - Whisper: `faster-whisper` (arm64 wheels, `initial_prompt`, VAD), lazy-loaded `local_files_only`, int8, `asyncio.to_thread` behind a lock, unloaded after 10 min idle; it calls `record_model_call(provider='other', location='local', …)` itself.
- **Config** `hester.voice: {enabled, provider, gemini_model, whisper_model: base.en, max_seconds: 60, timeout_s: 30}` from `load_merged_config()`, cached by mtime, `HESTER_VOICE_*` env overrides.
- Files: `voice/{config,audio,hints,routes}.py` (`audio.py`: `parse_wav`, `validate`, `pcm16_to_float32`), `voice/providers/{base,gemini,whisper,__init__}.py`; `main.py` includes `create_voice_router()`; `copilot/lee_events.py` adds `voice.transcribe` to `INGEST_TYPES`.
- CLI `hester voice status | setup | test FILE.wav` (`setup` is the explicit whisper model download: the only network fetch for whisper, user-initiated, so C1 holds). `pyproject.toml` extra `voice-local = ["faster-whisper>=1.1"]`.
- **Events (never content):** `voice.transcribe` `{purpose, provider, model, location, audio_ms, bytes, ok, error?, text_chars, latency_ms}`. `ReplyRequest` and capture requests get `input?: 'voice'`, copied onto `attention.reply` and the capture event; together these give transcript acceptance (voice sends ÷ successful transcriptions).

### 5.3 Lee (M, R)

- **Shared contract** (Z writes `electron/src/shared/voice.ts`; Dart and C++ mirror it by hand): `VoiceCapabilities`, `VoicePurpose` (`reply | capture | ask | send`), `TranscribeResult`, `VoiceErrorCode` (the server codes plus `permission_denied | silence | network | cancelled`), `VoiceState = idle | arming | recording | transcribing | error`; constants 16 kHz, min 300 ms, client max 60 s (30 s on Dirigible); `appendTranscript(draft, t)` (empty draft becomes `t`; else `draft + (space if needed) + t`, caret at the end).
- **Rules every client follows:** show the mic only when `available`; cache capabilities 5 min and refetch after a 503; one recording at a time; tap toggles, and on Lee/Aeronaut a hold over 300 ms stops on release; the max auto-stops and still transcribes; cancel discards; silent or too-short clips are never uploaded; never auto-send, and focus returns to the field; tag the send `input: 'voice'`.
- **M:**
  - `main.ts`: `setPermissionRequestHandler` / `setPermissionCheckHandler` on the default session, allowing `media` only for audio from the app's own origin and **allowing every other permission as before** (a handler replaces Electron's allow-all default); IPC `voice:mic-status` / `voice:mic-request` (`systemPreferences.getMediaAccessStatus` / `askForMediaAccess`); `window.lee.voice` in `preload.ts` and `shared/lee-api.ts`.
  - `package.json` `build.mac`: `extendInfo.NSMicrophoneUsageDescription`; `entitlements` / `entitlementsInherit` → new `electron/build/entitlements.mac.plist` with `com.apple.security.device.audio-input` **and** Electron's JIT entitlements (a custom plist replaces electron-builder's defaults).
  - `pty-manager.ts` venv bootstrap: install `lee-tools[voice-local]` when the config says `provider: whisper`.
  - `voice.transcribe` in Lee's `INGEST_TYPES` and `LeeEventType`; `input` copied into `attention.reply` and capture events.
- **R** (no CSP change for audio):
  - `lib/voice/wav.ts` (pure PCM16 WAV encoder), `lib/voice/recorder.ts` (MediaRecorder webm/opus → `decodeAudioData` → `OfflineAudioContext` resample to 16 kHz → WAV; an AnalyserNode drives the level meter and the silence check), `lib/voice/hesterVoice.ts` (capabilities and transcribe, same origin and auth as `lib/hesterCopilot.ts`), `hooks/useVoiceInput.ts` (state machine and a global lock), `components/voice/MicButton.tsx` + `voice.css` (level ring, spinner, inline error, field-scoped `Mod+Shift+M`).
  - `design/icons.json`: `mic`, `speaker`, `camera`, `send` (then `node design/build.mjs`, which regenerates the TS, Dart and firmware icon files).
  - The mic goes in: the Work reply fields (agent reply popover, attention rows), the Drawer's capture box, the Command Palette's input (purpose `ask`), and the Page's Ask box (purpose `ask`).
  - `electron/scripts/voice-smoke.mjs`: WAV header and length, `appendTranscript` rules.

### 5.4 GOALS.md check (two-sided; from VoicePlan)

- **Moves:** device_creative_share ↑ (voice makes reply and capture cheap where typing is weak; Send to Lee makes the phone a creative input); attention_latency ↓ away from the desk (steering a tab with Send); pull_usage ↑. C1, C2 and C3 hold by construction: every model call comes from a press and is logged `trigger=user`; nothing auto-sends or approves, and Enter comes only from an explicit Send.
- **Costs:** tool_failures (permissions, bad transcripts: `voice.transcribe ok=false`, `tether.send ok=false`); toil_load (fixing transcripts: watch acceptance); capture_pickup may dilute if voice captures are low value. The readback guard: voice sessions only, foreground only.
- **Proposal only** (a human edits GOALS.md): diagnostic readings `voice.share`, `voice.acceptance` and `tether.send_share` in `hester/daemon/copilot/metrics.py`.

### 5.5 Aeronaut (A)

- `pubspec.yaml`: `record`, `flutter_tts`, `image_picker`; `Info.plist`: microphone, camera and photo library usage strings (no speech-recognition permission).
- New: `lib/models/voice.dart` (mirror), `lib/services/voice_api.dart` (raw-body POST to `machine.hesterUrl`, auth via `services/api_auth.dart`), `lib/services/voice_recorder.dart` (`record` WAV encoder, 16 kHz mono, temp file deleted after reading), `lib/providers/voice_provider.dart`, `lib/widgets/voice_button.dart`, `lib/services/speech_sanitizer.dart`, `lib/services/speech_service.dart` (queued `flutter_tts`, stops when recording starts), `lib/providers/speech_provider.dart` ("Speak replies" in shared_preferences, `autoEnableFromVoice()`, the set of `pty_id`s you replied to by voice).
- Wiring: `_ReplyField` in `widgets/attention_tile.dart` (mic between the field and Send, `input: 'voice'` through `attention_provider.dart` / `copilot_api.dart`), the capture sheet (`widgets/now_header_actions.dart`), Hester's `_InputBar` (`screens/hester_screen.dart`), Send to Lee's voice note; a speaker toggle in Work's header and Hester's app bar.
- **Readback** (toggle on, foreground only, stopped when you start recording): Hester's final chat answers; new attention items from agent sessions **you replied to by voice**, as "Claude, in \<tab\>: \<title\>. \<sanitized text\>"; approvals get the title only plus "Approve or deny on screen." Nothing else, so the phone doesn't narrate (pull-first).
- **Speech sanitizer** (deterministic; test vectors in `aeronaut/test/speech_sanitizer_test.dart`):
  1. A code fence becomes "a N-line \<Language\> snippet".
  2. A table becomes "a table with N rows"; a link keeps its text; a bare URL becomes "a link to \<host\>".
  3. Inline code loses its backticks; paths become basenames; camelCase and snake_case are split.
  4. Markdown syntax is stripped.
  5. Cut at a sentence boundary around 600 chars, ending "More on screen."

### 5.6 Dirigible (D): voice input, behind a flag

- Built behind `CONFIG_DIRIGIBLE_VOICE` (Kconfig, **default off**) until verified on the device with the user; the agent builds and host-tests it, never flashes.
- **Verify the hardware in code comments and the first on-device check:** LilyGO's T-Deck schematic and `utilities.h` for the ES7210 mic ADC's I2C address and pins, its power gate, and whether the keyboard reports key-up (if not, tap-to-toggle only).
- `platform/esp32/components/tdeck-bsp`: audio pin defines in `include/tdeck_board.h`; new `tdeck_audio.cpp` (ES7210 via `espressif/esp_codec_dev`, I2S RX at 16 kHz into a PSRAM buffer): `tdeck_mic_start/read/stop`.
- `core/include/dirigible/transport.hpp`: `IHttpClient::postBody(url, content_type, bytes, cb)`, implemented in `transport_esp.cpp` with `esp_http_client_open(len)` and 4 KB writes, 35 s timeout (the fully-buffered cJSON post can't carry ~1 MB).
- New `core/include/dirigible/voice.hpp` + `core/src/voice.cpp`: capabilities, WAV header, `VoiceClient::transcribe`.
- Compose Reply / Capture (`screen_waiting.cpp`) and `screen_hester.cpp`: a mic touch button plus a plain-letter key, an elapsed-time footer, a 30 s cap; the transcript goes in via `lv_textarea_add_text`; the reply gets `input: 'voice'`.
- Host test `tools/wav-test` next to `md-test` / `vt-test`.

### 5.7 Risks (from VoicePlan)

- macOS mic permission (TCC): in dev it belongs to `Electron.app` or the launching terminal (`tccutil reset Microphone com.github.Electron`). Packaged builds need both the usage string and the entitlement, or `getUserMedia` fails silently.
- Gemini may answer instead of transcribing (mitigated by the schema and instruction) and may hallucinate on silence (client silence gate, minimum length). Latency about 1–3 s.
- Whisper: 200–500 MB RAM while loaded, CPU only.
- iOS audio session: `record` vs `flutter_tts` (stop TTS before recording).
- Dirigible: a 1 MB upload over Wi-Fi takes about 4–8 s; the pins are unverified.

### 5.8 The RFC's parts not built (from Multimodal.md)

Kept for later, not this round: native `audio` in `ContextRequest` and the ReAct loop (audio + image fused in one question, tone); a `transcript` SSE event; server TTS (`POST /tts`, a pluggable engine: macOS `say` / AVFoundation, Kokoro or Piper locally, Gemini audio modality, cloud providers); `tts: true` on `/context/stream` with `spoken_summary` and `audio` events; spoken alerts (attention items, task completion) through Lee or headphones; a Lee dictation hotkey beyond the mic button; T-Deck speaker output. Open questions it raised stay open: whether audio is ever kept (the default here: never), and single clips vs streamed audio (clips here).

## 6. Checks

| Package | Must pass (report exit codes) |
|---|---|
| Z | `npm run build:main`, `npm run typecheck`, the renderer and copilot smokes |
| H | `PYTHONPATH=$(pwd) ~/.lee/venv/bin/python -m pytest tests/copilot -q -p no:cacheprovider` (new tests: ideas store and routes, stash/unstash and the `put-away` → `stashed` migration, escalate → Page card, Open next and pre-Desk routes gone (404), Page assets, voice audio/config/hints/routes/gemini/whisper with fakes, `hester ideas` and `hester desk` CLI) |
| M | `build:main`, `typecheck`, `node scripts/copilot-queue-smoke.js`, `copilot-usage-smoke.js` (the `/tether/*` routes, send validation and IPC round trip with a fake window, spool rename) |
| R | `typecheck`, `deep-renderer`, `desk-renderer`, `cockpit-renderer`, `cockpit-work` smokes, new `voice-smoke.mjs` and a send-delivery smoke (pure logic: target resolution, insertion text, inbox paths, `submit` only for tabs) |
| A | `flutter analyze`, `flutter test` (Flutter at `~/Development/flutter/bin`) |
| D | host tests (`make check` in each `dirigible/tools/*-test`; vt-test's 7 colour failures predate this round), `idf.py build` with and without `CONFIG_DIRIGIBLE_VOICE`; never flash |

Nobody runs `dist:mac`, reinstalls Hester, flashes the T-Deck or installs Aeronaut; the lead does that after merging, with the user. The skill text in `electron/src/main/copilot/claude-plugin.ts` (M) is updated for `.hester/ideas/` and Stashed.

## 7. Decisions this plan makes (revisable)

- Voice notes reach Lee as reviewed transcripts, never as audio (VoicePlan's "never persisted").
- Send to Lee has no queue: it needs Lee running, and fails plainly otherwise.
- Two modes everywhere it makes sense: Deliver (not submitted) and Send (submitted: Enter in a tab, asked in Hester). `submit` comes only from an explicit Send tap or the T-Deck's Enter; voice never submits.
- Compose is the default in a device's tab view; keystroke mode stays one toggle away for TUIs.
- Images on Pages live with the card (`pages/<id>/assets/`) and go when it's deleted.
- New idea ids use `idea_`; old `sd_` files are gone.
- The T-Deck's Review key is `v`.
