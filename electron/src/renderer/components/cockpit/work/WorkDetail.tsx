/**
 * WorkDetail - one agent, item or task, in place of Work's list
 * (cockpit-design §4.2): the header, "It asked" / "It said" as prose, the
 * pending action (an approval's command with Allow and Deny, a question's
 * options), the reply box (all four quick replies, a textarea sent exactly
 * as written, C3: it answers the item that takes text, else types into the
 * idle agent's terminal, and waits disabled while the agent works), the
 * Updates feed (its recent turn summaries and lee-status), "Along the way"
 * from its activity (§7.1, folded) and the actions: icons for Resume (a
 * not-open task's Claude session), Check in, Rename, Open terminal in
 * Manual, Confirm, Accept / Discard and Close agent; a ⋯ menu for Link to a goal…, Priority…, Promote… (to a
 * workstream), Escalate → Explore (an exploration seeded from it, shown in
 * the Library), Hester's view (/suggest, answered inline with its
 * proposals) and Assign….
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
  REPLY_BUSY_LINE,
  alongLabel,
  alongTheWay,
  approvalLine,
  canTextReply,
  clockTime,
  detailActions,
  providerLabel,
  quickReplies,
  replyMode,
  resumableSession,
  sendIsNext,
  shortAge,
  tabSendError,
  updatesFeed,
  workspaceName,
  type DetailActionId,
} from '../../../lib/workModel';
import { agentUsageDetail } from '../../../lib/usageModel';
import type { IconName } from '../../Icon';
import { Btn, Chip, Dot, Eyebrow, IconAction, type DotKind } from '../ui';
import { AgentMarkdown } from '../AgentMarkdown';
import { StewardAnswerView } from '../StewardAnswerView';
import type { CockpitCtx } from '../CockpitHost';
import { choosable, choose, decide, sendText } from './actions';
import { MoreMenu, type MoreItem } from './MoreMenu';
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
  /** A resumed task's new agent (its pty): WorkSection opens its detail. */
  onResumed?: (ptyId: number) => void;
}

type Panel = 'assign' | 'link' | 'priority' | null;
type ViewState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; answer: StewardAnswer } | { phase: 'error'; error: string };

export const WorkDetail: React.FC<WorkDetailProps> = ({ ctx, subject, focusReply, openLink, onBack, onResumed }) => {
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
  const working = tile ? tile.working : agent?.state === 'busy';
  const mode = replyMode({ replyItem, ptyId, working });
  const cleared = () => {
    if (alive.current) setText('');
  };
  const send = (body: string) => {
    if (replyItem) {
      act(() => sendText(ctx, replyItem, body), cleared);
      return;
    }
    const api = ctx.api;
    const typed = body.trim();
    if (mode !== 'pty' || !api || ptyId == null || !typed) return;
    // No item takes text: type it into the idle agent's terminal (the main side refuses busy / awaiting states).
    act(async () => {
      try {
        const r = await api.tabs.send(ptyId, { text: typed, submit: true, purpose: 'reply' });
        if (!r.success) ctx.notify(tabSendError(r.error), 'error');
        return r.success;
      } catch {
        ctx.notify('failed', 'error');
        return false;
      }
    }, cleared);
  };

  const dot: DotKind = item ? 'needs' : tile?.working ? 'working' : task?.status === 'review' ? 'done' : tile?.needsYou ? 'needs' : 'idle';
  const started = task?.created_at ?? subject.busySince;
  const meta = [
    providerLabel(subject.provider),
    workspaceName(subject.workspace),
    started ? `started ${shortAge(started, ctx.now)} ago` : null,
    agentUsageDetail(agent?.usage) || null,
    item ? `waiting on you ${shortAge(item.created_at, ctx.now)}` : null,
    task?.serves.length ? `serves ${task.serves.join(', ')}` : null,
  ].filter(Boolean);

  const words = item?.text || tile?.summary?.text || task?.summary || '';
  const along = alongTheWay(agent?.recent);

  const updates = updatesFeed(agent?.updates, item ? null : words);
  const [alongOpen, setAlongOpen] = useState(false);

  const resumeId = !tile && ptyId == null ? resumableSession(task) : null;
  const { icons, more } = detailActions({ tile, ptyId, task, resumable: !!resumeId && !!ctx.api?.resume });
  // Resume through Lee main, so the tab gets Lee's hooks and the task link:
  // `claude --resume` in the task's worktree while it exists, else the workspace root.
  const resume = () => {
    const run = ctx.api?.resume;
    if (!task || !resumeId || !run) return;
    act(async () => {
      try {
        const r = await run({
          workspace: ctx.workspace,
          task_id: task.id,
          session_id: resumeId,
          cwd: task.worktree?.path ?? null,
          label: subject.name,
        });
        if (!r.success || r.pty_id == null) {
          ctx.notify(r.error || 'failed', 'error');
          return false;
        }
        if (r.fell_back) ctx.notify(`Resumed ${subject.name} in the workspace root: its worktree is gone, so Claude may start fresh`);
        if (onResumed) onResumed(r.pty_id);
        return true;
      } catch {
        ctx.notify('failed', 'error');
        return false;
      }
    });
  };
  const checkinCancel = () => {
    const api = ctx.api;
    if (!tile || !api) return;
    act(async () => {
      const r = await api.checkinCancel(tile.ptyId);
      if (!r.success) ctx.notify(r.error || 'failed', 'error');
      return r.success;
    });
  };
  const hesterView = () => {
    if (!task || view.phase === 'loading') return;
    const seq = ++viewSeq.current;
    setView({ phase: 'loading' });
    void suggestTask(ctx.workspace, task.id).then((r) => {
      if (!alive.current || seq !== viewSeq.current) return;
      setView(r.ok ? { phase: 'done', answer: r.data } : { phase: 'error', error: r.error });
    });
  };
  const escalate = () => {
    if (!task) return;
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
    });
  };
  const closeAgent = () => {
    if (!tile) return;
    if (tile.working && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    ctx.closeAgent(tile.ptyId, tile.tabId);
    ctx.notify(`Closed ${subject.name}`);
    onBack();
  };
  const togglePanel = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));

  interface ActionSpec {
    icon: IconName;
    label: string;
    onClick: () => void;
    kbd?: string;
    title?: string;
    open?: boolean;
    danger?: boolean;
    disabled?: boolean;
  }
  const spec = (id: DetailActionId): ActionSpec | null => {
    switch (id) {
      case 'resume':
        return { icon: 'play', label: 'Resume', title: 'Resume its Claude session in a new tab', disabled: busy || !ctx.api?.resume, onClick: resume };
      case 'cancel-checkin':
        return {
          icon: 'stop',
          label: 'Cancel check-in',
          title: tile?.checkin?.state === 'queued' ? 'Cancel the queued check-in (nothing has been typed)' : 'Stop waiting for the reply',
          disabled: busy || !ctx.api,
          onClick: checkinCancel,
        };
      case 'checkin':
        return tile ? { icon: 'chat', label: 'Check in', kbd: '⇧⌘.', title: `Check in (⇧⌘.): types exactly “${CHECKIN_PROMPT}”`, onClick: () => ctx.openCheckin(tile.ptyId, subject.name) } : null;
      case 'rename':
        return {
          icon: 'edit',
          label: 'Rename',
          kbd: '⌘E',
          onClick: () => ctx.openRename({ ptyId, taskId: task?.id ?? null, current: subject.name, provider: subject.provider }),
        };
      case 'terminal':
        return ptyId != null ? { icon: 'terminal', label: 'Open terminal in Manual', kbd: '⌥⌘0', onClick: () => ctx.goInto(ptyId, 'tile') } : null;
      case 'confirm':
        return task
          ? {
              icon: 'check',
              label: 'Confirm task',
              disabled: busy,
              onClick: () => {
                ctx.copilotApi?.logCeremony('confirm', 'task-confirm');
                taskAct(() => confirmTask(ctx.workspace, task.id), 'Confirmed');
              },
            }
          : null;
      case 'accept':
        return task
          ? {
              icon: 'check',
              label: 'Accept',
              title: "Accept this task's work",
              disabled: busy,
              onClick: () => taskAct(() => closeTask(ctx.workspace, task.id, { status: 'done', accepted: true }), 'Accepted'),
            }
          : null;
      case 'discard':
        return task
          ? {
              icon: 'trash',
              label: 'Discard',
              title: "Discard this task's work",
              disabled: busy,
              onClick: () => taskAct(() => closeTask(ctx.workspace, task.id, { status: 'discarded' }), 'Discarded'),
            }
          : null;
      case 'close':
        return tile
          ? {
              icon: 'power',
              label: confirmClose ? 'Working — close anyway?' : 'Close agent',
              title: tile.working ? 'Close this agent (it is working: asks once more)' : 'Close this agent and its tab',
              open: confirmClose,
              danger: confirmClose,
              onClick: closeAgent,
            }
          : null;
      default:
        return null;
    }
  };
  const moreSpec: Partial<Record<DetailActionId, { label: string; onClick: () => void; disabled?: boolean }>> = {
    link: { label: 'Link to a goal…', onClick: () => togglePanel('link') },
    priority: { label: 'Priority…', onClick: () => togglePanel('priority') },
    promote: {
      label: 'Promote…',
      disabled: busy,
      onClick: () => task && taskAct(() => promoteTask(ctx.workspace, task.id, task.name || undefined), 'Promoted to a workstream'),
    },
    escalate: { label: 'Escalate → Explore', disabled: busy, onClick: escalate },
    'hester-view': { label: view.phase === 'loading' ? 'Asking Hester…' : "Hester's view", disabled: view.phase === 'loading', onClick: hesterView },
    assign: { label: 'Assign…', onClick: () => togglePanel('assign') },
  };
  const moreItems: MoreItem[] = more.map((id) => moreSpec[id]).filter((x): x is MoreItem => !!x);
  const iconItems = icons.map((id) => ({ id, spec: spec(id) })).filter((x): x is { id: DetailActionId; spec: ActionSpec } => !!x.spec);

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

      {mode !== 'none' && (
        <div className={`work-reply${mode === 'busy' ? ' is-waiting' : ''}`}>
          <div className="work-chips">
            {quickReplies('detail').map((q) => (
              <Chip key={q} label={q} disabled={busy || mode === 'busy'} onClick={() => send(q)} />
            ))}
          </div>
          <textarea
            ref={replyRef}
            className="work-reply-field"
            value={text}
            rows={3}
            disabled={mode === 'busy'}
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
            <span className="work-hint">{mode === 'busy' ? REPLY_BUSY_LINE : 'Sent exactly as written'}</span>
            {/* Allow is this view's next step while an approval is pending (§0 rule 1). */}
            <Btn kind={sendIsNext(mode, !!approval) ? 'next' : 'plain'} kbd="⌘⏎" disabled={busy || mode === 'busy' || !text.trim()} onClick={() => send(text)}>
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

      {updates.length > 0 && (
        <>
          <Eyebrow>Updates</Eyebrow>
          <ol className="work-updates">
            {updates.map((u, i) => (
              <li key={`${u.at}:${i}`}>
                <span className="work-along-time">{u.time}</span>
                <span className="work-update-body">
                  {u.status && (
                    <span className="work-update-status">
                      {u.needsYou && <Dot kind="needs" label={u.status} />}
                      {u.status}
                    </span>
                  )}
                  {u.text && <span className="work-update-text">{u.text}</span>}
                  {u.next && <span className="work-update-next">next: {u.next}</span>}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      {along.length > 0 && (
        <div className="work-along-fold">
          <button type="button" className="work-fold-toggle" aria-expanded={alongOpen} onClick={() => setAlongOpen((o) => !o)}>
            <span className="work-fold-chevron" aria-hidden="true">
              {alongOpen ? '▾' : '▸'}
            </span>
            {alongLabel(along.length)}
          </button>
          {alongOpen && (
            <ol className="work-along">
              {along.map((a, i) => (
                <li key={`${a.at}:${i}`} className={a.failed ? 'is-failed' : undefined}>
                  <span className="work-along-time">{clockTime(a.at)}</span>
                  <span className="work-along-text">{a.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {(iconItems.length > 0 || moreItems.length > 0) && (
        <nav className="ui-icon-actions work-detail-actions" aria-label="Actions">
          {iconItems.map(({ id, spec: a }) => (
            <IconAction
              key={id}
              icon={a.icon}
              label={a.label}
              kbd={a.kbd}
              title={a.title}
              open={a.open}
              tone={a.danger ? 'danger' : 'default'}
              disabled={a.disabled}
              onClick={a.onClick}
            />
          ))}
          <MoreMenu items={moreItems} icon="more" label="More actions" />
        </nav>
      )}
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
