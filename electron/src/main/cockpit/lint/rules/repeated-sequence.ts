/**
 * toil/repeated-sequence (contracts §8.3): the same 1-3 hand-typed commands
 * run again and again with no operation behind them. Pure.
 */

import * as crypto from 'crypto';
import type { LeeEvent } from '../../../../shared/copilot';
import type { LintFixResult } from '../../../../shared/cockpit';
import { DAY_MS, UNAVAILABLE, bucket, num, strList, tsOf, weekday } from '../types';
import type { LintContext, LintFinding, LintFixContext, LintRule } from '../types';

export const RULE_ID = 'toil/repeated-sequence';

const GAP_MS = 10 * 60_000;
const KEEP_MS = 8 * DAY_MS;

export const DEFAULT_IGNORE = [
  'cd', 'ls', 'll', 'la', 'pwd', 'clear', 'exit', 'history', 'cat', 'less', 'head', 'tail', 'vim', 'nvim', 'nano', 'code', 'open',
  'git status', 'git diff', 'git log', 'git add', 'git commit',
];

interface Cmd {
  ts: number;
  end: number;
  pty: number;
  sig: string;
  argv0: string;
  cwd: string | null;
  /** Hand-typed and not linked to an operation. */
  plain: boolean;
}

export function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function commandSig(text: string): string {
  return crypto.createHash('sha1').update(normalizeCommand(text)).digest('hex').slice(0, 12);
}

interface IgnoreList {
  words: Set<string>;
  phrases: string[];
  sigs: Set<string>;
}

function ignoreList(extra: string[]): IgnoreList {
  const words = new Set<string>();
  const phrases: string[] = [];
  const sigs = new Set<string>();
  for (const raw of [...DEFAULT_IGNORE, ...extra]) {
    const p = normalizeCommand(raw);
    if (!p) continue;
    if (p.includes(' ')) {
      phrases.push(p);
      sigs.add(commandSig(p));
    } else {
      words.add(p);
    }
  }
  return { words, phrases, sigs };
}

function ignored(c: Cmd, text: string | null, list: IgnoreList, minChars: number): boolean {
  if (list.words.has(c.argv0)) return true;
  if (list.sigs.has(c.sig)) return true;
  if (text !== null) {
    const t = normalizeCommand(text);
    if (t.length < minChars) return true;
    if (list.words.has(t.split(' ')[0])) return true;
    if (list.phrases.some((p) => t === p || t.startsWith(`${p} `))) return true;
  }
  return false;
}

/** Name for the suggested operation: "<argv0>-<first arg>", deduped against existing names. */
function opName(text: string | null, argv0: string, taken: Set<string>): string {
  const words = text ? normalizeCommand(text).split(' ') : [argv0];
  const i = words.indexOf(argv0);
  const first = (i >= 0 ? words.slice(i + 1) : words.slice(1)).find((w) => !w.startsWith('-'));
  const base = [argv0, first].filter(Boolean).join('-').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'command';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

export class RepeatedSequenceRule implements LintRule {
  readonly id = RULE_ID;
  readonly family = 'toil' as const;
  readonly consumes = ['terminal.command'];
  private byWs = new Map<string, Cmd[]>();

  ingest(ev: LeeEvent): void {
    if (ev.type !== ('terminal.command' as string) || !ev.workspace) return;
    const d = ev.data as Record<string, unknown>;
    if (typeof d.sig !== 'string' || typeof d.pty_id !== 'number') return;
    const started = typeof d.started_at === 'string' ? Date.parse(d.started_at) : NaN;
    const ts = Number.isFinite(started) ? started : tsOf(ev);
    const dur = typeof d.duration_ms === 'number' ? d.duration_ms : 0;
    const list = this.byWs.get(ev.workspace) ?? [];
    list.push({
      ts,
      end: ts + Math.max(0, dur),
      pty: d.pty_id,
      sig: d.sig,
      argv0: typeof d.argv0 === 'string' ? d.argv0 : '',
      cwd: typeof d.cwd_rel === 'string' ? d.cwd_rel : null,
      plain: d.by === 'user' && (d.op === null || d.op === undefined),
    });
    this.byWs.set(ev.workspace, list);
  }

  evaluate(ctx: LintContext): LintFinding[] {
    const out: LintFinding[] = [];
    for (const [ws, all] of this.byWs) {
      const kept = all.filter((c) => ctx.now - c.ts < KEEP_MS);
      this.byWs.set(ws, kept);
      const cfg = ctx.config(RULE_ID, ws);
      if (cfg.severity === 'off') continue;
      const minRepeats = num(cfg, 'min_repeats', 3);
      const maxLen = Math.max(1, Math.min(10, num(cfg, 'max_len', 3)));
      const minChars = num(cfg, 'min_chars', 8);
      const since = ctx.now - num(cfg, 'window_days', 7) * DAY_MS;
      const list = ignoreList(strList(cfg, 'ignore_commands'));
      const userIgnored = ctx.ignoredCommands(ws);
      const text = (sig: string) => ctx.commandText(ws, sig);

      // Runs of consecutive plain commands per PTY; ignored commands are
      // transparent, anything else (Lee-typed, linked to an op, a long gap) breaks a run.
      const byPty = new Map<number, Cmd[]>();
      for (const c of kept) {
        if (c.ts < since) continue;
        const arr = byPty.get(c.pty) ?? [];
        arr.push(c);
        byPty.set(c.pty, arr);
      }
      const runs: Cmd[][] = [];
      for (const cmds of byPty.values()) {
        cmds.sort((a, b) => a.ts - b.ts);
        let run: Cmd[] = [];
        let lastEnd = -Infinity;
        for (const c of cmds) {
          if (c.ts - lastEnd > GAP_MS && run.length) {
            runs.push(run);
            run = [];
          }
          lastEnd = Math.max(c.end, c.ts);
          if (!c.plain) {
            if (run.length) runs.push(run);
            run = [];
            continue;
          }
          if (userIgnored.has(c.sig) || ignored(c, text(c.sig), list, minChars)) continue;
          run.push(c);
        }
        if (run.length) runs.push(run);
      }

      const used = runs.map((r) => new Array<boolean>(r.length).fill(false));
      for (let len = maxLen; len >= 1; len--) {
        for (;;) {
          const counts = new Map<string, { n: number; first: number; at: Array<[number, number]> }>();
          runs.forEach((r, ri) => {
            const lastStart = new Map<string, number>();
            for (let i = 0; i + len <= r.length; i++) {
              let free = true;
              for (let k = 0; k < len; k++) if (used[ri][i + k]) free = false;
              if (!free) continue;
              const sigs = r.slice(i, i + len).map((c) => c.sig);
              if (new Set(sigs).size !== sigs.length) continue;
              const key = sigs.join(',');
              const prev = lastStart.get(key);
              if (prev !== undefined && i < prev + len) continue;
              lastStart.set(key, i);
              const e = counts.get(key) ?? { n: 0, first: r[i].ts, at: [] };
              e.n++;
              e.first = Math.min(e.first, r[i].ts);
              e.at.push([ri, i]);
              counts.set(key, e);
            }
          });
          let best: [string, { n: number; first: number; at: Array<[number, number]> }] | null = null;
          for (const entry of counts) {
            if (entry[1].n < minRepeats) continue;
            if (!best || entry[1].n > best[1].n || (entry[1].n === best[1].n && entry[0] < best[0])) best = entry;
          }
          if (!best) break;
          const [key, info] = best;
          for (const [ri, i] of info.at) for (let k = 0; k < len; k++) used[ri][i + k] = true;
          const sample = runs[info.at[0][0]].slice(info.at[0][1], info.at[0][1] + len);
          out.push(this.finding(ws, key, sample, info.n, info.first, minRepeats, ctx));
        }
      }
    }
    return out;
  }

  private finding(ws: string, key: string, sample: Cmd[], n: number, first: number, minRepeats: number, ctx: LintContext): LintFinding {
    const shown = sample.map((c) => ctx.commandText(ws, c.sig) ?? c.argv0);
    return {
      rule: RULE_ID,
      workspace: ws,
      subject: key,
      message: sample.length > 1 ? `You ran the same ${sample.length} commands by hand ${n} times` : `You ran the same command by hand ${n} times`,
      evidence: [`\`${shown.join(' && ')}\` run by hand ${n} times since ${weekday(first)}`, 'No operation matches it'],
      fixes: [
        { id: 'make-operation', label: 'Make it an operation', confirm_text: `Suggest an operation: ${shown.join(' && ')}` },
        { id: 'ignore-command', label: 'Ignore this command', confirm_text: null },
      ],
      item_ref: `cmdseq:${ws}:${key}`,
      state_key: `${RULE_ID}:${bucket(n, minRepeats)}`,
    };
  }

  async fix(f: LintFinding, fixId: string, ctx: LintFixContext): Promise<LintFixResult> {
    const ws = f.workspace;
    if (!ws) return { success: false, error: 'no_workspace' };
    const sigs = f.subject.split(',');
    if (fixId === 'ignore-command') {
      await ctx.ignoreCommands(ws, sigs);
      return { success: true, message: 'Ignoring this command in this workspace' };
    }
    if (fixId !== 'make-operation') return { success: false, error: 'unknown_fix' };
    if (!ctx.ops) return UNAVAILABLE;
    const cmds = sigs.map((sig) => {
      const c = this.latest(ws, sig);
      return { sig, argv0: c?.argv0 ?? '', cwd: c?.cwd ?? null, text: ctx.commandText(ws, sig) };
    });
    let taken = new Set<string>();
    try {
      const snap = ctx.ops.snapshot(ws);
      taken = new Set([...snap.operations.map((o) => o.def.name), ...snap.suggestions.map((s) => s.def.name)]);
    } catch {
      // unknown workspace: nothing taken
    }
    const cwds = new Set(cmds.map((c) => c.cwd));
    const cwd = cwds.size === 1 ? [...cwds][0] : null;
    const firstNamed = cmds.find((c) => c.argv0) ?? cmds[0];
    ctx.ops.suggest(
      ws,
      {
        name: opName(firstNamed.text, firstNamed.argv0 || 'command', taken),
        kind: 'oneshot',
        command: cmds.map((c) => c.text ?? c.argv0).join(' && '),
        cwd,
      },
      `lint:${RULE_ID}`,
    );
    return { success: true, message: 'Added to Operations suggestions: confirm it there' };
  }

  private latest(ws: string, sig: string): Cmd | null {
    const list = this.byWs.get(ws) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].sig === sig) return list[i];
    return null;
  }
}
