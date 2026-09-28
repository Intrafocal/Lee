/**
 * Typed wrappers for Hester's Deep endpoints (Deep D1 §3.2, §8.1): the Page,
 * references, asks and answers, questions, sessions, explore and the opener.
 * Same shape as lib/hesterCockpit.ts: every call names its workspace as
 * `?workspace=` and `X-Lee-Workspace`, carries the bearer token, and accepts
 * both the `{success, data}` envelope and a bare body. A failure keeps the
 * parsed error body (`body`) so the Page's 409 can show both sides (§4.3).
 *
 * Also the Ideas capture (POST /ideas with a Deep source, §5), the opener
 * (GET /copilot/opener, §8.2) and an exploration create that takes `page` and
 * origin `opener` (§3.2).
 *
 * Every call here is data only; the one model call (POST /asks) runs only
 * because the user asked (C2).
 *
 * Desk D2 (contract §4, §7.1): the Page's own calls take a card id too. A
 * `pg-` id goes to `/desk/pages/{id}/…` (pageRoute), anything else to the
 * exploration routes as before, so the Page editor and its sheets work on a
 * card unchanged. A hand-off from a card has origin `{kind: 'page'}`.
 */

import { hesterHeaders, HESTER_DAEMON_URL, type Exploration, type GoalStatus } from './hesterCockpit';
import type { DeskPageCreate } from '../../shared/desk';
import type {
  Anchor,
  DeepAnswer,
  DeepQuestion,
  DeepReference,
  DeepSessionRecord,
  HandoffKind,
  HandoffState,
  LaunchRequest,
  Opener,
  TaskOrigin,
} from '../../shared/cockpit';

export type DeepResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number; body?: unknown };

async function call<T>(workspace: string, method: string, path: string, body?: unknown): Promise<DeepResult<T>> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${HESTER_DAEMON_URL}${path}${sep}workspace=${encodeURIComponent(workspace)}`;
  const headers = await hesterHeaders(workspace);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    const env = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'success' in parsed ? (parsed as { success: boolean; data?: unknown; error?: string }) : null;
    if (!res.ok || (env && env.success !== true)) {
      const detail = env?.error || (parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : null);
      return {
        ok: false,
        error: detail || (res.status === 404 ? 'Not available in this Hester' : `Hester error (${res.status})`),
        status: res.status,
        body: env && env.data !== undefined ? env.data : parsed,
      };
    }
    return { ok: true, data: (env ? env.data : parsed) as T };
  } catch {
    return { ok: false, error: 'Hester offline' };
  }
}

/** The shared call, for lib/hesterDesk.ts. */
export const hesterCall = call;

const expPath = (id: string, rest = '') => `/cockpit/explorations/${encodeURIComponent(id)}${rest}`;

/** A Page card's id (Desk D2): `pg-` and 8 hex. */
export function isCardId(id: string | null | undefined): boolean {
  return !!id && /^pg-[0-9a-f]{8}$/.test(id);
}

/** Where a Page's calls go: a card's `/desk/pages/{id}…`, else the exploration's. */
export function pageRoute(id: string, rest = ''): string {
  return isCardId(id) ? `/desk/pages/${encodeURIComponent(id)}${rest}` : expPath(id, rest);
}

// ---------------------------------------------------------------------------
// Page (§3.2, §4.3)
// ---------------------------------------------------------------------------

export interface PageDoc {
  text: string;
  version: string;
}

export function getPage(workspace: string, id: string): Promise<DeepResult<PageDoc>> {
  return call<PageDoc>(workspace, 'GET', pageRoute(id, '/page'));
}

export type PutPageResult =
  | { ok: true; version: string }
  | { ok: false; conflict: PageDoc }
  | { ok: false; conflict?: undefined; error: string; status?: number };

/** PUT /page with base_version; a 409 carries the current text and version back. */
export async function putPage(workspace: string, id: string, text: string, baseVersion: string | null): Promise<PutPageResult> {
  const r = await call<{ version: string }>(workspace, 'PUT', pageRoute(id, '/page'), { text, base_version: baseVersion });
  if (r.ok) return { ok: true, version: r.data.version };
  if (r.status === 409) {
    const b = (r.body ?? {}) as { version?: unknown; text?: unknown; data?: { version?: unknown; text?: unknown } };
    const src = typeof b.version === 'string' ? b : b.data ?? {};
    if (typeof src.version === 'string') return { ok: false, conflict: { version: src.version, text: typeof src.text === 'string' ? src.text : '' } };
  }
  return { ok: false, error: r.error, status: r.status };
}

// ---------------------------------------------------------------------------
// References (§3.4)
// ---------------------------------------------------------------------------

export interface ReferenceCreate {
  kind: 'quote' | 'link';
  quote?: string;
  url?: string;
  title?: string;
  note?: string;
  section?: string | null;
  source?: { kind: 'page' | 'palette' | 'answer' | 'file'; ref?: string };
  /** Deep next R10: a workspace-relative file and its 1-based line range. */
  file?: string;
  lines?: [number, number];
}

export function listReferences(workspace: string, id: string): Promise<DeepResult<DeepReference[]>> {
  return call<DeepReference[]>(workspace, 'GET', pageRoute(id, '/references'));
}

export function addReference(workspace: string, id: string, body: ReferenceCreate): Promise<DeepResult<DeepReference>> {
  return call<DeepReference>(workspace, 'POST', pageRoute(id, '/references'), body);
}

export function patchReference(workspace: string, id: string, rid: string, body: { note?: string; opened?: true }): Promise<DeepResult<DeepReference>> {
  return call<DeepReference>(workspace, 'PATCH', pageRoute(id, `/references/${encodeURIComponent(rid)}`), body);
}

// ---------------------------------------------------------------------------
// Asks and answers (§3.5, §6)
// ---------------------------------------------------------------------------

export function listAnswers(workspace: string, id: string): Promise<DeepResult<DeepAnswer[]>> {
  return call<DeepAnswer[]>(workspace, 'GET', pageRoute(id, '/answers'));
}

/** Queues a deep-ask (202). Only ever called from a user's Ask, Follow up or affordance click (C2). */
export function askDeep(
  workspace: string,
  id: string,
  body: { question: string; anchor: Anchor; follow_up_of?: string; section_text?: string },
): Promise<DeepResult<DeepAnswer>> {
  const { section_text, ...rest } = body;
  // Deep next R2: the section the question is about (≤ 6 000 chars); omitted when empty.
  const section = section_text?.trim() ? section_text.slice(0, SECTION_TEXT_MAX) : null;
  return call<DeepAnswer>(workspace, 'POST', pageRoute(id, '/asks'), section ? { ...rest, section_text: section } : rest);
}

export function patchAnswer(
  workspace: string,
  id: string,
  aid: string,
  body: { read?: true; dismissed?: true; inserted?: true; kept?: true; task_id?: string; status?: 'error'; error?: string },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'PATCH', pageRoute(id, `/answers/${encodeURIComponent(aid)}`), body);
}

/** Re-queues an errored or interrupted answer (a user's Retry click). */
export function retryAnswer(workspace: string, id: string, aid: string): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', pageRoute(id, `/answers/${encodeURIComponent(aid)}/retry`), {});
}

// ---------------------------------------------------------------------------
// Questions (§3.7), sessions (§3.6), explore (§3.2)
// ---------------------------------------------------------------------------

export function listQuestions(workspace: string, id: string): Promise<DeepResult<DeepQuestion[]>> {
  return call<DeepQuestion[]>(workspace, 'GET', pageRoute(id, '/questions'));
}

export function addQuestion(
  workspace: string,
  id: string,
  body: { text: string; source: 'page' | 'ask'; anchor?: Anchor },
): Promise<DeepResult<DeepQuestion>> {
  return call<DeepQuestion>(workspace, 'POST', pageRoute(id, '/questions'), body);
}

export function patchQuestion(workspace: string, id: string, qid: string, status: 'open' | 'closed'): Promise<DeepResult<DeepQuestion>> {
  return call<DeepQuestion>(workspace, 'PATCH', pageRoute(id, `/questions/${encodeURIComponent(qid)}`), { status });
}

export function postSession(workspace: string, id: string, record: Omit<DeepSessionRecord, 'id'>): Promise<DeepResult<DeepSessionRecord>> {
  return call<DeepSessionRecord>(workspace, 'POST', expPath(id, '/sessions'), record);
}

/** A child exploration seeded from a selection, linked both ways; doesn't switch. */
export function exploreFrom(workspace: string, id: string, body: { seed: string; anchor?: Anchor }): Promise<DeepResult<Exploration>> {
  return call<Exploration>(workspace, 'POST', expPath(id, '/explore'), body);
}

// ---------------------------------------------------------------------------
// Explorations with a Page, Ideas capture, the opener
// ---------------------------------------------------------------------------

export interface DeepExplorationCreate {
  title?: string;
  seed?: string;
  /** The initial page.md (the opener writes your text into it). */
  page?: string;
  origin?: { kind: 'opener' | 'cockpit' | 'exploration'; ref?: string | null };
  /** Deep next R12: the workspace's Goals Page (Hester returns the existing one, 200). */
  purpose?: 'goals';
}

export function createDeepExploration(workspace: string, input: DeepExplorationCreate): Promise<DeepResult<Exploration>> {
  return call<Exploration>(workspace, 'POST', '/cockpit/explorations', { ...input, workspace });
}

export interface DeepCaptureSource {
  surface: 'lee';
  /** The exploration (pre-Desk); a card sends card_id instead. */
  exploration_id?: string;
  card_id?: string;
  section?: string | null;
  url?: string;
  context?: string;
}

/** Capture to Ideas with where it came from (§5); `input: 'voice'` when the text came from the mic. */
export function captureIdea(
  workspace: string,
  text: string,
  source: DeepCaptureSource,
  input?: 'voice',
): Promise<DeepResult<{ id: string }>> {
  return call<{ id: string }>(workspace, 'POST', '/ideas', { workspace, text, as: 'someday', source, ...(input ? { input } : {}) });
}

export function fetchOpener(workspace: string): Promise<DeepResult<Opener>> {
  return call<Opener>(workspace, 'GET', '/copilot/opener');
}

// ---------------------------------------------------------------------------
// Deep next (docs/plans/2026-09-27-deep-next-contract.md §2, §5): hand-offs,
// deleting empty explorations, the Goals Page. Every endpoint here may be
// missing from an older Hester: callers treat 404 as "not available" and
// degrade (a local template, nothing deleted, no README draft).
// ---------------------------------------------------------------------------

/** R2: the most section text an Ask carries (Hester's limit). */
export const SECTION_TEXT_MAX = 6000;

/** Creates the hand-off's answer record (201): kind 'handoff', state 'launching'. Only from the sheet's Launch. */
export function createHandoff(
  workspace: string,
  id: string,
  body: { kind: HandoffKind; provider: string; brief: string; anchor: Anchor },
): Promise<DeepResult<DeepAnswer>> {
  return call<DeepAnswer>(workspace, 'POST', pageRoute(id, '/handoffs'), body);
}

/** The fixed part of a kind's brief, as Hester renders it (`handoff_brief`). */
export function fetchHandoffTemplate(workspace: string, kind: HandoffKind): Promise<DeepResult<{ template: string }>> {
  return call<{ template: string }>(workspace, 'GET', `/cockpit/handoff-template?kind=${encodeURIComponent(kind)}`);
}

/**
 * R8: removes an exploration only while it is still Untitled with an empty
 * Page and nothing asked or kept; otherwise 409 `not_empty` (callers ignore it).
 */
export function deleteExploration(workspace: string, id: string): Promise<DeepResult<unknown>> {
  return call(workspace, 'DELETE', pageRoute(id));
}

/**
 * R12: Hester's first guess at the four prompts from README.md / CLAUDE.md.
 * A user action; never writes the Page. 400 when the repo has neither file.
 */
export function draftFromReadme(workspace: string, id: string): Promise<DeepResult<{ text: string; sources?: string[] }>> {
  return call<{ text: string; sources?: string[] }>(workspace, 'POST', pageRoute(id, '/draft-from-readme'), {});
}

/** R12: the workspace's Goals Page, if there is one (filtered here too: an older Hester ignores `purpose`). */
export async function findGoalsPage(workspace: string): Promise<DeepResult<Exploration | null>> {
  const r = await call<Exploration[]>(workspace, 'GET', '/cockpit/explorations?status=all&purpose=goals');
  if (!r.ok) return r;
  const list = (Array.isArray(r.data) ? r.data : []).filter((e) => e.purpose === 'goals');
  return { ok: true, data: list.find((e) => e.status !== 'archived') ?? list[0] ?? null };
}

// ---- hand-off briefs and launches (R3), pure ----

export const HANDOFF_KINDS: ReadonlyArray<{ kind: HandoffKind; label: string; line: string }> = [
  { kind: 'spike', label: 'Spike', line: 'A throwaway prototype in a worktree, timeboxed. It reports evidence.' },
  { kind: 'docs', label: 'Docs', line: 'Writes or updates repository docs as a diff in a worktree.' },
  { kind: 'research', label: 'Research', line: 'No code changes. Compares options against the section, with sources.' },
];

export const HANDOFF_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'pi', label: 'Pi' },
];

/** The fixed part of each brief when Hester can't serve its own (`GET /cockpit/handoff-template`). */
export const HANDOFF_TEMPLATES: Readonly<Record<HandoffKind, string>> = {
  spike:
    'Spike. Build a throwaway prototype in this worktree to learn what the section below needs. Keep to the timebox. ' +
    'Report evidence, not a recommendation to merge: what you tried, what worked, and the size and constraints you found.',
  docs:
    "Docs. Write or update this repository's docs for the section below, as a diff in this worktree. " +
    'Name the target file first (or propose one under docs/), and change nothing else.',
  research:
    'Research. Make no code changes. Compare the options for the section below against the criteria it states, ' +
    'and cite your sources.',
};

/** How each kind launches (§2): lead delegate, its task kind, worktree, tools and timebox. */
export const HANDOFF_LAUNCH: Readonly<
  Record<HandoffKind, { kind: 'prototype' | 'chore' | 'question'; worktree: boolean; timebox_min: number; tools?: readonly string[] }>
> = {
  spike: { kind: 'prototype', worktree: true, timebox_min: 45 },
  docs: { kind: 'chore', worktree: true, timebox_min: 30 },
  research: { kind: 'question', worktree: false, timebox_min: 20, tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'] },
};

/** The line that closes every brief: where it came from (a Page card, or a pre-Desk exploration). */
export function handoffFromLine(title: string, id: string): string {
  return isCardId(id) ? `From the Page '${title}' (${id})` : `From the exploration '${title}' (${id})`;
}

/** R3: template, then the section word for word, then where it came from. */
export function handoffBrief(template: string, sectionText: string, title: string, id: string): string {
  // Hester's handoff_brief: leading and trailing newlines off the section, parts joined by blank lines.
  return [template.trim(), sectionText.replace(/^\n+|\n+$/g, ''), handoffFromLine(title, id)].filter(Boolean).join('\n\n');
}

/**
 * The brief after a kind change: swap the old template for the new one when
 * the brief still starts with it; an edited opening is kept as written.
 */
export function swapTemplate(brief: string, from: string, to: string): string {
  const f = from.trim();
  if (f && brief.startsWith(f)) return to.trim() + brief.slice(f.length);
  return brief;
}

export type HandoffLaunchRequest = LaunchRequest & { timebox_min: number };

/** The LaunchRequest for a hand-off (§2): Lee main launches it; the brief is the prompt, exactly. */
export function handoffLaunchRequest(input: {
  workspace: string;
  kind: HandoffKind;
  provider: string;
  brief: string;
  explorationId: string;
  answerId: string;
  title: string;
}): HandoffLaunchRequest {
  const how = HANDOFF_LAUNCH[input.kind];
  const label = HANDOFF_KINDS.find((k) => k.kind === input.kind)?.label ?? input.kind;
  // Desk D2 §6.2: a card's hand-off is origin 'page'; an exploration's keeps 'exploration'.
  const origin: TaskOrigin = { kind: isCardId(input.explorationId) ? 'page' : 'exploration', ref: `${input.explorationId}#${input.answerId}` };
  return {
    workspace: input.workspace,
    title: `${label}: ${input.title}`.slice(0, 120),
    prompt: input.brief,
    lead: 'delegate',
    kind: how.kind,
    provider: input.provider,
    worktree: how.worktree,
    ...(how.tools ? { tools: [...how.tools] } : {}),
    timebox_min: how.timebox_min,
    origin,
  };
}

/** A hand-off's state in words (margin cards, the ritual). */
export function handoffStateLabel(state: HandoffState | null | undefined): string {
  switch (state) {
    case 'launching':
      return 'launching…';
    case 'running':
      return 'running';
    case 'waiting':
      return 'waiting on you';
    case 'review':
      return 'ready to review';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    default:
      return 'queued';
  }
}

export function handoffKindLabel(kind: HandoffKind | null | undefined): string {
  return HANDOFF_KINDS.find((k) => k.kind === kind)?.label ?? 'Hand-off';
}

export function isHandoff(a: Pick<DeepAnswer, 'kind' | 'surface'>): boolean {
  return a.kind === 'handoff' || a.surface === 'deep-handoff';
}

/** Still out with an agent: closing Lee would stop it. */
export function handoffInFlight(a: Pick<DeepAnswer, 'kind' | 'surface' | 'handoff' | 'dismissed_at'>): boolean {
  const s = a.handoff?.state;
  return isHandoff(a) && !a.dismissed_at && (s === 'launching' || s === 'running' || s === 'waiting');
}

/** R11: who @ can reach: Hester, the providers, then this exploration's hand-offs. */
export function mentionTargetsFor(
  answers: ReadonlyArray<Pick<DeepAnswer, 'id' | 'kind' | 'surface' | 'question' | 'handoff' | 'dismissed_at'>>,
): Array<{ id: string; label: string; kind: 'hester' | 'provider' | 'handoff' }> {
  return [
    { id: 'hester', label: 'Hester', kind: 'hester' as const },
    ...HANDOFF_PROVIDERS.map((p) => ({ id: p.id, label: p.label, kind: 'provider' as const })),
    ...answers
      .filter((a) => isHandoff(a) && !a.dismissed_at && !!a.handoff?.task_id)
      .map((a) => ({ id: a.id, label: `${handoffKindLabel(a.handoff?.kind)}: ${a.question}`.slice(0, 80), kind: 'handoff' as const })),
  ];
}

// ---- titles (R7), pure ----

export function isUntitled(title: string | null | undefined): boolean {
  return !title || title.trim().startsWith('Untitled');
}

/** Markdown markers off a line: heading hashes, list and quote markers, emphasis, code ticks, links. */
function plainLineText(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at a word to ≤ max chars (a single long word is cut hard). */
export function cutAtWord(text: string, max = 60): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max + 1);
  const at = room.lastIndexOf(' ');
  return (at > 0 ? room.slice(0, at) : t.slice(0, max)).replace(/[\s,;:.–—-]+$/, '');
}

/**
 * R7: the automatic title: the Page's first heading, else its first line
 * (≤ 60 chars, cut at a word). Null when the Page has nothing to name it by.
 */
export function autoTitle(page: string, max = 60): string | null {
  let fence = false;
  let firstLine: string | null = null;
  for (const raw of page.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const plain = plainLineText(raw);
    if (!plain) continue;
    if (/^\s{0,3}#{1,6}\s+\S/.test(raw)) return cutAtWord(plain, max);
    if (firstLine == null && !/^\s*>/.test(raw)) firstLine = plain;
  }
  return firstLine ? cutAtWord(firstLine, max) : null;
}

// ---- the ritual's "This session" (R6), pure ----

export interface SessionAsk {
  id: string;
  question: string;
  state: 'pending' | 'unread' | 'read' | 'error';
  label: string;
}

export interface SessionHandoff {
  id: string;
  question: string;
  kind: HandoffKind | null;
  state: HandoffState | null;
  label: string;
}

export interface StillOpen {
  kind: 'question' | 'requirements';
  /** The question line, or the colon line plus its list. */
  text: string;
  /** The block it sits in (the Ask's section, the hand-off's brief). */
  sectionText: string;
  from: number;
  to: number;
}

type SessionAnswer = Pick<DeepAnswer, 'id' | 'question' | 'status' | 'asked_at' | 'read_at' | 'dismissed_at' | 'kind' | 'surface' | 'handoff'>;

function askState(a: SessionAnswer): SessionAsk['state'] {
  if (a.status === 'queued' || a.status === 'running') return 'pending';
  if (a.status === 'error' || a.status === 'interrupted') return 'error';
  return a.read_at ? 'read' : 'unread';
}

const ASK_LABELS: Record<SessionAsk['state'], string> = { pending: 'asking…', unread: 'answered, unread', read: 'answered', error: 'failed' };

/**
 * R6: this session's Asks and hand-offs: made since the Deep session started
 * (`since`), or from this Page while it was open (`madeHere`).
 */
export function sessionLists(
  answers: readonly SessionAnswer[],
  since: string | null,
  madeHere: ReadonlySet<string> = new Set(),
): { asked: SessionAsk[]; handedOff: SessionHandoff[] } {
  const mine = answers.filter((a) => !a.dismissed_at && (madeHere.has(a.id) || (!!since && a.asked_at >= since)));
  const asked = mine
    .filter((a) => !isHandoff(a))
    .map((a) => {
      const state = askState(a);
      return { id: a.id, question: a.question, state, label: ASK_LABELS[state] };
    });
  const handedOff = mine
    .filter((a) => isHandoff(a))
    .map((a) => ({ id: a.id, question: a.question, kind: a.handoff?.kind ?? null, state: a.handoff?.state ?? null, label: handoffStateLabel(a.handoff?.state) }));
  return { asked, handedOff };
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The paragraph block (blank-line separated) around [from, to]. */
export function blockAround(text: string, from: number, to: number = from): { from: number; to: number; text: string } {
  const before = from > 0 ? text.lastIndexOf('\n\n', from - 1) : -1;
  const start = before < 0 ? 0 : before + 2;
  const after = text.indexOf('\n\n', to);
  const end = after < 0 ? text.length : after;
  return { from: start, to: end, text: text.slice(start, end) };
}

/**
 * R6: what's still open on the Page: question lines (trimmed, ending in "?")
 * nobody has asked about yet, and requirement-style sections (a line ending
 * in ":" followed by a list) with nothing asked or handed off on them.
 * Quoted lines (inserted answers) and fenced code are skipped.
 */
export function stillOpenOnPage(page: string, answers: ReadonlyArray<Pick<DeepAnswer, 'question' | 'anchor'>>, max = 8): StillOpen[] {
  const asked = answers.map((a) => ({ q: norm(a.question), quote: a.anchor.kind === 'page' ? norm(a.anchor.quote) : '' }));
  const covered = (t: string) => {
    const n = norm(t);
    return !!n && asked.some((a) => a.q === n || (!!a.quote && (a.quote.includes(n) || n.includes(a.quote))));
  };
  const out: StillOpen[] = [];
  const lines = page.split('\n');
  let off = 0;
  let fence = false;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    const from = off;
    off += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    const t = line.trim();
    if (t.length > 1 && t.endsWith('?')) {
      const q = plainLineText(line);
      if (!covered(q)) out.push({ kind: 'question', text: q, sectionText: blockAround(page, from, from + line.length).text, from, to: from + line.length });
      continue;
    }
    if (t.endsWith(':') && i + 1 < lines.length && LIST_ITEM.test(lines[i + 1])) {
      let j = i + 1;
      let end = off;
      while (j < lines.length && (LIST_ITEM.test(lines[j]) || /^\s{2,}\S/.test(lines[j]))) {
        end += lines[j].length + 1;
        j++;
      }
      const block = page.slice(from, Math.min(page.length, end)).replace(/\n$/, '');
      if (!covered(t) && !covered(block)) out.push({ kind: 'requirements', text: block, sectionText: block, from, to: from + block.length });
      i = j - 1;
      off = end;
    }
  }
  return out;
}

// ---- the Goals Page (R12), pure ----

/** The four prompts in the Goals Page's margin. */
export const GOALS_PROMPTS: readonly string[] = [
  'What is this for, and who is it for?',
  'How will you know it’s working?',
  'What won’t you trade away?',
  'What pulls against what?',
];

/** The entry points show only when goal status has loaded with no goals (no GOALS.md, or no `### G…`). */
export function goalsEntryShown(data: { goals?: readonly unknown[] | null } | null | undefined): boolean {
  return !!data && Array.isArray(data.goals) && data.goals.length === 0;
}

/** A goal with no metrics reads "not measured yet", never as a problem. Older daemons omit `measured`. */
export function goalNotMeasured(goal: Pick<GoalStatus, 'metrics'> & { measured?: boolean }): boolean {
  return goal.measured === false || (goal.measured === undefined && goal.metrics.length === 0);
}

/** "Nearly empty": Draft from README is offered only until there are a few lines of your own. */
export function pageNearlyEmpty(page: string): boolean {
  const own = page
    .split('\n')
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return own.length < 160;
}

/** The README draft as an Insert at the end of the Page: the text, then who wrote it (you rewrite it). */
export function readmeInsertion(page: string, draft: string, date: string): { from: number; insert: string } {
  const lead = !page.trim() ? '' : page.endsWith('\n\n') ? '' : page.endsWith('\n') ? '\n' : '\n\n';
  return { from: page.length, insert: `${lead}${draft.trim()}\n\n> — Hester, a first guess from the README, ${date}\n` };
}

/** The instruction Draft goals sends: the Goals Page itself. */
export function goalsDraftInstruction(page: string, max = 12000): string {
  return `Draft GOALS.md from my Goals Page below. Keep my words where you can; a goal may be just "### G<n> <title>" and a paragraph.\n\n${page.trim().slice(0, max)}`;
}

// ---- in-memory Pages (R8): the opener creates nothing until there's text ----

export interface DraftPage {
  workspace: string;
  title: string;
  page: string;
  /** Sent on create (the opener's text); Hester titles it from the seed when no title is sent. */
  seed?: string;
  sendTitle: boolean;
  origin: { kind: 'opener' | 'cockpit' | 'exploration'; ref?: string | null };
  purpose?: 'goals';
  /** Desk D2: an in-memory Page card: created with POST /desk/pages where it was started. */
  desk?: { area_id: string | null; x?: number; y?: number; from?: DeskPageCreate['from'] };
}

export const DRAFT_PREFIX = 'draft-';
const drafts = new Map<string, DraftPage>();
let draftSeq = 0;

export function isDraftId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(DRAFT_PREFIX);
}

/** Registers an in-memory Page; returns its id (never sent to Hester). */
export function newDraft(d: DraftPage, now: number = Date.now()): string {
  const id = `${DRAFT_PREFIX}${now.toString(36)}-${(++draftSeq).toString(36)}`;
  drafts.set(id, d);
  return id;
}

export function getDraft(id: string): DraftPage | null {
  return drafts.get(id) ?? null;
}

export function dropDraft(id: string): void {
  drafts.delete(id);
}

/** The body that turns a draft into an exploration, with the Page as written now. */
export function draftCreateBody(d: DraftPage, page: string): DeepExplorationCreate {
  return {
    ...(d.sendTitle || !d.seed ? { title: d.title } : {}),
    ...(d.seed ? { seed: d.seed } : {}),
    page,
    origin: d.origin,
    ...(d.purpose ? { purpose: d.purpose } : {}),
  };
}

/** The body that turns an in-memory Page card into a card (POST /desk/pages), with the Page as written now. */
export function deskCreateBody(d: DraftPage, page: string): DeskPageCreate {
  const at = d.desk ?? { area_id: null };
  return {
    ...(d.purpose === 'goals' ? { purpose: 'goals' as const } : at.area_id ? { area_id: at.area_id } : {}),
    ...(d.purpose !== 'goals' && typeof at.x === 'number' && typeof at.y === 'number' ? { x: at.x, y: at.y } : {}),
    ...(d.purpose !== 'goals' && at.from ? { from: at.from } : {}),
    ...(d.sendTitle ? { title: d.title } : {}),
    text: page,
  };
}

/** Text to put first on a Page once it opens (the Goals entry points' typed line). */
const pendingFirstLines = new Map<string, string>();

export function setPendingFirstLine(id: string, line: string): void {
  if (line.trim()) pendingFirstLines.set(id, line.trim());
}

export function takePendingFirstLine(id: string): string | null {
  const v = pendingFirstLines.get(id) ?? null;
  pendingFirstLines.delete(id);
  return v;
}

/** Where the typed first line goes: at the top, unless the Page already says it. */
export function firstLineInsertion(page: string, line: string): { from: number; insert: string } | null {
  const t = line.trim();
  if (!t || page.includes(t)) return null;
  return { from: 0, insert: `${t}\n\n` };
}

/**
 * R12: the Goals Page to open: the existing one (the typed line to go
 * first), else an in-memory one titled "Goals" with purpose 'goals',
 * created on its first save with content (Hester returns the existing one
 * if another window got there first).
 */
export async function resolveGoalsPage(workspace: string, firstLine: string): Promise<{ id: string; title: string; draft: boolean }> {
  const found = await findGoalsPage(workspace);
  if (found.ok && found.data) {
    setPendingFirstLine(found.data.id, firstLine);
    return { id: found.data.id, title: found.data.title, draft: false };
  }
  const line = firstLine.trim();
  const id = newDraft({ workspace, title: 'Goals', page: line ? `${line}\n\n` : '', sendTitle: true, origin: { kind: 'cockpit' }, purpose: 'goals' });
  return { id, title: 'Goals', draft: true };
}
