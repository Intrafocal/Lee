---

# Technical Specification: Project "Lee" & "Hester"

## 1. Executive Summary

**Lee** (Lightweight Editing Environment) is a terminal-native Integrated Development Environment designed for speed, local-first development, and keyboard efficiency. It provides a rich TUI (Terminal User Interface) for editing code, managing local environments, and handling version control.

**Hester** is the accompanying AI Daemon. Unlike a standard chatbot, Hester runs as a sidecar process (locally or proxied) that maintains deep context of the editing session. Hester observes Lee's state and can actively drive the editor interface upon request.

## 2. Technology Stack

* **Core Framework:** Python 3.10+ with `textual` (TUI handling, CSS styling).
* **Terminal Engine:** `textual-terminal` (Wraps `pyte` and `pty` for full ANSI emulation).
* **Syntax Engine:** `tree-sitter` (Editor highlighting) & `pygments` (Markdown rendering).
* **Version Control:** `GitPython`.
* **Process Management:** `asyncio.subprocess` (for managing Docker/Flutter envs).
* **Communication:** `aiohttp` (Server) & `httpx` (Client).
* **Diff Engine:** `difflib`.

---

## 3. System Architecture

The system operates as two distinct but entangled entities:

### 3.1 Lee (The Host)

Lee is the frontend application running the event loop. It is responsible for:

* Rendering the UI (Tabs, Splits, Dashboards).
* Capturing User Input.
* Managing File I/O.
* Hosting an internal API server (Port 9000) to accept commands from Hester.

### 3.2 Hester (The Daemon)

Hester is the reasoning engine. It operates as a sidecar service (listening on Port 8888). It is responsible for:

* Receiving context payloads from Lee (selected code, file paths).
* Processing reasoning/LLM queries.
* Sending commands back to Lee (e.g., "Open `utils.py` so I can see it").

---

## 4. Module Specifications (Lee)

### 4.1 The Editor Module ("The JetBrains View")

* **Component:** `SplitView` (Horizontal Container).
* **Left Pane:** `TextArea` with `tree-sitter` syntax highlighting.
* *Language Mapping:* Smart detection (e.g., `.dart` mapped to `java` grammar if native support is missing).


* **Right Pane:** `Markdown` widget for live rendering.
* **Sync:** Debounced (200ms) signal passing text from Editor to Preview.

### 4.2 The Terminal Module

* **Component:** `TabPane` containing `textual_terminal.Terminal`.
* **Function:** Provides fully interactive shell sessions.
* **Use Cases:** Running `claude-code`, `vim`, `htop`, or `ssh`.
* **Keybinding:** `Ctrl+T` spawns a new Terminal tab.

### 4.3 The DevOps Dashboard (Environment Manager)

* **Component:** `ServiceRow` widgets in a vertical list.
* **Config Driven:** Reads `config.yaml` to generate controls for specific runtimes (Docker, Flutter, Venv).
* **Features:**
* **Process Isolation:** Each service runs in a non-blocking `asyncio` subprocess.
* **Live Logging:** `stdout`/`stderr` piped to a shared `RichLog`.
* **Signal Injection:** specific support for sending characters to `stdin` (e.g., sending 'r' to a Flutter process for Hot Reload).



### 4.4 The Version Control Module

* **Component:** `GitDashboard` (Grid Layout).
* **Features:**
* **Status Column:** Lists Unstaged vs. Staged files.
* **Action Column:** Fetch, Pull, Push buttons.
* **Commit Interface:** Dedicated text box and Submit button.
* **Auto-Refresh:** Polls `git status` on tab focus.



### 4.5 The Visual Diff Tool

* **Component:** `DiffView` (Side-by-side TextAreas).
* **Logic:** Uses `difflib` to compute delta.
* **Styling:** Red backgrounds for deletions (Left), Green for additions (Right).

---

## 5. The "Daemonic Link" (Lee <-> Hester Protocol)

### 5.1 Outbound: Context Injection (Lee -> Hester)

* **Trigger:** User selects text and presses `Ctrl+S`.
* **Payload:**
```json
{
  "source": "Lee",
  "file": "/abs/path/main.py",
  "line_start": 45,
  "line_end": 50,
  "content": "def calculate_orbit(): ..."
}

```


* **Destination:** `POST http://localhost:8888/context`

### 5.2 Inbound: Remote Control (Hester -> Lee)

* **Listener:** Lee starts an `aiohttp` server on `Port 9000` on launch.
* **Endpoint:** `POST /open_file`
* **Payload:** `{ "file": "utils.py", "line": 10 }`
* **Behavior:** Lee receives the request, interrupts the main thread safely, opens a new tab (or focuses an existing one), and scrolls to the requested line.

---

## 6. Configuration (`config.yaml`)

```yaml
app:
  name: "Lee"
  theme: "dracula"
  
hester:
  enabled: true
  url: "http://localhost:8888/context"
  listen_port: 9000

environments:
  - name: "Mobile Client"
    type: "flutter"
    path: "./app"
    hot_key: "r"

  - name: "Database"
    type: "docker"
    command: "docker-compose up"

```

---
