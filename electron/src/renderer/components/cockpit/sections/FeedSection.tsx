/**
 * FeedSection - the merged Feed (contracts §4.1): attention items (v0 queue,
 * acted on through window.lee.copilot), Lee Feed entries (acted on through
 * feed.act; any confirm_text is shown verbatim before it takes effect) and
 * Hester task events. Newest first, blocking and needs-you pinned.
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../../Icon';
import { AttentionItemRow } from '../../copilot/AttentionItemRow';
import type { FeedAction, FeedEntry } from '../../../../shared/cockpit';
import { formatAge, plainPreview, type FeedRow } from '../../../lib/cockpitModel';
import { AgentMarkdown } from '../AgentMarkdown';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

function rowHandle(ctx: CockpitCtx, row: FeedRow): RowHandle {
  if (row.source === 'attention') {
    const item = row.item;
    const pty = item.source.pty_id;
    return {
      id: row.id,
      title: row.title,
      ptyId: pty,
      open: () => {
        if (pty != null) ctx.goInto(pty, 'feed');
        else void ctx.copilotApi?.openItem(item.id);
      },
      approval: item.actions.includes('approve') ? item : null,
      replyItem: item.actions.includes('reply') ? item : null,
      dismiss: item.actions.includes('dismiss') ? () => void ctx.copilotApi?.dismiss(item.id) : undefined,
    };
  }
  if (row.source === 'lee') {
    const e = row.entry;
    return {
      id: row.id,
      title: row.title,
      ptyId: e.ref.pty_id ?? null,
      open: () => {
        if (e.ref.pty_id != null) ctx.focusPty(e.ref.pty_id);
        else if (e.ref.task_id) {
          ctx.setSection('tasks');
          ctx.selectRow(`task:${e.ref.task_id}`);
        } else if (e.ref.op || e.ref.proposal_id) ctx.setSection('ops');
      },
      dismiss: () => void ctx.api?.feed.act(e.id, 'dismiss').catch(() => {}),
    };
  }
  const ev = row.event;
  return {
    id: row.id,
    title: row.title,
    open: () => {
      ctx.setSection('tasks');
      ctx.selectRow(`task:${ev.task_id}`);
    },
  };
}

const KIND_ICONS: Record<string, 'lock' | 'warning' | 'info' | 'bell' | 'check' | 'chat' | 'play'> = {
  approval: 'lock',
  blocker: 'warning',
  decision: 'chat',
  failure: 'warning',
  metric: 'info',
  lint: 'warning',
  proposal: 'bell',
  event: 'check',
  prepared: 'play',
};

const FeedEntryRow: React.FC<{ ctx: CockpitCtx; entry: FeedEntry; selected: boolean }> = ({ ctx, entry, selected }) => {
  const [pending, setPending] = useState<FeedAction | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = (action: FeedAction | 'dismiss', payload?: Record<string, string>) => {
    if (!ctx.api || busy) return;
    const id = action === 'dismiss' ? 'dismiss' : action.id;
    if (entry.kind === 'proposal' && id !== 'dismiss') ctx.copilotApi?.logCeremony('confirm', 'proposal');
    setBusy(true);
    setError(null);
    ctx.api.feed
      .act(entry.id, id, payload)
      .then((r) => {
        if (!r.success) setError(r.error || 'failed');
        else setPending(null);
      })
      .catch(() => setError('failed'))
      .finally(() => setBusy(false));
  };

  const start = (a: FeedAction) => {
    if (a.confirm_text || a.input) {
      setPending(a);
      setValue(a.input?.kind === 'select' ? a.input.options?.[0] ?? '' : '');
    } else act(a);
  };

  return (
    <div className="cockpit-feed-entry">
      <div className="cockpit-row-head">
        <Icon name={KIND_ICONS[entry.kind] ?? 'info'} size={12} />
        <span className="cockpit-row-title">{entry.title}</span>
        <span className="cockpit-muted">{formatAge(entry.updated_at, ctx.now)}</span>
      </div>
      {entry.text &&
        (!entry.text_is_agent ? (
          <div className="cockpit-row-text">{entry.text}</div>
        ) : selected ? (
          <div className="cockpit-agent-words is-expanded">
            <span className="cockpit-agent-label">Agent says:</span>
            <AgentMarkdown text={entry.text} />
          </div>
        ) : (
          <div className="cockpit-agent-words">
            <span className="cockpit-agent-label">Agent says:</span> {plainPreview(entry.text) || '(code)'}
          </div>
        ))}
      {pending && (
        <div className="cockpit-confirm" onClick={(e) => e.stopPropagation()}>
          {pending.confirm_text && (
            <>
              <div className="cockpit-muted">{pending.label} will do exactly this:</div>
              <pre className="cockpit-confirm-text">{pending.confirm_text}</pre>
            </>
          )}
          {pending.input?.kind === 'text' && (
            <input autoFocus className="cockpit-input" value={value} placeholder={pending.input.placeholder} onChange={(e) => setValue(e.target.value)} />
          )}
          {pending.input?.kind === 'select' && (
            <select className="cockpit-input" value={value} onChange={(e) => setValue(e.target.value)}>
              {(pending.input.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          <div className="cockpit-row-actions">
            <button
              className={`cockpit-btn${pending.style === 'danger' ? ' is-danger' : ' is-primary'}`}
              disabled={busy || (!!pending.input && !value)}
              onClick={() => act(pending, pending.input ? { [pending.input.param]: value } : undefined)}
            >
              Confirm {pending.label}
            </button>
            <button className="cockpit-btn" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!pending && (
        <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
          {entry.actions.slice(0, 3).map((a) => (
            <button
              key={a.id}
              className={`cockpit-btn${a.style === 'primary' ? ' is-primary' : a.style === 'danger' ? ' is-danger' : ''}`}
              disabled={busy}
              title={a.confirm_text ?? undefined}
              onClick={() => start(a)}
            >
              {a.label}
            </button>
          ))}
          <button className="cockpit-btn" disabled={busy} onClick={() => act('dismiss')} title="Dismiss (⌘⌫)">
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="cockpit-error">{error}</div>}
    </div>
  );
};

export const FeedSection: React.FC<{ ctx: CockpitCtx }> = ({ ctx }) => {
  const rows = ctx.feedRows;
  const handles = rows.map((r) => rowHandle(ctx, r));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  // Lint entries shown here count as shown on the 'feed' surface (D's nudge_acceptance denominator).
  const lintIds = rows
    .flatMap((r) => (r.source === 'lee' && r.entry.producer === 'lint' && r.entry.ref.diag_id ? [r.entry.ref.diag_id] : []))
    .join('\n');
  useEffect(() => {
    if (!lintIds) return;
    try {
      ctx.api?.lint.shown(lintIds.split('\n'), 'feed');
    } catch {
      // older preload without lint
    }
  }, [lintIds, ctx.api]);
  const sel = ctx.mode.selected;
  const needs = rows.filter((r) => r.severity !== 'ambient').length;

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Feed</h2>
        <span className="cockpit-muted">{needs ? `${needs} need${needs === 1 ? 's' : ''} you · ` : ''}{rows.length} item{rows.length === 1 ? '' : 's'}</span>
      </header>
      {rows.length === 0 && <div className="cockpit-empty">Nothing needs you. Agents, operations and Hester post here.</div>}
      <div className="cockpit-rows">
        {rows.map((row, i) => (
          <div
            key={row.id}
            data-cockpit-row={row.id}
            className={`cockpit-row sev-${row.severity}${sel?.kind === 'row' && sel.id === row.id ? ' is-selected' : ''}`}
            onClick={() => ctx.selectRow(row.id)}
            onDoubleClick={() => handles[i].open?.()}
          >
            {row.source === 'attention' && ctx.copilotApi && (
              <>
                <AttentionItemRow item={row.item} api={ctx.copilotApi} />
                {row.item.source.pty_id != null && (
                  <button className="cockpit-btn cockpit-row-go" onClick={() => ctx.goInto(row.item.source.pty_id as number, 'feed')}>
                    <Icon name="arrow-right" size={11} /> Peek
                  </button>
                )}
              </>
            )}
            {row.source === 'lee' && <FeedEntryRow ctx={ctx} entry={row.entry} selected={sel?.kind === 'row' && sel.id === row.id} />}
            {row.source === 'hester' && (
              <div className="cockpit-row-head">
                <Icon name="check" size={12} />
                <span className="cockpit-row-title">{row.title}</span>
                <span className="cockpit-muted">{formatAge(row.at, ctx.now)}</span>
                <button className="cockpit-btn" onClick={() => handles[i].open?.()}>
                  Open task
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

export default FeedSection;
