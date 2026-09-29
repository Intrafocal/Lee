/**
 * The machine-wide attention queue: items, supersede/resolve rules, severity,
 * notify and snapshots (full and compact). Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §5.1, §5.2, §5.4, §7.2;
 * attention policy 'none' during Deep: docs/plans/2026-09-26-deep-d1-contracts.md §2.3;
 * the idle-end push (deep_idle): docs/plans/2026-09-27-desk-foundation-contract.md §9.2.
 */

import * as crypto from 'crypto';
import type {
  Actor,
  AttentionActionName,
  AttentionItem,
  AttentionKind,
  AttentionQuestion,
  AttentionSeverity,
  AttentionSnapshot,
  AttentionSource,
  AwayState,
  FocusState,
  LeeEventInput,
  LeeStatusBlock,
} from '../../shared/copilot';
import type { Quadrant } from '../../shared/cockpit';
import type { CopilotConfig } from './config';
import { AGENT_TEXT_MAX, clip, compactQuestion, isQuestionTool } from './hook-payload';

export const COMPACT_MAX_ITEMS = 25;
export const COMPACT_TEXT_MAX = 280;
const CLOSED_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_ITEM_FILES = 50;

export type Resolution = 'reply' | 'answered_in_tab' | 'superseded' | 'agent_exit' | 'dismissed' | 'expired' | 'returned';

/** Display name for an agent provider key; "Agent" when unknown. */
export function providerLabel(provider: string | null | undefined): string {
  const p = (provider ?? '').trim();
  if (!p) return 'Agent';
  if (p === 'claude') return 'Claude';
  if (p === 'pi') return 'Pi';
  if (p === 'hester') return 'Hester';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

type TitledKind = Exclude<AttentionKind, 'approval' | 'question' | 'failure'>;

const KIND_TITLE_TEMPLATES: Record<TitledKind, string> = {
  waiting: '{agent} is waiting for you',
  blocker: '{agent} is blocked',
  decision: '{agent} needs a decision',
  review: '{agent} finished a turn',
  summary: 'While you were away',
  deep_idle: 'Still thinking?',
};

/** An item title naming the agent's provider ("Pi finished a turn"). */
export function kindTitle(kind: TitledKind, provider: string | null | undefined): string {
  return KIND_TITLE_TEMPLATES[kind].replace('{agent}', providerLabel(provider));
}

const KIND_ACTIONS: Record<AttentionKind, AttentionActionName[]> = {
  approval: ['approve', 'deny', 'open', 'snooze', 'dismiss', 'wake'],
  question: ['choose', 'open', 'snooze', 'dismiss', 'wake'],
  waiting: ['reply', 'open', 'snooze', 'dismiss', 'wake'],
  blocker: ['reply', 'open', 'snooze', 'dismiss', 'wake'],
  decision: ['reply', 'open', 'snooze', 'dismiss', 'wake'],
  failure: ['open', 'dismiss'],
  review: ['reply', 'open', 'dismiss'],
  summary: ['open', 'dismiss'],
  deep_idle: ['extend', 'end_rate', 'capture', 'dismiss'],
};

const PTY_ACTIONS = new Set<AttentionActionName>(['approve', 'deny', 'choose', 'reply', 'open']);

/** Kinds that are a prompt the agent is showing right now (answered with keys). */
export const PROMPT_KINDS: AttentionKind[] = ['approval', 'question'];

export function isPromptKind(kind: AttentionKind): boolean {
  return kind === 'approval' || kind === 'question';
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { blocking: 0, 'needs-you': 1, ambient: 2 };

/** `choosable`: a question one option pick can answer (see AttentionItem.actions). */
export function actionsFor(kind: AttentionKind, ptyId: number | null, choosable = false): AttentionActionName[] {
  const all = KIND_ACTIONS[kind].filter((a) => a !== 'choose' || choosable);
  if (kind === 'summary') return [...all];
  return ptyId == null ? all.filter((a) => !PTY_ACTIONS.has(a)) : [...all];
}

export function baseSeverity(kind: AttentionKind): AttentionSeverity {
  return kind === 'review' || kind === 'summary' ? 'ambient' : 'needs-you';
}

/** Key for "one open item per agent session": the PTY, else the session. */
export function sourceKey(source: AttentionSource): string {
  if (source.pty_id != null) return `pty:${source.pty_id}`;
  if (source.session_id) return `session:${source.session_id}`;
  return `lee:${source.kind}`;
}

export interface NewItem {
  kind: AttentionKind;
  title: string;
  text: string;
  source: AttentionSource;
  tool?: { name: string; preview: string; signature: string } | null;
  /** Question items: what is asked, and whether one pick answers it. */
  question?: AttentionQuestion | null;
  choosable?: boolean;
  lee_status?: LeeStatusBlock | null;
  files?: string[];
  wake?: boolean;
  /** kind 'deep_idle' only. */
  deep_idle?: AttentionItem['deep_idle'];
}

export interface QueueDeps {
  log: (input: LeeEventInput) => void;
  config: () => CopilotConfig;
  quietHours: (at: Date) => boolean;
  /** Focus tracker view. */
  focus: {
    readonly active: boolean;
    readonly sessionId: string | null;
    /** 'none' during a Deep session: only woken items escalate or notify. */
    readonly policy: 'normal' | 'none';
    isRelated: (ptyId: number | null, filesWritten: string[]) => boolean;
    noteInterruption: () => void;
  };
  away: {
    readonly active: boolean;
    isWoken: (item: { id: string; wake: boolean; source: { pty_id: number | null } }) => boolean;
  };
  /** Files the item's agent session wrote (for files-focus relation). */
  sessionFiles: (item: AttentionItem) => string[];
  /** True when some Lee window exists to show the blocking banner. */
  hasSurface: () => boolean;
}

interface Entry {
  item: AttentionItem;
  key: string;
  createdMs: number;
  waitAccum: number;
  waitSince: number | null;
  snoozeUntilMs: number | null;
  snoozeOnChange: boolean;
  closedMs: number | null;
  escalatedFor: Set<string>;
  /** Question items: 'choose' is offered. */
  choosable: boolean;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isLive(e: Entry): boolean {
  return e.item.state === 'open' || e.item.state === 'snoozed';
}

function copyItem(item: AttentionItem): AttentionItem {
  return JSON.parse(JSON.stringify(item));
}

/** v4 §7.2: an item's quadrant for ordering; rank Q1 = 0, Q2 = 1, Q3 = 2, null = 3, Q4 = 4. */
export type AttentionRanker = (item: AttentionItem) => { quadrant: Quadrant | null; rank: number };

export const QUADRANT_RANK: Record<Quadrant, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 4 };
export const UNCLASSIFIED_RANK = 3;

export function quadrantRank(q: Quadrant | null | undefined): number {
  return q ? QUADRANT_RANK[q] : UNCLASSIFIED_RANK;
}

export class AttentionQueue {
  private entries = new Map<string, Entry>();
  private ranker: AttentionRanker | null = null;

  constructor(private deps: QueueDeps) {}

  /** Install (or with null remove) the quadrant ranker used by snapshot(). */
  setRanker(fn: AttentionRanker | null): void {
    this.ranker = fn;
  }

  private rankOf(item: AttentionItem): { quadrant: Quadrant | null; rank: number } {
    if (!this.ranker) return { quadrant: null, rank: UNCLASSIFIED_RANK };
    try {
      const r = this.ranker(item);
      return { quadrant: r.quadrant ?? null, rank: Number.isFinite(r.rank) ? r.rank : UNCLASSIFIED_RANK };
    } catch {
      return { quadrant: null, rank: UNCLASSIFIED_RANK };
    }
  }

  private ctx(item: AttentionItem): { workspace: string | null; window_id: number | null } {
    return { workspace: item.source.workspace, window_id: item.source.window_id };
  }

  private bump(e: Entry, now: number): void {
    e.item.version++;
    e.item.updated_at = iso(now);
  }

  get(id: string): AttentionItem | undefined {
    const e = this.entries.get(id);
    return e ? copyItem(e.item) : undefined;
  }

  /** Live (open or snoozed) items, internal references. */
  private live(): Entry[] {
    return Array.from(this.entries.values()).filter(isLive);
  }

  liveItems(): AttentionItem[] {
    return this.live().map((e) => copyItem(e.item));
  }

  findLive(key: string, kinds?: AttentionKind[]): AttentionItem[] {
    return this.live()
      .filter((e) => e.key === key && (!kinds || kinds.includes(e.item.kind)))
      .map((e) => copyItem(e.item));
  }

  open(spec: NewItem, now: number): AttentionItem {
    const key = sourceKey(spec.source);
    // A summary or an idle-end push stands alone: it never supersedes an agent's item.
    const standalone = spec.kind === 'summary' || spec.kind === 'deep_idle';
    const siblings = standalone ? [] : this.live().filter((e) => e.key === key);
    for (const e of siblings) {
      const kind = e.item.kind;
      if (isPromptKind(spec.kind) && kind === spec.kind) {
        const sameTool = !spec.tool || !e.item.tool || e.item.tool.signature === spec.tool.signature;
        if (sameTool) {
          this.update(
            e.item.id,
            {
              text: spec.text || e.item.text,
              tool: spec.tool ?? e.item.tool ?? null,
              source: spec.source,
              ...(spec.kind === 'question' && spec.question
                ? { title: spec.title, question: spec.question, choosable: !!spec.choosable }
                : {}),
            },
            now,
          );
          return copyItem(e.item);
        }
      }
      // An approval opened for AskUserQuestion becomes the question.
      const askApproval = kind === 'approval' && isQuestionTool(e.item.tool?.name);
      if (spec.kind === 'question' && askApproval) {
        this.resolve(e.item.id, 'superseded', now);
        continue;
      }
      // A prompt that is showing stays until it is answered; a different
      // prompt of the same kind replaces it.
      if (isPromptKind(kind) && kind !== spec.kind) continue;
      if (kind === 'failure') continue;
      this.resolve(e.item.id, 'superseded', now);
    }

    const id = `att_${now.toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const item: AttentionItem = {
      id,
      version: 1,
      kind: spec.kind,
      severity: baseSeverity(spec.kind),
      state: 'open',
      parked: false,
      wake: !!spec.wake,
      notify: false,
      related_to_focus: false,
      created_at: iso(now),
      updated_at: iso(now),
      active_wait_ms: 0,
      title: spec.title,
      text: clip(spec.text ?? '', AGENT_TEXT_MAX),
      source: { ...spec.source },
      files: (spec.files ?? []).slice(-MAX_ITEM_FILES),
      tool: spec.tool ?? null,
      ...(spec.kind === 'question' ? { question: spec.question ?? null } : {}),
      ...(spec.kind === 'deep_idle' ? { deep_idle: spec.deep_idle ?? null } : {}),
      lee_status: spec.lee_status ?? null,
      actions: actionsFor(spec.kind, spec.source.pty_id, !!spec.choosable),
      snoozed_until: null,
    };
    const entry: Entry = {
      item,
      key: standalone ? `${spec.kind}:${id}` : key,
      createdMs: now,
      waitAccum: 0,
      waitSince: now,
      snoozeUntilMs: null,
      snoozeOnChange: false,
      closedMs: null,
      escalatedFor: new Set(),
      choosable: spec.kind === 'question' && !!spec.choosable,
    };
    this.entries.set(id, entry);
    this.deps.log({
      type: 'attention.open',
      ...this.ctx(item),
      data: {
        item_id: id,
        kind: item.kind,
        severity: item.severity,
        source: item.source,
        ...(item.tool ? { tool_signature: item.tool.signature } : {}),
      },
    });
    this.recompute(now, entry);
    return copyItem(item);
  }

  update(
    id: string,
    changes: Partial<Pick<AttentionItem, 'text' | 'title' | 'tool' | 'question' | 'lee_status' | 'files' | 'source'>> & {
      choosable?: boolean;
    },
    now: number,
  ): AttentionItem | undefined {
    const e = this.entries.get(id);
    if (!e || !isLive(e)) return undefined;
    const changed: string[] = [];
    if (changes.text !== undefined) {
      const text = clip(changes.text, AGENT_TEXT_MAX);
      if (text !== e.item.text) {
        e.item.text = text;
        changed.push('text');
      }
    }
    if (changes.title !== undefined && changes.title !== e.item.title) {
      e.item.title = changes.title;
      changed.push('title');
    }
    if (changes.tool !== undefined && JSON.stringify(changes.tool) !== JSON.stringify(e.item.tool ?? null)) {
      e.item.tool = changes.tool;
      changed.push('tool');
    }
    if (e.item.kind === 'question') {
      if (changes.question !== undefined && JSON.stringify(changes.question) !== JSON.stringify(e.item.question ?? null)) {
        e.item.question = changes.question;
        changed.push('question');
      }
      if (changes.choosable !== undefined && changes.choosable !== e.choosable) {
        e.choosable = changes.choosable;
        e.item.actions = actionsFor(e.item.kind, e.item.source.pty_id, e.choosable);
        changed.push('actions');
      }
    }
    if (changes.lee_status !== undefined && JSON.stringify(changes.lee_status) !== JSON.stringify(e.item.lee_status ?? null)) {
      e.item.lee_status = changes.lee_status;
      changed.push('lee_status');
    }
    if (changes.files !== undefined) {
      const files = changes.files.slice(-MAX_ITEM_FILES);
      if (JSON.stringify(files) !== JSON.stringify(e.item.files ?? [])) {
        e.item.files = files;
        changed.push('files');
      }
    }
    if (changes.source !== undefined) {
      const merged: AttentionSource = { ...e.item.source };
      for (const [k, v] of Object.entries(changes.source) as Array<[keyof AttentionSource, never]>) {
        if (v !== null && v !== undefined) merged[k] = v;
      }
      if (JSON.stringify(merged) !== JSON.stringify(e.item.source)) {
        e.item.source = merged;
        e.item.actions = actionsFor(e.item.kind, merged.pty_id, e.choosable);
        changed.push('source');
      }
    }
    if (changed.length === 0) return copyItem(e.item);
    this.bump(e, now);
    this.logUpdate(e, changed);
    this.recompute(now, e);
    return copyItem(e.item);
  }

  private logUpdate(e: Entry, changes: string[]): void {
    this.deps.log({
      type: 'attention.update',
      ...this.ctx(e.item),
      data: { item_id: e.item.id, version: e.item.version, changes, severity: e.item.severity },
    });
  }

  private close(e: Entry, state: 'resolved' | 'dismissed', resolution: Resolution, now: number, actor?: Actor): void {
    e.item.state = state;
    e.item.notify = false;
    e.item.snoozed_until = null;
    e.closedMs = now;
    this.bump(e, now);
    this.deps.log({
      type: 'attention.resolve',
      ...this.ctx(e.item),
      actor,
      data: { item_id: e.item.id, kind: e.item.kind, resolution, latency_ms: Math.max(0, now - e.createdMs) },
    });
  }

  resolve(id: string, resolution: Exclude<Resolution, 'dismissed'>, now: number, actor?: Actor): boolean {
    const e = this.entries.get(id);
    if (!e || !isLive(e)) return false;
    this.close(e, 'resolved', resolution, now, actor);
    return true;
  }

  /** Resolve every live item matching `pred`. Returns how many. */
  resolveWhere(pred: (item: AttentionItem) => boolean, resolution: Exclude<Resolution, 'dismissed'>, now: number): number {
    let n = 0;
    for (const e of this.live()) {
      if (pred(e.item)) {
        this.close(e, 'resolved', resolution, now);
        n++;
      }
    }
    return n;
  }

  dismiss(id: string, now: number, actor: Actor): boolean {
    const e = this.entries.get(id);
    if (!e || !isLive(e)) return false;
    this.deps.log({ type: 'attention.dismiss', ...this.ctx(e.item), actor, data: { item_id: id } });
    this.close(e, 'dismissed', 'dismissed', now, actor);
    return true;
  }

  /** `until` = epoch ms, or 'change' (until the source produces a new hook event). */
  snooze(id: string, until: number | 'change', now: number, actor: Actor): boolean {
    const e = this.entries.get(id);
    if (!e || !isLive(e)) return false;
    e.item.state = 'snoozed';
    e.snoozeOnChange = until === 'change';
    e.snoozeUntilMs = until === 'change' ? null : until;
    e.item.snoozed_until = until === 'change' ? 'change' : iso(until);
    e.item.notify = false;
    this.bump(e, now);
    this.deps.log({
      type: 'attention.snooze',
      ...this.ctx(e.item),
      actor,
      data: { item_id: id, until: e.item.snoozed_until },
    });
    this.recompute(now, e);
    return true;
  }

  setWake(id: string, wake: boolean, now: number, actor: Actor): boolean {
    const e = this.entries.get(id);
    if (!e || !isLive(e)) return false;
    if (e.item.wake !== wake) {
      e.item.wake = wake;
      this.bump(e, now);
    }
    this.deps.log({
      type: 'attention.wake',
      ...this.ctx(e.item),
      actor,
      data: { item_id: id, ...(e.item.source.pty_id != null ? { pty_id: e.item.source.pty_id } : {}), wake },
    });
    this.recompute(now, e);
    return true;
  }

  /** The source produced a new hook event: wake items snoozed "until it changes". */
  touchKey(key: string, now: number): boolean {
    let changed = false;
    for (const e of this.live()) {
      if (e.key === key && e.item.state === 'snoozed' && e.snoozeOnChange) {
        this.unsnooze(e, now);
        changed = true;
      }
    }
    return changed;
  }

  private unsnooze(e: Entry, now: number): void {
    e.item.state = 'open';
    e.item.snoozed_until = null;
    e.snoozeOnChange = false;
    e.snoozeUntilMs = null;
    this.bump(e, now);
    this.logUpdate(e, ['state']);
  }

  /** Severity, parking, notify and expiry. Returns true if anything visible changed. */
  recompute(now: number, only?: Entry): boolean {
    const cfg = this.deps.config();
    const limitMs = cfg.attention.waiting_limit_minutes * 60_000;
    const reviewMs = cfg.attention.review_expiry_hours * 3_600_000;
    const quiet = this.deps.quietHours(new Date(now));
    let changed = false;

    for (const e of only ? [only] : this.live()) {
      if (!isLive(e)) continue;
      const item = e.item;

      if (item.state === 'snoozed' && e.snoozeUntilMs !== null && now >= e.snoozeUntilMs) {
        this.unsnooze(e, now);
        changed = true;
      }
      if (item.kind === 'review' && now - e.createdMs >= reviewMs) {
        this.close(e, 'resolved', 'expired', now);
        changed = true;
        continue;
      }

      if (item.kind === 'deep_idle') {
        // Desk D2 §9.2: the one exception to Deep's 'none' policy (and to
        // away parking). Never escalates; notifies unless in quiet hours.
        const notify = !quiet && item.state === 'open';
        if (item.parked || item.severity !== 'needs-you' || item.notify !== notify) {
          const changes = [
            ...(item.severity !== 'needs-you' ? ['severity'] : []),
            ...(item.parked ? ['parked'] : []),
            ...(item.notify !== notify ? ['notify'] : []),
          ];
          item.severity = 'needs-you';
          item.parked = false;
          item.notify = notify;
          this.bump(e, now);
          this.logUpdate(e, changes);
          changed = true;
        }
        continue;
      }

      const base = baseSeverity(item.kind);
      const woken = this.deps.away.isWoken(item);
      const deep = this.deps.focus.policy === 'none';
      // Deep D1 §2.3: during Deep, an item that would have escalated (by age;
      // nothing relates to a Deep session) is parked instead, as under away.
      // Once parked its wait stops at or past the limit, so it stays parked
      // until Deep ends.
      const waitNow = e.waitAccum + (e.waitSince !== null ? Math.max(0, now - e.waitSince) : 0);
      const wouldEscalate = base === 'needs-you' && item.state === 'open' && waitNow >= limitMs;
      const parked = !woken && (this.deps.away.active || (deep && wouldEscalate));
      if (parked && e.waitSince !== null) {
        e.waitAccum += Math.max(0, now - e.waitSince);
        e.waitSince = null;
      } else if (!parked && e.waitSince === null) {
        e.waitSince = now;
      }
      item.active_wait_ms = e.waitAccum + (e.waitSince !== null ? Math.max(0, now - e.waitSince) : 0);

      const related = this.deps.focus.active && this.deps.focus.isRelated(item.source.pty_id, this.deps.sessionFiles(item));
      // During Deep neither age nor relatedness escalates; only a woken item does.
      const blocking =
        base === 'needs-you' && item.state === 'open' && !parked &&
        (deep ? woken : related || item.active_wait_ms >= limitMs);
      const severity: AttentionSeverity = blocking ? 'blocking' : base;
      const notify =
        !quiet && item.state === 'open' && (this.deps.away.active || deep ? woken : severity === 'blocking');

      const changes: string[] = [];
      const prevSeverity = item.severity;
      if (severity !== item.severity) changes.push('severity');
      if (parked !== item.parked) changes.push('parked');
      if (related !== item.related_to_focus) changes.push('related_to_focus');
      if (notify !== item.notify) changes.push('notify');
      if (changes.length === 0) continue;

      item.severity = severity;
      item.parked = parked;
      item.related_to_focus = related;
      item.notify = notify;
      this.bump(e, now);
      this.logUpdate(e, changes);
      changed = true;

      if (severity === 'blocking' && prevSeverity !== 'blocking') {
        const scope = this.deps.focus.sessionId ?? 'none';
        if (!e.escalatedFor.has(scope)) {
          e.escalatedFor.add(scope);
          const surfaced = this.deps.hasSurface() || notify;
          const duringFocus = this.deps.focus.active;
          if (surfaced && duringFocus) this.deps.focus.noteInterruption();
          this.deps.log({
            type: 'attention.escalate',
            ...this.ctx(item),
            data: {
              item_id: item.id,
              from: prevSeverity,
              to: 'blocking',
              reason: deep ? 'wake' : related ? 'focus' : 'age',
              surfaced,
              during_focus: duringFocus,
            },
          });
        }
      }
    }
    return changed;
  }

  /** Drop closed items older than 24 h. */
  prune(now: number): void {
    for (const [id, e] of this.entries) {
      if (e.closedMs !== null && now - e.closedMs > CLOSED_KEEP_MS) this.entries.delete(id);
    }
  }

  counts(): AttentionSnapshot['counts'] {
    const counts = { blocking: 0, needs_you: 0, ambient: 0, parked: 0 };
    for (const e of this.live()) {
      if (e.item.state !== 'open') continue;
      if (e.item.parked) counts.parked++;
      else if (e.item.severity === 'blocking') counts.blocking++;
      else if (e.item.severity === 'needs-you') counts.needs_you++;
      else counts.ambient++;
    }
    return counts;
  }

  /**
   * Open, non-blocking items not related to focus (held quietly during focus).
   * During Deep: every open needs-you item, parked or not (the neutral "N waiting").
   */
  quietCount(): number {
    const deep = this.deps.focus.policy === 'none';
    let n = 0;
    for (const e of this.live()) {
      if (e.item.state !== 'open' || e.item.kind === 'deep_idle') continue;
      if (deep ? baseSeverity(e.item.kind) === 'needs-you' : e.item.severity !== 'blocking' && !e.item.related_to_focus) n++;
    }
    return n;
  }

  parkedCount(): number {
    return this.live().filter((e) => e.item.state === 'open' && e.item.parked).length;
  }

  snapshot(
    focus: FocusState,
    away: AwayState,
    opts: { compact?: boolean; all?: boolean } = {},
    now: number = Date.now(),
  ): AttentionSnapshot {
    let entries = Array.from(this.entries.values()).filter((e) => {
      if (isLive(e)) return !(opts.compact && e.item.state === 'snoozed');
      return !!opts.all && e.closedMs !== null && now - e.closedMs <= CLOSED_KEEP_MS;
    });
    const ranks = new Map<Entry, { quadrant: Quadrant | null; rank: number }>();
    for (const e of entries) ranks.set(e, this.rankOf(e.item));
    // Live before closed, then severity, then quadrant rank, then longest wait (v4 §7.2).
    entries.sort((a, b) => {
      const la = isLive(a) ? 0 : 1;
      const lb = isLive(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      const s = SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity];
      if (s !== 0) return s;
      const r = ranks.get(a)!.rank - ranks.get(b)!.rank;
      return r !== 0 ? r : b.item.active_wait_ms - a.item.active_wait_ms;
    });
    if (opts.compact) entries = entries.slice(0, COMPACT_MAX_ITEMS);
    const items = entries.map((e) => {
      const item = copyItem(e.item);
      if (this.ranker) item.quadrant = ranks.get(e)!.quadrant;
      if (opts.compact) {
        item.text = clip(item.text, COMPACT_TEXT_MAX);
        delete item.files;
        delete item.lee_status;
        if (item.question) item.question = compactQuestion(item.question);
      }
      return item;
    });
    return { items, counts: this.counts(), focus, away, generated_at: iso(now) };
  }
}
