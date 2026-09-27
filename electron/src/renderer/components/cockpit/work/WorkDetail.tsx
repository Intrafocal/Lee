/**
 * WorkDetail - one agent, item or task, in place of Work's list
 * (cockpit-design §4.2): the header, "It asked" / "It said" as prose, the
 * pending action (an approval's command with Allow and Deny, a question's
 * options), the reply box (all four quick replies, a textarea sent exactly
 * as written, C3), "Along the way" from the agent's activity (§7.1) and the
 * quiet links: Check in, Rename, Open terminal in Manual, Accept / Discard,
 * Link to a goal…, and for an open task Promote… (to a workstream),
 * Escalate → Explore (an exploration seeded from it, shown in the Library),
 * Hester's view (/suggest, answered inline with its proposals) and
 * Priority… (the Important / Urgent overrides); then Assign… and Close agent.
 *
 * Esc and ↑/↓ are Work's (WorkSection): back to the list, or the previous or
 * next item without going back.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { AgentSummary, AttentionItem } from '../../../../shared/copilot';
import { CHECKIN_PROMPT, type CockpitTask, type StewardAnswer } from '../../../../shared/cockpit';
import { taskTitle, type TileModel } from '../../../lib/cockpitModel';
import { closeTask, confirmTask, escalateTask, promoteTask, suggestTask } from '../../../lib/hesterCockpit';
import {
  alongTheWay,
  approvalLine,
  canTextReply,
  clockTime,
  providerLabel,
  quickReplies,
  shortAge,
  workspaceName,
} from '../../../lib/workModel';
import { Btn, Chip, Dot, Eyebrow, QuietLinks, type DotKind, type QuietLink } from '../ui';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import type { CockpitCtx } from '../CockpitHost';
import { choosable, choose, decide, sendText } from './actions';
import { AssignPicker, LinkPicker, PriorityPicker } from './Pickers';

/** What the detail view shows, resolved from the list id by WorkSection. */
export interface DetailSubject {
  id: string;
  name: string;
  /** The item that needs you, if any (the one this card was, or the agent's first). */
  item: AttentionItem | null;
  tile: TileModel | null;
  task: CockpitTask | null;
  agent: AgentSummary | null;
  ptyId: number | null;
  provider: string | null;
  workspace: string | null;
  /** When the current turn started (busy), for "started 18m ago". */
  busySince: string | null;
  sessionId: string | null;
}

interface WorkDetailProps {
  ctx: CockpitCtx;
  subject: DetailSubject;
  /** Put the caret in the reply field on open ("Write a reply…"). */
  focusReply: boolean;
  /** Open the goal picker on open (a link-goal request). */
  openLink: boolean;
  onBack: () => void;
}

type Panel = 'assign' | 'link' | 'priority' | null;
type ViewState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; answer: StewardAnswer } | { phase: 'error'; error: string };

export const WorkDetail: React.FC<WorkDetailProps> = ({ ctx, subject, focusReply, openLink, onBack }) => {
  const { item, tile, task, agent, ptyId } = subject;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(openLink && task ? 'link' : null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [view, setView] = useState<ViewState>({ phase: 'idle' });
  const viewSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Keys reach Work through this view: focus it (or the reply field) on open.
  useEffect(() => {
    if (focusReply && replyRef.current) replyRef.current.focus({ preventScroll: true });
    else rootRef.current?.focus({ preventScroll: true });
  }, [subject.id, focusReply]);

  useEffect(() => {
    if (openLink && task) setPanel('link');
  }, [openLink, task]);

  // Hester's view belongs to the task it was asked about.
  useEffect(() => {
    viewSeq.current++;
    setView({ phase: 'idle' });
  }, [task?.id]);

  useEffect(() => {
    if (!confirmClose) return;
    const t = window.setTimeout(() => setConfirmClose(false), 5000);
    return () => window.clearTimeout(t);
  }, [confirmClose]);

  const act = (fn: () => Promise<boolean>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    void fn()
      .then((ok) => {
        if (ok && after) after();
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
  };

  const taskAct = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    act(async () => {
      const r = await fn();
      if (!r.ok) {
        ctx.notify(r.error || 'failed', 'error');
        return false;
      }
      ctx.hester.refresh();
      ctx.notify(ok);
      return true;
    });

  const approval = item?.kind === 'approval' && item.actions.includes('approve') ? item : tile?.approval ?? null;
  const question = item?.kind === 'question' ? item.question?.questions[0] ?? null : null;
  const replyItem = item && canTextReply(item) ? item : tile?.replyItem ?? null;
  const send = (body: string) => {
    if (!replyItem) return;
    act(() => sendText(ctx, replyItem, body), () => {
      if (alive.current) setText('');
    });
  };

  const dot: DotKind = item ? 'needs' : tile?.working ? 'working' : task?.status === 'review' ? 'done' : tile?.needsYou ? 'needs' : 'idle';
  const started = task?.created_at ?? subject.busySince;
  const meta = [
    providerLabel(subject.provider),
    workspaceName(subject.workspace),
    started ? `started ${shortAge(started, ctx.now)} ago` : null,
    item ? `waiting on you ${shortAge(item.created_at, ctx.now)}` : null,
    task?.serves.length ? `serves ${task.serves.join(', ')}` : null,
  ].filter(Boolean);

  const words = item?.text || tile?.summary?.text || task?.summary || '';
  const along = alongTheWay(agent?.recent);

  const links: QuietLink[] = [];
  if (tile?.checkin && ctx.api) {
    const api = ctx.api;
    links.push({
      label: 'Cancel check-in',
      onClick: () =>
        act(async () => {
          const r = await api.checkinCancel(tile.ptyId);
          if (!r.success) ctx.notify(r.error || 'failed', 'error');
          return r.success;
        }),
    });
  } else if (tile?.canCheckin) {
    links.push({ label: 'Check in', kbd: '⇧⌘.', onClick: () => ctx.openCheckin(tile.ptyId, subject.name) });
  }
  if (ptyId != null || task) {
    links.push({
      label: 'Rename',
      kbd: '⌘E',
      onClick: () => ctx.openRename({ ptyId, taskId: task?.id ?? null, current: subject.name, provider: subject.provider }),
    });
  }
  if (ptyId != null) links.push({ label: 'Open terminal in Manual', kbd: '⌥⌘0', onClick: () => ctx.goInto(ptyId, 'tile') });
  if (task && !task.confirmed) {
    links.push({
      label: 'Confirm task',
      onClick: () => {
        ctx.copilotApi?.logCeremony('confirm', 'task-confirm');
        taskAct(() => confirmTask(ctx.workspace, task.id), 'Confirmed');
      },
    });
  }
  if (task?.status === 'review') {
    links.push({ label: 'Accept', onClick: () => taskAct(() => closeTask(ctx.workspace, task.id, { status: 'done', accepted: true }), 'Accepted') });
    links.push({ label: 'Discard', onClick: () => taskAct(() => closeTask(ctx.workspace, task.id, { status: 'discarded' }), 'Discarded') });
  }
  if (task && task.status !== 'done' && task.status !== 'discarded') {
    links.push({ label: 'Link to a goal…', onClick: () => setPanel((p) => (p === 'link' ? null : 'link')) });
    if (!task.workstream) {
      links.push({
        label: 'Promote…',
        onClick: () => taskAct(() => promoteTask(ctx.workspace, task.id, task.name || undefined), 'Promoted to a workstream'),
      });
    }
    links.push({
      label: 'Escalate → Explore',
      onClick: () =>
        act(async () => {
          const r = await escalateTask(ctx.workspace, task.id);
          if (!r.ok) {
            ctx.notify(r.error, 'error');
            return false;
          }
          ctx.hester.refresh();
          ctx.notify(`Exploration started: ${r.data.exploration.title}`);
          // The task stays open; its exploration is in the Library.
          ctx.setSection('library');
          ctx.selectRow(`explore:${r.data.exploration.id}`);
          return true;
        }),
    });
    links.push({
      label: view.phase === 'loading' ? 'Asking Hester…' : "Hester's view",
      onClick: () => {
        if (view.phase === 'loading') return;
        const seq = ++viewSeq.current;
        setView({ phase: 'loading' });
        void suggestTask(ctx.workspace, task.id).then((r) => {
          if (!alive.current || seq !== viewSeq.current) return;
          setView(r.ok ? { phase: 'done', answer: r.data } : { phase: 'error', error: r.error });
        });
      },
    });
    links.push({ label: 'Priority…', onClick: () => setPanel((p) => (p === 'priority' ? null : 'priority')) });
  }
  if (tile && !tile.task && ptyId != null) links.push({ label: 'Assign…', onClick: () => setPanel((p) => (p === 'assign' ? null : 'assign')) });
  if (tile) {
    links.push({
      label: confirmClose ? 'Agent is working — close anyway?' : 'Close agent',
      onClick: () => {
        if (tile.working && !confirmClose) {
          setConfirmClose(true);
          return;
        }
        setConfirmClose(false);
        ctx.closeAgent(tile.ptyId, tile.tabId);
        ctx.notify(`Closed ${subject.name}`);
        onBack();
      },
    });
  }

  return (
    <div ref={rootRef} className="work-detail" tabIndex={-1} aria-label={subject.name}>
      <nav className="work-detail-nav">
        <Btn kind="quiet" onClick={onBack}>
          ‹ Work
        </Btn>
        <span className="work-detail-esc">esc</span>
      </nav>

      <header className="work-detail-head">
        <div className="work-detail-title">
          <Dot kind={dot} />
          <h2 className="work-detail-name">{subject.name}</h2>
        </div>
        {meta.length > 0 && <div className="work-detail-meta">{meta.join(' · ')}</div>}
      </header>

      {words && (
        <>
          <Eyebrow>{item ? 'It asked' : 'It said'}</Eyebrow>
          <div className="work-prose">
            <AgentMarkdown text={words} />
          </div>
        </>
      )}

      {approval && (
        <div className="work-pending">
          <div className="work-card-line">{approvalLine(approval)}</div>
          {approval.tool?.preview && <pre className="work-command">{approval.tool.preview}</pre>}
          <div className="work-card-actions">
            <Btn kind="next" kbd="⌘⏎" disabled={busy} onClick={() => act(() => decide(ctx, approval, 'approve'))}>
              Allow
            </Btn>
            <Btn kind="plain" kbd="⌘D" disabled={busy} onClick={() => act(() => decide(ctx, approval, 'deny'))}>
              Deny
            </Btn>
          </div>
        </div>
      )}

      {item && question && (
        <div className="work-pending">
          <div className="work-card-line">{question.question}</div>
          {question.options.length > 0 && (
            <div className="work-chips">
              {question.options.map((o, i) => (
                <Chip
                  key={`${i}:${o.label}`}
                  label={o.label}
                  title={choosable(item) ? o.description ?? undefined : 'Answer this one in its terminal'}
                  disabled={!choosable(item) || busy}
                  onClick={() => act(() => choose(ctx, item, i))}
                />
              ))}
            </div>
          )}
          {!choosable(item) && <div className="work-hint">Answer this one in its terminal (Open terminal in Manual).</div>}
        </div>
      )}

      {replyItem && (
        <div className="work-reply">
          <div className="work-chips">
            {quickReplies('detail').map((q) => (
              <Chip key={q} label={q} disabled={busy} onClick={() => send(q)} />
            ))}
          </div>
          <textarea
            ref={replyRef}
            className="work-reply-field"
            value={text}
            rows={3}
            placeholder="Or write a reply"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <div className="work-reply-foot">
            <span className="work-hint">Sent exactly as written</span>
            {/* Allow is this view's next step while an approval is pending (§0 rule 1). */}
            <Btn kind={approval ? 'plain' : 'next'} kbd="⌘⏎" disabled={busy || !text.trim()} onClick={() => send(text)}>
              Send
            </Btn>
          </div>
        </div>
      )}

      {tile?.checkin && (
        <div className="work-hint" title={CHECKIN_PROMPT}>
          {tile.checkin.state === 'queued' ? 'A check-in is queued: Lee types it when this turn ends.' : 'Checked in; waiting for the reply.'}
        </div>
      )}

      {along.length > 0 && (
        <>
          <Eyebrow>Along the way</Eyebrow>
          <ol className="work-along">
            {along.map((a, i) => (
              <li key={`${a.at}:${i}`} className={a.failed ? 'is-failed' : undefined}>
                <span className="work-along-time">{clockTime(a.at)}</span>
                <span className="work-along-text">{a.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}

      {links.length > 0 && <QuietLinks items={links} />}
      {panel === 'assign' && tile && ptyId != null && (
        <AssignPicker
          ctx={ctx}
          target={{ ptyId, label: subject.name, provider: subject.provider, sessionId: subject.sessionId }}
          onDone={() => setPanel(null)}
        />
      )}
      {panel === 'link' && task && <LinkPicker ctx={ctx} task={task} onDone={() => setPanel(null)} />}
      {panel === 'priority' && task && <PriorityPicker ctx={ctx} task={task} onDone={() => setPanel(null)} />}
      {view.phase === 'loading' && <div className="work-hint">Hester is weighing which goals this serves and where to start…</div>}
      {view.phase === 'error' && <div className="work-error">{view.error}</div>}
      {view.phase === 'done' && (
        <StewardAnswerView key={view.answer.request_id} ctx={ctx} answer={view.answer} onClose={() => setView({ phase: 'idle' })} />
      )}
    </div>
  );
};

/** The detail's display name for a task with no agent tile. */
export function taskName(task: CockpitTask): string {
  return taskTitle(task) || task.title;
}

export default WorkDetail;
