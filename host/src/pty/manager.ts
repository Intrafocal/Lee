/**
 * PTY Manager - Spawns and manages pseudo-terminal processes.
 *
 * Handles:
 * - Spawning shells and TUI applications (Lee, lazygit, etc.)
 * - Parsing custom OSC escape sequences from Lee
 * - Routing PTY I/O to blessed terminals
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'events';

/** Custom escape sequence data from Lee editor */
export interface LeeState {
  file?: string;
  line?: number;
  column?: number;
  selection?: string;
  modified?: boolean;
}

/** PTY process wrapper */
export interface PTYProcess {
  id: number;
  name: string;
  pty: pty.IPty;
  state: LeeState;
}

/**
 * Manages PTY processes with escape sequence parsing.
 *
 * Events:
 * - 'data': (id: number, data: string) - Raw output from PTY
 * - 'state': (id: number, state: LeeState) - Parsed Lee state
 * - 'exit': (id: number, code: number) - Process exited
 */
export class PTYManager extends EventEmitter {
  private processes: Map<number, PTYProcess> = new Map();
  private nextId = 1;
  private shell: string;

  constructor() {
    super();
    // Detect shell
    this.shell = process.env.SHELL || '/bin/bash';
  }

  /**
   * Spawn a new PTY process.
   *
   * @param command - Command to run (default: shell)
   * @param args - Command arguments
   * @param cwd - Working directory
   * @param name - Display name for the process
   * @returns Process ID
   */
  spawn(
    command?: string,
    args: string[] = [],
    cwd?: string,
    name?: string
  ): number {
    const id = this.nextId++;
    const cmd = command || this.shell;

    const ptyProcess = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const proc: PTYProcess = {
      id,
      name: name || cmd,
      pty: ptyProcess,
      state: {},
    };

    this.processes.set(id, proc);

    // Handle data with escape sequence parsing
    ptyProcess.onData((data) => {
      const { cleanData, states } = this.parseEscapeSequences(data);

      // Emit raw data for terminal display
      if (cleanData) {
        this.emit('data', id, cleanData);
      }

      // Emit parsed states
      for (const state of states) {
        proc.state = { ...proc.state, ...state };
        this.emit('state', id, proc.state);
      }
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      this.processes.delete(id);
      this.emit('exit', id, exitCode);
    });

    return id;
  }

  /**
   * Spawn Lee editor.
   *
   * @param workspace - Workspace directory
   * @returns Process ID
   */
  spawnLee(workspace?: string): number {
    // Use full path to lee in the venv, or fall back to PATH
    const leePath = process.env.LEE_PATH ||
      'lee';

    return this.spawn(
      leePath,
      workspace ? ['--workspace', workspace] : [],
      workspace,
      'Lee Editor'
    );
  }

  /**
   * Spawn a generic TUI application.
   *
   * @param command - TUI command to run
   * @param args - Command arguments
   * @param cwd - Working directory
   * @param name - Display name for the tab
   * @returns Process ID
   */
  spawnTUI(
    command: string,
    args: string[] = [],
    cwd?: string,
    name?: string
  ): number {
    return this.spawn(command, args, cwd, name || command);
  }

  /**
   * Spawn lazygit for Git operations.
   *
   * @param cwd - Repository directory (default: current working directory)
   * @returns Process ID
   */
  spawnLazygit(cwd?: string): number {
    return this.spawnTUI('lazygit', [], cwd, 'Git');
  }

  /**
   * Spawn lazydocker for Docker management.
   *
   * @returns Process ID
   */
  spawnLazydocker(): number {
    return this.spawnTUI('lazydocker', [], undefined, 'Docker');
  }

  /**
   * Spawn k9s for Kubernetes management.
   *
   * @param context - Kubernetes context (optional)
   * @param namespace - Kubernetes namespace (optional)
   * @returns Process ID
   */
  spawnK9s(context?: string, namespace?: string): number {
    const args: string[] = [];
    if (context) {
      args.push('--context', context);
    }
    if (namespace) {
      args.push('-n', namespace);
    }
    return this.spawnTUI('k9s', args, undefined, 'K8s');
  }

  /**
   * Spawn flx for Flutter hot reload management.
   *
   * @param cwd - Flutter project directory
   * @returns Process ID
   */
  spawnFlx(cwd?: string): number {
    return this.spawnTUI('flx', [], cwd, 'Flutter');
  }

  /**
   * Write data to a PTY process (keyboard input).
   *
   * @param id - Process ID
   * @param data - Data to write
   */
  write(id: number, data: string): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.pty.write(data);
    }
  }

  /**
   * Send a key combination to a PTY process.
   *
   * @param id - Process ID
   * @param key - Key name (e.g., 'C-o' for Ctrl+O)
   */
  sendKey(id: number, key: string): void {
    const keyMap: Record<string, string> = {
      'C-a': '\x01',
      'C-b': '\x02',
      'C-c': '\x03',
      'C-d': '\x04',
      'C-e': '\x05',
      'C-f': '\x06',
      'C-g': '\x07',
      'C-h': '\x08',
      'C-i': '\x09',
      'C-j': '\x0a',
      'C-k': '\x0b',
      'C-l': '\x0c',
      'C-m': '\x0d',
      'C-n': '\x0e',
      'C-o': '\x0f',
      'C-p': '\x10',
      'C-q': '\x11',
      'C-r': '\x12',
      'C-s': '\x13',
      'C-t': '\x14',
      'C-u': '\x15',
      'C-v': '\x16',
      'C-w': '\x17',
      'C-x': '\x18',
      'C-y': '\x19',
      'C-z': '\x1a',
      'escape': '\x1b',
      'enter': '\r',
      'tab': '\t',
      'backspace': '\x7f',
      'up': '\x1b[A',
      'down': '\x1b[B',
      'right': '\x1b[C',
      'left': '\x1b[D',
      'home': '\x1b[H',
      'end': '\x1b[F',
      'pageup': '\x1b[5~',
      'pagedown': '\x1b[6~',
      'delete': '\x1b[3~',
      'insert': '\x1b[2~',
    };

    const data = keyMap[key.toLowerCase()] || key;
    this.write(id, data);
  }

  /**
   * Resize a PTY process.
   *
   * @param id - Process ID
   * @param cols - Number of columns
   * @param rows - Number of rows
   */
  resize(id: number, cols: number, rows: number): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.pty.resize(cols, rows);
    }
  }

  /**
   * Kill a PTY process.
   *
   * @param id - Process ID
   */
  kill(id: number): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.pty.kill();
      this.processes.delete(id);
    }
  }

  /**
   * Get a PTY process by ID.
   *
   * @param id - Process ID
   */
  get(id: number): PTYProcess | undefined {
    return this.processes.get(id);
  }

  /**
   * Get all PTY processes.
   */
  getAll(): PTYProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Parse OSC escape sequences from Lee.
   *
   * Lee emits sequences like:
   *   \x1b]lee:state;file=/path;line=42\x07
   *   \x1b]lee:selection;text=code here\x07
   *
   * @param data - Raw PTY output
   * @returns Clean data (sequences stripped) and parsed states
   */
  private parseEscapeSequences(data: string): {
    cleanData: string;
    states: LeeState[];
  } {
    const states: LeeState[] = [];

    // Match OSC sequences: \x1b] ... \x07 or \x1b] ... \x1b\\
    const oscRegex = /\x1b\]lee:([^;\x07\x1b]+);?(.*?)\x07/g;

    const cleanData = data.replace(oscRegex, (match, type, params) => {
      const state: LeeState = {};

      // Parse key=value pairs
      const pairs = params.split(';').filter(Boolean);
      for (const pair of pairs) {
        const [key, ...valueParts] = pair.split('=');
        const value = valueParts.join('='); // Handle values with '='

        switch (key) {
          case 'file':
            state.file = value;
            break;
          case 'line':
            state.line = parseInt(value, 10);
            break;
          case 'column':
            state.column = parseInt(value, 10);
            break;
          case 'text':
          case 'selection':
            state.selection = decodeURIComponent(value);
            break;
          case 'modified':
            state.modified = value === 'true' || value === '1';
            break;
        }
      }

      // Handle type-specific defaults
      if (type === 'state') {
        // state type contains all fields
      } else if (type === 'selection') {
        // selection type focuses on text
      }

      if (Object.keys(state).length > 0) {
        states.push(state);
      }

      return ''; // Strip sequence from output
    });

    return { cleanData, states };
  }

  /**
   * Kill all PTY processes.
   */
  killAll(): void {
    for (const [id] of this.processes) {
      this.kill(id);
    }
  }
}

// Singleton instance
export const ptyManager = new PTYManager();
