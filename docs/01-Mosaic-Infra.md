Here is the finalized summary of the **Mosaic Architecture** for **Project Lee & Hester**.

This architecture leverages your existing Python TUI editor ("Lee") by running it as a subprocess inside a robust Node.js container. This gives you the best of both worlds: Python's text processing power and Node's industry-standard terminal emulation.

### 1. High-Level Concept

* **The Container ("The Wrapper"):** A Node.js/TypeScript application that acts as the window manager. It handles the tab system, split panes, and the low-level PTY (Pseudo-Terminal) bridging.
* **The Editor ("Lee"):** Your existing Python Textual application. Instead of taking over the whole screen, it launches inside the Wrapper's primary tab.
* **The Agent ("Hester"):** A background sidecar process providing intelligence and remote control over the Wrapper and Editor.

---

### 2. Component Breakdown

#### **A. The Host Wrapper (Node.js + TypeScript)**

* **Tech:** `react-blessed`, `neo-blessed`, `node-pty`, `react-blessed-xterm`.
* **Role:** The "Operating System" of the IDE.
* **Responsibilities:**
* **Tab Management:** Creating and destroying tabs (React State).
* **Terminal Emulation:** Uses `node-pty` to run robust shells (bash, zsh, ssh).
* **Hosting Lee:** Spawns `python lee_main.py` inside the first tab, passing mouse and keyboard events through transparently.
* **API Listener (Port 9001):** Listens for system-level commands (e.g., "Create new terminal split", "Focus Tab 2").



#### **B. Lee (Python TUI Editor)**

* **Tech:** `textual`, `tree-sitter`, `httpx`.
* **Role:** The dedicated editing environment.
* **Status:** *Already built.* Runs as a child process of the Node wrapper.
* **Responsibilities:**
* **Editing:** Syntax highlighting, file I/O, diff viewing.
* **Context Export:** Sends selected code/state to Hester via `POST :8888`.
* **API Listener (Port 9000):** Listens for editor-specific commands (e.g., "Open `utils.py` at line 50").



#### **C. Hester (AI Sidecar)**

* **Tech:** Python, LLM API (local/cloud), `aiohttp`.
* **Role:** The intelligent daemon.
* **Responsibilities:**
* **Reasoning:** Receives context from Lee.
* **Orchestration:** Can drive the UI by sending commands to the Host (to open terminals) or Lee (to edit files).



---

### 3. Communication Protocol ("The Nervous System")

The three components communicate via local HTTP requests, ensuring loosely coupled stability.

| Source | Target | Port | Purpose | Payload Example |
| --- | --- | --- | --- | --- |
| **Lee** | **Hester** | `:8888` | **Context Injection** | `{"file": "app.py", "selection": "def init()..."}` |
| **Hester** | **Lee** | `:9000` | **File Control** | `{"command": "open", "file": "config.yaml"}` |
| **Hester** | **Host** | `:9001` | **System Control** | `{"command": "new_tab", "type": "terminal"}` |

### 4. Why This Wins

1. **Stability:** You don't have to maintain a complex terminal emulator in Python. You just use `node-pty` (battle-tested by VS Code/Hyper).
2. **Modularity:** If Lee crashes, the Host stays alive. If Hester hangs, the editor keeps working.
3. **Polyglot:** You can eventually add a tab running a completely different TUI (e.g., `lazygit` or `htop`) seamlessly alongside Lee.

This specification is ready for implementation. You start by setting up the **Node.js Host** and configuring it to spawn your existing Python Lee script on startup.