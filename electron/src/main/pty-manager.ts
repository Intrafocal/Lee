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
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execSync, execFile } from 'child_process';
import { app } from 'electron';
import { TUIDefinition } from '../shared/context';

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
  hester?: {
    google_api_key?: string;
    model?: string;
    thinking_depth?: boolean;
    ollama_url?: string;
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
  private extendedPath: string;

  // Background daemon PTY (hidden, not attached to any tab)
  private daemonPtyId: number | null = null;

  // Prewarmed TUI pool for instant startup
  // Maps TUI type to { ptyId, workspace }
  private warmTUIPool: Map<string, { id: number; workspace: string | null }> = new Map();

  // App-managed hester venv at ~/.lee/venv/
  private hesterVenvPath: string;
  private hesterVenvReady: boolean = false;
  private hesterBootstrapPromise: Promise<void> | null = null;

  // Workspace-specific config (loaded from .lee/config.yaml)
  private workspaceConfig: WorkspaceConfig | null = null;
  private currentWorkspace: string | null = null;

  constructor() {
    super();
    // Detect shell
    this.shell = process.env.SHELL || '/bin/bash';
    // Load config
    this.config = loadConfig();
    // Build extended PATH from config
    const configPaths = (this.config.paths || []).map(expandPath);
    const currentPath = process.env.PATH || '';
    this.extendedPath = [...configPaths, ...currentPath.split(':')].join(':');
    console.log('Lee config loaded, PATH extended with:', configPaths);

    // App-managed venv path
    this.hesterVenvPath = path.join(app.getPath('home'), '.lee', 'venv');

    // Quick check if venv already exists and has hester
    const hesterBin = path.join(this.hesterVenvPath, 'bin', 'hester');
    if (fs.existsSync(hesterBin)) {
      this.hesterVenvReady = true;
      console.log('Hester venv already exists at:', this.hesterVenvPath);
    }
  }

  /**
   * Set workspace configuration (called when workspace is selected).
   */
  setWorkspaceConfig(workspace: string, config: WorkspaceConfig | null): void {
    this.currentWorkspace = workspace;
    this.workspaceConfig = config;
    console.log('Workspace config set:', workspace, config?.source || 'no source files');
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
    if (fs.existsSync(hesterBin)) {
      try {
        execSync(`${hesterBin} --version`, { timeout: 10000, stdio: 'pipe' });
        this.hesterVenvReady = true;
        this.log('INFO', 'Hester venv validated successfully');
        this.emit('hester-setup', { phase: 'ready', message: 'Hester ready' });
        return;
      } catch {
        this.log('WARN', 'Hester venv exists but is broken, rebuilding');
      }
    }

    // Find system python
    this.emit('hester-setup', { phase: 'finding-python', message: 'Finding Python...' });
    const python = this.findPython();
    if (!python) {
      const error = 'Python 3.11+ not found. Install Python to use Hester.';
      this.log('ERROR', error);
      this.emit('hester-setup', { phase: 'error', message: error });
      throw new Error(error);
    }
    this.log('INFO', `Using Python: ${python}`);

    // Find bundled source
    const hesterSrc = this.getBundledHesterSource();
    const pyprojectPath = path.join(hesterSrc, 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) {
      const error = `Hester source not found at ${hesterSrc}`;
      this.log('ERROR', error);
      this.emit('hester-setup', { phase: 'error', message: error });
      throw new Error(error);
    }

    // Create venv
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

      const pip = path.join(this.hesterVenvPath, 'bin', 'pip');

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
   * Get environment variables including sourced files.
   */
  private getEnvironment(cwd?: string): Record<string, string> {
    // Start with process environment
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Load source files from workspace config FIRST
    const workspace = cwd || this.currentWorkspace;
    if (this.workspaceConfig?.source && this.workspaceConfig.source.length > 0) {
      const sourceEnv = loadSourceEnv(this.workspaceConfig.source, workspace || undefined);
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
    extraEnv?: Record<string, string>
  ): number {
    const id = this.nextId++;

    // Use configured shell from workspace config, or fall back to system shell
    let cmd = command;
    let finalArgs = args;

    if (!cmd) {
      const configuredShell = this.workspaceConfig?.terminal?.shell;
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
      configuredShell: this.workspaceConfig?.terminal?.shell || null,
    });

    // Get environment with sourced files
    const env = this.getEnvironment(cwd);

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
    const hesterConfig = this.workspaceConfig?.hester;
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
    return env;
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

    // Check if port 9000 is already in use (daemon from previous session)
    const portAvailable = await isPortAvailable(9000);
    if (!portAvailable) {
      this.log('INFO', 'Port 9000 already in use, assuming Hester daemon is already running');
      return;
    }

    this.log('INFO', 'Starting Hester daemon in background', {
      workspace: this.currentWorkspace,
    });

    // Use hester daemon start command - pass workspace for env sourcing
    const hesterPath = this.resolveTool('hester');
    const daemonEnv = this.getDaemonEnvironment();
    const id = this.spawn(
      hesterPath,
      ['daemon', 'start', '--port', '9000', '--host', '0.0.0.0'],
      this.currentWorkspace || undefined,
      'Hester Daemon',
      true,
      daemonEnv
    );

    this.daemonPtyId = id;

    // If daemon exits, clear reference
    this.once('exit', (exitId: number, code: number) => {
      if (exitId === id && this.daemonPtyId === id) {
        this.log(code === 0 ? 'INFO' : 'WARN', 'Hester daemon exited', { exitCode: code });
        this.daemonPtyId = null;
      }
    });
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
  prewarmTUI(tuiType: string, workspace?: string): void {
    // Only prewarm supported types
    if (!PTYManager.PREWARMABLE_TUIS.includes(tuiType as any)) {
      return;
    }

    // Already warmed for this type
    if (this.warmTUIPool.has(tuiType)) {
      return;
    }

    this.log('INFO', `Prewarming ${tuiType} TUI`, { workspace });

    let id: number;
    const cwd = workspace || this.currentWorkspace || undefined;

    switch (tuiType) {
      case 'terminal':
        id = this.spawn(undefined, [], cwd, 'Terminal (warm)');
        break;
      case 'hester':
        id = this.spawnTUI(
          'hester',
          ['chat', '--daemon-url', 'http://localhost:9000', '--dir', cwd || process.cwd()],
          cwd,
          'Hester (warm)'
        );
        break;
      case 'claude':
        id = this.spawnTUI('claude', [], cwd, 'Claude (warm)', { DEBUG: 'false' });
        break;
      default:
        return;
    }

    this.warmTUIPool.set(tuiType, { id, workspace: workspace || null });

    // If warm TUI exits, remove from pool
    this.once('exit', (exitId: number) => {
      const warm = this.warmTUIPool.get(tuiType);
      if (warm && warm.id === exitId) {
        this.log('INFO', `Prewarmed ${tuiType} exited, removing from pool`);
        this.warmTUIPool.delete(tuiType);
      }
    });
  }

  /**
   * Get a prewarmed TUI or spawn a fresh one.
   * If prewarmed instance exists with matching workspace, use it.
   * Then start warming a replacement.
   */
  getOrSpawnTUI(
    tuiType: string,
    spawnFn: () => number,
    workspace?: string
  ): number {
    const warm = this.warmTUIPool.get(tuiType);

    if (warm) {
      const workspaceMatches = warm.workspace === (workspace || null);

      if (workspaceMatches) {
        this.log('INFO', `Using prewarmed ${tuiType}`, { id: warm.id });
        this.warmTUIPool.delete(tuiType);

        // Rename the warm process to remove "(warm)" suffix
        const proc = this.processes.get(warm.id);
        if (proc) {
          proc.name = proc.name.replace(' (warm)', '');
        }

        // Start warming replacement after short delay
        setTimeout(() => this.prewarmTUI(tuiType, workspace), 500);

        return warm.id;
      } else {
        // Workspace mismatch - kill warm and spawn fresh
        this.log('INFO', `Prewarmed ${tuiType} workspace mismatch, spawning fresh`);
        this.kill(warm.id);
        this.warmTUIPool.delete(tuiType);
      }
    }

    // Spawn fresh
    const id = spawnFn();

    // Start warming replacement
    setTimeout(() => this.prewarmTUI(tuiType, workspace), 500);

    return id;
  }

  /**
   * Prewarm all commonly used TUIs for a workspace.
   * Called on app startup after workspace is determined.
   */
  prewarmAllTUIs(workspace?: string): void {
    this.log('INFO', 'Prewarming all TUIs', { workspace });

    // Stagger the prewarming to avoid spike
    PTYManager.PREWARMABLE_TUIS.forEach((tuiType, index) => {
      setTimeout(() => this.prewarmTUI(tuiType, workspace), index * 200);
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
   * Spawn a generic TUI application.
   * Runs through interactive login shell to ensure PATH is properly set from .bashrc
   */
  spawnTUI(
    command: string,
    args: string[] = [],
    cwd?: string,
    name?: string,
    envOverrides?: Record<string, string>
  ): number {
    const resolvedCmd = this.resolveTool(command);

    // Build environment variable prefix for any overrides
    const envPrefix = envOverrides
      ? Object.entries(envOverrides)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ') + ' '
      : '';

    // Build the full command string
    const fullCommand = args.length > 0
      ? `${envPrefix}${resolvedCmd} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`
      : `${envPrefix}${resolvedCmd}`;

    // Spawn through interactive login shell so PATH is set from .bashrc
    // -i = interactive (sources .bashrc), -l = login (sources .bash_profile)
    // -c = run command
    const shell = this.workspaceConfig?.terminal?.shell || this.shell;
    return this.spawn(shell, ['-il', '-c', fullCommand], cwd, name || command, false);
  }

  /**
   * Default TUI definitions - used when no config is provided.
   * Users can override these in .lee/config.yaml under the `tuis:` section.
   */
  private static readonly DEFAULT_TUIS: Record<string, TUIDefinition> = {
    git: {
      command: 'lazygit',
      name: 'Git (lazygit)',
      icon: '🌿',
      shortcut: '⇧⌘G',
      cwd_aware: true,
      path_arg: '-p',  // lazygit uses -p/--path
    },
    docker: {
      command: 'lazydocker',
      name: 'Docker (lazydocker)',
      icon: '🐳',
      shortcut: '⇧⌘D',
      path_arg: 'cwd',  // lazydocker uses working directory
    },
    k8s: {
      command: 'k9s',
      name: 'Kubernetes (k9s)',
      icon: '☸️',
      shortcut: '⇧⌘K',
      path_arg: 'cwd',  // k9s uses working directory
    },
    flutter: {
      command: 'flx',
      name: 'Flutter (flx)',
      icon: '📱',
      shortcut: '⇧⌘F',
      cwd_from_config: 'flutter.path',
      cwd_aware: true,
      path_arg: 'cwd',
    },
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
    'hester-qa': {
      command: 'hester',
      name: 'Hester QA',
      icon: '🧪',
      shortcut: '⇧⌘Q',
      args: ['qa', 'scene', 'welcome', '--tui'],
      cwd_aware: true,
      path_arg: '--dir',
    },
    system: {
      command: 'btop',
      name: 'System Monitor (btop)',
      icon: '📊',
      shortcut: '⇧⌘M',
      path_arg: 'cwd',
    },
    sql: {
      command: 'pgcli',
      name: 'SQL (pgcli)',
      icon: '🗄️',
      shortcut: '⇧⌘P',
      path_arg: 'cwd',
    },
  };

  /**
   * Get a TUI definition by key, checking config first then falling back to defaults.
   */
  getTUIDefinition(tuiType: string): TUIDefinition | null {
    // Check workspace config first
    const configTui = this.workspaceConfig?.tuis?.[tuiType];
    if (configTui) {
      return configTui;
    }

    // Fall back to defaults
    const defaultTui = PTYManager.DEFAULT_TUIS[tuiType];
    if (defaultTui) {
      return defaultTui;
    }

    return null;
  }

  /**
   * Get all available TUI types (from config + defaults).
   */
  getAvailableTUITypes(): string[] {
    const types = new Set<string>(Object.keys(PTYManager.DEFAULT_TUIS));

    // Add any custom TUIs from config
    if (this.workspaceConfig?.tuis) {
      for (const key of Object.keys(this.workspaceConfig.tuis)) {
        types.add(key);
      }
    }

    return Array.from(types);
  }

  /**
   * Get available TUIs with full metadata for dropdown rendering.
   * If workspace config has a non-empty `tuis` section, returns only those.
   * Otherwise falls back to all DEFAULT_TUIS.
   */
  getAvailableTUIsWithMeta(): Array<{ key: string; name: string; icon: string; shortcut?: string }> {
    const configTuis = this.workspaceConfig?.tuis;
    const hasConfigTuis = configTuis && Object.keys(configTuis).length > 0;

    if (hasConfigTuis) {
      // Config-driven: only show what's configured
      return Object.entries(configTuis!).map(([key, def]) => {
        // Merge with defaults for icon/shortcut fallback
        const defaultDef = PTYManager.DEFAULT_TUIS[key];
        return {
          key,
          name: def.name || defaultDef?.name || key,
          icon: def.icon || defaultDef?.icon || '🔧',
          shortcut: def.shortcut || defaultDef?.shortcut,
        };
      });
    }

    // Fallback: show all defaults
    return Object.entries(PTYManager.DEFAULT_TUIS).map(([key, def]) => ({
      key,
      name: def.name || key,
      icon: def.icon || '🔧',
      shortcut: def.shortcut,
    }));
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
    }
  ): number {
    const def = this.getTUIDefinition(tuiType);

    if (!def) {
      throw new Error(`Unknown TUI type: ${tuiType}`);
    }

    // Build args - start with definition args
    const args = [...(def.args || [])];

    // Determine working directory
    let workingDir = cwd;

    if (def.cwd_from_config) {
      // Resolve cwd from config path (e.g., 'flutter.path')
      const parts = def.cwd_from_config.split('.');
      let configValue: any = this.workspaceConfig;
      for (const part of parts) {
        configValue = configValue?.[part];
      }
      if (typeof configValue === 'string') {
        // Resolve relative to workspace
        workingDir = path.isAbsolute(configValue)
          ? configValue
          : path.join(this.currentWorkspace || process.cwd(), configValue);
      }
    }

    if (!workingDir && def.cwd_aware) {
      workingDir = this.currentWorkspace || undefined;
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

    return this.spawnTUI(def.command, args, workingDir, def.name, def.env);
  }

  /**
   * Spawn a TUI that has connection config (e.g., pgcli for SQL).
   * Builds connection string from the TUI definition's connection property.
   *
   * @param tuiType - The TUI type key (e.g., 'sql-local', 'sql-prod')
   * @param def - The TUI definition with connection config
   * @param cwd - Working directory
   */
  spawnConnectionTUI(tuiType: string, def: TUIDefinition, cwd?: string): number {
    if (!def.connection) {
      throw new Error(`TUI ${tuiType} does not have connection config`);
    }

    const conn = def.connection;
    const args: string[] = [...(def.args || [])];

    // Build connection string: postgresql://user:password@host:port/database
    const port = conn.port || 5432;
    const password = conn.password ? `:${conn.password}` : '';
    const sslMode = conn.ssl ? '?sslmode=require' : '';
    const connStr = `postgresql://${conn.user}${password}@${conn.host}:${port}/${conn.database}${sslMode}`;
    args.push(connStr);

    this.log('INFO', `Spawning ${def.command} with connection`, {
      tuiType,
      host: conn.host,
      database: conn.database,
      user: conn.user,
    });

    return this.spawnTUI(def.command, args, cwd, def.name, def.env);
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

    return logPath;
  }

  /**
   * Log a message to ~/.lee/logs/lee.log (main process events).
   */
  private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, any>): void {
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
