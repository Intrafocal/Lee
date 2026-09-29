/**
 * The mic for voice input (docs/plans/2026-09-28-tether-review-voice.md §5.3).
 *
 * Electron allows every permission when no handler is set. Setting one to
 * gate `media` replaces that default, so every other permission (and media
 * from anywhere but Lee's own page) keeps the old answer here: only a media
 * request that isn't audio from the app's own origin is refused. Browser
 * tabs (<webview>) share the default session and never get the mic.
 *
 * IPC voice:mic-status / voice:mic-request wrap macOS's TCC state, so the
 * renderer can explain a denied mic instead of failing silently.
 */

import { ipcMain, session, systemPreferences, type WebContents } from 'electron';
import { VOICE_IPC, type MicStatus } from '../shared/lee-api';

/** Lee's own page: the packaged file:// renderer, or Vite's dev server. */
export function isAppOrigin(origin: string, isDev: boolean): boolean {
  if (origin.startsWith('file://')) return true;
  return isDev && /^http:\/\/localhost:5173(\/|$)/.test(origin);
}

/**
 * A permission request's answer. `media` is allowed only for audio (never the
 * camera or the screen) from the app's own page; everything else as before.
 */
export function allowPermission(
  permission: string,
  origin: string,
  mediaTypes: readonly string[] | undefined,
  fromWebview: boolean,
  isDev: boolean,
): boolean {
  if (permission !== 'media') return true;
  if (fromWebview || !isAppOrigin(origin, isDev)) return false;
  const types = mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === 'audio');
}

/** The synchronous check Chromium makes first; `mediaType` is 'audio', 'video' or 'unknown'. */
export function allowPermissionCheck(permission: string, origin: string, mediaType: string | undefined, fromWebview: boolean, isDev: boolean): boolean {
  if (permission !== 'media') return true;
  if (fromWebview || !isAppOrigin(origin, isDev)) return false;
  return mediaType !== 'video';
}

function isWebview(wc: WebContents | null | undefined): boolean {
  try {
    return !!wc && wc.getType() === 'webview';
  } catch {
    return false;
  }
}

function micStatus(): MicStatus {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone') as MicStatus;
  } catch {
    return 'unknown';
  }
}

export function installMediaPermissions(isDev: boolean): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = (details as { requestingUrl?: string }).requestingUrl ?? '';
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(allowPermission(permission, origin, mediaTypes, isWebview(wc), isDev));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType;
    return allowPermissionCheck(permission, requestingOrigin, mediaType, isWebview(wc), isDev);
  });

  ipcMain.handle(VOICE_IPC.micStatus, (): MicStatus => micStatus());
  ipcMain.handle(VOICE_IPC.micRequest, async (): Promise<boolean> => {
    // Only macOS asks (once; after a denial it answers false until System Settings changes it).
    if (process.platform !== 'darwin') return micStatus() === 'granted';
    try {
      return await systemPreferences.askForMediaAccess('microphone');
    } catch {
      return false;
    }
  });
}
