# Dirigible

A LilyGO T-Deck running firmware that talks to Lee: see what is waiting on
you and answer it, capture an idea, watch the live tab list, type into one
terminal, ask Hester a question. Plain ESP-IDF + LVGL — no
framework, no code generation.

```
dirigible/
├── core/                     portable C++ protocol layer, no ESP-IDF in it
│   ├── include/dirigible/    LeeConnection, PTYClient, HesterClient,
│   └── src/                  MachineManager, LeeContext models, EventBus
├── platform/esp32/components/
│   ├── dirigible-core/       wraps core/ as an ESP-IDF component
│   ├── dirigible-esp32/      transports (websocket/http/mdns), WiFi, NVS config
│   └── tdeck-bsp/            T-Deck board support: ST7789, GT911, keyboard,
│                             trackball, battery, LVGL glue
├── firmware/                 the ESP-IDF project (main/, sdkconfig.defaults,
│                             partitions.csv)
└── tools/dirigible-provision/  host-side NVS provisioning over USB
```

## Build

Requires ESP-IDF v5.4.

```bash
source /path/to/esp-idf/export.sh
cd dirigible/firmware
idf.py set-target esp32s3      # first time only
idf.py build
idf.py -p /dev/tty.usbmodem* flash monitor
```

The component manager fetches `lvgl`, `esp_lcd_touch_gt911`,
`esp_websocket_client` and `mdns` on the first configure, so that step needs
network access.

## Pairing

On first boot (no WiFi credentials or no machine in NVS) the device opens the
pairing flow; you can reach it later from the menu (hold the trackball).

1. pick a WiFi network from the scan
2. type the password — Enter connects and saves it
3. pick a Lee instance found over mDNS (`_lee._tcp`), or choose **Manual entry**
   and type `host` / `host:port`
4. the device shows a **6-digit code**; Lee pops a "Pair a device" dialog with
   the same code — click **Approve** there and the token arrives on its own

Step 4 is code approval (E19): the device POSTs the code and a random nonce to
Lee's unauthenticated `/pair/request`, then polls `/pair/poll` every 1.5 s for
up to 120 s while a bar counts down. Lee's dialog names the device, its kind and
its IP, defaults to **Deny**, and only an Approve releases the bearer — once.
Nobody types 36 characters on a thumb keyboard, and because the code lives on
the device's screen, a machine that merely knows Lee's address cannot pair
itself. Lee logs every approval and denial to `lee.log`.

Since Copilot v0 the approved grant is a **per-device token** plus a
`device_id` (`dev_` + 12 hex): Lee stores only its hash, lists the device under
Devices, can revoke it, and attributes what the device does to it. The device
keeps the id in NVS next to the token (`did_<name>`) and shows it in the setup
card and in the empty Waiting screen's footer. Replying to an agent needs a device
token: a device still holding the shared token can read the queue but gets
`re-pair to reply`.

If pairing fails (denied, expired, or Lee unreachable) the card turns red and
the footer offers **Retry** and **Token**.

**Typed-token fallback.** The old step is still there behind that **Token**
button — for a Lee older than E19, one with `hester: { pairing_enabled: false }`
in `~/.lee/config.yaml`, or a network that will not pass the POST. Type the
bearer from `cat ~/.lee/api-token` — or, better, a device token from
**Create device token** in Lee's Devices list, which can reply; the field
counts up to `n/36` and turns green when what you typed is a UUID. **Code** goes back to the approve screen.

Every screen carries a 20 px header (title | step/status | battery, WiFi, link
dot) and a 16 px footer key legend. The pairing screen shows four step chips
across the top, a summary card down the right that fills in as you go (SSID and
signal, IP, Lee name/host:port/workspace, Hester port, and failures in red), and
the step's own list or text entry on the left. **Back** is a footer button as
well as the header's back button and a trackball hold; the ball scrolls the
WiFi and Lee lists (click picks the highlighted row) and leaves the text
entry steps alone.

To eyeball every pairing state without a network:

```bash
idf.py -DDIRIGIBLE_UI_DEMO=1 build flash monitor   # cycles the steps every 3 s
```

The same build gives the Work screen a canned queue (a blocker, an
approval with long text, a waiting item, a multiple-choice question, an old
style AskUserQuestion approval, and two finished turns for the empty state),
In flight three agents (busy, waiting, idle) and Library a canned Carry with
two explorations.
Answering, dismissing or snoozing removes an item locally; once the queue is
empty, `x` refills it, and `z` on Work starts or ends a pretend Deep session. Without a paired machine, Back from the first pairing
step leaves for Waiting. The menu also gets **MD sample**: the viewer on a
built-in markdown page with headings, inline styles, nested and task lists,
quotes, a rule, fenced code and three tables (one that fits, one that wraps,
one that pans).

## Markdown in the viewer

`core/src/markdown.cpp` is a pure parser (no LVGL) with host tests:
`cd tools/md-test && make check`. The viewer lays its output out by measured
Montserrat widths. Tables are drawn one of three ways: **fit** (every column
at its natural width fits 320 px: measured columns, `:---:` alignment, the
header in phosphor over a hairline), **wrap** (up to four columns, where each
column that must shrink keeps at least 60 px and its longest word: cells wrap
inside their columns), otherwise **mono** (a monospace grid you pan with the
ball or `h` / `l`, like code). Inline styles are colours — the fonts have no
bold: strong in bright phosphor, emphasis dimmer, code blue, links lit with a
short URL dimmed after them.

Do not ship a `DIRIGIBLE_UI_DEMO` build — it drives the UI with canned data.

The token is never discovered: the mDNS advertisement deliberately carries no
`token` TXT record, since any device on the LAN can read one. It is either
approved (step 4) or typed (the fallback).

Alternatively provision over USB without touching the UI:

```bash
source /path/to/esp-idf/export.sh
python3 tools/dirigible-provision/dirigible_provision.py wifi set MySSID hunter2
python3 tools/dirigible-provision/dirigible_provision.py machine add studio 192.168.1.10 \
    --token "$(cat ~/.lee/api-token)"
python3 tools/dirigible-provision/dirigible_provision.py flash --port /dev/tty.usbmodem1101
```

## Screens

| Screen   | What it does                                                    |
|----------|-----------------------------------------------------------------|
| Work (`w`) | the default screen: Lee's attention queue as a pager, one item that needs you per page (see below): a kind chip (red blocking, amber needs you), `Claude · tab`, age and `1/3`; the title; the agent's words (the full text is fetched when the snapshot's copy was clipped), scrolled by the ball; and big bordered buttons naming their key: **Approve (Y)** / **Deny (N)** on an approval, the quick replies **Go (G)** / **Wait (W)** / **Why (E)** / **Reply (R)** on anything that takes text. Nothing waiting: "Nothing needs you", the last few finished turns (tap one to read it) and **Capture (C)** / **In flight (I)** / **Library (L)** buttons. The header centre is Work's line, as in Lee: "One thing needs you.", "Working on it.", "All clear." (`away:` counts while away), or **In deep work** while a Deep session runs at the machine |
| In flight (`i`) | the agents Lee is running, as a trackball list: a state dot (amber waiting on you, phosphor working, grey idle), the name, what it is doing now in words ("Running tests", "Editing queue.ts"), its age and its tokens ("412k tok"). Click (or Enter, or tap) opens its words as a page with earlier turns and "Along the way"; `j` / `k` step between agents there. `c` checks in. The footer shows the subscription windows ("5h 42%") when Lee has seen them |
| Library (`l`) | Carry (14 §8.1): one exploration per page, `j` / `k` between them. "You stopped at" and one open question in Montserrat italic (your words), then **Add a thought (C)** (a paragraph into that exploration) and **Open next (O)** (the next Deep session opens it first). Nothing to carry: a thought goes to Someday instead |
| Tabs     | live list of Lee tabs with a type badge and a focus marker; tap a row (or roll the ball to highlight one and click) to focus it on the host, and open the terminal if it has a PTY, Files for a `files` tab, or the viewer for an editor tab. Disconnected, it names the machine it cannot reach and offers Reconnect / Re-pair. With several Lee windows open on the host, the header shows the one being followed (`lee 1/2`) and a **Win (W)** button picks another; tabs, Files and commands all follow that window, like Aeronaut's workspace switcher |
| Files    | the workspace tree (like Aeronaut's Files): lazy per-directory fetch, cached; select a file to view it. Also on the menu |
| Viewer   | read-only file view, scrolled by the pixel: code with a line gutter (pans, or wraps on click / `w`); markdown rendered (headings, **strong** / *em* / `code` / links in colour, bullet / numbered / task lists with hanging indents, quotes, rules, fenced code, pipe tables — see below); plain text wrapped. Follows an editor tab's file, cursor line and unsaved mark |
| Terminal | character grid over the PTY WebSocket, 40x22, with a bordered key bar underneath: **Esc**, **Tab**, **S-Tab**, **Ctrl-C**, **Ctrl-D** (the keyboard has none of them). Leave with the header's close button or a trackball hold |
| Hester   | chat-shaped: question at the bottom, scrolling answer above (the ball scrolls it), ReAct phases in the header's status slot |
| Pairing  | WiFi → Lee host → approve a 6-digit code (or type the token)      |

The trackball is **never a pointer**: there is no cursor. It scrolls, and
its click activates; touch does every tap.

| Input                   | Effect                                          |
|-------------------------|-------------------------------------------------|
| trackball roll          | lists (Tabs, In flight, menu, Windows, pairing lists, Work's empty screen): moves a highlighted row and keeps it in view, two detents a row. Text (Viewer, Hester, Work's and Library's words, an opened agent): scrolls smoothly, faster the faster you roll. Files: moves the selection; a firm sideways roll expands / collapses. Viewer: sideways pans code and wide tables. Work, Library: a deliberate sideways flick turns the page. Terminal: arrow keys |
| trackball click         | opens / activates the highlighted row (a first click with nothing highlighted just highlights). Viewer: wrap toggle on code. Work: opens the reply box on items that take text, or sends the highlighted option of a question. Never approves or sends a quick reply. Library: opens the thought box |
| trackball hold (0.8 s)  | back, everywhere (In flight and Library go back to Work); on Work it opens the menu: Work / In flight / Library / Tabs / Files / Hester / Capture / Windows / Pairing / Reconnect |
| header back button      | the same back, as a touch target (a close button in the Terminal) |
| w / i / l               | Work / In flight / Library, from any of the three (i and l from Tabs too) |
| swipe left / right, j / k (Work, Library) | next / previous item or exploration |
| space / b (Work, Library, Viewer) | scroll a screen down / up             |
| y / n (Work)            | approve / deny an approval (never on a question) |
| g / w / e (Work)        | quick replies on an item that takes text: "Yes, go ahead", "Stop and wait for me", "Explain first", sent at once as written. On Work, w is Wait |
| r or Enter (Work)       | open the reply box; Enter sends; **Cancel** (or back, or Backspace in an empty box) closes it and keeps the draft |
| d / s / o (Work)        | dismiss / snooze 15 minutes / open the item's tab on Lee |
| c / t (Work)            | capture to Someday, show the tab list. `f` (Focus) is retired: Library's Open next replaces it |
| c (In flight)           | check in on the highlighted or opened agent     |
| c / o / r (Library)     | add a thought, open next, reload                |
| w (on Tabs)             | pick which Lee window to follow                 |
| h / l, w, r, o (Viewer) | pan, wrap (code), reload, open in Lee           |
| touch                   | every button and row; footer buttons have a hit area that reaches a few pixels above the 15 px footer |

There is **no Esc key** on the T-Deck, so nothing needs one: back is the
header button or a trackball hold, text boxes have a Cancel button, and the
terminal has Esc on its key bar. Every control with a key names it:
"Reload (R)" (the key is the lowercase letter).

Sym+key chords are **not** availableSym+key chords are **not** available: the T-Deck's keypad MCU resolves the
modifier itself and reports a single ASCII byte, so the firmware cannot tell
Sym+X from the symbol X produces.

## Waiting, Reply and Capture (Copilot v0)

Lee keeps one machine-wide queue of agents that want you (approvals, questions,
blockers, finished turns); `docs/13-Copilot.md` §5 and
`docs/plans/2026-09-25-copilot-v0-v1-contracts.md` §9.3 are the spec.

- **Live.** The queue rides the `/context/stream` socket the device already
  holds, as `{"type":"attention_snapshot","data":…}`; `GET /attention?compact=1`
  fills it on every connect and whenever the screen is opened. At most 25
  items, text cut to 280 characters; only what the screen draws is kept.
- **Full text.** The snapshot cuts the agent's words at 280 characters; when a
  page shows an item whose text is at that cap (or a question), the device
  asks `GET /attention/:id` once for the whole item (up to 2000 characters),
  keeps the clipped text on screen until it lands, and caches the last three
  by id and version so paging back and forth never refetches. A slow answer
  shows "loading full text" in the header; 404 / 410 (gone) are remembered.
- **Pager.** Approvals, questions, blockers and decisions (plus anything Lee
  marks blocking) each get a page: blocking first, then needs you, oldest
  first; parked items last. The page stays on its item as snapshots arrive;
  when it is answered elsewhere the next one slides in. Only letters are
  shortcuts, since symbols and digits need chords on the T-Deck keyboard.
- **Reply.** An approval shows **Approve (Y)** / **Deny (N)** (/ **Snooze (S)**);
  anything that takes text shows the quick replies **Go (G)** ("Yes, go ahead"),
  **Wait (W)** ("Stop and wait for me"), **Why (E)** ("Explain first") and
  **Reply (R)**: the first three are Lee's `QUICK_REPLIES` and send at once
  through the same reply path, their words shown on the header as they go
  (`sending: Yes, go ahead`). `d` and `s` still dismiss and snooze.
  Reply opens a full-screen text box with **Cancel** and **Send (Enter)**
  buttons: Enter sends (there is no newline), Cancel closes it and keeps the
  draft. Every write echoes the `version` the page
  showed: if the item moved on, Lee answers 409, the queue is refetched and
  nothing is resent — decide again on what is there now. `agent gone` means
  its terminal exited. A swipe that starts on a button never presses it.
- **Questions.** Claude Code's AskUserQuestion arrives as a `question` item
  (chip QUESTION): the question, then its options as bordered buttons (label
  over a dimmed description). Tap one to send it, or roll the ball to
  highlight one and click (or press Enter); the header says
  `sending: <option>` then `sent: <option>`. Only when Lee offers `choose`
  (one question, single-select, with options) — otherwise the questions and
  options are shown read-only with **Open tab (O)**. There is never an
  Approve / Deny on a question, and an older Lee's `approval` for the
  `AskUserQuestion` tool says "answer in the tab" instead of offering them.
- **Capture.** `c` (the empty screen's **Capture (C)** button, or Menu > Capture) opens a
  full-screen box; Enter sends it to Hester's Someday list for the followed
  window's workspace. "Saved - reaches Someday when Hester is back" means Lee
  spooled it; the box closes itself after a successful send.
- **Deep.** There is no Focus key any more (`f` is retired; 14 §8.1): Deep
  can't start from a device. While a Deep session runs at the machine, the
  snapshot's `deep` is set, the header says **In deep work** and nothing
  alerts. Library's **Open next (O)** picks what the next session opens.
- **Alerts.** Pull-first: the only alert is the header blinking amber when an
  item's `notify` flips on (Lee decides: blocking outside quiet hours, or a
  wake-marked item while you are away). Nothing goes through a push service.

A Lee without the queue (404 on `/attention`) shows "no queue" and the rest of
the firmware works as before. The snapshot's newer fields (`agents[].now`,
`recent`, `updates`, `usage`, `limits`, `deep`) are all optional: an older Lee
just gives a plainer In flight.

The words In flight uses are ports: `core/src/activity.cpp` copies
`describeActivity` and `formatTokens` from `electron/src/shared/cockpit.ts` and
`workLine` from the renderer's `cockpitModel.ts`, with the same cases as Lee's
smoke test in `tools/activity-test` (which also covers the snapshot's agents
and `GET /carry` parsing): `cd tools/activity-test && make check`.

## Wire protocol

Everything is authenticated with a bearer: the per-device token from pairing,
or Lee's shared API token (`~/.lee/api-token`) on older setups.

| Direction | Endpoint |
|-----------|----------|
| device → Lee  | `ws://host:9001/context/stream?token=…` — live `LeeContext`; also `attention_snapshot`, `presence`, `copilot_return` messages |
| device → Lee  | `ws://host:9001/pty/<id>/stream?token=…` — PTY bytes out, raw text in, `{"type":"resize","cols":C,"rows":R}` to resize |
| device → Lee  | `POST http://host:9001/command` with `Authorization: Bearer …` |
| device → Lee  | `GET http://host:9001/attention?compact=1` → `{success,data:AttentionSnapshot}` |
| device → Lee  | `POST http://host:9001/attention/<id>/reply` — `{action:"approve"\|"deny"\|"text",text?,version}`; 409 stale, 410 agent gone, 403 shared token |
| device → Lee  | `POST http://host:9001/attention/<id>/dismiss`, `…/snooze` `{minutes:15}` |
| device → Lee  | `GET http://host:9001/carry?workspace=…` → `{workspace,pick_up,open_questions,captured_count,reading_count,open_next}`; 503 `hester_offline` |
| device → Lee  | `POST http://host:9001/carry/capture` `{workspace,text,exploration_id?}`, `POST /carry/open-next` `{workspace,exploration_id}` |
| device → Lee  | `POST http://host:9001/command` `{domain:"tab",action:"checkin",params:{pty_id}}` — In flight's check-in |
| device → Lee  | `POST http://host:9001/capture` — `{text,workspace}` → `{success,someday_id,spooled}` |
| device → Lee  | `GET http://host:9001/fs/list?path=…`, `GET /fs/read?path=…[&stat=1]` — bearer; read-only, workspace-scoped |
| device → Lee  | `POST http://host:9001/pair/request` — **no auth**; `{device,kind,code,nonce}` → `{status:"pending",expires_in}` |
| device → Lee  | `GET http://host:9001/pair/poll?nonce=…` — **no auth**; → `pending` / `denied` / `expired` / `approved` + `{token,hester_port,name,device_id?}` |
| device → Hester | `POST http://host:9000/context/stream` with the same bearer → SSE |

See `docs/Dirigible.md` for the longer version.
