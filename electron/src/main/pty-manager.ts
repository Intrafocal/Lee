/**
 * PTY Manager - Spawns and manages pseudo-terminal processes.
 *
 * Handles:
 * - Spawning shells and TUI applications (Lee, lazygit, etc.)
 * - Parsing custom OSC escape sequences from Lee
 * - Routing PTY I/O to xterm.js terminals
 */

import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execSync, execFile } from 'child_process';
import { app } from 'electron';
import { TUIDefinition, AgentDefinition } from '../shared/context';

/**
 * Check if a port is available (not in use).
 * Returns a promise that resolves to true if port is free, false if in use.
 */
function isPortAvailable(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        // Other error, assume port is available
        resolve(true);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, host);
  });
}

/** Configuration loaded from lee.config.json */
interface LeeConfig {
  paths?: string[];
  tools?: Record<string, string | null>;
}

/** Workspace configuration from .lee/config.yaml */
interface WorkspaceConfig {
  source?: string[];
  environments?: any[];
  flutter?: { path?: string };
  terminal?: { shell?: string; scrollback?: number; font_size?: number; copy_on_select?: boolean };
  tuis?: Record<string, TUIDefinition>;
  keybindings?: Record<string, string>;
  sql?: {
    /** Name of the connection in `connections` to use by default */
    default?: string;
    connections?: Array<{
      name: string;
      host: string;
      port?: number;
      database: string;
      user: string;
      password?: string;
      ssl?: boolean;
    }>;
  };
  hester?: {
    google_api_key?: string;
    model?: string;
    thinking_depth?: boolean;
    ollama_url?: string;
    prepare_model?: string;
    local_model?: string;
    ollama_recheck_minutes?: number;
    listen_host?: string;
  };
}

/** Load and parse lee.config.json */
function loadConfig(): LeeConfig {
  // Check if we're running in a packaged app
  const isPackaged = app.isPackaged;

  // Get app path - works correctly for both dev and packaged
  const appPath = app.getAppPath();

  const configPaths = [
    // App root (works for both packaged asar and dev)
    path.join(appPath, 'lee.config.json'),
    // Fallback: relative to __dirname
    path.join(__dirname, '../../lee.config.json'),
    path.join(__dirname, '../lee.config.json'),
    path.join(__dirname, '../../../lee.config.json'),
    // User config
    path.join(process.env.HOME || '', '.config/lee/config.json'),
  ];

  console.log('Is packaged app:', isPackaged);
  console.log('app.getAppPath():', appPath);
  console.log('__dirname:', __dirname);
  console.log('Looking for config in:', configPaths);

  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        console.log('Found config at:', configPath);
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        console.log('Loaded config:', JSON.stringify(config, null, 2));
        return config;
      }
    } catch (e) {
      console.warn(`Failed to load config from ${configPath}:`, e);
    }
  }

  // No config found - login shell (-l flag) will handle PATH via ~/.bashrc
  console.log('No config found, relying on login shell for environment');
  return { paths: [], tools: {} };
}

/**
 * POSIX single-quote an argument for the `shell: true` escape hatch.
 * Everything else spawns with an argv array and needs no quoting at all.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(process.env.HOME || '', p.slice(1));
  }
  return p;
}

/**
 * Parse environment variables from a file (supports .env and shell export formats).
 * Returns a Record of environment variable name to value.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};

  try {
    const resolvedPath = expandPath(filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.log(`Source file not found: ${resolvedPath}`);
      return env;
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Handle 'export VAR=value' format
      let varLine = trimmed;
      if (varLine.startsWith('export ')) {
        varLine = varLine.slice(7);
      }

      // Parse VAR=value (only process simple assignments)
      const eqIndex = varLine.indexOf('=');
      if (eqIndex > 0) {
        const key = varLine.slice(0, eqIndex).trim();
        let value = varLine.slice(eqIndex + 1).trim();

        // Skip if key contains spaces or special chars (shell functions, etc.)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        // Expand ~ in values (common for PATH-like variables)
        if (value.includes('~')) {
          value = value.replace(/~/g, process.env.HOME || '');
        }

        env[key] = value;
      }
    }

    console.log(`Parsed ${Object.keys(env).length} env vars from ${resolvedPath}`);
  } catch (error) {
    console.error(`Error parsing env file ${filePath}:`, error);
  }

  return env;
}

/**
 * Load environment variables from multiple source files.
 * Later files override earlier ones.
 * Exported for use in main.ts execSync calls.
 */
export function loadSourceEnv(sourceFiles: string[], workspace?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const sourceFile of sourceFiles) {
    // Resolve relative paths against workspace
    let filePath = sourceFile;
    if (!sourceFile.startsWith('~') && !path.isAbsolute(sourceFile) && workspace) {
      filePath = path.join(workspace, sourceFile);
    }

    const fileEnv = parseEnvFile(filePath);
    Object.assign(env, fileEnv);
  }

  return env;
}

/** Custom escape sequence data from Lee editor */
export interface LeeState {
  file?: string;
  line?: number;
  column?: number;
  selection?: string;
  modified?: boolean;
  daemonPort?: number;  // Port the editor daemon is listening on
}

/** PTY process wrapper */
export interface PTYProcess {
  id: number;
  name: string;
  pty: pty.IPty;
  state: LeeState;
  windowId: number | null;  // null = daemon/background
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
  private config: LeeConfig;
  private configPaths: string[];
  private cachedExtendedPath: string | null = null;
  private loginShellPath: string | null = null;
  private loginShellPathResolved = false;

  // Background daemon PTY (hidden, not attached to any tab)
  private daemonPtyId: number | null = null;

  // Ring buffer of the daemon PTY's recent output, for surfacing crash context
  private daemonOutputBuffer: string[] = [];

  // lee.log size cap (see rotateLogIfNeeded)
  private static readonly LOG_MAX_BYTES = 10 * 1024 * 1024;
  private static readonly LOG_BACKUP_COUNT = 3;
  private logRotationChecked = false;

  // Last workspace we told the daemon to serve (avoids redundant POSTs)
  private lastDaemonWorkspace: string | null = null;
  private static DAEMON_BUFFER_MAX_LINES = 40;

  // Prewarmed TUI pool for instant startup
  // Maps TUI type to { ptyId, workspace }
  private warmTUIPool: Map<string, { id: number; workspace: string | null }> = new Map();

  // App-managed hester venv at ~/.lee/venv/
  private hesterVenvPath: string;
  private hesterVenvReady: boolean = false;
  private hesterBootstrapPromise: Promise<void> | null = null;

  // Per-window workspace configs (loaded from .lee/config.yaml)
  private windowConfigs: Map<number, { workspace: string; config: WorkspaceConfig | null }> = new Map();

  /**
   * Which window's config feeds the (single, shared) Hester daemon.
   *
   * One daemon backs every Lee window, so its env - API key, model, listen
   * host, HESTER_WORKING_DIRECTORY - has to come from exactly one window.
   * That's the focused one: main.ts calls setDaemonWindow() on window focus
   * and on prewarm, the same hook A3 uses to POST /workspace. Previously
   * these reads silently took whichever window happened to be inserted into
   * the map first, so a second window on another project could never
   * influence the daemon and a stale `-1` placeholder entry could win.
   */
  private daemonWindowId: number | null = null;

  /** Point the daemon-facing config reads at a specific window. */
  setDaemonWindow(windowId: number): void {
    this.daemonWindowId = windowId;
  }

  /** Workspace of the window currently feeding the daemon. */
  private get daemonWorkspace(): string | null {
    if (this.daemonWindowId === null) return null;
    return this.windowConfigs.get(this.daemonWindowId)?.workspace ?? null;
  }

  /** Config of the window currently feeding the daemon. */
  private get daemonConfig(): WorkspaceConfig | null {
    if (this.daemonWindowId === null) return null;
    return this.windowConfigs.get(this.daemonWindowId)?.config ?? null;
  }

  /** Resolve a window's merged workspace config (null when unknown). */
  private configFor(windowId?: number): WorkspaceConfig | null {
    if (windowId == null) return null;
    return this.windowConfigs.get(windowId)?.config ?? null;
  }

  /** Resolve a window's workspace path (null when unknown). */
  private workspaceFor(windowId?: number): string | null {
    if (windowId == null) return null;
    return this.windowConfigs.get(windowId)?.workspace ?? null;
  }

  constructor() {
    super();
    // Detect shell
    this.shell = process.env.SHELL || '/bin/bash';
    // Load config
    this.config = loadConfig();
    // Build extended PATH from config (the login shell's PATH is folded in
    // lazily on first use - see the `extendedPath` getter)
    this.configPaths = (this.config.paths || []).map(expandPath);
    console.log('Lee config loaded, PATH extended with:', this.configPaths);

    // App-managed venv path
    this.hesterVenvPath = path.join(app.getPath('home'), '.lee', 'venv');

    // Note: don't set hesterVenvReady here — ensureHesterVenv() handles
    // validation including source change detection for auto-upgrades.
    const hesterBin = path.join(this.hesterVenvPath, 'bin', 'hester');
    if (fs.existsSync(hesterBin)) {
      console.log('Hester venv found at:', this.hesterVenvPath, '(will validate on first use)');
    }

    // Capture the daemon PTY's output into a small ring buffer so we can
    // surface the last few meaningful lines if it crashes.
    this.on('data', (id: number, chunk: string) => {
      if (this.daemonPtyId === null || id !== this.daemonPtyId) return;
      const lines = chunk.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return;
      this.daemonOutputBuffer.push(...lines);
      const excess = this.daemonOutputBuffer.length - PTYManager.DAEMON_BUFFER_MAX_LINES;
      if (excess > 0) {
        this.daemonOutputBuffer.splice(0, excess);
      }
    });
  }

  /**
   * Ask the user's login shell what PATH it ends up with.
   *
   * Launched from the Dock, Electron inherits a bare
   * /usr/bin:/bin:/usr/sbin:/sbin, so anything installed by Homebrew, nvm,
   * pyenv, mise, cargo or pipx is invisible. Spawning TUIs through
   * `$SHELL -ilc '<string>'` used to paper over that (at the cost of building
   * a shell command string - see C11); now that TUIs are spawned directly
   * with an argv array, we resolve that PATH once here instead.
   *
   * Cached for the life of the process; failures fall back to config paths
   * plus whatever PATH Electron was given.
   */
  private resolveLoginShellPath(): string | null {
    if (this.loginShellPathResolved) return this.loginShellPath;
    this.loginShellPathResolved = true;
    try {
      // A sentinel keeps rc-file chatter (MOTDs, version notices) out of the
      // parsed value - we take only the line we printed.
      const output = execSync(
        `${this.shell} -ilc 'printf "\n__LEE_PATH__%s\n" "$PATH"'`,
        { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const line = output.split('\n').reverse().find((l) => l.startsWith('__LEE_PATH__'));
      const value = line?.slice('__LEE_PATH__'.length).trim();
      // Sanity check: a PATH is colon-separated. A shell whose $PATH isn't a
      // plain string (fish expands it as a list) would hand back something
      // space-separated - ignore that rather than poisoning the PATH.
      if (value && value.includes(':') && !value.includes(' ')) {
        this.loginShellPath = value;
        this.log('INFO', 'Resolved login-shell PATH', { entries: value.split(':').length });
      }
    } catch (error: any) {
      this.log('WARN', 'Could not resolve login-shell PATH; using inherited PATH', {
        shell: this.shell,
        error: error?.message,
      });
    }
    return this.loginShellPath;
  }

  /**
   * PATH used for every spawn and for command-availability checks:
   * config `paths:` first, then the login shell's PATH, then Electron's own.
   */
  private get extendedPath(): string {
    if (this.cachedExtendedPath) return this.cachedExtendedPath;
    const loginPath = this.resolveLoginShellPath();
    const parts = [
      ...this.configPaths,
      ...(loginPath ? loginPath.split(':') : []),
      ...(process.env.PATH || '').split(':'),
    ].filter(Boolean);
    this.cachedExtendedPath = [...new Set(parts)].join(':');
    return this.cachedExtendedPath;
  }

  /**
   * Set workspace configuration for a specific window.
   */
  setWorkspaceConfig(workspace: string, config: WorkspaceConfig | null, windowId: number): void {
    this.windowConfigs.set(windowId, { workspace, config });
    // First window to report a config also becomes the daemon's source of
    // truth until something focuses a different one.
    if (this.daemonWindowId === null) this.daemonWindowId = windowId;
    console.log('Workspace config set:', workspace, 'windowId:', windowId, config?.source || 'no source files');
  }

  /**
   * Get workspace config for a specific window.
   */
  getWindowConfig(windowId: number): { workspace: string; config: WorkspaceConfig | null } | undefined {
    return this.windowConfigs.get(windowId);
  }

  /**
   * Remove config for a window (called on window close).
   */
  removeWindowConfig(windowId: number): void {
    this.windowConfigs.delete(windowId);
  }

  /**
   * Find a working python 3.11+ binary.
   * Priority: bundled python-build-standalone > system python.
   */
  private findPython(): string | null {
    // 1. Bundled python-build-standalone (packaged app)
    if (app.isPackaged) {
      const bundled = path.join(process.resourcesPath, 'python', 'bin', 'python3');
      if (fs.existsSync(bundled)) {
        this.log('INFO', `Using bundled Python at ${bundled}`);
        return bundled;
      }
    }

    // 2. System python — version-specific names first, then generic
    const candidates = [
      'python3.14', 'python3.13', 'python3.12', 'python3.11',
      'python3', 'python',
    ];

    // Well-known paths that may not be on Electron's PATH
    const extraPaths = [
      '/opt/homebrew/bin',           // macOS Homebrew (Apple Silicon)
      '/usr/local/bin',              // macOS Homebrew (Intel) / Linux
      '/opt/local/bin',              // MacPorts
      path.join(process.env.HOME || '', '.pyenv', 'shims'), // pyenv
    ];

    const searchPath = [...new Set([
      ...this.extendedPath.split(':'),
      ...extraPaths,
    ])].join(':');

    for (const candidate of candidates) {
      try {
        const result = execSync(`which ${candidate}`, {
          encoding: 'utf-8',
          env: { ...process.env, PATH: searchPath },
          timeout: 5000,
        }).trim();
        if (!result) continue;

        // Verify it's Python 3.11+
        try {
          const version = execSync(`${result} -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"`, {
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
          const [major, minor] = version.split('.').map(Number);
          if (major >= 3 && minor >= 11) {
            this.log('INFO', `Found Python ${version} at ${result}`);
            return result;
          }
          this.log('WARN', `${candidate} at ${result} is ${version}, need 3.11+`);
        } catch {
          // Can't check version, skip
        }
      } catch {
        // Not found, try next
      }
    }
    return null;
  }

  /**
   * Get the path to bundled hester source.
   * In packaged mode: process.resourcesPath/hester-src
   * In dev mode: lee/ directory (one level up from lee/electron/)
   */
  getBundledHesterSource(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'hester-src');
    }
    // Dev mode: lee/ is one level up from lee/electron/
    return path.resolve(app.getAppPath(), '..');
  }

  /**
   * Ensure the app-managed hester venv exists at ~/.lee/venv/.
   * Creates venv + pip installs from bundled source on first launch.
   * Self-repairing: re-bootstraps if venv is missing or broken.
   *
   * Emits 'hester-setup' events with { phase, message } for UI feedback.
   */
  async ensureHesterVenv(): Promise<void> {
    // Already ready
    if (this.hesterVenvReady) {
      return;
    }

    // Deduplicate concurrent calls
    if (this.hesterBootstrapPromise) {
      return this.hesterBootstrapPromise;
    }

    this.hesterBootstrapPromise = this._bootstrapHesterVenv();
    try {
      await this.hesterBootstrapPromise;
    } finally {
      this.hesterBootstrapPromise = null;
    }
  }

  private async _bootstrapHesterVenv(): Promise<void> {
    const hesterBin = path.join(this.hesterVenvPath, 'bin', 'hester');

    // Quick validation: if binary exists, try running it
    let venvExists = false;
    let sourceChanged = false;
    if (fs.existsSync(hesterBin)) {
      try {
        execSync(`${hesterBin} --version`, { timeout: 10000, stdio: 'pipe' });
        venvExists = true;

        // Check if bundled source is newer than installed version
        if (!this.isHesterSourceChanged()) {
          this.hesterVenvReady = true;
          this.log('INFO', 'Hester venv validated successfully');
          this.emit('hester-setup', { phase: 'ready', message: 'Hester ready' });
          return;
        }
        sourceChanged = true;
        this.log('INFO', 'Hester source changed, upgrading');
      } catch {
        this.log('WARN', 'Hester venv exists but is broken, rebuilding');
      }
    }

    // Find bundled source
    const hesterSrc = this.getBundledHesterSource();
    const pyprojectPath = path.join(hesterSrc, 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) {
      const error = `Hester source not found at ${hesterSrc}`;
      this.log('ERROR', error);
      this.emit('hester-setup', { phase: 'error', message: error });
      throw new Error(error);
    }

    const pip = path.join(this.hesterVenvPath, 'bin', 'pip');

    // Fast path: venv works but source changed — just pip install over the top
    if (venvExists && sourceChanged) {
      this.emit('hester-setup', { phase: 'upgrading', message: 'Updating Hester...' });
      this.log('INFO', 'Upgrading hester in existing venv', { src: hesterSrc });

      try {
        const pipArgs = app.isPackaged
          ? ['install', '--upgrade', hesterSrc]
          : ['install', '-e', hesterSrc];

        await new Promise<void>((resolve, reject) => {
          execFile(pip, pipArgs, {
            timeout: 300000,
            env: { ...process.env, PATH: this.extendedPath },
          }, (err, _stdout, stderr) => {
            if (err) {
              this.log('ERROR', 'pip upgrade failed, will rebuild venv', { stderr });
              reject(err);
            } else {
              this.log('INFO', 'pip upgrade succeeded');
              resolve();
            }
          });
        });

        this.writeHesterSourceHash();
        this.hesterVenvReady = true;
        this.log('INFO', 'Hester upgrade complete');
        this.emit('hester-setup', { phase: 'ready', message: 'Hester ready' });
        return;
      } catch {
        this.log('WARN', 'Upgrade failed, falling through to full rebuild');
      }
    }

    // Full bootstrap: find python, create venv, install
    this.emit('hester-setup', { phase: 'finding-python', message: 'Finding Python...' });
    const python = this.findPython();
    if (!python) {
      const error = 'Python 3.11+ not found. Install Python to use Hester.';
      this.log('ERROR', error);
      this.emit('hester-setup', { phase: 'error', message: error });
      throw new Error(error);
    }
    this.log('INFO', `Using Python: ${python}`);

    this.emit('hester-setup', { phase: 'creating-venv', message: 'Creating Python environment...' });
    this.log('INFO', 'Creating hester venv', { path: this.hesterVenvPath, python });

    try {
      // Ensure parent directory exists
      fs.mkdirSync(path.dirname(this.hesterVenvPath), { recursive: true });

      // Create venv (remove broken one first if needed)
      if (fs.existsSync(this.hesterVenvPath)) {
        fs.rmSync(this.hesterVenvPath, { recursive: true, force: true });
      }

      await new Promise<void>((resolve, reject) => {
        execFile(python, ['-m', 'venv', this.hesterVenvPath], { timeout: 30000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Install hester from bundled source
      this.emit('hester-setup', { phase: 'installing', message: 'Installing Hester (first launch)...' });
      this.log('INFO', 'Installing hester from bundled source', { src: hesterSrc });

      // In dev mode, use editable install so code changes are reflected immediately.
      // In packaged mode, do a regular install from the bundled source.
      const pipArgs = app.isPackaged
        ? ['install', hesterSrc]
        : ['install', '-e', hesterSrc];

      await new Promise<void>((resolve, reject) => {
        execFile(pip, pipArgs, {
          timeout: 300000, // 5 minutes for deps
          env: { ...process.env, PATH: this.extendedPath },
        }, (err, stdout, stderr) => {
          if (err) {
            this.log('ERROR', 'pip install failed', { stderr });
            reject(err);
          } else {
            this.log('INFO', 'pip install succeeded');
            resolve();
          }
        });
      });

      // Verify
      if (!fs.existsSync(hesterBin)) {
        throw new Error('hester binary not found after install');
      }

      // Write source hash so we can detect changes on next launch
      this.writeHesterSourceHash();

      this.hesterVenvReady = true;
      this.log('INFO', 'Hester venv bootstrap complete');
      this.emit('hester-setup', { phase: 'ready', message: 'Hester ready' });

    } catch (error: any) {
      const msg = `Hester setup failed: ${error.message}`;
      this.log('ERROR', msg);
      this.emit('hester-setup', { phase: 'error', message: msg });
      throw error;
    }
  }

  /**
   * Check if the bundled hester source has changed since last install.
   * Compares a hash of pyproject.toml against a stored hash in the venv.
   */
  private isHesterSourceChanged(): boolean {
    try {
      const currentHash = this.computeHesterSourceHash();
      if (!currentHash) return false;

      const hashFile = path.join(this.hesterVenvPath, '.hester-source-hash');
      if (!fs.existsSync(hashFile)) return true; // No hash = first install or pre-hash version

      const storedHash = fs.readFileSync(hashFile, 'utf-8').trim();
      return currentHash !== storedHash;
    } catch {
      // Hash check is an optimisation; a failure just means "no upgrade
      // needed" rather than blocking Hester from starting.
      return false;
    }
  }

  /** Write the current source hash after a successful install. */
  private writeHesterSourceHash(): void {
    try {
      const hash = this.computeHesterSourceHash();
      if (!hash) return;
      fs.writeFileSync(path.join(this.hesterVenvPath, '.hester-source-hash'), hash);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Compute a fingerprint of the bundled hester source.
   * Hashes pyproject.toml content — bump the version field to trigger a reinstall.
   */
  private computeHesterSourceHash(): string | null {
    const hesterSrc = this.getBundledHesterSource();
    const pyprojectPath = path.join(hesterSrc, 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) return null;

    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(pyprojectPath))
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Get environment variables including sourced files.
   */
  private getEnvironment(cwd?: string, windowId?: number): Record<string, string> {
    // Start with process environment
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    const wsConfig = this.configFor(windowId);
    const workspace = cwd || this.workspaceFor(windowId);

    // Load source files from workspace config FIRST
    if (wsConfig?.source && wsConfig.source.length > 0) {
      const sourceEnv = loadSourceEnv(wsConfig.source, workspace || undefined);
      // Don't let sourced files override PATH - we'll handle that specially
      delete sourceEnv.PATH;
      Object.assign(env, sourceEnv);
      console.log('Applied source env vars:', Object.keys(sourceEnv).join(', '));
    }

    // Set our extended PATH AFTER sourcing (so it takes precedence)
    env.PATH = this.extendedPath;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';

    return env;
  }

  /** Resolve a tool command - config override > app venv > project venv (dev) > PATH */
  private resolveTool(name: string): string {
    // 1. Config override (lee.config.json tools)
    const override = this.config.tools?.[name];
    if (override && typeof override === 'string' && override.length > 0) {
      const resolved = expandPath(override);
      console.log(`Resolved tool ${name} -> ${resolved} (config override)`);
      return resolved;
    }

    // 2. App-managed venv (~/.lee/venv/bin/<tool>)
    const appVenvBin = path.join(this.hesterVenvPath, 'bin', name);
    if (fs.existsSync(appVenvBin)) {
      console.log(`Resolved tool ${name} -> ${appVenvBin} (app venv)`);
      return appVenvBin;
    }

    // 3. Project dev venv (dev mode only: ../../venvs/venv-lee/bin/<tool>)
    if (!app.isPackaged) {
      const devVenvBin = path.resolve(app.getAppPath(), '..', '..', 'venvs', 'venv-lee', 'bin', name);
      if (fs.existsSync(devVenvBin)) {
        console.log(`Resolved tool ${name} -> ${devVenvBin} (project dev venv)`);
        return devVenvBin;
      }
    }

    // 4. PATH fallback
    console.log(`Tool ${name} not found locally, will use PATH`);
    return name;
  }

  /**
   * Spawn a new PTY process.
   *
   * @param command - Command to run. If not provided, spawns an interactive login shell.
   * @param args - Arguments for the command.
   * @param cwd - Working directory.
   * @param name - Display name for the process.
   * @param loginShell - If true and no command provided, spawn as login shell (-l flag).
   *                     This ensures .bash_profile/.bashrc are fully sourced including
   *                     SDK initializations like gcloud. Defaults to true for terminals.
   */
  spawn(
    command?: string,
    args: string[] = [],
    cwd?: string,
    name?: string,
    loginShell: boolean = true,
    extraEnv?: Record<string, string>,
    windowId?: number
  ): number {
    const id = this.nextId++;

    // Use configured shell from workspace config, or fall back to system shell
    let cmd = command;
    let finalArgs = args;

    const wsConfig = this.configFor(windowId);

    if (!cmd) {
      const configuredShell = wsConfig?.terminal?.shell;
      cmd = configuredShell && configuredShell.length > 0 ? configuredShell : this.shell;

      // Spawn as login shell to properly source .bash_profile/.bashrc
      // This ensures things like gcloud SDK, nvm, pyenv, etc. are initialized
      if (loginShell && finalArgs.length === 0) {
        finalArgs = ['-l'];
      }
    }

    this.log('INFO', `Spawning PTY ${id}`, {
      command: cmd,
      args: finalArgs,
      cwd: cwd || process.cwd(),
      name: name || cmd,
      loginShell: loginShell && !command,
      configuredShell: wsConfig?.terminal?.shell || null,
      windowId: windowId ?? null,
    });

    // Get environment with sourced files
    const env = this.getEnvironment(cwd, windowId);

    // Merge extra environment variables (e.g., daemon-specific config)
    if (extraEnv) {
      Object.assign(env, extraEnv);
    }

    const ptyProcess = pty.spawn(cmd, finalArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || process.cwd(),
      env,
    });

    const proc: PTYProcess = {
      id,
      name: name || cmd,
      pty: ptyProcess,
      state: {},
      windowId: windowId ?? null,
    };

    this.processes.set(id, proc);

    // Buffer data briefly to allow renderer to register handlers before data flows
    // This fixes race conditions with prewarmed PTYs that send data immediately
    const dataBuffer: string[] = [];
    let bufferingComplete = false;

    // Handle data with escape sequence parsing
    ptyProcess.onData((data) => {
      const { cleanData, states } = this.parseEscapeSequences(data);

      // Emit raw data for terminal display
      if (cleanData) {
        if (bufferingComplete) {
          this.emit('data', id, cleanData);
        } else {
          dataBuffer.push(cleanData);
        }
      }

      // Emit parsed states (these don't need buffering)
      for (const state of states) {
        proc.state = { ...proc.state, ...state };
        this.emit('state', id, proc.state);
      }
    });

    // After 50ms, flush buffer and stop buffering
    setTimeout(() => {
      bufferingComplete = true;
      if (dataBuffer.length > 0) {
        this.emit('data', id, dataBuffer.join(''));
      }
    }, 50);

    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      this.log(exitCode === 0 ? 'INFO' : 'WARN', `PTY ${id} exited`, {
        name: name || cmd,
        exitCode,
      });
      this.processes.delete(id);
      this.emit('exit', id, exitCode);
    });

    return id;
  }

  /**
   * Build extra environment variables for the Hester daemon from workspace config.
   */
  private getDaemonEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};

    // The daemon PTY is deliberately not owned by any window (so closing a
    // window doesn't kill it), which means getEnvironment() can't resolve a
    // window config for it. Apply the daemon window's `source:` files here
    // instead - they carry things like GOOGLE_APPLICATION_CREDENTIALS.
    const daemonConfig = this.daemonConfig;
    if (daemonConfig?.source && daemonConfig.source.length > 0) {
      const sourceEnv = loadSourceEnv(daemonConfig.source, this.daemonWorkspace || undefined);
      delete sourceEnv.PATH; // PATH is owned by the extendedPath getter
      Object.assign(env, sourceEnv);
    }

    // Pass resources path so Hester can find bundled binaries (redis-server, etc.)
    if (app.isPackaged) {
      env.HESTER_RESOURCES_PATH = process.resourcesPath;
    } else {
      // Dev mode: point to local resources directory
      env.HESTER_RESOURCES_PATH = path.join(app.getAppPath(), 'resources');
    }

    // Workspace config is set from the deep-merged config.yaml chain
    // (~/.config/lee < ~/.lee < <workspace>/.lee), so it already contains
    // global keys even when the workspace file itself has `hester: {}`.
    const hesterConfig = this.daemonConfig?.hester;

    if (!hesterConfig) return env;

    if (hesterConfig.google_api_key) {
      env.GOOGLE_API_KEY = hesterConfig.google_api_key;
    }
    if (hesterConfig.model) {
      env.HESTER_GEMINI_MODEL = hesterConfig.model;
    }
    if (hesterConfig.thinking_depth !== undefined) {
      env.HESTER_THINKING_DEPTH_ENABLED = hesterConfig.thinking_depth ? 'true' : 'false';
    }
    if (hesterConfig.ollama_url) {
      env.HESTER_OLLAMA_URL = hesterConfig.ollama_url;
    }
    if (hesterConfig.prepare_model) {
      env.HESTER_PREPARE_MODEL = hesterConfig.prepare_model;
    }
    if (hesterConfig.local_model) {
      env.HESTER_LOCAL_MODEL = hesterConfig.local_model;
    }
    if (hesterConfig.ollama_recheck_minutes !== undefined) {
      env.HESTER_OLLAMA_RECHECK_MINUTES = String(hesterConfig.ollama_recheck_minutes);
    }
    return env;
  }

  /**
   * Which interface the daemon should bind.
   *
   * Defaults to 0.0.0.0 so paired devices (Aeronaut, Dirigible, remote
   * Spyglass) keep working; the daemon now requires the ~/.lee/api-token
   * bearer on every endpoint except GET /health. Set
   * `hester.listen_host: 127.0.0.1` in config to restrict it to loopback.
   */
  private getDaemonHost(): string {
    const configured = this.daemonConfig?.hester?.listen_host;
    return typeof configured === 'string' && configured.trim()
      ? configured.trim()
      : '0.0.0.0';
  }

  /**
   * Check if GOOGLE_API_KEY is available from workspace config, global config, or process environment.
   * Returns the source if found, or null if missing.
   */
  private getGoogleApiKeySource(): 'config' | 'env' | null {
    // Same source of truth as getDaemonEnvironment(): the deep-merged
    // workspace config (~/.config/lee < ~/.lee < <workspace>/.lee).
    if (this.daemonConfig?.hester?.google_api_key) return 'config';
    if (process.env.GOOGLE_API_KEY) return 'env';
    return null;
  }

  /**
   * Start the Hester daemon in background (hidden PTY, not attached to any tab).
   * The daemon provides AI assistance via the command palette.
   * Checks if port 9000 is available first - if already in use, assumes daemon is running.
   */
  async prewarmDaemon(): Promise<void> {
    if (this.daemonPtyId !== null) {
      // Already tracking daemon - silently skip to avoid log spam
      return;
    }

    // Wait for venv bootstrap if still in progress (avoids race condition)
    if (this.hesterBootstrapPromise) {
      try {
        await this.hesterBootstrapPromise;
      } catch {
        // Bootstrap failed — venv not ready, can't start daemon
        this.log('WARN', 'Skipping daemon start: hester venv bootstrap failed');
        return;
      }
    }

    // Pre-flight: check if GOOGLE_API_KEY is available
    const apiKeySource = this.getGoogleApiKeySource();
    if (!apiKeySource) {
      this.log('WARN', 'Skipping daemon start: GOOGLE_API_KEY not found in workspace config or environment');
      this.emit('daemon-warning', {
        message: 'Hester needs GOOGLE_API_KEY — set it in .lee/config.yaml under hester.google_api_key or export it in your shell',
        type: 'warning' as const,
      });
      return;
    }

    // Check if port 9000 is already in use (daemon from previous session)
    const portAvailable = await isPortAvailable(9000);
    if (!portAvailable) {
      this.log('INFO', 'Port 9000 already in use, assuming Hester daemon is already running');
      return;
    }

    this.log('INFO', 'Starting Hester daemon in background', {
      workspace: this.daemonWorkspace,
    });

    // Use hester daemon start command - pass workspace for env sourcing
    const hesterPath = this.resolveTool('hester');
    const daemonEnv = this.getDaemonEnvironment();
    // Make the workspace explicit rather than leaving the daemon to infer it
    // from cwd; /workspace re-points it later when the user switches projects.
    if (this.daemonWorkspace) {
      daemonEnv.HESTER_WORKING_DIRECTORY = this.daemonWorkspace;
    }
    const daemonHost = this.getDaemonHost();
    const id = this.spawn(
      hesterPath,
      ['daemon', 'start', '--port', '9000', '--host', daemonHost],
      this.daemonWorkspace || undefined,
      'Hester Daemon',
      true,
      daemonEnv,
      undefined,
    );

    this.daemonPtyId = id;
    this.daemonOutputBuffer = [];

    // If daemon exits, clear reference. Use `on` + an id check (not `once`),
    // since `once('exit', ...)` would be consumed by the exit of ANY PTY,
    // not necessarily the daemon's.
    const onDaemonExit = (exitId: number, code: number) => {
      if (exitId !== id) return;
      this.off('exit', onDaemonExit);
      this.log(code === 0 ? 'INFO' : 'WARN', 'Hester daemon exited', { exitCode: code });
      if (this.daemonPtyId === id) {
        this.daemonPtyId = null;
      }
      if (code !== 0) {
        const tail = this.daemonOutputBuffer.slice(-8).join(' | ');
        this.emit('daemon-warning', {
          message: `Hester daemon exited (code ${code})${tail ? ': ' + tail : ''}`,
          type: 'error' as const,
        });
      }
    };
    this.on('exit', onDaemonExit);
  }

  /**
   * Is the daemon on :9000 one WE started (as opposed to an external process
   * that already owned the port)?
   */
  isDaemonLeeManaged(): boolean {
    return this.daemonPtyId !== null;
  }

  /**
   * Read the shared Lee/Hester bearer token (~/.lee/api-token). Same file the
   * api-server persists; the daemon requires it on every endpoint but /health.
   */
  private readApiToken(): string | null {
    try {
      const token = fs.readFileSync(path.join(app.getPath('home'), '.lee', 'api-token'), 'utf-8').trim();
      return token || null;
    } catch {
      // No token file yet (first run, or the api-server hasn't written it);
      // requests go out unauthenticated and the daemon logs the refusal.
      return null;
    }
  }

  /**
   * Tell the daemon which workspace to serve.
   *
   * One daemon backs every Lee window, so it has to follow the active one:
   * this reloads that workspace's plugins and re-points the .hester/-backed
   * stores and watchers, without the cost of a daemon restart.
   */
  async setDaemonWorkspace(workspace: string): Promise<boolean> {
    if (!workspace) return false;
    if (this.lastDaemonWorkspace === workspace) return true;

    const token = this.readApiToken();
    try {
      const response = await fetch('http://127.0.0.1:9000/workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ path: workspace }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        this.log('WARN', 'Hester workspace switch rejected', {
          workspace,
          status: response.status,
        });
        return false;
      }
      this.lastDaemonWorkspace = workspace;
      this.log('INFO', 'Hester now serving workspace', { workspace });
      return true;
    } catch (error: any) {
      // Daemon may simply not be up yet; it picks the workspace up from
      // HESTER_WORKING_DIRECTORY when it starts.
      this.log('INFO', 'Could not notify Hester of workspace change', {
        workspace,
        error: error?.message,
      });
      return false;
    }
  }

  /**
   * Ask the daemon to exit cleanly (A11), so it and the managed redis it
   * started don't outlive Lee. Used on quit only — a restart kills the PTY
   * instead, which leaves the managed redis running for the next daemon to
   * reconnect to.
   */
  async shutdownDaemonGracefully(timeoutMs = 3000): Promise<boolean> {
    if (this.daemonPtyId === null) return false;

    const token = this.readApiToken();
    try {
      await fetch('http://127.0.0.1:9000/shutdown', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      this.log('WARN', 'Graceful daemon shutdown request failed', { error: error?.message });
      return false;
    }

    // Give the daemon a moment to save Redis and exit before killAll().
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.daemonPtyId === null) {
        this.log('INFO', 'Hester daemon shut down cleanly');
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.log('WARN', 'Hester daemon did not exit within timeout; killing');
    return false;
  }

  /**
   * Check if daemon is running (either via PTY or external process on port 9000).
   */
  async isDaemonRunning(): Promise<boolean> {
    // First check our PTY tracking
    if (this.daemonPtyId !== null) {
      return true;
    }
    // Also check if port 9000 is in use (external daemon process)
    const portAvailable = await isPortAvailable(9000);
    return !portAvailable;
  }

  /**
   * Start the daemon if not already running.
   * Returns success status and any error message.
   */
  async startDaemon(): Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }> {
    // Pre-flight: check API key before attempting to start
    const apiKeySource = this.getGoogleApiKeySource();
    if (!apiKeySource) {
      const error = 'GOOGLE_API_KEY not configured. Set hester.google_api_key in .lee/config.yaml or export GOOGLE_API_KEY in your shell.';
      this.log('WARN', error);
      this.emit('daemon-warning', { message: error, type: 'warning' as const });
      return { success: false, error };
    }

    // Check if already running via PTY
    if (this.daemonPtyId !== null) {
      this.log('INFO', 'Daemon already running (PTY tracked)');
      return { success: true, alreadyRunning: true };
    }

    // Check if port 9000 is in use (external daemon)
    const portAvailable = await isPortAvailable(9000);
    if (!portAvailable) {
      this.log('INFO', 'Daemon already running (port 9000 in use)');
      return { success: true, alreadyRunning: true };
    }

    // Start daemon via prewarm mechanism (which tracks PTY)
    try {
      await this.prewarmDaemon();
      // Give it a moment to bind the port
      await new Promise(resolve => setTimeout(resolve, 1500));
      // Verify it started
      const nowAvailable = await isPortAvailable(9000);
      if (nowAvailable) {
        return { success: false, error: 'Daemon failed to start - port 9000 still available' };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Stop the daemon if running.
   */
  async stopDaemon(): Promise<{ success: boolean; error?: string }> {
    // If we're tracking a PTY, kill it
    if (this.daemonPtyId !== null) {
      this.log('INFO', 'Stopping daemon (killing PTY)', { ptyId: this.daemonPtyId });
      this.kill(this.daemonPtyId);
      this.daemonPtyId = null;
      // Give it a moment to release the port
      await new Promise(resolve => setTimeout(resolve, 500));
      return { success: true };
    }

    // Otherwise try to stop via CLI (external daemon)
    const { spawn } = await import('child_process');
    return new Promise<{ success: boolean; error?: string }>((resolve) => {
      const hesterPath = this.resolveTool('hester');
      const proc = spawn(hesterPath, ['daemon', 'stop'], { stdio: 'pipe' });
      proc.on('close', (code) => {
        if (code === 0) {
          this.log('INFO', 'Stopped external daemon via CLI');
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `hester daemon stop exited with code ${code}` });
        }
      });
      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  /**
   * Restart the daemon.
   */
  async restartDaemon(): Promise<{ success: boolean; error?: string }> {
    this.log('INFO', 'Restarting daemon');
    this.lastDaemonWorkspace = null;

    // Stop first
    const stopResult = await this.stopDaemon();
    if (!stopResult.success) {
      // Even if stop fails, try to start (daemon might not have been running)
      this.log('WARN', 'Stop daemon returned error, attempting start anyway', { error: stopResult.error });
    }

    // Wait a bit for port to be released
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start fresh
    return this.startDaemon();
  }

  /**
   * TUI types that can be prewarmed.
   * These are the most commonly used TUIs that benefit from instant startup.
   */
  private static readonly PREWARMABLE_TUIS = ['terminal', 'hester', 'claude'] as const;

  /**
   * Prewarm a TUI instance for instant startup.
   * Only prewarms if not already warmed for this type.
   */
  prewarmTUI(tuiType: string, workspace?: string, windowId?: number): void {
    // Only prewarm supported types
    if (!PTYManager.PREWARMABLE_TUIS.includes(tuiType as any)) {
      return;
    }

    // Pool key includes windowId to keep per-window pools
    const poolKey = windowId != null ? `${tuiType}:${windowId}` : tuiType;

    // Already warmed for this type+window
    if (this.warmTUIPool.has(poolKey)) {
      return;
    }

    this.log('INFO', `Prewarming ${tuiType} TUI`, { workspace, windowId });

    let id: number;
    const cwd = workspace || this.workspaceFor(windowId) || undefined;

    switch (tuiType) {
      case 'terminal':
        id = this.spawn(undefined, [], cwd, 'Terminal (warm)', true, undefined, windowId);
        break;
      case 'hester':
        id = this.spawnTUI(
          'hester',
          ['chat', '--daemon-url', 'http://localhost:9000', '--dir', cwd || process.cwd()],
          cwd,
          'Hester (warm)',
          undefined,
          windowId
        );
        break;
      case 'claude':
        id = this.spawnTUI('claude', [], cwd, 'Claude (warm)', { DEBUG: 'false' }, windowId);
        break;
      default:
        return;
    }

    this.warmTUIPool.set(poolKey, { id, workspace: workspace || null });

    // If warm TUI exits, remove from pool. Use `on` + an id check (not
    // `once`), since `once('exit', ...)` would be consumed by the exit of
    // ANY PTY, not necessarily this warm entry's.
    const onWarmExit = (exitId: number) => {
      if (exitId !== id) return;
      this.off('exit', onWarmExit);
      const warm = this.warmTUIPool.get(poolKey);
      if (warm && warm.id === exitId) {
        this.log('INFO', `Prewarmed ${tuiType} exited, removing from pool`);
        this.warmTUIPool.delete(poolKey);
      }
    };
    this.on('exit', onWarmExit);
  }

  /**
   * Get a prewarmed TUI or spawn a fresh one.
   * If prewarmed instance exists with matching workspace, use it.
   * Then start warming a replacement.
   */
  getOrSpawnTUI(
    tuiType: string,
    spawnFn: () => number,
    workspace?: string,
    windowId?: number
  ): number {
    const poolKey = windowId != null ? `${tuiType}:${windowId}` : tuiType;
    const warm = this.warmTUIPool.get(poolKey);

    if (warm) {
      const workspaceMatches = warm.workspace === (workspace || null);

      if (workspaceMatches) {
        this.log('INFO', `Using prewarmed ${tuiType}`, { id: warm.id, windowId });
        this.warmTUIPool.delete(poolKey);

        // Rename the warm process to remove "(warm)" suffix
        const proc = this.processes.get(warm.id);
        if (proc) {
          proc.name = proc.name.replace(' (warm)', '');
        }

        // Start warming replacement after short delay
        setTimeout(() => this.prewarmTUI(tuiType, workspace, windowId), 500);

        return warm.id;
      } else {
        // Workspace mismatch - kill warm and spawn fresh
        this.log('INFO', `Prewarmed ${tuiType} workspace mismatch, spawning fresh`);
        this.kill(warm.id);
        this.warmTUIPool.delete(poolKey);
      }
    }

    // Spawn fresh
    const id = spawnFn();

    // Start warming replacement
    setTimeout(() => this.prewarmTUI(tuiType, workspace, windowId), 500);

    return id;
  }

  /**
   * Prewarm all commonly used TUIs for a workspace.
   * Called on app startup after workspace is determined.
   */
  prewarmAllTUIs(workspace?: string, windowId?: number): void {
    this.log('INFO', 'Prewarming all TUIs', { workspace, windowId });

    // Stagger the prewarming to avoid spike
    PTYManager.PREWARMABLE_TUIS.forEach((tuiType, index) => {
      setTimeout(() => this.prewarmTUI(tuiType, workspace, windowId), index * 200);
    });
  }

  /**
   * Clean up all prewarmed TUIs (call on app quit).
   */
  cleanupWarmTUIs(): void {
    for (const [tuiType, warm] of this.warmTUIPool) {
      this.log('INFO', `Cleaning up prewarmed ${tuiType}`);
      this.kill(warm.id);
    }
    this.warmTUIPool.clear();
  }

  /**
   * Check whether a resolved command is actually runnable: an absolute path
   * that exists, or a bare name found in one of the extended PATH
   * directories. Used before spawnTUI() hands a shell -c command, so a
   * missing tool (lazygit not installed, say) surfaces as a clear error
   * instead of a PTY that opens and immediately exits with "command not
   * found" - which looked to the tab UI like a spawn that silently no-oped.
   */
  private resolveExecutable(command: string): string | null {
    if (command.includes('/')) {
      try {
        return fs.statSync(command).isFile() ? command : null;
      } catch {
        return null;
      }
    }
    for (const dir of this.extendedPath.split(':')) {
      if (!dir) continue;
      const candidate = path.join(dir, command);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this directory
      }
    }
    return null;
  }

  private isCommandAvailable(command: string): boolean {
    return this.resolveExecutable(command) !== null;
  }

  /** Install hints surfaced when a default TUI's command isn't on PATH. */
  private static readonly TUI_INSTALL_HINTS: Record<string, string> = {
    lazygit: 'brew install lazygit',
    lazydocker: 'brew install lazydocker',
    k9s: 'brew install k9s',
    btop: 'brew install btop',
    pgcli: 'brew install pgcli or pipx install pgcli',
  };

  /**
   * Spawn a generic TUI application.
   * Runs through interactive login shell to ensure PATH is properly set from .bashrc
   */
  spawnTUI(
    command: string,
    args: string[] = [],
    cwd?: string,
    name?: string,
    envOverrides?: Record<string, string>,
    windowId?: number,
    useShell: boolean = false,
  ): number {
    const resolvedCmd = this.resolveTool(command);

    // Escape hatch: a TUI definition can set `shell: true` when its `command`
    // is really a shell snippet (`foo && bar`, a pipeline, a glob). Those
    // still go through `$SHELL -ilc`, with every argument quoted.
    if (useShell) {
      const shell = this.configFor(windowId)?.terminal?.shell || this.shell;
      const fullCommand = [resolvedCmd, ...args.map(shellQuote)].join(' ');
      this.log('INFO', 'Spawning TUI through a shell (shell: true)', { command, args });
      return this.spawn(shell, ['-il', '-c', fullCommand], cwd, name || command, false, envOverrides, windowId);
    }

    const executable = this.resolveExecutable(resolvedCmd);
    if (!executable) {
      const hint = PTYManager.TUI_INSTALL_HINTS[command];
      this.log('WARN', 'Refusing to spawn TUI: command not found on PATH', { command, resolvedCmd });
      throw new Error(`"${command}" not found on PATH${hint ? ` (${hint})` : ''}`);
    }

    // Spawn the resolved binary directly with an argv array and an env
    // object - no shell, so nothing in an argument (quotes, $, backticks,
    // spaces) can be reinterpreted as shell syntax, and env overrides never
    // appear in `ps` as part of a command string.
    return this.spawn(executable, args, cwd, name || command, false, envOverrides, windowId);
  }

  /**
   * Default TUI definitions - used when no config is provided.
   * Users can override these in .lee/config.yaml under the `tuis:` section.
   */
  private static readonly DEFAULT_TUIS: Record<string, TUIDefinition> = {
    claude: {
      command: 'claude',
      name: 'Claude',
      icon: '🤖',
      shortcut: '⇧⌘C',
      env: { DEBUG: 'false' },
      cwd_aware: true,
      prewarm: true,
      path_arg: 'cwd',  // claude uses working directory
    },
    hester: {
      command: 'hester',
      name: 'Hester',
      icon: '🐇',
      shortcut: '⇧⌘H',
      args: ['chat', '--daemon-url', 'http://localhost:9000'],
      cwd_aware: true,
      prewarm: true,
      path_arg: '--dir',  // hester uses --dir
    },
    devops: {
      command: 'hester',
      name: 'DevOps',
      icon: '🚀',
      shortcut: '⇧⌘O',
      args: ['devops', 'tui'],
      cwd_aware: true,
      path_arg: '--dir',
    },
    pi: {
      command: 'pi',
      name: 'Pi',
      icon: '🥧',
      shortcut: '⇧⌘I',
      cwd_aware: true,
      path_arg: 'cwd',
    },
    // Documented in CLAUDE.md as built-in defaults, but were missing here -
    // Cmd+Shift+G/D/K/P/F silently no-op'd (spawnTUI threw "Unknown TUI
    // type", swallowed by the renderer's console.error-only catch).
    git: {
      command: 'lazygit',
      name: 'Git',
      icon: '🌿',
      shortcut: '⇧⌘G',
      cwd_aware: true,
    },
    docker: {
      command: 'lazydocker',
      name: 'Docker',
      icon: '🐳',
      shortcut: '⇧⌘D',
    },
    k8s: {
      command: 'k9s',
      name: 'K8s',
      icon: '☸️',
      shortcut: '⇧⌘K',
    },
    system: {
      command: 'btop',
      name: 'System Monitor',
      icon: '📊',
    },
    flutter: {
      command: 'flx',
      name: 'Flutter',
      icon: '📱',
      shortcut: '⇧⌘F',
      cwd_from_config: 'flutter.path',
      cwd_aware: true,
    },
    // getTUIDefinition() fills `connection` in from the top-level `sql:`
    // block (sql.default names one of sql.connections) when there's no
    // explicit `tuis.sql.connection` override. With neither, bare pgcli
    // still works off libpq's usual PG* env vars / local socket.
    sql: {
      command: 'pgcli',
      name: 'SQL',
      icon: '🗄️',
      shortcut: '⇧⌘P',
    },
  };

  /**
   * Get a TUI definition by key, checking config first then falling back to defaults.
   */
  getTUIDefinition(tuiType: string, windowId?: number): TUIDefinition | null {
    const wsConfig = this.configFor(windowId);
    const configTui = wsConfig?.tuis?.[tuiType];
    const defaultTui = PTYManager.DEFAULT_TUIS[tuiType];

    let def: TUIDefinition | null = null;
    if (configTui && defaultTui) {
      // Merge: config overrides defaults, but defaults fill in missing fields
      def = { ...defaultTui, ...configTui };
    } else {
      def = configTui ?? defaultTui ?? null;
    }

    if (def && tuiType === 'sql' && !def.connection) {
      const conn = this.resolveSqlConnection(wsConfig);
      if (conn) def = { ...def, connection: conn };
    }

    return def;
  }

  /**
   * Map the documented top-level `sql:` block onto the `sql` TUI's connection.
   *
   * `sql.default` names an entry in `sql.connections`; if it names nothing (or
   * is absent) the first connection wins. An explicit `tuis.sql.connection`
   * still takes precedence - this only fills in when there isn't one. The
   * password never reaches the command line: spawnConnectionTUI passes it via
   * PGPASSWORD.
   */
  private resolveSqlConnection(wsConfig: WorkspaceConfig | null): TUIDefinition['connection'] | null {
    const connections = wsConfig?.sql?.connections;
    if (!Array.isArray(connections) || connections.length === 0) return null;

    const wanted = wsConfig?.sql?.default;
    const chosen = (wanted && connections.find((c) => c?.name === wanted)) || connections[0];
    if (!chosen || !chosen.host || !chosen.database || !chosen.user) {
      if (wanted && !connections.some((c) => c?.name === wanted)) {
        this.log('WARN', 'sql.default names an unknown connection', { default: wanted });
      }
      return null;
    }

    return {
      host: chosen.host,
      port: chosen.port,
      database: chosen.database,
      user: chosen.user,
      password: chosen.password,
      ssl: chosen.ssl,
    };
  }

  /**
   * Get all available TUI types (from config + defaults).
   */
  getAvailableTUITypes(windowId?: number): string[] {
    const types = new Set<string>(Object.keys(PTYManager.DEFAULT_TUIS));

    // Add any custom TUIs from this window's config
    const wsConfig = this.configFor(windowId);
    if (wsConfig?.tuis) {
      for (const key of Object.keys(wsConfig.tuis)) {
        types.add(key);
      }
    }

    return Array.from(types);
  }

  // TUIs that always appear in the tab menu (part of Lee itself)
  // Note: hester and devops are now in CORE_TAB_OPTIONS / FEATURE_TAB_OPTIONS in TabBar
  private static readonly ALWAYS_SHOW_TUIS: string[] = [];

  /**
   * Get all available TUI definitions (defaults merged with config).
   * Used to broadcast available TUIs in context for Bridge discovery.
   */
  getAllTUIDefinitions(windowId?: number): Record<string, TUIDefinition> {
    const configTuis = this.configFor(windowId)?.tuis ?? {};

    const merged: Record<string, TUIDefinition> = { ...PTYManager.DEFAULT_TUIS };
    for (const [key, def] of Object.entries(configTuis)) {
      merged[key] = { ...merged[key], ...def };
    }
    return merged;
  }

  /**
   * Get available TUIs with full metadata for dropdown rendering.
   * Always includes Hester and DevOps (bundled with Lee).
   * Additional TUIs appear when explicitly configured in workspace config.
   * Core tabs (Terminal, Browser, Library, Workstream) are handled by TabBar.
   */
  getAvailableTUIsWithMeta(windowId?: number): Array<{ key: string; name: string; icon: string; shortcut?: string }> {
    const configTuis = this.configFor(windowId)?.tuis ?? {};

    // Merge always-show defaults with configured TUIs
    const merged = new Map<string, { key: string; name: string; icon: string; shortcut?: string }>();

    // Always-show TUIs first
    for (const key of PTYManager.ALWAYS_SHOW_TUIS) {
      const def = configTuis[key] ?? {};
      const defaultDef = PTYManager.DEFAULT_TUIS[key];
      merged.set(key, {
        key,
        name: def.name || defaultDef?.name || key,
        icon: def.icon || defaultDef?.icon || '🔧',
        shortcut: def.shortcut || defaultDef?.shortcut,
      });
    }

    // Then configured TUIs
    for (const [key, def] of Object.entries(configTuis)) {
      if (merged.has(key)) continue;
      const defaultDef = PTYManager.DEFAULT_TUIS[key];
      merged.set(key, {
        key,
        name: def.name || defaultDef?.name || key,
        icon: def.icon || defaultDef?.icon || '🔧',
        shortcut: def.shortcut || defaultDef?.shortcut,
      });
    }

    return Array.from(merged.values());
  }

  // Built-in agent providers. Config `agents:` entries merge with / extend these.
  private static readonly DEFAULT_AGENTS: Record<string, AgentDefinition> = {
    hester: {
      command: 'hester',
      name: 'Hester',
      icon: '🐇',
      args: ['chat', '--daemon-url', 'http://localhost:9000'],
      cwd_aware: true,
      prewarm: true,
      path_arg: '--dir',
    },
    claude: {
      command: 'claude',
      name: 'Claude',
      icon: '🤖',
      env: { DEBUG: 'false' },
      cwd_aware: true,
      prewarm: true,
      path_arg: 'cwd',
    },
    pi: {
      command: 'pi',
      name: 'Pi',
      icon: '🥧',
      cwd_aware: true,
      path_arg: 'cwd',
    },
  };

  /**
   * Get an agent definition by provider key.
   * Checks config `agents:` first, then built-in defaults.
   */
  getAgentDefinition(provider: string, windowId?: number): AgentDefinition | null {
    const wsConfig = this.configFor(windowId);
    const configAgent = (wsConfig as any)?.agents?.[provider] as AgentDefinition | undefined;
    const defaultAgent = PTYManager.DEFAULT_AGENTS[provider];

    if (configAgent && defaultAgent) {
      return { ...defaultAgent, ...configAgent };
    }
    return configAgent ?? defaultAgent ?? null;
  }

  /**
   * Get all available agent providers (built-ins merged with config).
   */
  getAllAgentProviders(windowId?: number): Record<string, AgentDefinition> {
    const wsConfig = this.configFor(windowId);
    const configAgents = ((wsConfig as any)?.agents ?? {}) as Record<string, AgentDefinition>;

    const merged: Record<string, AgentDefinition> = { ...PTYManager.DEFAULT_AGENTS };
    for (const [key, def] of Object.entries(configAgents)) {
      merged[key] = { ...merged[key], ...def };
    }
    return merged;
  }

  /**
   * Spawn an agent tab for the given provider key.
   */
  spawnAgent(provider: string, cwd?: string, windowId?: number): number {
    const def = this.getAgentDefinition(provider, windowId);
    if (!def) {
      throw new Error(`Unknown agent provider: ${provider}`);
    }

    const args = [...(def.args || [])];
    let spawnCwd = cwd;

    if (def.path_arg && def.path_arg !== 'cwd' && cwd) {
      args.push(def.path_arg, cwd);
    } else if (def.path_arg === 'cwd' && cwd) {
      spawnCwd = cwd;
    }

    return this.spawnTUI(def.command, args, spawnCwd, def.name, def.env, windowId, def.shell === true);
  }

  /**
   * Spawn a TUI from config definition.
   *
   * @param tuiType - The TUI type key (e.g., 'git', 'docker', 'hester')
   * @param cwd - Working directory override
   * @param options - Additional options (e.g., sessionId for hester, scene for hester-qa)
   */
  spawnConfiguredTUI(
    tuiType: string,
    cwd?: string,
    options?: {
      sessionId?: string;
      scene?: string;
      persona?: string;
      maxTurns?: number;
      connection?: string; // SQL connection name
      context?: string; // k8s context
      namespace?: string; // k8s namespace
    },
    windowId?: number
  ): number {
    const def = this.getTUIDefinition(tuiType, windowId);

    if (!def) {
      throw new Error(`Unknown TUI type: ${tuiType}`);
    }

    // Build args - start with definition args
    const args = [...(def.args || [])];

    // Determine working directory
    let workingDir = cwd;

    const wsConfig = this.configFor(windowId);
    const wsWorkspace = this.workspaceFor(windowId);

    if (def.cwd_from_config) {
      // Resolve cwd from config path (e.g., 'flutter.path')
      const parts = def.cwd_from_config.split('.');
      let configValue: any = wsConfig;
      for (const part of parts) {
        configValue = configValue?.[part];
      }
      if (typeof configValue === 'string') {
        // Resolve relative to workspace
        workingDir = path.isAbsolute(configValue)
          ? configValue
          : path.join(wsWorkspace || process.cwd(), configValue);
      }
    }

    if (!workingDir && def.cwd_aware) {
      workingDir = wsWorkspace || undefined;
    }

    // Handle path argument based on TUI definition
    // path_arg can be: 'cwd' (use as working directory), or an arg name like '-p', '--dir'
    const pathArg = def.path_arg || '--dir';  // Default to --dir for backwards compatibility

    if (def.cwd_aware && workingDir && pathArg !== 'cwd') {
      // Add path as command line argument
      if (!args.includes(pathArg)) {
        args.push(pathArg, workingDir);
      }
    }
    // If path_arg is 'cwd', workingDir is already set and will be used as cwd in spawnTUI

    // Handle special options per TUI type
    if (tuiType === 'hester' && options?.sessionId) {
      args.push('--session', options.sessionId);
    }

    if (tuiType === 'hester-qa') {
      // Replace default scene with specified one
      if (options?.scene) {
        const sceneIndex = args.indexOf('welcome');
        if (sceneIndex !== -1) {
          args[sceneIndex] = options.scene;
        }
      }
      if (options?.persona) {
        args.push('--persona', options.persona);
      }
      if (options?.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
    }

    if (tuiType === 'k8s') {
      if (options?.context) {
        args.push('--context', options.context);
      }
      if (options?.namespace) {
        args.push('-n', options.namespace);
      }
    }

    return this.spawnTUI(def.command, args, workingDir, def.name, def.env, windowId, def.shell === true);
  }

  /**
   * Spawn a TUI that has connection config (e.g., pgcli for SQL).
   * Builds connection string from the TUI definition's connection property.
   *
   * @param tuiType - The TUI type key (e.g., 'sql-local', 'sql-prod')
   * @param def - The TUI definition with connection config
   * @param cwd - Working directory
   */
  spawnConnectionTUI(tuiType: string, def: TUIDefinition, cwd?: string, windowId?: number): number {
    if (!def.connection) {
      throw new Error(`TUI ${tuiType} does not have connection config`);
    }

    const conn = def.connection;
    const args: string[] = [...(def.args || [])];

    // Connection string WITHOUT the password: argv is world-readable through
    // `ps`, so the password travels in the environment instead (libpq reads
    // PGPASSWORD, and pgcli/psql/pg_dump all inherit it).
    const port = conn.port || 5432;
    const sslMode = conn.ssl ? '?sslmode=require' : '';
    const connStr = `postgresql://${conn.user}@${conn.host}:${port}/${conn.database}${sslMode}`;
    args.push(connStr);

    const env: Record<string, string> = { ...(def.env || {}) };
    if (conn.password) {
      env.PGPASSWORD = conn.password;
    }

    this.log('INFO', `Spawning ${def.command} with connection`, {
      tuiType,
      host: conn.host,
      database: conn.database,
      user: conn.user,
      password: conn.password ? 'via PGPASSWORD' : 'none',
    });

    return this.spawnTUI(def.command, args, cwd, def.name, env, windowId, def.shell === true);
  }

  /**
   * Write data to a PTY process (keyboard input).
   */
  write(id: number, data: string): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.pty.write(data);
    } else {
      this.log('WARN', `Write to non-existent PTY ${id}`, { dataLength: data.length });
    }
  }

  /**
   * Resize a PTY process.
   */
  resize(id: number, cols: number, rows: number): void {
    const proc = this.processes.get(id);
    if (proc) {
      proc.pty.resize(cols, rows);
    }
  }

  /**
   * Kill a PTY process.
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
   * Get the log file path and ensure directory exists.
   */
  private getLogPath(): string {
    const homeDir = app.getPath('home');
    const logDir = path.join(homeDir, '.lee', 'logs');
    const logPath = path.join(logDir, 'lee.log');

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.rotateLogIfNeeded(logPath);

    return logPath;
  }

  /**
   * Size-cap lee.log: once per process, if it exceeds 10 MB, shift
   * lee.log -> lee.log.1 -> .2 -> .3 and start fresh. (Hester rotates its own
   * log via RotatingFileHandler.)
   */
  private rotateLogIfNeeded(logPath: string): void {
    if (this.logRotationChecked) return;
    this.logRotationChecked = true;

    try {
      const stats = fs.statSync(logPath);
      if (stats.size < PTYManager.LOG_MAX_BYTES) return;

      const keep = PTYManager.LOG_BACKUP_COUNT;
      // Drop the oldest, then shift each backup up one slot.
      try { fs.unlinkSync(`${logPath}.${keep}`); } catch { /* may not exist */ }
      for (let i = keep - 1; i >= 1; i--) {
        try { fs.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`); } catch { /* may not exist */ }
      }
      fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      // File missing or unreadable — nothing to rotate.
    }
  }

  /**
   * Log a message to ~/.lee/logs/lee.log (main process events).
   *
   * Public so other main-process modules (e.g. the mDNS advertiser,
   * machine-manager's config watcher) can append to the same log without
   * duplicating the rotation/format logic.
   */
  log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>): void {
    try {
      const logPath = this.getLogPath();
      const now = new Date();
      const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

      let logEntry = `[${timestamp}] [${level}] ${message}`;
      if (details) {
        logEntry += ` ${JSON.stringify(details)}`;
      }
      logEntry += '\n';

      // Also log to console
      console.log(logEntry.trim());

      // Append to log file asynchronously
      fs.appendFile(logPath, logEntry, (err) => {
        if (err) {
          console.error('Failed to write log:', err);
        }
      });
    } catch (error) {
      console.error('Error in log:', error);
    }
  }

  /**
   * Parse OSC escape sequences from Lee.
   *
   * Handles:
   * - lee:state - Editor state updates (file, line, column, selection, modified)
   * - lee:ready - Editor daemon ready with port number
   */
  private parseEscapeSequences(data: string): {
    cleanData: string;
    states: LeeState[];
  } {
    const states: LeeState[] = [];

    // Match OSC sequences: \x1b]lee:<type>;params\x07
    // Types: state, ready
    const oscRegex = /\x1b\]lee:([^;\x07\x1b]+);?(.*?)\x07/g;

    const cleanData = data.replace(oscRegex, (_match, type, params) => {
      const state: LeeState = {};

      // Parse key=value pairs
      const pairs = params.split(';').filter(Boolean);
      for (const pair of pairs) {
        const [key, ...valueParts] = pair.split('=');
        const value = valueParts.join('=');

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
          case 'port':
            // From lee:ready signal - daemon port
            state.daemonPort = parseInt(value, 10);
            break;
        }
      }

      // Log ready signal for debugging
      if (type === 'ready' && state.daemonPort) {
        console.log(`Lee editor daemon ready on port ${state.daemonPort}`);
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

  /**
   * Get the window that owns a PTY.
   */
  getWindowForPty(ptyId: number): number | null {
    const proc = this.processes.get(ptyId);
    return proc?.windowId ?? null;
  }

  /**
   * Get count of active terminal PTYs for a specific window.
   */
  getActiveCountForWindow(windowId: number): number {
    let count = 0;
    for (const [id, proc] of this.processes) {
      if (proc.windowId !== windowId) continue;
      if (id === this.daemonPtyId) continue;
      let isWarm = false;
      for (const warm of this.warmTUIPool.values()) {
        if (warm.id === id) { isWarm = true; break; }
      }
      if (isWarm) continue;
      count++;
    }
    return count;
  }

  /**
   * Get names of active terminal PTYs for a specific window.
   */
  getActiveNamesForWindow(windowId: number): string[] {
    const names: string[] = [];
    for (const [id, proc] of this.processes) {
      if (proc.windowId !== windowId) continue;
      if (id === this.daemonPtyId) continue;
      let isWarm = false;
      for (const warm of this.warmTUIPool.values()) {
        if (warm.id === id) { isWarm = true; break; }
      }
      if (isWarm) continue;
      names.push(proc.name.replace(' (warm)', ''));
    }
    return names;
  }

  /**
   * Kill all PTYs owned by a specific window.
   * Also cleans up warm pool entries for that window.
   */
  killForWindow(windowId: number): void {
    // Kill active processes
    for (const [id, proc] of this.processes) {
      if (proc.windowId === windowId) {
        proc.pty.kill();
        this.processes.delete(id);
      }
    }

    // Clean up warm pool entries for this window
    for (const [key, warm] of this.warmTUIPool) {
      if (key.endsWith(`:${windowId}`)) {
        this.kill(warm.id);
        this.warmTUIPool.delete(key);
      }
    }

    // Clean up window config
    this.windowConfigs.delete(windowId);
  }

  /**
   * Get count of active terminal PTYs (excluding prewarmed/background processes).
   * Used to determine if we should show a quit confirmation dialog.
   */
  getActiveTerminalCount(): number {
    let count = 0;

    for (const [id, proc] of this.processes) {
      // Skip daemon PTY
      if (id === this.daemonPtyId) continue;

      // Skip prewarmed TUIs
      let isWarm = false;
      for (const warm of this.warmTUIPool.values()) {
        if (warm.id === id) {
          isWarm = true;
          break;
        }
      }
      if (isWarm) continue;

      // Count this as an active terminal
      count++;
    }

    return count;
  }

  /**
   * Get names of active terminal PTYs for display in quit dialog.
   */
  getActiveTerminalNames(): string[] {
    const names: string[] = [];

    for (const [id, proc] of this.processes) {
      // Skip daemon PTY
      if (id === this.daemonPtyId) continue;

      // Skip prewarmed TUIs
      let isWarm = false;
      for (const warm of this.warmTUIPool.values()) {
        if (warm.id === id) {
          isWarm = true;
          break;
        }
      }
      if (isWarm) continue;

      // Add name (remove " (warm)" suffix if present)
      names.push(proc.name.replace(' (warm)', ''));
    }

    return names;
  }
}
