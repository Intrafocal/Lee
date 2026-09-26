/**
 * Launcher (+ Task / n): one text field and Enter launches with defaults
 * (contracts §4.2). Optional chips: kind, lead, play, worktree, auto
 * (Claude --permission-mode auto; default from cockpit.launch.permission_default;
 * a Plan lead always runs in plan mode), provider.
 * Zero required fields beyond the text; works with Hester down (A spools the
 * task record). No Q4 note, no suggestion chip (v4).
 *
 * Addendum 2026-09-26b: an optional Name (the session's display name, e.g.
 * `claude --name`) and an optional context picker: workspace files (fuzzy
 * search) and Hester context bundles, attached as `@path` references to the
 * agent's initial prompt. Deterministic and offline; nothing is summarised.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import type { LaunchRequest, TaskKind, TaskLead, TaskOrigin } from '../../../shared/cockpit';
import { fuzzyFilter } from '../../lib/cockpitModel';
import { fetchBundles, type ContextBundleRef } from '../../lib/hesterCockpit';
import type { CockpitCtx } from './CockpitHost';

export interface LauncherPrefill {
  text?: string;
  kind?: TaskKind;
  lead?: TaskLead;
  origin?: TaskOrigin;
}

const KINDS: TaskKind[] = ['bug', 'question', 'prototype', 'chore'];
const LEADS: Array<{ id: TaskLead; label: string }> = [
  { id: 'delegate', label: 'Delegate' },
  { id: 'human', label: "I'll do this myself" },
  { id: 'plan', label: 'Plan' },
];
const PROVIDERS = ['claude', 'pi'];
/** Providers whose launch takes an initial prompt (so context references can ride along). */
const CONTEXT_PROVIDERS = new Set(['claude', 'pi']);
const PICKER_LIMIT = 12;

type ContextPick =
  | { kind: 'file'; path: string }
  | { kind: 'bundle'; id: string; title: string };

function pickKey(p: ContextPick): string {
  return p.kind === 'file' ? `f:${p.path}` : `b:${p.id}`;
}

interface LauncherProps {
  ctx: CockpitCtx;
  prefill?: LauncherPrefill;
  onClose: () => void;
}

export const Launcher: React.FC<LauncherProps> = ({ ctx, prefill, onClose }) => {
  const [text, setText] = useState(prefill?.text ?? '');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TaskKind | null>(prefill?.kind ?? null);
  const [lead, setLead] = useState<TaskLead>(prefill?.lead ?? 'delegate');
  const [play, setPlay] = useState(false);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  // Claude auto mode: null follows cockpit.launch.permission_default (default 'auto').
  const [auto, setAuto] = useState<boolean | null>(null);
  const [autoDefault, setAutoDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Context picker
  const [picked, setPicked] = useState<ContextPick[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [bundles, setBundles] = useState<ContextBundleRef[] | null>(null);
  const [bundlesOffline, setBundlesOffline] = useState(false);
  const queryRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const effectiveWorktree = worktree ?? lead === 'delegate';
  const effectiveProvider = provider ?? 'claude';
  const contextSupported = lead !== 'human' && CONTEXT_PROVIDERS.has(effectiveProvider);
  // A plan lead always runs in plan mode; the auto toggle only applies to Claude.
  const autoApplies = lead === 'delegate' && effectiveProvider === 'claude';
  const effectiveAuto = auto ?? autoDefault;

  useEffect(() => {
    let alive = true;
    ctx.api
      ?.launchDefaults?.(ctx.workspace)
      .then((d) => alive && setAutoDefault(d.permission_default !== 'default'))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ctx.api, ctx.workspace]);

  // Load the pick lists the first time the picker opens (no model, no network beyond local Hester).
  useEffect(() => {
    if (!pickerOpen) return;
    let alive = true;
    if (files == null) {
      const api = ctx.api;
      if (api?.files) {
        api
          .files(ctx.workspace)
          .then((r) => {
            if (!alive) return;
            setFiles(r.files);
            setFilesTruncated(r.truncated);
          })
          .catch(() => alive && setFiles([]));
      } else setFiles([]);
    }
    if (bundles == null) {
      fetchBundles(ctx.workspace)
        .then((r) => {
          if (!alive) return;
          if (r.ok) setBundles(r.data);
          else {
            setBundles([]);
            setBundlesOffline(true);
          }
        })
        .catch(() => alive && setBundles([]));
    }
    return () => {
      alive = false;
    };
  }, [pickerOpen, files, bundles, ctx.api, ctx.workspace]);

  const candidates = useMemo<ContextPick[]>(() => {
    const taken = new Set(picked.map(pickKey));
    const bs: ContextPick[] = fuzzyFilter(query, bundles ?? [], (b) => `${b.title} ${b.id}`, 5)
      .map((b): ContextPick => ({ kind: 'bundle', id: b.id, title: b.title }))
      .filter((p) => !taken.has(pickKey(p)));
    const fs: ContextPick[] = fuzzyFilter(query, files ?? [], (f) => f, PICKER_LIMIT)
      .map((f): ContextPick => ({ kind: 'file', path: f }))
      .filter((p) => !taken.has(pickKey(p)));
    return [...bs, ...fs].slice(0, PICKER_LIMIT);
  }, [query, files, bundles, picked]);

  useEffect(() => setCursor(0), [query]);

  const add = (p: ContextPick | undefined) => {
    if (!p) return;
    setPicked((cur) => (cur.some((x) => pickKey(x) === pickKey(p)) ? cur : [...cur, p]));
    setQuery('');
    queryRef.current?.focus();
  };
  const remove = (key: string) => setPicked((cur) => cur.filter((x) => pickKey(x) !== key));

  const launch = () => {
    const body = text.trim();
    const nm = name.trim();
    const hasContext = contextSupported && picked.length > 0;
    if ((!body && !hasContext) || busy) return;
    if (!ctx.api) {
      setError('Launching needs the Cockpit runtime');
      return;
    }
    const firstLine = body.split('\n')[0].slice(0, 80);
    const context = hasContext
      ? {
          files: picked.filter((p): p is Extract<ContextPick, { kind: 'file' }> => p.kind === 'file').map((p) => p.path),
          bundles: picked.filter((p): p is Extract<ContextPick, { kind: 'bundle' }> => p.kind === 'bundle').map((p) => p.id),
        }
      : null;
    const req: LaunchRequest = {
      workspace: ctx.workspace,
      lead,
      play,
      origin: prefill?.origin ?? { kind: 'launcher' },
      ...(kind ? { kind } : {}),
      ...(lead === 'human' ? { title: nm || firstLine } : body ? { prompt: body } : {}),
      ...(nm ? { name: nm } : {}),
      ...(context ? { context } : {}),
      ...(worktree != null ? { worktree } : {}),
      ...(provider ? { provider } : {}),
      // Only when you flipped the toggle; otherwise main applies the configured default.
      ...(autoApplies && auto != null ? { permission_mode: auto ? ('auto' as const) : ('acceptEdits' as const) } : {}),
    };
    setBusy(true);
    setError(null);
    ctx.api
      .launch(req)
      .then((r) => {
        if (!r.success) {
          setError(r.error === 'prompt_unsupported' ? 'That provider can’t take a prompt or context; start it and type there' : r.error || 'Launch failed');
          return;
        }
        ctx.notify(lead === 'human' ? 'Task added' : r.relayed === false ? 'Launched (task record queued for Hester)' : 'Launched');
        ctx.hester.refresh();
        if (r.pty_id != null) ctx.selectRow(`task:${r.task_id}`);
        onClose();
      })
      .catch(() => setError('Launch failed'))
      .finally(() => setBusy(false));
  };

  // ⌘Enter launches from any field; Esc closes (the picker first).
  const commonKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      launch();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (pickerOpen) {
        setPickerOpen(false);
        textRef.current?.focus();
      } else onClose();
      return true;
    }
    return false;
  };

  const canLaunch = !!text.trim() || (contextSupported && picked.length > 0);

  return (
    <div className="cockpit-popover-backdrop" onClick={onClose}>
      <div className="cockpit-popover is-wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New task">
        <div className="cockpit-popover-title">
          <Icon name="plus" size={14} /> New task
        </div>
        <textarea
          ref={textRef}
          autoFocus
          className="cockpit-textarea is-launcher"
          value={text}
          placeholder={lead === 'human' ? 'What will you do?' : 'What should the agent do? Enter launches'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (commonKeys(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              launch();
            }
          }}
        />
        <input
          className="cockpit-input"
          value={name}
          maxLength={120}
          placeholder={lead === 'human' ? 'Name (optional; default: the first line)' : 'Name (optional; shown on the tile and tab)'}
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (commonKeys(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              launch();
            }
          }}
        />
        {lead !== 'human' && (
          <div className="cockpit-launch-context">
            <div className="cockpit-chips">
              {picked.map((p) => (
                <span key={pickKey(p)} className="cockpit-chip-btn is-on" title={p.kind === 'file' ? `@${p.path}` : `Bundle ${p.id}`}>
                  {p.kind === 'file' ? p.path : `▣ ${p.title}`}
                  <button className="cockpit-chip-x" aria-label="Remove" onClick={() => remove(pickKey(p))}>
                    ×
                  </button>
                </span>
              ))}
              {contextSupported ? (
                <button
                  className="cockpit-chip-btn"
                  title="Attach workspace files or Hester context bundles as @references"
                  onClick={() => {
                    setPickerOpen(true);
                    setTimeout(() => queryRef.current?.focus(), 0);
                  }}
                >
                  + Context
                </button>
              ) : (
                <span className="cockpit-muted">Context needs a provider that takes a prompt.</span>
              )}
            </div>
            {pickerOpen && contextSupported && (
              <div className="cockpit-picker">
                <input
                  ref={queryRef}
                  className="cockpit-input is-mono"
                  value={query}
                  placeholder="Search files and bundles… (↑/↓, Enter adds, ⌫ removes, Esc closes)"
                  aria-label="Search context"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (commonKeys(e)) return;
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setCursor((c) => Math.min(candidates.length - 1, c + 1));
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setCursor((c) => Math.max(0, c - 1));
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      add(candidates[cursor]);
                    } else if (e.key === 'Backspace' && !query && picked.length) {
                      e.preventDefault();
                      remove(pickKey(picked[picked.length - 1]));
                    }
                  }}
                />
                <div className="cockpit-picker-list" role="listbox">
                  {files == null && <div className="cockpit-muted">Loading files…</div>}
                  {candidates.map((p, i) => (
                    <div
                      key={pickKey(p)}
                      role="option"
                      aria-selected={i === cursor}
                      className={`cockpit-picker-row${i === cursor ? ' is-selected' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        add(p);
                      }}
                    >
                      {p.kind === 'file' ? (
                        <code>{p.path}</code>
                      ) : (
                        <span>
                          ▣ {p.title} <span className="cockpit-muted">bundle {p.id}</span>
                        </span>
                      )}
                    </div>
                  ))}
                  {files != null && candidates.length === 0 && <div className="cockpit-muted">No matches</div>}
                </div>
                <div className="cockpit-muted">
                  {filesTruncated ? 'Large workspace: only the first files are searchable. ' : ''}
                  {bundlesOffline ? 'Bundles need Hester. ' : ''}
                  Attached as @references to the prompt; the agent reads them itself.
                </div>
              </div>
            )}
          </div>
        )}
        <div className="cockpit-chips">
          {KINDS.map((k) => (
            <button key={k} className={`cockpit-chip-btn${kind === k ? ' is-on' : ''}`} onClick={() => setKind(kind === k ? null : k)}>
              {k}
            </button>
          ))}
          <span className="cockpit-chip-sep" />
          {LEADS.map((l) => (
            <button key={l.id} className={`cockpit-chip-btn${lead === l.id ? ' is-on' : ''}`} onClick={() => setLead(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        <div className="cockpit-chips">
          <button className={`cockpit-chip-btn${play ? ' is-on' : ''}`} onClick={() => setPlay((p) => !p)}>
            play
          </button>
          {lead !== 'human' && (
            <>
              <button className={`cockpit-chip-btn${effectiveWorktree ? ' is-on' : ''}`} onClick={() => setWorktree(!effectiveWorktree)}>
                worktree
              </button>
              {effectiveProvider === 'claude' && (
                <button
                  className={`cockpit-chip-btn${autoApplies && effectiveAuto ? ' is-on' : ''}`}
                  disabled={!autoApplies}
                  aria-pressed={autoApplies && effectiveAuto}
                  title={
                    autoApplies
                      ? effectiveAuto
                        ? 'Claude runs in auto mode (--permission-mode auto). Click for accept-edits.'
                        : 'Claude runs in accept-edits mode. Click for auto mode.'
                      : 'Plan runs in plan mode'
                  }
                  onClick={() => setAuto(!effectiveAuto)}
                >
                  auto
                </button>
              )}
              <span className="cockpit-chip-sep" />
              {PROVIDERS.map((p) => (
                <button key={p} className={`cockpit-chip-btn${effectiveProvider === p ? ' is-on' : ''}`} onClick={() => setProvider(p)}>
                  {p}
                </button>
              ))}
            </>
          )}
        </div>
        {error && <div className="cockpit-error">{error}</div>}
        <div className="cockpit-popover-actions">
          <button className="cockpit-btn is-primary" disabled={busy || !canLaunch} onClick={launch}>
            {lead === 'human' ? 'Add task' : 'Launch'} <kbd>⏎</kbd>
          </button>
          <button className="cockpit-btn" onClick={onClose}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
};

export default Launcher;
