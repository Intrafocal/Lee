# Usage: tokens, spend and limits for agents and Hester

> **Status:** Plan, 2026-09-27. Not built. Decisions in §9 settled 2026-09-27; transcript fields partly verified (§3.2).
> **Answers:** `13-Copilot.md` open question "Agent spend" (`background_leverage`'s guard needs spend per accepted result).
> **Related:** [`GOALS.md`](../GOALS.md), `13-Copilot.md` §6 (Cockpit), `plans/2026-09-25-copilot-v2-contracts.md` (agent hooks, Pi extension)

## 1. Why

Lee runs Claude Code and Pi agents in the background and Hester calls Gemini and local models on your behalf. None of that has a visible cost today. You can't answer:

- **Will this run stall?** How much of the Claude subscription's 5-hour and weekly windows is left, and when does each reset?
- **What did this cost?** Tokens and dollars per work item, per agent session, per day.
- **What is Hester costing?** Cloud spend (Gemini, Claude delegates) vs local compute (Ollama).

`GOALS.md` already needs the second answer: `background_leverage`'s guard is "agent spend per accepted result", and `metrics.py`'s `accepted_spend` only has `busy_ms`.

### 1.1 Goal check

| Part | Moves | Costs |
|---|---|---|
| Capture (§3, §4) | G4 `background_leverage` guard becomes measurable; C1/C2 telemetry gains tokens, not just call counts | Nothing visible; a status line script in Lee-launched Claude sessions |
| Limit meters in Work (§6.1) | G4: fewer stalled background runs (launch when there's headroom); G1 `tool_failures`-like surprises ("agent just stopped") fall | G1 `peek_rate` risk: a live meter is something to watch |
| Per-item spend (§6.2) | G2 attribution gets a cost dimension; G4 guard shown where you review results | Minor: one more line in Work detail |
| Usage view (§6.3) | G3: Hester's own cost is visible, so its value can be judged honestly | None if pull-only |
| Admin API (§7, optional) | Real API billing | C1: a network call, so on demand only |

Rules that follow from the costs:

- **Pull, not push.** No notifications about spend. The only proactive signal is at launch time (§6.1).
- **Not in Deep.** Meters and numbers appear in Cockpit and Manual only, never in Deep mode (G0).
- **No new background network calls.** Everything in §3 is read from local files, hooks and responses Lee or Hester already receive (C1).

## 2. Cost bases

Summing subscription usage as if it were money spent would mislead, so every cost carries a basis:

| `cost_basis` | Meaning | Examples |
|---|---|---|
| `billed` | Money actually charged per token | Hester's Gemini calls on an API key; Pi on an API key; Claude Code on an API key |
| `subscription` | API-list-price equivalent of usage covered by a flat subscription | Claude Code on Pro/Max |
| `estimate` | Tokens × Lee's price table, when no provider figure exists | Gemini calls (the response has tokens, not dollars) |
| `local` | No money; tokens and compute time only | Ollama |

The UI never adds `subscription` to `billed`/`estimate` into one "spend" figure. It shows **spend** (`billed` + `estimate`) in dollars, and subscription usage as **tokens only** (*decided 2026-09-27*). A `subscription` event still records Claude's list-price `cost_usd`, but no UI shows it as dollars.

## 3. Sources

| What | Source | Where it enters Lee |
|---|---|---|
| Claude subscription limits | Claude Code's status line input: `rate_limits.five_hour.{used_percentage,resets_at}`, `rate_limits.seven_day.{…}` | New status line relay (§3.1) |
| Claude session cost | Status line input: `cost.total_cost_usd` (Claude's own list-price math) | Same relay |
| Claude per-turn tokens | Transcript at the hook's `transcript_path`: `message.usage` and `message.model` per assistant message | Transcript reader on `agent.turn_end` (§3.2) |
| Pi tokens and cost | Pi `message_end`: `message.usage` has `input`, `output`, `cacheRead`, `cacheWrite`, `cost.total`, plus `provider`/`model` | Pi extension (§3.3) |
| Hester Gemini | `response.usage_metadata` (`prompt_token_count`, `candidates_token_count`, `cached_content_token_count`, `thoughts_token_count`) | `copilot/model_log.py` wrapper (§3.4) |
| Hester Ollama | Response `prompt_eval_count`, `eval_count`, `total_duration` | Manual `record_model_call` sites in `prepare.py` (§3.4) |
| Hester Claude delegates | `ResultMessage.total_cost_usd` and `.usage` in `tasks/claude_delegate.py` (captured today, then dropped) | `record_model_call` (§3.4) |
| API billing (optional) | Anthropic Admin API `/v1/organizations/cost_report` | On-demand fetch (§7) |

### 3.1 Claude status line relay

Lee already writes `~/.lee/hooks/claude-settings.json` and passes it with `--settings` to every Claude it launches (`electron/src/main/copilot/hook-install.ts`). Add a `statusLine` entry pointing at a new `~/.lee/hooks/claude-statusline.sh`, which:

1. Reads the JSON from stdin.
2. POSTs it in the background (`curl --max-time 1 … &`, same `auth-header` and `X-Lee-Pty-Id` / `X-Lee-Window-Id` headers as `claude-hook.sh`) to a new `POST :9001/agent/status`. Never blocks rendering.
3. Prints a status line. If the user's own `~/.claude/settings.json` has a `statusLine.command` (read at install time), pipe the same stdin to it and print its output, so Lee's settings don't shadow the user's line. Otherwise print a small default: `model · 5h 42% · 7d 18%`.

Lee main (`/agent/status` handler, next to `/agent/hook` in `copilot/queue.ts`):

- Keeps the latest status per `session_id` in memory.
- Emits `limits.snapshot` only when a whole-number percentage or a `resets_at` changes. The status line fires on every render; logging each one would flood the event log.
- Keeps each session's latest `cost.total_cost_usd` for §3.2.
- Omits limits entirely when the fields are absent (API-key sessions, or before a session's first response).

**Verify first:** the field names above come from the Claude Code status line docs, not from observed input on the installed version (2.1.283). Step U0.1 logs one real payload before anything depends on it.

### 3.2 Claude transcript reader

On `agent.turn_end`, Lee main reads the session transcript from its last offset (kept per `session_id`), sums `usage` from new assistant lines and emits `agent.usage` (§4.2).

- **Dedupe by `message.id`.** Claude Code writes several lines for one API message as it streams; count each id once (last line wins). *Verified 2026-09-27:* one session's transcript had 606 assistant lines with usage but only 291 unique ids (185 repeated); summing lines roughly doubles the count.
- **Fields (verified on 2.1.283):** `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` (also split as `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`), and thinking at `usage.output_tokens_details.thinking_tokens` (a subset of output). Skip messages whose `model` is `<synthetic>`.
- **Model per message.** A session can switch models, so group by `message.model`.
- **Cost per turn** = the session's status-line `total_cost_usd` now minus at the previous turn end, which uses Claude's own pricing. If no status line has been seen for the session, fall back to the price table with `cost_basis: estimate`.
- **Basis:** `subscription` if the session has reported `rate_limits`, else `billed`.
- **Subagents** (*verified 2026-09-27*): subagent usage is **not** in the main transcript (it has no sidechain lines). Each subagent writes its own file under `<session id>/subagents/agent-*.jsonl` next to the main transcript. The reader walks those files too (with their own offsets), and attributes their usage to the parent session.

The hook already emits `transcript_path` on the bus as `agent-transcript` (`copilot/queue.ts`); today only the tab-title reader consumes it.

### 3.3 Pi

Pi already computes cost per message. In `electron/src/main/cockpit/pi-extension.ts`, accumulate `message.usage` on `message_end` and include the totals in the `Stop` post sent on `agent_settled`, as a `usage` object (§4.2 shape). `hook-payload.ts` normalises payloads to a fixed field list, so `usage` must be added to it; `queue.ts` emits `agent.usage` alongside `agent.turn_end`. Basis is `billed` (Pi runs on API keys).

### 3.4 Hester

`install_model_call_logging()` in `hester/daemon/copilot/model_log.py` already wraps every `google.genai` generate, stream and embed call and emits `model.call`. Extend it:

- Add optional `tokens` and `cost_usd` / `cost_basis` arguments to `record_model_call`.
- Gemini, non-streamed: read `result.usage_metadata`. Streamed: keep the last chunk's `usage_metadata`. Embeddings: count input tokens if the response reports them, else record the call without tokens.
- Ollama (`prepare.py`, both sites): pass `prompt_eval_count`, `eval_count` and `total_duration`; basis `local`.
- Claude delegates (`claude_delegate.py`): call `record_model_call(provider="anthropic", location="cloud", …)` with `total_cost_usd` and `usage`; basis `billed` or `subscription` depending on how the SDK is authenticated. This needs `"anthropic"` added to the provider set (today anything else becomes `"other"`).
- Gemini cost: tokens × price table, basis `estimate`.

The existing token reads in `shared/react/capability.py` and `hybrid.py` feed `trace.total_tokens_used` for the TUI; leave them. The wrapper is the single source for usage events.

## 4. Event contracts

All events go to the existing log (`~/.lee/events/YYYY-MM-DD.jsonl`). Hester's go through `lee_events.ingest`, so each new type must also join `INGEST_TYPES` in `lee_events.py` and Lee's ingest allow-list.

### 4.1 Common `usage` object

```jsonc
{
  "provider": "anthropic" | "google" | "ollama" | "openai" | "other",
  "model": "claude-opus-5-5",
  "tokens": { "input": 2, "output": 318, "cache_read": 26740, "cache_write": 21251, "thinking": 139 },
  "cost_usd": 0.412,          // omitted for basis=local
  "cost_basis": "billed" | "subscription" | "estimate" | "local",
  "duration_ms": 5120          // local compute time, where known
}
```

`tokens.thinking` is a subset of `output`, not added to it. Unknown fields are omitted, never zero-filled.

### 4.2 Events

| Type | Emitted by | Data |
|---|---|---|
| `model.call` (extended) | Hester | existing fields + optional `usage` |
| `agent.usage` | Lee main, per turn | `{session_id, pty_id, provider, by_model: usage[]}`; actor as for other `agent.*` events |
| `limits.snapshot` | Lee main, on change | `{source: "claude", five_hour: {used_pct, resets_at}, seven_day: {used_pct, resets_at}, session_id}` |
| `usage.billing` (U3) | Hester, on demand | `{source: "anthropic_admin", day, cost_usd, by_model}` |

## 5. Aggregation

Hester already computes metrics from the event log (`copilot/metrics.py`), and the Cockpit reads from Hester. Add a `copilot/usage.py` with the same reading approach, and:

- **`GET /cockpit/usage?range=today|week|month`** returns:
  - `limits`: the latest `limits.snapshot`, with its age;
  - `totals`: spend and subscription value by source (Claude, Pi, Hester cloud, Hester local), per the §2 rule;
  - `by_day`: the same, per day;
  - `hester`: calls, tokens and cost split by trigger kind (user vs automatic), which doubles as a richer C1/C2 reading.
- **Per work item:** tasks link to agent sessions via `task.agent.session_id` (`cockpit/tasks.py`). `follower.py` already accumulates `busy_ms` and `turns` from `agent.turn_end`; accumulate `agent.usage` onto the task the same way, and return it from `/cockpit/tasks`.
- **`background_leverage` guard:** fill `accepted_spend` in `metrics.py` with tokens and `cost_usd` alongside `busy_ms`, and report spend per accepted result. Subscription value counts here too (it's what the result consumed), labelled as such.

## 6. Cockpit UI

### 6.1 Limits (Work)

Revised 2026-09-27 for the Cockpit redesign. Work leads with one serif line ("Two things need you."), so there is no separate meter strip. The limits sit in Work's neutral summary line: `2 working · 5h 62% · 7d 18%`, with "resets 3:40pm" in the tooltip. They're **hidden until the 5-hour window passes 50%**, so there is nothing to watch while there is headroom. They show the snapshot's age when it's older than 10 minutes ("5h 62% as of 2h ago"), since the snapshot only updates while some Lee-launched Claude session is rendering.

The one proactive signal: the **Launcher** notes when the 5-hour window is at 85% or more as you start a Claude run ("5h window at 91%, resets 3:40pm"). It's informational, with no confirm and no extra step (G1 ceremony).

### 6.2 Next to each agent (Work)

*Decided 2026-09-27:* usage shows next to every agent in Work, not only in the detail view.

- **List rows and waiting cards:** a quiet meta item, `412k tok`, after the time.
- **Detail view:** in the meta line after "started Xm ago": `412k tokens` for subscription runs, `412k tokens · $3.10` for billed ones. The Updates feed can add per-turn tokens later.

Numbers are tokens for subscription usage and dollars only for billed or estimated spend (§2). They never show in Deep.

### 6.3 Usage view (History)

*Decided 2026-09-27:* a **Usage** tab inside History ("what happened" and "what it cost" together), not a rail entry. Pull-only, with today / week / month:

- Spend vs subscription value, per source;
- Hester cloud vs local, and user-triggered vs automatic;
- Top work items by cost.


On Aeronaut and Dirigible (*first pass built 2026-09-27*), each agent in In flight shows its token label, the same as on the Mac (§6.2). They show no limits and no Usage view; if limits are added later, it's only on request (G4 pull-first).

## 7. API billing (optional, U3)

Anthropic's Admin API `cost_report` gives real API-key charges at daily granularity. It needs an admin key (`sk-ant-admin01-…`) and it doesn't cover subscription usage. Because it's a network call, it runs only when you open the Usage view and press Refresh, never on a timer (C1). The key lives in the keychain, not in config. Other providers' billing APIs (Google) follow the same pattern if wanted.

## 8. Price table

Needed for Gemini (Hester) and as a fallback for Claude sessions without a status line. Ship `hester/daemon/copilot/prices.yaml` with per-model input, output, cache-read and cache-write prices per million tokens, overridable in `~/.lee/config.yaml` under `usage.prices`. Unknown models get tokens but no cost, never a guessed price.

## 9. Decisions (2026-09-27)

1. **Subscription display:** tokens only. Dollars only for billed or estimated spend.
2. **Admin API (U3):** not now. Revisit if API-key spend grows.
3. **Price table source:** Lee's own `prices.yaml` (as planned). It's only needed for Gemini and the no-status-line fallback.
4. **Usage view placement:** a tab in History, plus usage next to each agent in Work (§6.2).
5. **Claude sessions not launched by Lee:** not counted. Usage stays tied to Lee's work items.

## 10. Phases

| Phase | Scope | Done when |
|---|---|---|
| **U0 Capture** | U0.1 log one real status line payload and one transcript to confirm §3.1/§3.2 fields; status line relay and `limits.snapshot`; transcript reader and `agent.usage`; Pi usage; Hester `model.call` usage (Gemini, Ollama, delegates); price table | Events appear in the log for each source in a live session |
| **U1 Read** | `copilot/usage.py`, `/cockpit/usage`, per-task usage via `follower.py`, `accepted_spend` in `metrics.py` | Endpoint returns correct totals against a hand-checked day |
| **U2 UI** | Limit strip, Launcher note, Work detail line, Usage view | Live-tested in Cockpit |
| **U3 Billing** | Admin API on demand | Not planned (§9) |

Tests: transcript dedupe (repeated `message.id`), model switches mid-session, cost-delta across turns, status line throttling, basis separation in totals, and a `model.call` with and without `usage_metadata`.

## 11. Risks

- **Status line fields change or disappear.** Limits then go missing; everything else still works. The relay tolerates absent fields.
- **Stale limits.** The windows are account-wide, but Lee only sees them while a Lee-launched session renders. The age label is the mitigation.
- **Meters become something to watch** (`peek_rate`). If they do, hide the strip until ≥ 50% used.
- **Status line overhead.** One backgrounded `curl` per render; the script must exit fast even when Lee is down.
