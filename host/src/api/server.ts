/**
 * API Server - Express server on port 9001 for Hester communication.
 *
 * Provides endpoints for:
 * - System commands (create tabs, splits, focus)
 * - Editor commands (open file, goto line)
 * - Context retrieval (Lee state)
 */

import crypto from 'crypto';
import express, { Request, Response, NextFunction, Application } from 'express';
import { Server } from 'http';
import { MosaicApp } from '../App';
import { LeeState } from '../pty/manager';

export interface APIServerConfig {
  port: number;
  app: MosaicApp;
  hesterPort?: number;
}

export interface CommandPayload {
  type: 'system' | 'editor';
  action: string;
  [key: string]: unknown;
}

export interface APIResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * API server for Hester communication.
 */
export class APIServer {
  private app: Application;
  private server: Server | null = null;
  private mosaicApp: MosaicApp;
  private port: number;
  private hesterPort: number;
  private authToken: string;

  /** Get the auth token for passing to legitimate clients (e.g., Hester daemon). */
  getAuthToken(): string {
    return this.authToken;
  }

  constructor(config: APIServerConfig) {
    this.mosaicApp = config.app;
    this.port = config.port;
    this.hesterPort = config.hesterPort || 9000;
    this.authToken = crypto.randomUUID();

    this.app = express();
    this.app.use(express.json());

    // Auth middleware - require Bearer token on POST and DELETE routes
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' || req.method === 'OPTIONS') {
        next();
        return;
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${this.authToken}`) {
        res.status(401).json({ success: false, error: 'Unauthorized: invalid or missing token' });
        return;
      }
      next();
    });

    this.setupRoutes();
  }

  /**
   * Start the API server.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, () => {
          console.log(`Mosaic API server listening on port ${this.port}`);
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the API server.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('Mosaic API server stopped');
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
        },
      });
    });

    // Get Lee state (context)
    this.app.get('/context', (_req: Request, res: Response) => {
      const state = this.mosaicApp.getLeeState();
      res.json({
        success: true,
        data: state,
      });
    });

    // Execute command
    this.app.post('/command', (req: Request, res: Response) => {
      const payload = req.body as CommandPayload;

      if (!payload.type || !payload.action) {
        res.status(400).json({
          success: false,
          error: 'Missing type or action',
        });
        return;
      }

      try {
        const result = this.executeCommand(payload);
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // System commands
    this.app.post('/command/system', (req: Request, res: Response) => {
      const { action, ...params } = req.body;

      if (!action) {
        res.status(400).json({
          success: false,
          error: 'Missing action',
        });
        return;
      }

      try {
        const result = this.executeSystemCommand(action, params);
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Editor commands
    this.app.post('/command/editor', (req: Request, res: Response) => {
      const { action, ...params } = req.body;

      if (!action) {
        res.status(400).json({
          success: false,
          error: 'Missing action',
        });
        return;
      }

      try {
        this.mosaicApp.sendToLee(action, params);
        res.json({
          success: true,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // TUI commands - spawn external TUI applications (lazygit, lazydocker, k9s, flx)
    this.app.post('/command/tui', (req: Request, res: Response) => {
      const { tui, command, label } = req.body;

      if (!tui) {
        res.status(400).json({
          success: false,
          error: 'Missing tui parameter. Use: git, docker, k8s, flutter, or custom',
        });
        return;
      }

      try {
        let tabId: number | null = null;

        switch (tui) {
          case 'git':
          case 'lazygit':
            tabId = this.mosaicApp.createGitTab();
            break;
          case 'docker':
          case 'lazydocker':
            tabId = this.mosaicApp.createDockerTab();
            break;
          case 'k8s':
          case 'k9s':
          case 'kubernetes':
            tabId = this.mosaicApp.createK8sTab();
            break;
          case 'flutter':
          case 'flx':
            tabId = this.mosaicApp.createFlutterTab();
            break;
          case 'custom':
            if (!command) {
              res.status(400).json({
                success: false,
                error: 'Custom TUI requires command parameter',
              });
              return;
            }
            tabId = this.mosaicApp.createTUITab('custom', command, label);
            break;
          default:
            res.status(400).json({
              success: false,
              error: `Unknown TUI: ${tui}. Use: git, docker, k8s, flutter, or custom`,
            });
            return;
        }

        res.json({
          success: true,
          data: { tab_id: tabId },
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Send context to Hester
    this.app.post('/context/send', async (_req: Request, res: Response) => {
      try {
        const state = this.mosaicApp.getLeeState();
        const result = await this.sendToHester(state);
        res.json({
          success: true,
          data: result,
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });
  }

  /**
   * Execute a command.
   */
  private executeCommand(payload: CommandPayload): unknown {
    if (payload.type === 'system') {
      const { action, ...params } = payload;
      return this.executeSystemCommand(action, params);
    } else if (payload.type === 'editor') {
      const { action, ...params } = payload;
      this.mosaicApp.sendToLee(action, params);
      return { sent: true };
    }

    throw new Error(`Unknown command type: ${payload.type}`);
  }

  /**
   * Execute a system command.
   */
  private executeSystemCommand(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case 'new_tab': {
        const tabType = params.tab_type as string || 'terminal';
        if (tabType === 'terminal') {
          const command = params.command as string | undefined;
          const label = params.label as string | undefined;
          const tabId = this.mosaicApp.createTerminalTab(command, label);
          return { tab_id: tabId };
        } else if (tabType === 'lee') {
          const tabId = this.mosaicApp.createLeeTab();
          return { tab_id: tabId };
        }
        throw new Error(`Unknown tab type: ${tabType}`);
      }

      case 'close_tab': {
        const tabId = params.tab_id as number;
        if (typeof tabId !== 'number') {
          throw new Error('Missing tab_id');
        }
        this.mosaicApp.closeTab(tabId);
        return { closed: true };
      }

      case 'focus_tab': {
        const tabId = params.tab_id as number;
        if (typeof tabId !== 'number') {
          throw new Error('Missing tab_id');
        }
        this.mosaicApp.focusTab(tabId);
        return { focused: true };
      }

      case 'split': {
        const direction = (params.direction as string || 'horizontal') as 'horizontal' | 'vertical';
        const tabId = this.mosaicApp.splitPane(direction);
        return { tab_id: tabId };
      }

      default:
        throw new Error(`Unknown system action: ${action}`);
    }
  }

  /**
   * Send context to Hester daemon.
   */
  private async sendToHester(state: LeeState): Promise<unknown> {
    const url = `http://127.0.0.1:${this.hesterPort}/context`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: 'mosaic',
          context: {
            file_path: state.file,
            line: state.line,
            column: state.column,
            selected_text: state.selection,
            modified: state.modified,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Hester returned ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to send to Hester:', error);
      throw error;
    }
  }
}
