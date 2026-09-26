/**
 * ExploreSection - deeper dives (spec §7.5; v3 contract: Explore absorbs the
 * Library). Someday is quick capture; Explore is where an idea gets a
 * durable, open-ended investigation with Hester.
 *
 * Each exploration is a file in the workspace's .hester/explore/ (Hester's
 * ExplorationStore) holding a node tree: the root (Seed + Log), branches
 * (the Library's nodes), decisions, spikes and their evidence. "Dive in"
 * asks Hester to seed the chat session explore-<id> from the file, then opens
 * it as a Hester tab; "Open tree" opens the Library tab on the same file.
 * Decisions, spikes, promotes and archive are deterministic (no model), and
 * no action needs a reason.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../Icon';
import { formatAge, formatDuration } from '../../../lib/cockpitModel';
import {
  archiveExploration,
  createExploration,
  decideExploration,
  getExploration,
  listExplorations,
  patchExploration,
  patchExploreNode,
  promoteExploration,
  pruneExploreNode,
  startSpike,
  workspacePath,
  type Exploration,
  type ExplorationPromoteTo,
  type ExploreNode,
} from '../../../lib/hesterCockpit';
import { AgentMarkdown } from '../AgentMarkdown';
import type { CockpitCtx, RowHandle } from '../CockpitHost';

interface ExploreSectionProps {
  ctx: CockpitCtx;
  /** Bumped by the header's "+ Explore": focus the new-exploration field. */
  focusCreateNonce: number;
}

/** An expanded row's tree: null while loading, a string on error. */
type TreeState = Exploration | string | null;

type RowForm =
  | { kind: 'spike'; parent: string | null; prompt: string }
  | { kind: 'decide'; text: string; reason: string }
  | { kind: 'menu'; menu: 'promote' | 'archive' };

const KIND_ICON: Record<string, IconName> = {
  thought: 'chat',
  source_file: 'file-code',
  source_web: 'browser',
  source_db: 'sql',
  decision: 'check',
  spike: 'play',
  evidence: 'document',
};

const KIND_LABEL: Record<string, string> = {
  thought: 'branch',
  source_file: 'file',
  source_web: 'web',
  source_db: 'db',
  decision: 'decision',
  spike: 'spike',
  evidence: 'evidence',
};

/** Nodes in outline order (depth-first from the root), with their depth. */
export function outlineOrder(nodes: ExploreNode[]): Array<{ node: ExploreNode; depth: number }> {
  const byParent = new Map<string | null, ExploreNode[]>();
  for (const n of nodes) {
    const key = n.parent ?? null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  const out: Array<{ node: ExploreNode; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of byParent.get(parent) ?? []) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans (a parent that is missing) still show, at the top level.
  for (const n of nodes) if (!seen.has(n.id)) out.push({ node: n, depth: 0 });
  return out;
}

const SPIKE_PARENT_KINDS = new Set(['thought', 'source_file', 'source_web', 'source_db']);

export const ExploreSection: React.FC<ExploreSectionProps> = ({ ctx, focusCreateNonce }) => {
  const workspace = ctx.workspace;
  const [items, setItems] = useState<Exploration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [trees, setTrees] = useState<Record<string, TreeState>>({});
  const [forms, setForms] = useState<Record<string, RowForm | undefined>>({});
  const [reasonEdit, setReasonEdit] = useState<{ nodeId: string; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    listExplorations(workspace, showArchived ? 'all' : 'active').then((r) => {
      if (r.ok) {
        setItems(r.data);
        setError(null);
      } else setError(r.error);
    });
  }, [workspace, showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (focusCreateNonce > 0) inputRef.current?.focus();
  }, [focusCreateNonce]);

  const loadTree = useCallback(
    (id: string) => {
      getExploration(workspace, id).then((r) => setTrees((t) => (id in t ? { ...t, [id]: r.ok ? r.data : r.error } : t)));
    },
    [workspace],
  );

  /** After a change: refresh the list, and the tree when it is open. */
  const refresh = (id: string) => {
    load();
    if (id in trees) loadTree(id);
  };

  const setForm = (id: string, form: RowForm | undefined) => setForms((f) => ({ ...f, [id]: form }));

  const create = async (dive: boolean) => {
    const body = text.trim();
    if (!body) return;
    setBusy('create');
    try {
      const r = await createExploration(workspace, { seed: body, origin: { kind: 'cockpit' } });
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      setText('');
      load();
      ctx.selectRow(`explore:${r.data.id}`);
      if (dive) await ctx.openExploration(r.data);
      else ctx.notify(`Exploration started: ${r.data.title}`);
    } finally {
      setBusy(null);
    }
  };

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const unarchive = (exp: Exploration) =>
    withBusy(exp.id, async () => {
      const r = await patchExploration(workspace, exp.id, { status: 'active' });
      if (!r.ok) ctx.notify(r.error, 'error');
      load();
    });

  const archive = (exp: Exploration, asKnowledge: boolean) =>
    withBusy(exp.id, async () => {
      setForm(exp.id, undefined);
      const r = await archiveExploration(workspace, exp.id, asKnowledge);
      if (!r.ok) ctx.notify(r.error, 'error');
      else if (asKnowledge && r.data.knowledge_path) ctx.notify(`Archived as knowledge: ${r.data.knowledge_path}`);
      else ctx.notify('Archived');
      load();
    });

  const promote = (exp: Exploration, to: ExplorationPromoteTo) =>
    withBusy(exp.id, async () => {
      setForm(exp.id, undefined);
      const r = await promoteExploration(workspace, exp.id, { to });
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      refresh(exp.id);
      if (to === 'task') {
        ctx.hester.refresh();
        ctx.notify(`Promoted to a task${r.data.task ? `: ${r.data.task.title}` : ''}`);
      } else if (to === 'workstream' && r.data.workstream_id) {
        ctx.openWorkstream(r.data.workstream_id, r.data.title || exp.title);
      } else if (to === 'goal' && r.data.draft_path) {
        ctx.openFile(workspacePath(workspace, r.data.draft_path));
      } else ctx.notify(`Promoted to a ${to}`);
    });

  const decide = (exp: Exploration, form: Extract<RowForm, { kind: 'decide' }>) =>
    withBusy(exp.id, async () => {
      const t = form.text.trim();
      if (!t) return;
      const r = await decideExploration(workspace, exp.id, { text: t, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) });
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        return;
      }
      setForm(exp.id, undefined);
      ctx.notify('Decision recorded');
      refresh(exp.id);
    });

  const spike = (exp: Exploration, form: Extract<RowForm, { kind: 'spike' }>) =>
    withBusy(exp.id, async () => {
      const prompt = form.prompt.trim();
      if (!prompt) return;
      if (!ctx.api) {
        ctx.notify('Launching needs the Cockpit runtime', 'error');
        return;
      }
      const api = ctx.api;
      const r = await startSpike(
        workspace,
        exp.id,
        { ...(form.parent ? { parent: form.parent } : {}), prompt, title: prompt.split('\n')[0].slice(0, 60) },
        (req) => api.launch(req),
      );
      if (!r.ok) {
        ctx.notify(r.error, 'error');
        refresh(exp.id);
        return;
      }
      setForm(exp.id, undefined);
      ctx.notify(r.data.launch.relayed === false ? 'Spike launched (task record queued for Hester)' : 'Spike launched');
      ctx.hester.refresh();
      refresh(exp.id);
    });

  const prune = (exp: Exploration, node: ExploreNode) =>
    withBusy(exp.id, async () => {
      const r = await pruneExploreNode(workspace, exp.id, node.id);
      if (!r.ok) ctx.notify(r.error, 'error');
      refresh(exp.id);
    });

  const saveReason = (exp: Exploration, nodeId: string, reason: string) =>
    withBusy(exp.id, async () => {
      const r = await patchExploreNode(workspace, exp.id, nodeId, { reason: reason.trim() || null });
      if (!r.ok) ctx.notify(r.error, 'error');
      setReasonEdit(null);
      refresh(exp.id);
    });

  const toggleTree = (exp: Exploration) => {
    if (exp.id in trees) {
      setTrees((t) => {
        const next = { ...t };
        delete next[exp.id];
        return next;
      });
      return;
    }
    setTrees((t) => ({ ...t, [exp.id]: null }));
    loadTree(exp.id);
  };

  const dive = (exp: Exploration) => withBusy(exp.id, () => ctx.openExploration(exp));

  const openTask = (taskId: string) => {
    ctx.setSection('tasks');
    ctx.selectRow(`task:${taskId}`);
  };

  const list = items ?? [];
  const handles: RowHandle[] = list.map((e) => ({
    id: `explore:${e.id}`,
    title: e.title,
    open: () => void dive(e),
    about: { kind: 'exploration', id: e.id, label: e.title },
  }));
  useEffect(() => {
    ctx.registerRows(handles);
  });
  const sel = ctx.mode.selected;
  const filePath = (id: string) => workspacePath(workspace, `.hester/explore/${id}.md`);

  const renderNode = (exp: Exploration, node: ExploreNode, depth: number) => {
    const isRoot = node.id === 'root' || node.parent == null;
    const pruned = !!node.pruned;
    const canBranch = SPIKE_PARENT_KINDS.has(node.kind) && !pruned;
    const icon: IconName = isRoot ? 'book' : KIND_ICON[node.kind] ?? 'dot';
    const d = node.decision;
    const sp = node.spike;
    const ev = node.evidence;
    const elapsedMs = sp?.started_at ? (sp.ended_at ? Date.parse(sp.ended_at) : ctx.now) - Date.parse(sp.started_at) : null;
    const files = ev?.files ?? [];
    const commits = ev?.commits ?? [];
    const chosen = d?.chosen ?? [];
    const prunedIds = d?.pruned ?? [];
    // Decision targets by label when the node is in this exploration (ids otherwise).
    const labelOf = (id: string) => (exp.nodes ?? []).find((n) => n.id === id)?.label || id;
    return (
      <div key={node.id} className={`cockpit-explore-node${pruned ? ' is-pruned' : ''}`} style={{ paddingLeft: depth * 16 }}>
        <div className="cockpit-explore-node-line">
          <Icon name={icon} size={11} />
          <span className="cockpit-explore-node-label" title={node.label}>
            {node.kind === 'decision' && d ? d.text || node.label : node.label}
          </span>
          {!isRoot && <span className="cockpit-tag">{KIND_LABEL[node.kind] ?? node.kind}</span>}
          {pruned && <span className="cockpit-tag">pruned</span>}
          {sp && <span className={`cockpit-status st-${sp.status}`}>{sp.status}</span>}
          {sp && (
            <span className="cockpit-muted">
              {elapsedMs != null && elapsedMs >= 0 ? formatDuration(elapsedMs) : '0m'}
              {sp.timebox_min != null ? ` / ${sp.timebox_min}m` : ''}
            </span>
          )}
          {sp?.task_id && (
            <button className="cockpit-link" onClick={() => openTask(sp.task_id as string)} title="Show the spike's task">
              {sp.task_id}
            </button>
          )}
          {(node.turns ?? 0) > 0 && <span className="cockpit-muted">{node.turns} exchange{node.turns === 1 ? '' : 's'}</span>}
          {canBranch && (
            <span className="cockpit-explore-node-actions">
              {!isRoot && (
                <button className="cockpit-btn" disabled={busy === exp.id} onClick={() => void prune(exp, node)}>
                  Prune
                </button>
              )}
              <button className="cockpit-btn" onClick={() => setForm(exp.id, { kind: 'spike', parent: node.id, prompt: node.label })}>
                Spike from here
              </button>
            </span>
          )}
        </div>
        {d && (chosen.length > 0 || prunedIds.length > 0) && (
          <div className="cockpit-explore-node-detail cockpit-muted">
            {chosen.length > 0 && <span>Chosen: {chosen.map(labelOf).join(', ')}</span>}
            {chosen.length > 0 && prunedIds.length > 0 && ' · '}
            {prunedIds.length > 0 && <span>Pruned: {prunedIds.map(labelOf).join(', ')}</span>}
          </div>
        )}
        {d && (
          <div className="cockpit-explore-node-detail">
            {reasonEdit?.nodeId === node.id ? (
              <span className="cockpit-explore-inline">
                <input
                  className="cockpit-input"
                  autoFocus
                  value={reasonEdit.text}
                  placeholder="Reason (optional)"
                  onChange={(e) => setReasonEdit({ nodeId: node.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void saveReason(exp, node.id, reasonEdit.text);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setReasonEdit(null);
                    }
                  }}
                />
                <button className="cockpit-btn" disabled={busy === exp.id} onClick={() => void saveReason(exp, node.id, reasonEdit.text)}>
                  Save
                </button>
                <button className="cockpit-btn" onClick={() => setReasonEdit(null)}>
                  Cancel
                </button>
              </span>
            ) : d.reason ? (
              <span>
                Reason: {d.reason}{' '}
                <button className="cockpit-link" onClick={() => setReasonEdit({ nodeId: node.id, text: d.reason ?? '' })}>
                  edit
                </button>
              </span>
            ) : (
              <button className="cockpit-link" onClick={() => setReasonEdit({ nodeId: node.id, text: '' })}>
                add reason
              </button>
            )}
          </div>
        )}
        {ev && (
          <div className="cockpit-explore-node-detail">
            {ev.summary && (
              <div className="cockpit-agent-words">
                <span className="cockpit-agent-label">Agent’s claim:</span> {ev.summary}
              </div>
            )}
            {ev.diffstat && <pre className="cockpit-explore-diffstat">{ev.diffstat}</pre>}
            <span className="cockpit-muted">
              {files.length} file{files.length === 1 ? '' : 's'}
              {commits.length ? ` · ${commits.length} commit${commits.length === 1 ? '' : 's'}` : ''}
              {ev.captured_at ? ` · captured ${formatAge(ev.captured_at, ctx.now)}` : ''}
            </span>
            {ev.diff_path && (
              <button className="cockpit-btn" onClick={() => ctx.openFile(workspacePath(workspace, ev.diff_path as string))}>
                <Icon name="file-code" size={11} /> Open diff
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderForm = (exp: Exploration, form: RowForm) => {
    if (form.kind === 'menu') {
      const items: Array<[string, () => void]> =
        form.menu === 'promote'
          ? [
              ['Task', () => void promote(exp, 'task')],
              ['Workstream', () => void promote(exp, 'workstream')],
              ['Goal draft', () => void promote(exp, 'goal')],
            ]
          : [
              ['Archive', () => void archive(exp, false)],
              ['Archive as knowledge', () => void archive(exp, true)],
            ];
      return (
        <div className="cockpit-explore-menu">
          {items.map(([label, fn]) => (
            <button key={label} className="cockpit-menu-item" disabled={busy === exp.id} onClick={fn}>
              {label}
            </button>
          ))}
        </div>
      );
    }
    if (form.kind === 'spike') {
      return (
        <div className="cockpit-explore-form">
          <div className="cockpit-muted">
            Spike: a delegate agent in a git worktree (30 min timebox); its summary and diff come back as evidence.
          </div>
          <textarea
            className="cockpit-input"
            rows={3}
            autoFocus
            value={form.prompt}
            placeholder="What should the spike try?"
            onChange={(e) => setForm(exp.id, { ...form, prompt: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void spike(exp, form);
              }
            }}
          />
          <div className="cockpit-row-actions">
            <button className="cockpit-btn is-primary" disabled={!form.prompt.trim() || busy === exp.id} onClick={() => void spike(exp, form)}>
              <Icon name="play" size={11} /> Start spike
            </button>
            <button className="cockpit-btn" onClick={() => setForm(exp.id, undefined)}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="cockpit-explore-form">
        <input
          className="cockpit-input"
          autoFocus
          value={form.text}
          placeholder="What did you decide?"
          onChange={(e) => setForm(exp.id, { ...form, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void decide(exp, form);
            }
          }}
        />
        <input
          className="cockpit-input"
          value={form.reason}
          placeholder="Reason (optional)"
          onChange={(e) => setForm(exp.id, { ...form, reason: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void decide(exp, form);
            }
          }}
        />
        <div className="cockpit-row-actions">
          <button className="cockpit-btn is-primary" disabled={!form.text.trim() || busy === exp.id} onClick={() => void decide(exp, form)}>
            Record decision
          </button>
          <button className="cockpit-btn" onClick={() => setForm(exp.id, undefined)}>
            Cancel
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="cockpit-sec">
      <header className="cockpit-sec-head">
        <h2>Explore</h2>
        <span className="cockpit-muted">Deeper dives with Hester, kept in .hester/explore/</span>
        <span className="cockpit-header-spacer" />
        <label className="cockpit-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> archived
        </label>
      </header>
      <div className="cockpit-capture">
        <input
          ref={inputRef}
          className="cockpit-input"
          value={text}
          placeholder="What do you want to dig into? (Enter creates, ⇧Enter creates and dives in)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void create(e.shiftKey);
            }
          }}
        />
        <button className="cockpit-btn" disabled={!text.trim() || busy === 'create'} onClick={() => void create(false)}>
          <Icon name="plus" size={12} /> Explore
        </button>
        <button className="cockpit-btn is-primary" disabled={!text.trim() || busy === 'create'} onClick={() => void create(true)}>
          <Icon name="chat" size={12} /> Create & dive in
        </button>
      </div>
      {error && <div className="cockpit-offline">{error}</div>}
      {!items && !error && <div className="cockpit-muted">Loading…</div>}
      {items && list.length === 0 && (
        <div className="cockpit-empty">
          No explorations yet. Start one here, promote a Someday idea with "Promote → Explore", or escalate a task.
        </div>
      )}
      <div className="cockpit-rows">
        {list.map((exp, i) => {
          const archived = exp.status === 'archived';
          const id = handles[i].id;
          const tree = trees[exp.id];
          const form = forms[exp.id];
          const menu = form?.kind === 'menu' ? form.menu : null;
          return (
            <div
              key={exp.id}
              data-cockpit-row={id}
              className={`cockpit-row${sel?.kind === 'row' && sel.id === id ? ' is-selected' : ''}${archived ? ' is-closed' : ''}`}
              onClick={() => ctx.selectRow(id)}
            >
              <div className="cockpit-row-head">
                <span className="cockpit-row-title">{exp.title}</span>
              </div>
              <div className="cockpit-row-meta">
                {formatAge(exp.last_touched_at ?? exp.updated_at, ctx.now)} · {exp.turns} exchange{exp.turns === 1 ? '' : 's'}
                {exp.origin?.kind === 'someday' && <span className="cockpit-tag">from Someday</span>}
                {exp.origin?.kind === 'task' && <span className="cockpit-tag">from a task</span>}
                {exp.origin?.kind === 'library' && <span className="cockpit-tag">from the Library</span>}
                {(exp.promoted ?? []).map((p, i) => (
                  <span key={`${p.to}:${p.ref}:${p.at ?? ''}:${i}`} className="cockpit-tag is-ok" title={p.ref}>
                    → {p.to}
                  </span>
                ))}
                {archived && <span className="cockpit-tag">archived</span>}
              </div>
              <div className="cockpit-row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="cockpit-btn is-primary" disabled={busy === exp.id} onClick={() => void dive(exp)}>
                  <Icon name="chat" size={11} /> {exp.turns > 0 ? 'Continue' : 'Dive in'}
                </button>
                <button className="cockpit-btn" onClick={() => ctx.openLibrary(exp.id)} title="Open this exploration's tree in the Library">
                  <Icon name="list" size={11} /> Open tree
                </button>
                <button className="cockpit-btn" onClick={() => toggleTree(exp)}>
                  {exp.id in trees ? 'Hide outline' : 'Outline'}
                </button>
                {!archived && (
                  <>
                    <button
                      className={`cockpit-btn${form?.kind === 'spike' ? ' is-active' : ''}`}
                      onClick={() => setForm(exp.id, form?.kind === 'spike' ? undefined : { kind: 'spike', parent: null, prompt: exp.title })}
                    >
                      Spike…
                    </button>
                    <button
                      className={`cockpit-btn${form?.kind === 'decide' ? ' is-active' : ''}`}
                      onClick={() => setForm(exp.id, form?.kind === 'decide' ? undefined : { kind: 'decide', text: '', reason: '' })}
                    >
                      Decide…
                    </button>
                    <button
                      className={`cockpit-btn${menu === 'promote' ? ' is-active' : ''}`}
                      disabled={busy === exp.id}
                      onClick={() => setForm(exp.id, menu === 'promote' ? undefined : { kind: 'menu', menu: 'promote' })}
                    >
                      Promote ▾
                    </button>
                  </>
                )}
                <button className="cockpit-btn" onClick={() => ctx.openFile(filePath(exp.id))} title="Open the exploration file in the Workbench">
                  <Icon name="file-code" size={11} /> File
                </button>
                {archived ? (
                  <button className="cockpit-btn" disabled={busy === exp.id} onClick={() => void unarchive(exp)}>
                    Unarchive
                  </button>
                ) : (
                  <button
                    className={`cockpit-btn${menu === 'archive' ? ' is-active' : ''}`}
                    disabled={busy === exp.id}
                    onClick={() => setForm(exp.id, menu === 'archive' ? undefined : { kind: 'menu', menu: 'archive' })}
                  >
                    Archive ▾
                  </button>
                )}
              </div>
              {form && (
                <div onClick={(e) => e.stopPropagation()}>
                  {renderForm(exp, form)}
                </div>
              )}
              {exp.id in trees && (
                <div className="cockpit-explore-notes" onClick={(e) => e.stopPropagation()}>
                  {tree == null ? (
                    <span className="cockpit-muted">Loading…</span>
                  ) : typeof tree === 'string' ? (
                    <span className="cockpit-muted">{tree}</span>
                  ) : (
                    <>
                      <div className="cockpit-explore-tree">
                        {outlineOrder(tree.nodes?.length ? tree.nodes : [{ id: 'root', parent: null, label: tree.title, kind: 'thought', created_at: tree.created_at }]).map(
                          ({ node, depth }) => renderNode(tree, node, depth),
                        )}
                      </div>
                      {tree.body && (
                        <details className="cockpit-explore-log">
                          <summary className="cockpit-muted">Seed and log</summary>
                          <AgentMarkdown text={tree.body} />
                        </details>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ExploreSection;
