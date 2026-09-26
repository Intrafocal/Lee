/**
 * LintStatus - the status bar's `⚠ N` (contracts §8.5): nudged warn and
 * needs-you diagnostics for this window's workspace plus machine-wide ones.
 * Hidden during focus. Click opens the problems flyout, which lists every open
 * diagnostic. Also tells main which approval tools the queue is showing, so
 * toil/repeat-approval can propose an exact permission rule.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LintFlyout } from './LintFlyout';
import type { CockpitAPI, LintSnapshot } from '../../../shared/cockpit';
import type { AttentionSnapshot } from '../../../shared/copilot';
import './lint.css';

interface LintStatusProps {
  workspace: string;
}

type LintApi = CockpitAPI['lint'];

function resolveApi(): LintApi | null {
  const lee = typeof window !== 'undefined' ? window.lee : undefined;
  return lee?.cockpit?.lint ?? null;
}

export const LintStatus: React.FC<LintStatusProps> = ({ workspace }) => {
  const [api] = useState<LintApi | null>(resolveApi);
  const [snapshot, setSnapshot] = useState<LintSnapshot | null>(null);
  const [focusActive, setFocusActive] = useState(false);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reported = useRef(new Set<string>());
  const learned = useRef(new Map<string, string>());

  const refresh = useCallback(() => {
    if (!api) return;
    api.list(workspace).then(setSnapshot).catch(() => setSnapshot(null));
  }, [api, workspace]);

  useEffect(() => {
    if (!api) return;
    refresh();
    return api.onChange((snap) => {
      if (snap.workspace === workspace) setSnapshot(snap);
    });
  }, [api, workspace, refresh]);

  useEffect(() => {
    const copilot = typeof window !== 'undefined' ? window.lee?.copilot : undefined;
    if (!copilot) return;
    const apply = (snap: AttentionSnapshot | null) => {
      if (!snap) return;
      setFocusActive(!!snap.focus?.active);
      if (!api) return;
      for (const item of snap.items) {
        if (item.kind !== 'approval' || !item.tool?.signature) continue;
        const key = `${item.tool.name}\0${item.tool.preview}`;
        if (learned.current.get(item.tool.signature) === key) continue;
        learned.current.set(item.tool.signature, key);
        api.learnTool({ signature: item.tool.signature, tool: item.tool.name, preview: item.tool.preview });
      }
    };
    copilot.getSnapshot().then(apply).catch(() => undefined);
    return copilot.onSnapshot(apply);
  }, [api]);

  const nudged = snapshot ? snapshot.counts.warn + snapshot.counts.needs_you : 0;
  const listed = snapshot ? snapshot.diagnostics.filter((d) => d.severity !== 'off').length : 0;

  // Report what the count displays (main ignores diagnostics it hasn't nudged).
  useEffect(() => {
    if (!api || !snapshot || focusActive || nudged === 0) return;
    const ids = snapshot.diagnostics
      .filter((d) => d.severity === 'warn' || d.severity === 'needs-you')
      .filter((d) => !d.shown && !reported.current.has(`${d.id}@${d.updated_at}`))
      .map((d) => {
        reported.current.add(`${d.id}@${d.updated_at}`);
        return d.id;
      });
    if (ids.length > 0) api.shown(ids, 'status');
  }, [api, snapshot, focusActive, nudged]);

  if (!api || focusActive) return null;
  if (nudged === 0 && listed === 0 && !open) return null;

  return (
    <>
      <button
        ref={buttonRef}
        className={`status-item lint-status${nudged > 0 ? ' lint-status-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={nudged > 0 ? `${nudged} problem${nudged === 1 ? '' : 's'}` : 'Problems'}
      >
        <span className="lint-status-glyph">⚠</span>
        {nudged > 0 && <span className="status-text">{nudged}</span>}
      </button>
      {open && snapshot && buttonRef.current && (
        <LintFlyout
          api={api}
          snapshot={snapshot}
          anchorRect={buttonRef.current.getBoundingClientRect()}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
};

export default LintStatus;
