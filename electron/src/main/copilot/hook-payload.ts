/**
 * Claude Code hook payloads: tolerant normalisation and the small parsers the
 * queue needs (Notification classification, tool files and signature,
 * transcript tail, lee-status blocks). Pure: no Electron.
 *
 * Contract: docs/plans/2026-09-25-copilot-v0-v1-contracts.md §6.4.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type { AttentionQuestion, LeeStatusBlock } from '../../shared/copilot';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const AGENT_TEXT_MAX = 2000;
export const TOOL_PREVIEW_MAX = 200;
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export interface NormalizedHook {
  event: HookEventName | null;
  session_id: string | null;
  transcript_path: string | null;
  cwd: string | null;
  source: string | null;
  prompt_chars: number | null;
  tool_name: string | null;
  tool_input: unknown;
  tool_use_id: string | null;
  /** Set by Claude Code on hook inputs fired from a subagent. */
  agent_id: string | null;
  message: string | null;
  notification_type: string | null;
  last_assistant_message: string | null;
  reason: string | null;
  /** Sent by Lee's Pi extension ('pi'); Claude Code's payloads have none. */
  provider: string | null;
  /**
   * docs/15-Usage.md §3.3: the turn's usage, on a Stop from Lee's Pi extension
   * (`{ by_model: [{ provider, model, tokens, cost_usd }] }`). Raw here; the
   * usage tracker validates it. Claude Code's payloads have none.
   */
  usage: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function toHookEvent(name: unknown): HookEventName | null {
  return typeof name === 'string' && (HOOK_EVENTS as readonly string[]).includes(name)
    ? (name as HookEventName)
    : null;
}

/** Normalise a raw hook body. The header event name wins over `hook_event_name`. */
export function normalizeHook(headerEvent: string | null | undefined, body: unknown): NormalizedHook {
  const b = isRecord(body) ? body : {};
  const prompt = typeof b.prompt === 'string' ? b.prompt : null;
  return {
    event: toHookEvent(headerEvent) ?? toHookEvent(b.hook_event_name),
    session_id: str(b.session_id),
    transcript_path: str(b.transcript_path),
    cwd: str(b.cwd),
    source: str(b.source),
    prompt_chars: prompt === null ? null : prompt.length,
    tool_name: str(b.tool_name),
    tool_input: b.tool_input,
    tool_use_id: str(b.tool_use_id),
    agent_id: str(b.agent_id),
    message: str(b.message),
    notification_type: str(b.notification_type),
    last_assistant_message: str(b.last_assistant_message),
    reason: str(b.reason),
    provider: str(b.provider),
    usage: isRecord(b.usage) ? b.usage : null,
  };
}

export type NotificationClass = 'approval' | 'waiting' | 'ignore';

/** Notification types that never mean "the agent is waiting on you". */
const IGNORED_NOTIFICATIONS = new Set([
  'auth_success',
  'computer_use_enter',
  'computer_use_exit',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
]);

export function classifyNotification(message: string | null, type: string | null): NotificationClass {
  if (type && IGNORED_NOTIFICATIONS.has(type)) return 'ignore';
  if (type === 'permission_prompt' || type === 'worker_permission_prompt') return 'approval';
  if (message && /permission|approve|allow|wants to (use|run)/i.test(message)) return 'approval';
  return 'waiting';
}

/** Claude Code's multiple-choice question tool. Its prompt is a question, not a permission. */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
export const QUESTION_MAX = 4;
export const QUESTION_OPTIONS_MAX = 8;
export const QUESTION_TEXT_MAX = 300;
/** Question strings in compact snapshots (devices). */
export const COMPACT_QUESTION_TEXT_MAX = 120;

export function isQuestionTool(name: string | null | undefined): boolean {
  return name === ASK_USER_QUESTION_TOOL;
}

export interface ParsedQuestion {
  question: AttentionQuestion;
  /**
   * One pick answers it from a device: exactly one question, single-select,
   * with options, and no option previews (with previews Claude Code switches
   * to a side-by-side picker where a digit only moves the cursor).
   */
  choosable: boolean;
}

function oneLine(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? clip(t, max) : null;
}

/**
 * AskUserQuestion's tool_input, as Claude Code 2.1.283 sends it:
 * `{ questions: [{ question, header, options: [{ label, description, preview? }],
 * multiSelect, kind? }] }` (`kind` "text"/"number" questions have no options).
 * Tolerant: snake_case `multi_select` too, missing fields, junk entries.
 * Null when there is no usable question.
 */
export function parseAskUserQuestion(toolInput: unknown): ParsedQuestion | null {
  if (!isRecord(toolInput) || !Array.isArray(toolInput.questions)) return null;
  const questions: AttentionQuestion['questions'] = [];
  let previews = false;
  let total = 0;
  for (const raw of toolInput.questions) {
    if (!isRecord(raw)) continue;
    const question = oneLine(raw.question, QUESTION_TEXT_MAX);
    if (!question) continue;
    total++;
    if (questions.length >= QUESTION_MAX) continue;
    const multi = raw.multiSelect === true || raw.multi_select === true;
    const options: AttentionQuestion['questions'][number]['options'] = [];
    for (const o of Array.isArray(raw.options) ? raw.options : []) {
      if (!isRecord(o)) continue;
      const label = oneLine(o.label, QUESTION_TEXT_MAX);
      if (!label) continue;
      if (o.preview !== undefined && o.preview !== null) previews = true;
      if (options.length < QUESTION_OPTIONS_MAX) options.push({ label, description: oneLine(o.description, QUESTION_TEXT_MAX) });
    }
    questions.push({ question, header: oneLine(raw.header, QUESTION_TEXT_MAX), multi_select: multi, options });
  }
  if (questions.length === 0) return null;
  const q0 = questions[0];
  const choosable = total === 1 && !q0.multi_select && q0.options.length > 0 && !previews;
  return { question: { questions }, choosable };
}

/** The same question with every string clipped for compact snapshots. */
export function compactQuestion(q: AttentionQuestion): AttentionQuestion {
  const c = (s: string) => clip(s, COMPACT_QUESTION_TEXT_MAX);
  return {
    questions: q.questions.map((x) => ({
      question: c(x.question),
      header: x.header === null ? null : c(x.header),
      multi_select: x.multi_select,
      options: x.options.map((o) => ({ label: c(o.label), description: o.description === null ? null : c(o.description) })),
    })),
  };
}

/** Paths a tool call touches: `file_path`, `path` or `notebook_path` of its input. */
export function toolFiles(toolInput: unknown): string[] {
  if (!isRecord(toolInput)) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = toolInput[key];
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

export function isWriteTool(name: string | null): boolean {
  return !!name && WRITE_TOOLS.has(name);
}

/** First 12 hex of sha1(tool + JSON(tool_input)). Identifies repeats without storing input. */
export function toolSignature(tool: string, toolInput: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(toolInput ?? null) ?? 'null';
  } catch {
    json = 'null';
  }
  return crypto.createHash('sha1').update(tool + json).digest('hex').slice(0, 12);
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

/** Short human preview of a pending tool call. Shown in the queue, never logged. */
export function toolPreview(tool: string, toolInput: unknown): string {
  if (isRecord(toolInput)) {
    const pick = (k: string) => (typeof toolInput[k] === 'string' ? (toolInput[k] as string) : null);
    const primary =
      pick('command') ?? pick('file_path') ?? pick('notebook_path') ?? pick('path') ?? pick('url') ??
      pick('pattern') ?? pick('query') ?? pick('description') ?? pick('prompt');
    if (primary) return clip(primary.replace(/\s+/g, ' ').trim(), TOOL_PREVIEW_MAX);
  }
  let json = '';
  try {
    json = JSON.stringify(toolInput ?? {}) ?? '';
  } catch {
    json = '';
  }
  return clip(json === '{}' ? tool : json, TOOL_PREVIEW_MAX);
}

function assistantText(entry: unknown): string | null {
  if (!isRecord(entry) || entry.type !== 'assistant') return null;
  const message = entry.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  const text = parts.join('\n').trim();
  return text || null;
}

/**
 * Text of the last assistant entry (with text blocks) in a Claude Code
 * transcript, reading at most the last `maxBytes`. Null on any failure.
 */
export function readTranscriptTail(file: string, maxBytes: number = TRANSCRIPT_TAIL_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const text = assistantText(JSON.parse(line));
        if (text) return text;
      } catch {
        // partial or foreign line
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

const LEE_STATUS_VALUES = new Set(['done', 'in-progress', 'blocked', 'waiting']);

/**
 * Parse the last fenced block whose info string is `lee-status`:
 * `key: value` lines; `files` comma-separated; unknown keys ignored.
 */
export function parseLeeStatus(text: string | null | undefined): LeeStatusBlock | null {
  if (!text) return null;
  const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*lee-status[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g;
  let body: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) body = m[3];
  if (body === null) return null;
  const block: LeeStatusBlock = { status: null, summary: null, blockers: null, files: [], next: null };
  for (const raw of body.split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    switch (key) {
      case 'status': {
        const s = value.toLowerCase();
        block.status = LEE_STATUS_VALUES.has(s) ? (s as LeeStatusBlock['status']) : null;
        break;
      }
      case 'summary':
        block.summary = value ? clip(value, AGENT_TEXT_MAX) : null;
        break;
      case 'blockers':
        block.blockers = value ? clip(value, AGENT_TEXT_MAX) : null;
        break;
      case 'next':
        block.next = value ? clip(value, AGENT_TEXT_MAX) : null;
        break;
      case 'files':
        block.files = value
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f.length > 0)
          .slice(0, 50);
        break;
      default:
        break;
    }
  }
  return block;
}
