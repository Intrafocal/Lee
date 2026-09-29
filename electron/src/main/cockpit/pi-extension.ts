/**
 * Pi agent adapter (contract §5.6b): a per-session Pi extension that relays
 * Pi's lifecycle events to Lee's existing POST /agent/hook as Claude-shaped
 * hook payloads, so Pi tabs get the same live tracking as Claude tabs.
 *
 * Lee writes ~/.lee/hooks/pi-lee.ts at startup and every `pi` it spawns gets
 * `--extension <that file>`. Pi started by hand outside Lee is unaffected.
 * `copilot.hooks.pi: false` turns it off. The Stop post also carries the
 * run's token counts and Pi's own cost (docs/15-Usage.md §3.3).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

export const PI_EXTENSION = `// Lee relay for Pi lifecycle events. Written by Lee at startup; edits are overwritten.
// Loaded per session with \`pi --extension <this file>\`. Posts Claude-shaped hook
// payloads to Lee's loopback API. Never sends prompts or tool input (file paths
// only); the one exception is the agent's own last message (text parts only), clipped to its
// first 2000 chars plus any trailing lee-status block. Stop also carries token counts and cost.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:9001";
const TIMEOUT_MS = 1500;
const TEXT_MAX = 2000;
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS",
};

function baseUrl(): string {
  const v = process.env.LEE_API_URL || "";
  return /^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(v) ? v : DEFAULT_BASE;
}

function authHeader(): string | null {
  try {
    const line = fs.readFileSync(path.join(os.homedir(), ".lee", "hooks", "auth-header"), "utf8").trim();
    const m = /^Authorization:\\s*(.+)$/i.exec(line);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function post(event: string, body: Record<string, unknown>): void {
  try {
    const auth = authHeader();
    if (!auth) return;
    void fetch(baseUrl() + "/agent/hook", {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "X-Lee-Hook-Event": event,
        "X-Lee-Pty-Id": process.env.LEE_PTY_ID || "",
        "X-Lee-Window-Id": process.env.LEE_WINDOW_ID || "",
      },
      body: JSON.stringify({ hook_event_name: event, provider: "pi", ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then((r) => r.body?.cancel?.(), () => undefined);
  } catch {
    // never slow down or break Pi
  }
}

function toolName(name: unknown): string {
  const n = typeof name === "string" ? name : "unknown";
  return TOOL_NAMES[n] ?? n;
}

function toolPaths(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (input && typeof input === "object") {
    const p = (input as Record<string, unknown>).path;
    if (typeof p === "string" && p) out.file_path = p;
  }
  return out;
}

function messageText(message: unknown): string | null {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (!m || m.role !== "assistant") return null;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return null;
  const parts = m.content
    .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text as string);
  return parts.length > 0 ? parts.join("\\n") : null;
}

// Keep the beginning of a long message (the queue and tiles read it as a
// summary). A trailing lee-status block is kept too, after an ellipsis, so the
// queue can still parse it.
const LEE_STATUS_TAIL = /(^|\\n)([ \\t]*(\\x60{3,}|~{3,})[ \\t]*lee-status[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n[ \\t]*\\3[ \\t]*)$/;
function clipText(raw: string): string {
  const text = raw.trim();
  if (text.length <= TEXT_MAX) return text;
  const m = LEE_STATUS_TAIL.exec(text);
  const sep = "\\n\u2026\\n";
  if (m) {
    const block = m[2].trim();
    const room = TEXT_MAX - block.length - sep.length;
    if (room > 0) return text.slice(0, room).trimEnd() + sep + block;
  }
  return text.slice(0, TEXT_MAX);
}

// docs/15-Usage.md §3.3: token counts and Pi's own cost per message, summed per
// provider and model over one agent run, sent with the Stop post. Numbers only.
type Totals = { provider: string; model: string; tokens: Record<string, number>; cost_usd?: number };
const USAGE_FIELDS: Array<[string, string]> = [
  ["input", "input"], ["output", "output"], ["cacheRead", "cache_read"], ["cacheWrite", "cache_write"],
];
function addUsage(acc: Map<string, Totals>, message: any): void {
  const u = message && message.role === "assistant" ? message.usage : null;
  if (!u || typeof u !== "object") return;
  const provider = typeof message.provider === "string" ? message.provider : "other";
  const model = typeof message.model === "string" ? message.model : "unknown";
  const key = provider + "/" + model;
  let t = acc.get(key);
  if (!t) {
    t = { provider, model, tokens: {} };
    acc.set(key, t);
  }
  for (const [from, to] of USAGE_FIELDS) {
    const v = u[from];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) t.tokens[to] = (t.tokens[to] ?? 0) + v;
  }
  const cost = u.cost && typeof u.cost.total === "number" && Number.isFinite(u.cost.total) ? u.cost.total : null;
  if (cost !== null && cost >= 0) t.cost_usd = (t.cost_usd ?? 0) + cost;
}

export default function (pi: any) {
  let sessionId: string | null = null;
  let lastText: string | null = null;
  let usage = new Map<string, Totals>();
  const sid = (ctx: any): string | null => {
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id) sessionId = id;
    } catch {
      // keep the last known id
    }
    return sessionId;
  };

  pi.on("session_start", (_e: any, ctx: any) => {
    lastText = null;
    post("SessionStart", { session_id: sid(ctx), cwd: ctx?.cwd ?? process.cwd() });
  });
  pi.on("before_agent_start", (_e: any, ctx: any) => {
    lastText = null;
    usage = new Map();
    post("UserPromptSubmit", { session_id: sid(ctx) });
  });
  pi.on("tool_call", (e: any, ctx: any) => {
    post("PreToolUse", {
      session_id: sid(ctx),
      tool_name: toolName(e?.toolName),
      tool_use_id: e?.toolCallId ?? null,
      tool_input: toolPaths(e?.input),
    });
  });
  pi.on("tool_result", (e: any, ctx: any) => {
    post(e?.isError ? "PostToolUseFailure" : "PostToolUse", {
      session_id: sid(ctx),
      tool_name: toolName(e?.toolName),
      tool_use_id: e?.toolCallId ?? null,
    });
  });
  pi.on("message_end", (e: any) => {
    const text = messageText(e?.message);
    if (text && text.trim()) lastText = text;
    try {
      addUsage(usage, e?.message);
    } catch {
      // usage is best effort
    }
  });
  pi.on("agent_settled", (_e: any, ctx: any) => {
    const text = lastText ? clipText(lastText) : null;
    lastText = null;
    const byModel = [...usage.values()];
    usage = new Map();
    post("Stop", {
      session_id: sid(ctx),
      ...(text ? { last_assistant_message: text } : {}),
      ...(byModel.length ? { usage: { by_model: byModel } } : {}),
    });
  });
  pi.on("session_shutdown", (_e: any, ctx: any) => {
    post("SessionEnd", { session_id: sid(ctx) });
  });
}
`;

export function piExtensionPath(home: string = os.homedir()): string {
  return path.join(home, '.lee', 'hooks', 'pi-lee.ts');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `copilot.enabled` and `copilot.hooks.pi` from the machine-wide config files (later wins; default on). */
export function piHooksEnabled(home: string = os.homedir()): boolean {
  let enabled = true;
  let pi = true;
  for (const file of [path.join(home, '.config', 'lee', 'config.yaml'), path.join(home, '.lee', 'config.yaml')]) {
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      const c = isPlainObject(doc) ? doc.copilot : undefined;
      if (!isPlainObject(c)) continue;
      if (typeof c.enabled === 'boolean') enabled = c.enabled;
      if (isPlainObject(c.hooks) && typeof c.hooks.pi === 'boolean') pi = c.hooks.pi;
    } catch {
      // missing or unreadable file
    }
  }
  return enabled && pi;
}

let activePath: string | null = null;

/** Write (or, when disabled, remove) ~/.lee/hooks/pi-lee.ts. Rewrites only if changed. */
export function installPiExtension(home: string = os.homedir()): string | null {
  const file = piExtensionPath(home);
  if (!piHooksEnabled(home)) {
    fs.rmSync(file, { force: true });
    activePath = null;
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== PI_EXTENSION) fs.writeFileSync(file, PI_EXTENSION, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  activePath = file;
  return file;
}

export function isPi(cmd: string): boolean {
  return path.basename(cmd || '') === 'pi';
}

/**
 * Prepend `--extension <pi-lee.ts>` when launching Pi, unless the extension
 * file is absent or already passed. Never throws.
 */
export function withPiExtension(cmd: string, args: string[]): string[] {
  try {
    if (!isPi(cmd)) return args;
    const file = activePath ?? piExtensionPath();
    if (!fs.existsSync(file)) return args;
    const end = args.indexOf('--');
    const opts = end >= 0 ? args.slice(0, end) : args;
    if (opts.includes(file)) return args;
    return ['--extension', file, ...args];
  } catch {
    return args;
  }
}
