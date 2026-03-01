#!/usr/bin/env node
/**
 * Mosaic - Terminal IDE wrapper for Lee Editor and Hester AI.
 *
 * Entry point that bootstraps the blessed screen and API server.
 *
 * Usage:
 *   mosaic [--workspace <path>] [--api-port <port>] [--hester-port <port>]
 */

import { MosaicApp, MosaicConfig } from './App';
import { APIServer } from './api/server';

interface CLIArgs {
  workspace?: string;
  apiPort: number;
  hesterPort: number;
  help: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    apiPort: 9001,
    hesterPort: 9000,
    help: false,
  };

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--workspace' || arg === '-w') {
      args.workspace = argv[++i];
    } else if (arg === '--api-port') {
      args.apiPort = parseInt(argv[++i], 10);
    } else if (arg === '--hester-port') {
      args.hesterPort = parseInt(argv[++i], 10);
    } else if (!arg.startsWith('-') && !args.workspace) {
      // First positional argument is workspace
      args.workspace = arg;
    }
  }

  return args;
}

function showHelp(): void {
  console.log(`
Mosaic - Terminal IDE wrapper for Lee Editor and Hester AI

Usage:
  mosaic [options] [workspace]

Options:
  -w, --workspace <path>  Set the workspace directory (default: current directory)
  --api-port <port>       API server port for Hester communication (default: 9001)
  --hester-port <port>    Hester daemon port (default: 9000)
  -h, --help              Show this help message

Examples:
  mosaic                          # Start in current directory
  mosaic ~/projects/myapp         # Start in specified directory
  mosaic --api-port 9002 .        # Use custom API port

Keybindings:
  Ctrl+Q          Quit Mosaic
  Ctrl+Shift+T    New terminal tab
  Ctrl+W          Close current tab
  Ctrl+Tab        Next tab
  Ctrl+Shift+Tab  Previous tab
  Ctrl+\\         Split horizontal
  Ctrl+-          Split vertical
  Ctrl+]          Focus next pane
  Ctrl+[          Focus previous pane

API Endpoints (port 9001):
  GET  /health            Health check
  GET  /context           Get Lee editor state
  POST /command/system    System commands (new_tab, close_tab, focus_tab, split)
  POST /command/editor    Editor commands (open_file, save_file, goto_line)
  POST /context/send      Send context to Hester daemon
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const config: MosaicConfig = {
    workspace: args.workspace,
    apiPort: args.apiPort,
    hesterPort: args.hesterPort,
  };

  // Create app
  const app = new MosaicApp(config);

  // Create API server
  const apiServer = new APIServer({
    port: args.apiPort,
    app,
    hesterPort: args.hesterPort,
  });

  // Handle cleanup
  process.on('SIGINT', () => {
    cleanup();
  });

  process.on('SIGTERM', () => {
    cleanup();
  });

  let isCleaningUp = false;

  async function cleanup(): Promise<void> {
    if (isCleaningUp) return;
    isCleaningUp = true;

    console.log('\nShutting down Mosaic...');
    await apiServer.stop();
    app.destroy();
    process.exit(0);
  }

  // Start
  try {
    await apiServer.start();
    await app.init();

    // Listen for state updates
    app.on('state', (state) => {
      // Log state changes for debugging
      // console.log('Lee state:', state);
    });

    app.on('exit', () => {
      cleanup();
    });
  } catch (error) {
    console.error('Failed to start Mosaic:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
