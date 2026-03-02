/**
 * API Server - Express server on port 9001 for external tool communication.
 *
 * Allows Hester and other tools to control Lee via HTTP.
 */

import express, { Request, Response, Application } from 'express';
import { Server, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Socket } from 'net';
import { PTYManager, LeeState } from './pty-manager';
import { ContextBridge } from './context-bridge';
import { BrowserManager } from './browser-manager';
import { windowRegistry, WindowState } from './window-registry';
import { LeeContext } from '../shared/context';

export interface APIServerConfig {
  port: number;
  ptyManager: PTYManager;
  browserManager?: BrowserManager;
  /** @deprecated Use windowRegistry instead */
  contextBridge?: ContextBridge;
  /** @deprecated Use windowRegistry instead */
  getMainWindow?: () => Electron.BrowserWindow | null;
  windowRegistry?: typeof windowRegistry;
}

/**
 * API server for external tool communication.
 */
export class APIServer {
  private app: Application;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private ptyWss: WebSocketServer | null = null;
  private wsClients: Set<WebSocket> = new Set();
  private ptyClients: Map<number, Set<WebSocket>> = new Map();
  private ptyBuffers: Map<number, string[]> = new Map(); // Ring buffer per PTY
  private static PTY_BUFFER_MAX = 200; // Max chunks to keep (lighter for mobile replay)
  private browserCastWss: WebSocketServer | null = null;
  private browserCastClients: Map<number, Set<WebSocket>> = new Map(); // tabId -> clients
  private ptyManager: PTYManager;
  private browserManager?: BrowserManager;
  private port: number;
  private leeState: LeeState = {};

  constructor(config: APIServerConfig) {
    this.ptyManager = config.ptyManager;
    this.browserManager = config.browserManager;
    this.port = config.port;

    this.app = express();
    this.app.use(express.json());

    // CORS - allow Aeronaut (Flutter web) and other local tools
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (_req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // Track Lee state
    this.ptyManager.on('state', (_id: number, state: LeeState) => {
      this.leeState = { ...this.leeState, ...state };
    });

    this.setupRoutes();
  }

  /**
   * Get the window for a command. If params has window_id, use that;
   * otherwise use the focused window or any available window.
   */
  private getWindowForCommand(params?: Record<string, unknown>): WindowState | undefined {
    if (params?.window_id) {
      return windowRegistry.get(params.window_id as number);
    }
    return windowRegistry.getFocused() || windowRegistry.getAny();
  }

  /**
   * Send a command to the EditorPanel via IPC.
   * The EditorPanel listens for these commands in the renderer process.
   */
  private sendEditorPanelCommand(
    action: 'open' | 'save' | 'close',
    params?: Record<string, unknown>
  ): { success: boolean; error?: string } {
    const ws = this.getWindowForCommand(params);
    const mainWindow = ws?.browserWindow || null;
    if (!mainWindow) {
      return { success: false, error: 'No window available' };
    }

    try {
      switch (action) {
        case 'open':
          if (params?.file) {
            mainWindow.webContents.send('editor:open', params.file);
          }
          break;
        case 'save':
          mainWindow.webContents.send('editor:save');
          break;
        case 'close':
          mainWindow.webContents.send('editor:close');
          break;
      }
      return { success: true };
    } catch (error) {
      console.error(`Failed to send command to EditorPanel: ${error}`);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Start the API server and WebSocket server.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          console.log(`Lee API server listening on port ${this.port}`);

          // Create all WebSocket servers in noServer mode
          this.wss = new WebSocketServer({ noServer: true });
          this.ptyWss = new WebSocketServer({ noServer: true });
          this.browserCastWss = new WebSocketServer({ noServer: true });

          // Manual upgrade routing
          this.server!.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
            const url = new URL(request.url || '', `http://localhost:${this.port}`);
            const pathname = url.pathname;

            if (pathname === '/context/stream') {
              this.wss!.handleUpgrade(request, socket, head, (ws) => {
                this.wss!.emit('connection', ws, request);
              });
            } else {
              // Match /pty/:id/stream
              const ptyMatch = pathname.match(/^\/pty\/(\d+)\/stream$/);
              if (ptyMatch) {
                const ptyId = parseInt(ptyMatch[1], 10);
                (request as any)._ptyId = ptyId;
                this.ptyWss!.handleUpgrade(request, socket, head, (ws) => {
                  this.ptyWss!.emit('connection', ws, request);
                });
                return;
              }

              // Match /browser/:tabId/cast
              const browserCastMatch = pathname.match(/^\/browser\/(\d+)\/cast$/);
              if (browserCastMatch) {
                const tabId = parseInt(browserCastMatch[1], 10);
                (request as any)._browserTabId = tabId;
                this.browserCastWss!.handleUpgrade(request, socket, head, (ws) => {
                  this.browserCastWss!.emit('connection', ws, request);
                });
                return;
              }

              socket.destroy();
            }
          });

          // Context stream WebSocket handler
          this.wss.on('connection', (ws: WebSocket) => {
            console.log('WebSocket client connected to /context/stream');
            this.wsClients.add(ws);

            // Send current context from focused (or first) window immediately on connect
            const focusedWs = windowRegistry.getFocused() || windowRegistry.getAny();
            if (focusedWs) {
              const ctx = focusedWs.contextBridge.getContext();
              ws.send(JSON.stringify({ type: 'context_update', data: ctx }));
            }

            ws.on('close', () => {
              console.log('WebSocket client disconnected');
              this.wsClients.delete(ws);
            });

            ws.on('error', (err: Error) => {
              console.error('WebSocket client error:', err);
              this.wsClients.delete(ws);
            });
          });

          // PTY stream WebSocket handler
          this.ptyWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            const ptyId = (request as any)._ptyId as number;
            console.log(`WebSocket client connected to /pty/${ptyId}/stream`);

            // Track client
            if (!this.ptyClients.has(ptyId)) {
              this.ptyClients.set(ptyId, new Set());
            }
            this.ptyClients.get(ptyId)!.add(ws);

            // Notify renderer that this PTY is being cast (send to owning window)
            const ptyWindowId = this.ptyManager.getWindowForPty(ptyId);
            const ptyWinState = ptyWindowId != null ? windowRegistry.get(ptyWindowId) : windowRegistry.getAny();
            if (ptyWinState) {
              ptyWinState.browserWindow.webContents.send('cast:active', { ptyId });
            }

            // Replay buffered PTY output so Aeronaut sees history
            const buffer = this.ptyBuffers.get(ptyId);
            if (buffer && buffer.length > 0) {
              const replay = buffer.join('');
              ws.send(JSON.stringify({ type: 'data', data: replay }));
            }

            // Forward PTY data to this client
            const onData = (_id: number, data: string) => {
              if (_id === ptyId && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'data', data }));
              }
            };

            const onExit = (_id: number, code: number) => {
              if (_id === ptyId && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', code }));
              }
            };

            this.ptyManager.on('data', onData);
            this.ptyManager.on('exit', onExit);

            // Forward client input to PTY (supports raw text or JSON commands)
            ws.on('message', (msg) => {
              const text = typeof msg === 'string' ? msg : msg.toString();
              // Try to parse as JSON command (e.g. resize)
              try {
                const parsed = JSON.parse(text);
                if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
                  this.ptyManager.resize(ptyId, parsed.cols, parsed.rows);
                  return;
                }
              } catch {
                // Not JSON — treat as raw PTY input
              }
              this.ptyManager.write(ptyId, text);
            });

            // Cleanup on close/error
            const cleanup = () => {
              this.ptyManager.removeListener('data', onData);
              this.ptyManager.removeListener('exit', onExit);
              const clients = this.ptyClients.get(ptyId);
              if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                  this.ptyClients.delete(ptyId);
                  // No more cast clients — notify renderer
                  const cleanupPtyWindowId = this.ptyManager.getWindowForPty(ptyId);
                  const cleanupPtyWin = cleanupPtyWindowId != null ? windowRegistry.get(cleanupPtyWindowId) : windowRegistry.getAny();
                  if (cleanupPtyWin) {
                    cleanupPtyWin.browserWindow.webContents.send('cast:inactive', { ptyId });
                  }
                }
              }
            };

            ws.on('close', () => {
              console.log(`PTY ${ptyId} WebSocket client disconnected`);
              cleanup();
            });

            ws.on('error', (err: Error) => {
              console.error(`PTY ${ptyId} WebSocket client error:`, err);
              cleanup();
            });
          });

          // Browser cast WebSocket handler
          this.browserCastWss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
            const tabId = (request as any)._browserTabId as number;
            console.log(`[BrowserCast] Client connected for tab ${tabId}`);

            // Validate browserManager exists and tab is registered
            if (!this.browserManager) {
              ws.send(JSON.stringify({ type: 'error', message: 'Browser manager not available' }));
              ws.close();
              return;
            }

            const browserState = this.browserManager.getByTabId(tabId);
            if (!browserState) {
              ws.send(JSON.stringify({ type: 'error', message: `Browser tab ${tabId} not found` }));
              ws.close();
              return;
            }

            // Track client
            if (!this.browserCastClients.has(tabId)) {
              this.browserCastClients.set(tabId, new Set());
            }
            this.browserCastClients.get(tabId)!.add(ws);

            // Notify renderer that this tab is being cast
            const castWinState = windowRegistry.getFocused() || windowRegistry.getAny();
            if (castWinState) {
              castWinState.browserWindow.webContents.send('cast:active', { tabId });
            }

            // Get the webContentsId and actual webContents from Electron
            const webContentsId = this.browserManager.getWebContentsId(tabId);
            const { webContents: wcModule } = require('electron');
            const wc = webContentsId !== undefined ? wcModule.fromId(webContentsId) : null;

            // Set up CDP debugger 'message' listener for screencast frames
            let screencastListener: ((event: any, method: string, params: any) => void) | null = null;
            let viewportWidth = 390;
            let viewportHeight = 844;
            let logicalViewportWidth = 390;
            let logicalViewportHeight = 844;

            if (wc) {
              screencastListener = (_event: any, method: string, params: any) => {
                if (method === 'Page.screencastFrame' && ws.readyState === WebSocket.OPEN) {
                  // Send frame data as binary
                  const frameBuffer = Buffer.from(params.data, 'base64');
                  ws.send(frameBuffer);

                  // Track viewport dimensions from frame metadata
                  const meta = params.metadata;
                  if (meta) {
                    viewportWidth = meta.deviceWidth || viewportWidth;
                    viewportHeight = meta.deviceHeight || viewportHeight;
                  }

                  // Send metadata as JSON (Aeronaut expects type: 'metadata')
                  ws.send(JSON.stringify({
                    type: 'metadata',
                    viewportWidth,
                    viewportHeight,
                    url: browserState.url,
                    title: browserState.title,
                  }));

                  // Ack the frame so CDP sends the next one
                  this.browserManager!.ackScreencastFrame(tabId, params.sessionId);
                }
              };

              wc.debugger.on('message', screencastListener);
            }

            // Handle incoming messages from Aeronaut
            ws.on('message', async (msg) => {
              try {
                const text = typeof msg === 'string' ? msg : msg.toString();
                const parsed = JSON.parse(text);

                switch (parsed.type) {
                  case 'init':
                  case 'resize': {
                    const logicalWidth = parsed.width || 390;
                    const logicalHeight = parsed.height || 844;
                    const pixelRatio = parsed.pixelRatio || 2;
                    const pixelWidth = Math.round(logicalWidth * pixelRatio);
                    const pixelHeight = Math.round(logicalHeight * pixelRatio);

                    // Track logical dimensions for coordinate mapping
                    logicalViewportWidth = Math.round(logicalWidth);
                    logicalViewportHeight = Math.round(logicalHeight);

                    // Set CSS viewport to match mobile device dimensions
                    await this.browserManager!.setDeviceMetrics(tabId, {
                      width: logicalViewportWidth,
                      height: logicalViewportHeight,
                      deviceScaleFactor: pixelRatio,
                      mobile: true,
                    });

                    // Resize the webview container in the renderer to match
                    const resizeWinState = windowRegistry.getFocused() || windowRegistry.getAny();
                    if (resizeWinState) {
                      resizeWinState.browserWindow.webContents.send('browser:cast-resize', tabId, logicalViewportWidth, logicalViewportHeight);
                    }

                    await this.browserManager!.startScreencast(tabId, {
                      maxWidth: pixelWidth,
                      maxHeight: pixelHeight,
                      quality: parsed.quality ?? 80,
                    });
                    break;
                  }

                  case 'tap': {
                    // Convert normalized (0-1) coords to CSS pixel coords
                    const tapX = parsed.x * logicalViewportWidth;
                    const tapY = parsed.y * logicalViewportHeight;
                    // Move first so the browser registers the hover target
                    await this.browserManager!.dispatchMouseEvent(tabId, 'mouseMoved', tapX, tapY);
                    await this.browserManager!.dispatchMouseEvent(tabId, 'mousePressed', tapX, tapY, {
                      button: 'left',
                      clickCount: 1,
                    });
                    await this.browserManager!.dispatchMouseEvent(tabId, 'mouseReleased', tapX, tapY, {
                      button: 'left',
                      clickCount: 1,
                    });
                    break;
                  }

                  case 'scroll': {
                    const scrollX = parsed.x * logicalViewportWidth;
                    const scrollY = parsed.y * logicalViewportHeight;
                    await this.browserManager!.dispatchMouseEvent(tabId, 'mouseWheel', scrollX, scrollY, {
                      deltaX: parsed.deltaX || 0,
                      deltaY: parsed.deltaY || 0,
                    });
                    break;
                  }

                  case 'key': {
                    if (parsed.text) {
                      // Text input — send as char event
                      await this.browserManager!.dispatchKeyEvent(tabId, 'char', {
                        text: parsed.text,
                      });
                    } else if (parsed.key) {
                      // Key press — send keyDown + keyUp
                      await this.browserManager!.dispatchKeyEvent(tabId, 'keyDown', {
                        key: parsed.key,
                        code: parsed.code,
                      });
                      await this.browserManager!.dispatchKeyEvent(tabId, 'keyUp', {
                        key: parsed.key,
                        code: parsed.code,
                      });
                    }
                    break;
                  }

                  case 'navigate': {
                    const navWinState = windowRegistry.getFocused() || windowRegistry.getAny();
                    if (navWinState && parsed.url) {
                      navWinState.browserWindow.webContents.send('browser:navigate', tabId, parsed.url);
                    }
                    break;
                  }
                }
              } catch (err) {
                console.error(`[BrowserCast] Failed to parse message for tab ${tabId}:`, err);
              }
            });

            // Cleanup on disconnect
            const castCleanup = async () => {
              console.log(`[BrowserCast] Client disconnected for tab ${tabId}`);

              // Stop screencast and restore desktop viewport
              if (this.browserManager) {
                await this.browserManager.stopScreencast(tabId).catch(() => {});
                await this.browserManager.clearDeviceMetrics(tabId).catch(() => {});
              }

              // Restore the webview container size in the renderer
              const restoreWinState = windowRegistry.getFocused() || windowRegistry.getAny();
              if (restoreWinState) {
                restoreWinState.browserWindow.webContents.send('browser:cast-restore', tabId);
              }

              // Remove CDP debugger listener
              if (wc && screencastListener) {
                try {
                  wc.debugger.removeListener('message', screencastListener);
                } catch {
                  // webContents may already be destroyed
                }
              }

              // Remove from browserCastClients
              const clients = this.browserCastClients.get(tabId);
              if (clients) {
                clients.delete(ws);
                if (clients.size === 0) {
                  this.browserCastClients.delete(tabId);
                  // No more cast clients — notify renderer
                  const cleanupCastWin = windowRegistry.getFocused() || windowRegistry.getAny();
                  if (cleanupCastWin) {
                    cleanupCastWin.browserWindow.webContents.send('cast:inactive', { tabId });
                  }
                }
              }
            };

            ws.on('close', () => castCleanup());
            ws.on('error', (err: Error) => {
              console.error(`[BrowserCast] WebSocket error for tab ${tabId}:`, err);
              castCleanup();
            });
          });

          // Context broadcasting is now handled per-window:
          // Each window's ContextBridge calls apiServer.broadcastContext(windowId, ctx)
          // via the wiring in createWindow()

          // Buffer PTY output for replay when Aeronaut connects
          this.ptyManager.on('data', (id: number, data: string) => {
            if (!this.ptyBuffers.has(id)) {
              this.ptyBuffers.set(id, []);
            }
            const buffer = this.ptyBuffers.get(id)!;
            buffer.push(data);
            if (buffer.length > APIServer.PTY_BUFFER_MAX) {
              buffer.shift();
            }
          });

          // Clean up buffer when PTY exits
          this.ptyManager.on('exit', (id: number) => {
            this.ptyBuffers.delete(id);
          });

          console.log(`WebSocket server listening on ws://localhost:${this.port}/context/stream`);
          console.log(`PTY WebSocket server listening on ws://localhost:${this.port}/pty/:id/stream`);
          console.log(`Browser cast WebSocket server listening on ws://localhost:${this.port}/browser/:tabId/cast`);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Broadcast context update to all connected WebSocket clients.
   * Includes window_id so Hester can distinguish contexts from different windows.
   */
  broadcastContext(windowId: number, ctx: LeeContext): void {
    const message = JSON.stringify({ type: 'context_update', window_id: windowId, data: ctx });
    this.wsClients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  /**
   * Stop the API server and WebSocket server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all context WebSocket connections
      this.wsClients.forEach((ws) => {
        ws.close();
      });
      this.wsClients.clear();

      // Close all PTY WebSocket connections
      this.ptyClients.forEach((clients) => {
        clients.forEach((ws) => ws.close());
      });
      this.ptyClients.clear();

      // Close all browser cast WebSocket connections
      this.browserCastClients.forEach((clients) => {
        clients.forEach((ws) => ws.close());
      });
      this.browserCastClients.clear();

      // Close WebSocket servers
      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }
      if (this.ptyWss) {
        this.ptyWss.close();
        this.ptyWss = null;
      }
      if (this.browserCastWss) {
        this.browserCastWss.close();
        this.browserCastWss = null;
      }

      // Close HTTP server
      if (this.server) {
        this.server.close(() => {
          console.log('Lee API server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Setup API routes.
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        success: true,
        data: {
          status: 'healthy',
          version: '0.1.0',
          platform: 'electron',
        },
      });
    });

    // Get Lee context (full state from ContextBridge)
    // Optionally accepts ?window_id=N to target a specific window
    this.app.get('/context', (req: Request, res: Response) => {
      const windowIdParam = req.query.window_id ? parseInt(req.query.window_id as string, 10) : undefined;
      const ws = windowIdParam != null
        ? windowRegistry.get(windowIdParam)
        : (windowRegistry.getFocused() || windowRegistry.getAny());

      if (!ws) {
        res.status(503).json({ success: false, error: 'No window available' });
        return;
      }

      res.json({
        success: true,
        data: ws.contextBridge.getContext(),
      });
    });

    // ============================================
    // Unified Command API
    // ============================================

    // POST /command - Single endpoint for all actions
    this.app.post('/command', async (req: Request, res: Response) => {
      const { domain, action, params = {} } = req.body;

      if (!domain || !action) {
        res.status(400).json({
          success: false,
          error: 'Missing domain or action parameter',
        });
        return;
      }

      try {
        switch (domain) {
          case 'system':
            return this.handleSystemCommand(action, params, res);
          case 'editor':
            return await this.handleEditorCommand(action, params, res);
          case 'tui':
            return this.handleTuiCommand(action, params, res);
          case 'panel':
            return this.handlePanelCommand(action, params, res);
          case 'status':
            return this.handleStatusCommand(action, params, res);
          case 'browser':
            return await this.handleBrowserCommand(action, params, res);
          default:
            res.status(400).json({
              success: false,
              error: `Unknown domain: ${domain}. Use: system, editor, tui, panel, status, browser`,
            });
        }
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // ============================================
    // Process Management (utility endpoints)
    // ============================================

    // List active PTY processes
    this.app.get('/processes', (_req: Request, res: Response) => {
      const processes = this.ptyManager.getAll().map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
      }));

      res.json({
        success: true,
        data: processes,
      });
    });

    // Kill a PTY process
    this.app.delete('/process/:id', (req: Request, res: Response) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({
          success: false,
          error: 'Invalid process ID',
        });
        return;
      }

      this.ptyManager.kill(id);
      res.json({
        success: true,
        data: { killed: id },
      });
    });

  }

  // ============================================
  // Command Handlers for Unified API
  // ============================================

  /**
   * Handle system commands (tab management, focus).
   * These are sent to the renderer via IPC.
   */
  private handleSystemCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): void {
    const ws = this.getWindowForCommand(params);
    const mainWindow = ws?.browserWindow || null;
    if (!mainWindow) {
      res.status(503).json({
        success: false,
        error: 'No window available',
      });
      return;
    }

    switch (action) {
      case 'focus_tab':
        if (!params.tab_id) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        mainWindow.webContents.send('system:focus-tab', params.tab_id);
        res.json({ success: true, data: { action: 'focus_tab', tab_id: params.tab_id } });
        break;

      case 'close_tab':
        if (!params.tab_id) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        mainWindow.webContents.send('system:close-tab', params.tab_id);
        res.json({ success: true, data: { action: 'close_tab', tab_id: params.tab_id } });
        break;

      case 'create_tab':
        mainWindow.webContents.send('system:create-tab', {
          type: params.type || 'terminal',
          label: params.label,
          cwd: params.cwd,
        });
        res.json({ success: true, data: { action: 'create_tab', type: params.type || 'terminal' } });
        break;

      case 'focus_window':
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        res.json({ success: true, data: { action: 'focus_window' } });
        break;

      case 'minimize_window':
        mainWindow.minimize();
        res.json({ success: true, data: { action: 'minimize_window' } });
        break;

      case 'maximize_window':
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
        res.json({ success: true, data: { action: 'maximize_window' } });
        break;

      default:
        res.status(400).json({
          success: false,
          error: `Unknown system action: ${action}. Use: focus_tab, close_tab, create_tab, focus_window, minimize_window, maximize_window`,
        });
    }
  }

  /**
   * Handle editor commands (file operations via EditorPanel IPC).
   */
  private async handleEditorCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): Promise<void> {
    switch (action) {
      case 'open':
      case 'open_file':
        if (!params.file) {
          res.status(400).json({ success: false, error: 'Missing file parameter' });
          return;
        }
        // Use new IPC-based EditorPanel
        const openResult = this.sendEditorPanelCommand('open', { file: params.file });
        if (openResult.success) {
          res.json({ success: true, data: { action: 'open', file: params.file } });
        } else {
          res.status(503).json(openResult);
        }
        break;

      case 'save':
        const saveResult = this.sendEditorPanelCommand('save');
        if (saveResult.success) {
          res.json({ success: true, data: { action: 'save' } });
        } else {
          res.status(503).json(saveResult);
        }
        break;

      case 'save_as':
        // save_as not yet supported in new editor, return error
        res.status(501).json({
          success: false,
          error: 'save_as not yet implemented in CodeMirror editor',
        });
        break;

      case 'close':
        const closeResult = this.sendEditorPanelCommand('close');
        if (closeResult.success) {
          res.json({ success: true, data: { action: 'close' } });
        } else {
          res.status(503).json(closeResult);
        }
        break;

      case 'status':
        // EditorPanel doesn't have a separate daemon - just report context
        const statusWs = this.getWindowForCommand(params);
        const context = statusWs?.contextBridge.getContext();
        res.json({
          success: true,
          data: {
            connected: true,
            type: 'editor-panel',
            editor: context?.editor || null,
          },
        });
        break;

      default:
        res.status(400).json({
          success: false,
          error: `Unknown editor action: ${action}. Use: open, save, save_as, close, status`,
        });
    }
  }

  /**
   * Handle TUI commands (spawn TUI applications).
   */
  private handleTuiCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): void {
    const cwd = params.cwd as string | undefined;
    const label = params.label as string | undefined;

    // Map aliases to canonical names
    const tuiTypeMap: Record<string, string> = {
      'shell': 'terminal',
      'lee': 'editor-panel',
      'lazygit': 'git',
      'lazydocker': 'docker',
      'k9s': 'k8s',
      'kubernetes': 'k8s',
      'flx': 'flutter',
      'btop': 'system',
    };
    const tuiType = tuiTypeMap[action] || action;

    // Custom TUI requires a command parameter
    if (tuiType === 'custom') {
      const command = params.command as string | undefined;
      if (!command) {
        res.status(400).json({ success: false, error: 'Custom TUI requires command parameter' });
        return;
      }
      // Custom commands can't use renderer's createTab — spawn directly
      try {
        const ptyId = this.ptyManager.spawnTUI(command, [], cwd, label);
        res.json({ success: true, data: { pty_id: ptyId, action: 'custom' } });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      return;
    }

    // Delegate to renderer — it handles PTY spawning, prewarming, and tab creation
    const tuiWs = this.getWindowForCommand(params);
    const mainWindow = tuiWs?.browserWindow || null;
    if (!mainWindow) {
      res.status(503).json({ success: false, error: 'No window available' });
      return;
    }

    mainWindow.webContents.send('system:create-tab', {
      type: tuiType,
      label,
      cwd,
    });
    res.json({ success: true, data: { action: tuiType } });
  }

  /**
   * Handle panel commands (visibility, resize).
   */
  private handlePanelCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): void {
    const panelWs = this.getWindowForCommand(params);
    const mainWindow = panelWs?.browserWindow || null;
    if (!mainWindow) {
      res.status(503).json({
        success: false,
        error: 'No window available',
      });
      return;
    }

    switch (action) {
      case 'toggle':
        if (!params.panel) {
          res.status(400).json({ success: false, error: 'Missing panel parameter' });
          return;
        }
        mainWindow.webContents.send('panel:toggle', params.panel);
        res.json({ success: true, data: { action: 'toggle', panel: params.panel } });
        break;

      case 'show':
        if (!params.panel) {
          res.status(400).json({ success: false, error: 'Missing panel parameter' });
          return;
        }
        mainWindow.webContents.send('panel:show', params.panel);
        res.json({ success: true, data: { action: 'show', panel: params.panel } });
        break;

      case 'hide':
        if (!params.panel) {
          res.status(400).json({ success: false, error: 'Missing panel parameter' });
          return;
        }
        mainWindow.webContents.send('panel:hide', params.panel);
        res.json({ success: true, data: { action: 'hide', panel: params.panel } });
        break;

      case 'resize':
        if (!params.panel || params.size === undefined) {
          res.status(400).json({ success: false, error: 'Missing panel or size parameter' });
          return;
        }
        mainWindow.webContents.send('panel:resize', params.panel, params.size);
        res.json({ success: true, data: { action: 'resize', panel: params.panel, size: params.size } });
        break;

      case 'focus':
        if (!params.panel) {
          res.status(400).json({ success: false, error: 'Missing panel parameter' });
          return;
        }
        mainWindow.webContents.send('panel:focus', params.panel);
        res.json({ success: true, data: { action: 'focus', panel: params.panel } });
        break;

      default:
        res.status(400).json({
          success: false,
          error: `Unknown panel action: ${action}. Use: toggle, show, hide, resize, focus`,
        });
    }
  }

  /**
   * Handle status commands (Hester message queue for status bar).
   */
  private handleStatusCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): void {
    const statusWinState = this.getWindowForCommand(params);
    const mainWindow = statusWinState?.browserWindow || null;
    if (!mainWindow) {
      res.status(503).json({
        success: false,
        error: 'No window available',
      });
      return;
    }

    switch (action) {
      case 'push':
        // Push a new message to the status queue
        if (!params.message) {
          res.status(400).json({ success: false, error: 'Missing message parameter' });
          return;
        }
        const messageId = params.id || `msg-${Date.now()}`;
        mainWindow.webContents.send('status:push', {
          id: messageId,
          message: params.message,
          type: params.type || 'hint',
          prompt: params.prompt,
          ttl: params.ttl,
        });
        res.json({ success: true, data: { action: 'push', id: messageId } });
        break;

      case 'clear':
        // Clear a specific message by ID
        if (!params.id) {
          res.status(400).json({ success: false, error: 'Missing id parameter' });
          return;
        }
        mainWindow.webContents.send('status:clear', params.id);
        res.json({ success: true, data: { action: 'clear', id: params.id } });
        break;

      case 'clear_all':
        // Clear all messages
        mainWindow.webContents.send('status:clear-all');
        res.json({ success: true, data: { action: 'clear_all' } });
        break;

      default:
        res.status(400).json({
          success: false,
          error: `Unknown status action: ${action}. Use: push, clear, clear_all`,
        });
    }
  }

  /**
   * Handle browser commands (navigation, screenshot, DOM, click, type, fill_form).
   */
  private async handleBrowserCommand(
    action: string,
    params: Record<string, unknown>,
    res: Response
  ): Promise<void> {
    if (!this.browserManager) {
      res.status(503).json({
        success: false,
        error: 'Browser manager not available',
      });
      return;
    }

    const tabId = params.tab_id as number | undefined;

    switch (action) {
      case 'navigate':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        if (!params.url) {
          res.status(400).json({ success: false, error: 'Missing url parameter' });
          return;
        }
        // Request navigation with approval check (Hester must get approval)
        const navResult = await this.browserManager.requestNavigation(
          tabId,
          params.url as string,
          true // requireApproval for Hester
        );
        if (navResult.approved) {
          // If immediately approved, tell renderer to navigate
          const navWin = this.getWindowForCommand(params)?.browserWindow;
          if (navWin) {
            navWin.webContents.send('browser:navigate', tabId, params.url);
          }
          res.json({ success: true, data: { action: 'navigate', url: params.url, approved: true } });
        } else {
          // Pending user approval
          res.json({
            success: true,
            data: {
              action: 'navigate',
              url: params.url,
              approved: false,
              requestId: navResult.requestId,
              message: 'Navigation pending user approval',
            },
          });
        }
        break;

      case 'screenshot':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        const screenshotResult = await this.browserManager.screenshot(tabId);
        res.json(screenshotResult);
        break;

      case 'dom':
      case 'snapshot':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        const domResult = await this.browserManager.getDOM(tabId);
        res.json(domResult);
        break;

      case 'click':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        if (!params.selector) {
          res.status(400).json({ success: false, error: 'Missing selector parameter' });
          return;
        }
        const clickResult = await this.browserManager.click(tabId, params.selector as string);
        res.json(clickResult);
        break;

      case 'type':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        if (!params.selector) {
          res.status(400).json({ success: false, error: 'Missing selector parameter' });
          return;
        }
        if (typeof params.text !== 'string') {
          res.status(400).json({ success: false, error: 'Missing text parameter' });
          return;
        }
        const typeResult = await this.browserManager.type(
          tabId,
          params.selector as string,
          params.text as string
        );
        res.json(typeResult);
        break;

      case 'fill_form':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        if (!Array.isArray(params.fields)) {
          res.status(400).json({ success: false, error: 'Missing fields parameter (array)' });
          return;
        }
        const fillResult = await this.browserManager.fillForm(
          tabId,
          params.fields as Array<{ selector: string; value: string }>
        );
        res.json(fillResult);
        break;

      case 'list':
      case 'get_all':
        const browsers = this.browserManager.getAll();
        res.json({ success: true, data: browsers });
        break;

      case 'get':
        if (!tabId) {
          res.status(400).json({ success: false, error: 'Missing tab_id parameter' });
          return;
        }
        const browser = this.browserManager.getByTabId(tabId);
        if (browser) {
          res.json({ success: true, data: browser });
        } else {
          res.status(404).json({ success: false, error: 'Browser tab not found' });
        }
        break;

      default:
        res.status(400).json({
          success: false,
          error: `Unknown browser action: ${action}. Use: navigate, screenshot, dom, click, type, fill_form, list, get`,
        });
    }
  }
}
