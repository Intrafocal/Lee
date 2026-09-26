/**
 * OpenerCard - the opener at the top of the Copilot section (Deep D1 §8.2,
 * 14 §6): "What's on your mind?", then "Pick up where you left off", then
 * "Or start from". Deterministic: it reads GET /copilot/opener and makes no
 * model call. It recommends nothing and ranks nothing beyond the pick-up.
 *
 * - Field + Enter: an active exploration with that exact title (any case)
 *   opens; otherwise a new one is created with your text as its seed and
 *   Page, and opens with the cursor at the end. One keystroke to writing.
 * - Pick up: opens at this window's saved cursor, else at the end.
 * - Surfaces: Blank page, Open questions, Captured away, Reading list, Q2,
 *   Quiet explorations. Lists open inline; picking opens Deep.
 * - Refresh on load, on return, and every 10 minutes while shown.
 * - cockpitModeStore.focusOpener() (Go deep with nothing open) focuses the field.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Opener, OpenerSurface } from '../../../shared/cockpit';
import { cockpitModeStore } from '../cockpit/cockpitMode';
import { listExplorations, triageSomeday, type Exploration, type Q2Candidate } from '../../lib/hesterCockpit';
import { createDeepExploration, fetchOpener, patchReference } from '../../lib/hesterDeep';
import { matchExploration, untitledTitle } from '../../lib/deepModel';
import { openInDeep, openUrl } from './deepBridge';
import './deep.css';

interface OpenerCardProps {
  workspace: string;
  returnNonce: number;
  /** Q2 items act as they do in the digest (CopilotSection passes its handler). */
  onQ2?: (c: Q2Candidate) => void;
}

const REFRESH_MS = 10 * 60000;

// Go deep with nothing open may ask before the Copilot section has mounted
// this card; the request waits here until it does.
let focusPending = false;
let focusMounted: (() => void) | null = null;
cockpitModeStore.onFocusOpener(() => {
  if (focusMounted) focusMounted();
  else focusPending = true;
});

type Expanded = 'open_questions' | 'captured_away' | 'reading_list' | 'quiet' | 'q2' | null;

const LABELS: Record<Exclude<OpenerSurface['kind'], 'blank'>, string> = {
  open_questions: 'Open questions',
  captured_away: 'Captured away',
  reading_list: 'Reading list',
  q2: 'Q2',
  quiet: 'Quiet explorations',
};

export function OpenerCard({ workspace, returnNonce, onQ2 }: OpenerCardProps): JSX.Element | null {
  const [opener, setOpener] = useState<Opener | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const explorations = useRef<Exploration[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const focus = () => requestAnimationFrame(() => inputRef.current?.focus());
    focusMounted = focus;
    if (focusPending) {
      focusPending = false;
      focus();
    }
    return () => {
      if (focusMounted === focus) focusMounted = null;
    };
  }, []);

  const load = useCallback(() => {
    if (!workspace) return () => undefined;
    let cancelled = false;
    fetchOpener(workspace).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setOpener(r.data);
        setError(null);
      } else setError(r.error);
    });
    listExplorations(workspace).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data)) explorations.current = r.data;
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    const cancel = load();
    const id = window.setInterval(() => load(), REFRESH_MS);
    return () => {
      cancel();
      window.clearInterval(id);
    };
  }, [load, returnNonce]);

  const titleOf = (id: string, fallback?: string) => explorations.current.find((e) => e.id === id)?.title ?? fallback ?? id;

  const open = async (id: string, title: string) => {
    setBusy(true);
    try {
      await openInDeep(workspace, id, title);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const create = async (input: { seed?: string; title?: string; page?: string }) => {
    setBusy(true);
    const r = await createDeepExploration(workspace, { ...input, origin: { kind: 'opener' } });
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    explorations.current = [r.data, ...explorations.current];
    setText('');
    await open(r.data.id, r.data.title);
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (!explorations.current.length) {
      const r = await listExplorations(workspace);
      if (r.ok && Array.isArray(r.data)) explorations.current = r.data;
    }
    const hit = matchExploration(t, explorations.current);
    if (hit) {
      setText('');
      await open(hit.id, hit.title);
      return;
    }
    await create({ seed: t, page: `${t}\n\n` });
  };

  const pickUp = opener?.pick_up ?? null;
  const surfaces = (opener?.surfaces ?? []).filter((s) => s.kind === 'blank' || ('items' in s && s.items.length > 0));
  if (!surfaces.some((s) => s.kind === 'blank')) surfaces.unshift({ kind: 'blank' });

  const toggle = (k: Expanded) => setExpanded((cur) => (cur === k ? null : k));

  const expandedList = (() => {
    const s = surfaces.find((x) => x.kind === expanded);
    if (!s || s.kind === 'blank') return null;
    switch (s.kind) {
      case 'open_questions':
        return s.items.map((q) => (
          <button key={q.question_id} className="deep-pop-row" disabled={busy} onClick={() => void open(q.exploration_id, q.exploration_title)}>
            {q.text} <span className="deep-muted">· {q.exploration_title}</span>
          </button>
        ));
      case 'reading_list':
        return s.items.map((r) => (
          <button
            key={r.reference_id}
            className="deep-pop-row"
            disabled={busy}
            onClick={() => {
              openUrl(r.url);
              void patchReference(workspace, r.exploration_id, r.reference_id, { opened: true });
              void open(r.exploration_id, titleOf(r.exploration_id));
            }}
          >
            {r.title || r.url} <span className="deep-muted">· {titleOf(r.exploration_id)}</span>
          </button>
        ));
      case 'captured_away':
        return s.items.map((c) => (
          <button
            key={c.someday_id}
            className="deep-pop-row"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await triageSomeday(workspace, c.someday_id, { action: 'explore' });
              if (!alive.current) return;
              setBusy(false);
              if (r.ok && 'exploration' in r.data) void open(r.data.exploration.id, r.data.exploration.title);
              else setError(r.ok ? 'Hester made no exploration' : r.error);
            }}
          >
            {c.text} <span className="deep-muted">· {c.surface}</span>
          </button>
        ));
      case 'q2':
        return (s.items as Q2Candidate[]).map((c) => (
          <button key={`${c.kind}:${c.ref}`} className="deep-pop-row" disabled={!onQ2} onClick={() => onQ2?.(c)}>
            {c.goal_id ? `${c.goal_id} · ` : ''}
            {c.title}
            {c.detail && <span className="deep-muted"> · {c.detail}</span>}
          </button>
        ));
      case 'quiet':
        return s.items.map((e) => (
          <button key={e.exploration_id} className="deep-pop-row" disabled={busy} onClick={() => void open(e.exploration_id, e.title)}>
            {e.title}
          </button>
        ));
    }
    return null;
  })();

  return (
    <div className="deep-opener">
      <div className="deep-opener-field">
        <label htmlFor="deep-opener-input" className="deep-opener-label">
          What's on your mind?
        </label>
        <input
          id="deep-opener-input"
          ref={inputRef}
          className="deep-opener-input"
          value={text}
          disabled={busy}
          placeholder="Type to start, or pick below"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void submit();
            }
          }}
        />
        <kbd>↵</kbd>
      </div>

      {error && <div className="deep-opener-error">{error}</div>}

      {pickUp && (
        <div className="deep-opener-group">
          <div className="deep-opener-label">Pick up where you left off</div>
          <button className="deep-opener-pickup" disabled={busy} onClick={() => void open(pickUp.exploration.id, pickUp.exploration.title)}>
            <span className="deep-opener-pickup-title">{pickUp.exploration.title}</span>
            {pickUp.stopped_at && <span className="deep-muted"> · “…{pickUp.stopped_at}”</span>}
          </button>
          {(pickUp.arrived.answers > 0 || pickUp.arrived.open_questions > 0) && (
            <div className="deep-muted deep-opener-arrived">
              {[
                pickUp.arrived.answers ? `${pickUp.arrived.answers} answer${pickUp.arrived.answers === 1 ? '' : 's'} arrived` : null,
                pickUp.arrived.open_questions ? `${pickUp.arrived.open_questions} open question${pickUp.arrived.open_questions === 1 ? '' : 's'}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      )}

      <div className="deep-opener-group">
        <div className="deep-opener-label">Or start from</div>
        <div className="deep-opener-surfaces">
          {surfaces.map((s) =>
            s.kind === 'blank' ? (
              <button key="blank" className="deep-chip" disabled={busy} onClick={() => void create({ title: untitledTitle(new Date()) })}>
                Blank page
              </button>
            ) : (
              <button
                key={s.kind}
                className={`deep-chip${expanded === s.kind ? ' is-on' : ''}`}
                aria-expanded={expanded === s.kind}
                onClick={() => toggle(s.kind)}
              >
                {LABELS[s.kind]} ({'count' in s ? s.count : s.items.length})
              </button>
            ),
          )}
        </div>
        {expandedList && <div className="deep-opener-list">{expandedList}</div>}
      </div>
    </div>
  );
}
