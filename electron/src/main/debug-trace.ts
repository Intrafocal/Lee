/**
 * Debug Trace Module - Save browser snapshots to workspace .hester/watch/ folder.
 *
 * Captures:
 * - Screenshots (PNG)
 * - Console logs
 * - DOM/Accessibility tree
 * - Metadata
 * - Session state (for Frame sessions)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Debug trace data for saving
 */
export interface DebugTrace {
  url: string;
  title: string;
  timestamp: number;
  screenshot?: string; // base64
  consoleLogs: string[];
  dom?: object;
  sessionState?: object; // from hester session (Frame only)
}

/**
 * Result of saving a debug trace
 */
export interface SaveTraceResult {
  dir: string;
  timestamp: string;
  files: string[];
}

/**
 * Generate a slug-friendly version of a URL + title.
 * e.g., "localhost_8889_frame" or "github_com_user_repo_pull_123"
 */
export function generatePageSlug(url: string, title: string): string {
  try {
    const parsed = new URL(url);

    // Start with hostname (replace dots with underscores)
    let slug = parsed.hostname.replace(/\./g, '_');

    // Add port if non-standard
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
      slug += `_${parsed.port}`;
    }

    // Add path segments (first 3 meaningful parts)
    const pathParts = parsed.pathname
      .split('/')
      .filter((p) => p && p.length > 0)
      .slice(0, 3);

    if (pathParts.length > 0) {
      slug += '_' + pathParts.join('_');
    }

    // If slug is too short, add slugified title
    if (slug.length < 15 && title) {
      const titleSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .slice(0, 20);
      if (titleSlug && titleSlug !== slug) {
        slug += '_' + titleSlug;
      }
    }

    // Clean up: remove double underscores, trim
    slug = slug.replace(/_+/g, '_').replace(/^_|_$/g, '');

    // Max length and ensure non-empty
    slug = slug.slice(0, 50) || 'browser';

    return slug;
  } catch {
    // Fallback for invalid URLs
    return 'browser_' + Date.now().toString(36);
  }
}

/**
 * Format timestamp for filenames (ISO without colons)
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

/**
 * Save a debug trace to the workspace .hester/watch/ folder.
 *
 * @param trace - The debug trace data
 * @param workspacePath - The workspace root directory
 * @returns The save result with directory and file list
 */
export async function saveDebugTrace(
  trace: DebugTrace,
  workspacePath: string
): Promise<SaveTraceResult> {
  const pageSlug = generatePageSlug(trace.url, trace.title);
  const ts = formatTimestamp(trace.timestamp);
  const dir = path.join(workspacePath, '.hester', 'watch', pageSlug);

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true });

  const files: string[] = [];

  // Save screenshot
  if (trace.screenshot) {
    const screenshotPath = path.join(dir, `${ts}_screenshot.png`);
    await fs.writeFile(screenshotPath, Buffer.from(trace.screenshot, 'base64'));
    files.push(`${ts}_screenshot.png`);
  }

  // Save console logs
  if (trace.consoleLogs && trace.consoleLogs.length > 0) {
    const logPath = path.join(dir, `${ts}_console.log`);
    await fs.writeFile(logPath, trace.consoleLogs.join('\n'));
    files.push(`${ts}_console.log`);
  }

  // Save DOM/accessibility tree
  if (trace.dom) {
    const domPath = path.join(dir, `${ts}_dom.json`);
    await fs.writeFile(domPath, JSON.stringify(trace.dom, null, 2));
    files.push(`${ts}_dom.json`);
  }

  // Save session state (Frame only)
  if (trace.sessionState) {
    const checkpointPath = path.join(dir, `${ts}_checkpoint.json`);
    await fs.writeFile(checkpointPath, JSON.stringify(trace.sessionState, null, 2));
    files.push(`${ts}_checkpoint.json`);
  }

  // Save metadata
  const metadata = {
    url: trace.url,
    title: trace.title,
    timestamp: trace.timestamp,
    timestampISO: new Date(trace.timestamp).toISOString(),
    files,
  };
  const metadataPath = path.join(dir, `${ts}_metadata.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  files.push(`${ts}_metadata.json`);

  console.log(`[DebugTrace] Saved ${files.length} files to ${dir}`);

  return { dir, timestamp: ts, files };
}

/**
 * Get the watch directory for a workspace.
 */
export function getWatchDir(workspacePath: string): string {
  return path.join(workspacePath, '.hester', 'watch');
}

/**
 * List all page slugs in the watch directory.
 */
export async function listWatchedPages(workspacePath: string): Promise<string[]> {
  const watchDir = getWatchDir(workspacePath);
  try {
    const entries = await fs.readdir(watchDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * List all snapshots for a page slug.
 */
export async function listSnapshots(
  workspacePath: string,
  pageSlug: string
): Promise<string[]> {
  const pageDir = path.join(getWatchDir(workspacePath), pageSlug);
  try {
    const entries = await fs.readdir(pageDir);
    // Group by timestamp prefix
    const timestamps = new Set<string>();
    for (const entry of entries) {
      const match = entry.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
      if (match) {
        timestamps.add(match[1]);
      }
    }
    return Array.from(timestamps).sort().reverse(); // Most recent first
  } catch {
    return [];
  }
}
