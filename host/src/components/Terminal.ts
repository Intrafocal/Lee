/**
 * Terminal Component - blessed terminal widget wrapping a PTY process.
 *
 * Uses blessed's terminal widget for proper VT100/xterm escape sequence handling.
 */

import * as blessed from 'neo-blessed';
import { EventEmitter } from 'events';
import { PTYManager, LeeState } from '../pty/manager';

export interface TerminalOptions {
  parent: blessed.Widgets.Node;
  ptyManager: PTYManager;
  ptyId?: number;
  label?: string;
  top?: number | string;
  left?: number | string;
  width?: number | string;
  height?: number | string;
}

/**
 * Terminal widget that wraps a PTY process with full terminal emulation.
 *
 * Events:
 * - 'state': (state: LeeState) - Lee state update
 * - 'exit': (code: number) - Process exited
 * - 'focus': () - Terminal focused
 * - 'blur': () - Terminal blurred
 */
export class Terminal extends EventEmitter {
  private term: any; // blessed.terminal widget
  private ptyManager: PTYManager;
  private _ptyId: number | null = null;
  private _focused = false;

  constructor(options: TerminalOptions) {
    super();
    this.ptyManager = options.ptyManager;

    // Create terminal element with full VT100/xterm emulation
    this.term = (blessed as any).terminal({
      parent: options.parent,
      label: options.label ? ` ${options.label} ` : ' Terminal ',
      top: options.top ?? 0,
      left: options.left ?? 0,
      width: options.width ?? '100%',
      height: options.height ?? '100%',
      border: 'line',
      scrollable: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'gray',
        },
        style: {
          bg: 'white',
        },
      },
      style: {
        fg: 'white',
        bg: 'black',
        border: {
          fg: 'gray',
        },
        focus: {
          border: {
            fg: 'cyan',
          },
        },
      },
      // Terminal-specific options
      cursorBlink: true,
      screenKeys: false,
      // Don't handle input - we'll forward from PTY
      handler: () => {},
    });

    // Handle keyboard input - forward to PTY
    this.term.on('keypress', (ch: string, key: any) => {
      if (this._ptyId !== null) {
        this.handleKeypress(ch, key);
      }
    });

    // Handle focus
    this.term.on('focus', () => {
      this._focused = true;
      this.emit('focus');
    });

    this.term.on('blur', () => {
      this._focused = false;
      this.emit('blur');
    });

    // Handle resize
    this.term.on('resize', () => {
      this.syncSize();
    });

    // Attach to existing PTY if provided
    if (options.ptyId !== undefined) {
      this.attach(options.ptyId);
    }
  }

  /** Get the PTY ID */
  get ptyId(): number | null {
    return this._ptyId;
  }

  /** Get the blessed element */
  get element(): blessed.Widgets.BoxElement {
    return this.term;
  }

  /** Check if focused */
  get focused(): boolean {
    return this._focused;
  }

  /**
   * Attach to a PTY process.
   *
   * @param ptyId - PTY process ID
   */
  attach(ptyId: number): void {
    // Detach from current PTY if any
    if (this._ptyId !== null) {
      this.detach();
    }

    this._ptyId = ptyId;
    const proc = this.ptyManager.get(ptyId);
    if (proc) {
      this.term.setLabel(` ${proc.name} `);
    }

    // Listen for data
    this.ptyManager.on('data', this.handleData);
    this.ptyManager.on('state', this.handleState);
    this.ptyManager.on('exit', this.handleExit);

    // Sync size
    this.syncSize();
  }

  /**
   * Detach from current PTY process.
   */
  detach(): void {
    this.ptyManager.off('data', this.handleData);
    this.ptyManager.off('state', this.handleState);
    this.ptyManager.off('exit', this.handleExit);
    this._ptyId = null;
  }

  /**
   * Spawn a new shell and attach.
   *
   * @param command - Command to run
   * @param args - Arguments
   * @param cwd - Working directory
   * @returns PTY ID
   */
  spawn(command?: string, args?: string[], cwd?: string): number {
    const id = this.ptyManager.spawn(command, args, cwd);
    this.attach(id);
    return id;
  }

  /**
   * Spawn Lee editor and attach.
   *
   * @param workspace - Workspace directory
   * @returns PTY ID
   */
  spawnLee(workspace?: string): number {
    const id = this.ptyManager.spawnLee(workspace);
    this.attach(id);
    return id;
  }

  /**
   * Focus this terminal.
   */
  focus(): void {
    this.term.focus();
  }

  /**
   * Destroy this terminal.
   */
  destroy(): void {
    if (this._ptyId !== null) {
      this.ptyManager.kill(this._ptyId);
    }
    this.detach();
    this.term.destroy();
  }

  /**
   * Set the label.
   */
  setLabel(label: string): void {
    this.term.setLabel(` ${label} `);
  }

  /**
   * Write data directly to the terminal (for display).
   */
  write(data: string): void {
    this.term.write(data);
  }

  /**
   * Handle PTY data - write to terminal emulator.
   */
  private handleData = (id: number, data: string): void => {
    if (id !== this._ptyId) return;

    // Write to terminal widget - it handles escape sequence interpretation
    this.term.write(data);
  };

  /**
   * Handle Lee state updates.
   */
  private handleState = (id: number, state: LeeState): void => {
    if (id !== this._ptyId) return;
    this.emit('state', state);
  };

  /**
   * Handle PTY exit.
   */
  private handleExit = (id: number, code: number): void => {
    if (id !== this._ptyId) return;
    this.emit('exit', code);
    this._ptyId = null;
    this.term.write(`\r\n[Process exited with code ${code}]\r\n`);
  };

  /**
   * Handle keypress - forward to PTY.
   */
  private handleKeypress(ch: string, key: any): void {
    if (this._ptyId === null) return;

    // Map special keys
    if (key.ctrl && key.name) {
      this.ptyManager.sendKey(this._ptyId, `C-${key.name}`);
    } else if (key.name === 'escape') {
      this.ptyManager.sendKey(this._ptyId, 'escape');
    } else if (key.name === 'return' || key.name === 'enter') {
      this.ptyManager.sendKey(this._ptyId, 'enter');
    } else if (key.name === 'backspace') {
      this.ptyManager.sendKey(this._ptyId, 'backspace');
    } else if (key.name === 'tab') {
      this.ptyManager.sendKey(this._ptyId, 'tab');
    } else if (key.name === 'up') {
      this.ptyManager.sendKey(this._ptyId, 'up');
    } else if (key.name === 'down') {
      this.ptyManager.sendKey(this._ptyId, 'down');
    } else if (key.name === 'left') {
      this.ptyManager.sendKey(this._ptyId, 'left');
    } else if (key.name === 'right') {
      this.ptyManager.sendKey(this._ptyId, 'right');
    } else if (key.name === 'home') {
      this.ptyManager.sendKey(this._ptyId, 'home');
    } else if (key.name === 'end') {
      this.ptyManager.sendKey(this._ptyId, 'end');
    } else if (key.name === 'pageup') {
      this.ptyManager.sendKey(this._ptyId, 'pageup');
    } else if (key.name === 'pagedown') {
      this.ptyManager.sendKey(this._ptyId, 'pagedown');
    } else if (key.name === 'delete') {
      this.ptyManager.sendKey(this._ptyId, 'delete');
    } else if (key.name === 'insert') {
      this.ptyManager.sendKey(this._ptyId, 'insert');
    } else if (ch) {
      this.ptyManager.write(this._ptyId, ch);
    }
  }

  /**
   * Sync terminal size with PTY.
   */
  private syncSize(): void {
    if (this._ptyId === null) return;

    const width = this.term.width as number;
    const height = this.term.height as number;

    // Account for borders
    const cols = Math.max(1, width - 2);
    const rows = Math.max(1, height - 2);

    this.ptyManager.resize(this._ptyId, cols, rows);
  }
}
