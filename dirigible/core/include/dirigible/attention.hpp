#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// Copilot attention queue, compact form (electron/src/shared/copilot.ts
// AttentionSnapshot / AttentionItem; docs/plans/2026-09-25-copilot-v0-v1-
// contracts.md §5, §9.3).
//
// Arrives two ways, both carrying the same AttentionSnapshot:
//   WS   {"type":"attention_snapshot","data":{…}} on /context/stream
//   HTTP GET /attention?compact=1  ->  {"success":true,"data":{…}}
//
// Lee caps a compact snapshot at 25 items with text <= 280 characters.  Only
// the fields the Waiting view draws are kept, and every string is capped
// again here so a misbehaving host cannot grow the heap.
// ---------------------------------------------------------------------------

enum class AttentionKind : uint8_t {
    Approval, Waiting, Blocker, Decision, Failure, Review, Summary, Question, Other,
};

enum class AttentionSeverity : uint8_t { Ambient, NeedsYou, Blocking };

/// AttentionActionName as bit flags.
enum AttentionAction : uint8_t {
    ActApprove = 1 << 0,
    ActDeny    = 1 << 1,
    ActReply   = 1 << 2,
    ActOpen    = 1 << 3,
    ActSnooze  = 1 << 4,
    ActDismiss = 1 << 5,
    ActWake    = 1 << 6,
    ActChoose  = 1 << 7,   // pick one option of a single-select question
};

/// One question of Claude Code's AskUserQuestion, as Lee reports it
/// (electron/src/shared/copilot.ts AttentionQuestion).  Strings are capped;
/// the compact snapshot clips them further (~120 chars) and GET
/// /attention/:id carries them whole (<= 300).
struct AttentionOption {
    std::string label;
    std::string description;   // empty when the agent gave none
};

struct AttentionQuestion {
    std::string                  question;
    std::string                  header;       // short chip label, may be empty
    bool                         multi_select = false;
    std::vector<AttentionOption> options;      // empty: a free-text question
};

struct AttentionItem {
    std::string       id;
    int               version  = 0;
    AttentionKind     kind     = AttentionKind::Other;
    AttentionSeverity severity = AttentionSeverity::NeedsYou;
    std::string       title;
    std::string       text;        // the agent's own words
    std::string       tab_label;
    bool              notify   = false;
    bool              parked   = false;
    uint8_t           actions  = 0;   // AttentionAction bits
    /// generated_at - created_at, both host clock, so the device clock does
    /// not matter.  -1 when either timestamp was missing.
    int64_t           age_ms   = -1;
    /// Approvals: the pending tool's name ("Bash", "AskUserQuestion").
    std::string       tool_name;
    /// Question items only.
    std::vector<AttentionQuestion> questions;

    bool can(AttentionAction a) const { return (actions & a) != 0; }

    /// A question the device can answer with one pick: exactly one question,
    /// single-select, with options (the only shape Lee accepts "choose" for).
    bool choosable() const
    {
        return kind == AttentionKind::Question && questions.size() == 1 &&
               !questions[0].multi_select && !questions[0].options.empty();
    }

    /// An older Lee files AskUserQuestion as an approval, where Approve
    /// would silently pick whichever option is highlighted in the TUI.
    bool question_as_approval() const
    {
        return kind == AttentionKind::Approval && tool_name == "AskUserQuestion";
    }
};

// ---------------------------------------------------------------------------
// Running agents (AgentSummary in copilot.ts), for In flight.  Every field is
// optional on the wire: an older Lee sends no agents[] at all, and one before
// the Cockpit design sends no now / recent / updates / usage.
// ---------------------------------------------------------------------------

enum class AgentState : uint8_t { Busy, Idle, Waiting, Unknown };

/// What an agent is doing now (AgentNow): the open tool, else the last entry
/// within 60 s.  Feed it to describe_activity().
struct AgentNow {
    std::string              tool;
    std::string              preview;
    std::vector<std::string> files;
    int64_t                  age_ms = -1;   // generated_at - since; -1 unknown
};

/// One activity entry (AgentActivity); `past` marks a post entry.
struct AgentActivityEntry {
    std::string              tool;
    std::string              preview;
    std::vector<std::string> files;
    bool                     failed = false;
    bool                     past   = false;
    int64_t                  age_ms = -1;
};

/// One finished turn (AgentUpdate): the agent's last message then.
struct AgentUpdateEntry {
    std::string summary;
    int64_t     age_ms = -1;
};

/// docs/15-Usage.md AgentUsage, as far as a device shows it.
struct AgentUsageInfo {
    int64_t     shown_tokens = -1;   // input + output + cache_write
    std::string cost_basis;          // billed | subscription | estimate | local
};

struct AgentSummary {
    int         pty_id    = -1;
    int         window_id = -1;
    int         tab_id    = -1;
    std::string label;
    std::string provider;
    std::string workspace;
    AgentState  state = AgentState::Unknown;
    /// generated_at - busy_since / idle_since (host clock); -1 when absent.
    int64_t     busy_ms = -1;
    int64_t     idle_ms = -1;
    std::string last_tool;
    std::string last_summary;          // the agent's words (compact: ~280)
    int         files_touched = 0;
    bool        has_now = false;
    AgentNow    now;
    std::vector<AgentActivityEntry> recent;    // newest last
    std::vector<AgentUpdateEntry>   updates;   // newest last
    bool           has_usage = false;
    AgentUsageInfo usage;
};

/// docs/15-Usage.md UsageLimits: the Claude subscription windows; -1 absent.
struct UsageLimitsInfo {
    int five_hour_pct = -1;
    int seven_day_pct = -1;
};

struct AttentionSnapshot {
    std::vector<AttentionItem> items;
    int  blocking   = 0;
    int  needs_you  = 0;
    int  ambient    = 0;
    int  parked     = 0;
    bool focus_active = false;
    int  quiet_count  = 0;
    bool away_active  = false;

    /// Running agents; empty against a Lee that sends none.
    std::vector<AgentSummary> agents;
    bool            has_limits = false;
    UsageLimitsInfo limits;
    /// Deep D1 §2.5: a Deep session is running at the machine ("In deep
    /// work").  focus_active stays true alongside it, so notifications hold.
    bool        deep_active = false;
    std::string deep_title;
    std::string deep_exploration_id;
    std::string mode;          // cockpit | deep | manual; "" from an older Lee

    /// Items that want you now (what Lee's pill counts).
    int waiting() const { return blocking + needs_you; }
    /// Agents busy in a turn.
    int working() const;
    const AttentionItem* find(const std::string& id) const;
};

inline constexpr size_t ATTENTION_MAX_ITEMS = 25;
inline constexpr size_t ATTENTION_MAX_TEXT  = 280;
inline constexpr size_t ATTENTION_MAX_TITLE = 96;
inline constexpr size_t ATTENTION_MAX_LABEL = 48;
inline constexpr size_t ATTENTION_MAX_ID    = 64;
/// GET /attention/:id carries the agent's words whole (Lee's AGENT_TEXT_MAX).
inline constexpr size_t ATTENTION_FULL_TEXT = 2000;
inline constexpr size_t ATTENTION_MAX_QUESTIONS = 4;
inline constexpr size_t ATTENTION_MAX_OPTIONS   = 8;
/// Question strings kept per item.  Lee caps them at 300 (120 compact).
inline constexpr size_t ATTENTION_MAX_QTEXT  = 300;
/// Agents kept per snapshot, and what each keeps.  Lee's compact snapshot
/// clips last_summary to ~280 and update summaries to 600.
inline constexpr size_t ATTENTION_MAX_AGENTS = 12;
inline constexpr size_t AGENT_MAX_SUMMARY    = 600;
inline constexpr size_t AGENT_MAX_PREVIEW    = 160;
inline constexpr size_t AGENT_MAX_FILES      = 8;
inline constexpr size_t AGENT_MAX_RECENT     = 8;
inline constexpr size_t AGENT_MAX_UPDATES    = 3;
/// Question items in one snapshot that keep their questions; the rest get
/// them from GET /attention/:id when shown.  Bounds a hostile snapshot.
inline constexpr size_t ATTENTION_MAX_QUESTION_ITEMS = 6;

/// Parse an AttentionSnapshot object, or a `{success, data}` envelope around
/// one.  Returns false (leaving `out` untouched) when it is not a snapshot.
bool attention_snapshot_parse(cJSON* json, AttentionSnapshot& out);

/// Parse one full item (GET /attention/:id, `{success, data: item}` or the
/// bare item), keeping up to ATTENTION_FULL_TEXT of its text.  Returns false
/// when it is not an item.
bool attention_item_parse(cJSON* json, AttentionItem& out);

/// True when some item in `next` has notify set and did not in `prev` (absent
/// counts as not set): the one moment a device may alert (§5.4).
bool attention_notify_rose(const AttentionSnapshot& prev,
                           const AttentionSnapshot& next);

const char* attention_kind_name(AttentionKind k);

/// Parse one agents[] entry.  `generated_ms` (the snapshot's generated_at,
/// -1 unknown) turns its timestamps into ages.  False without a pty_id.
bool agent_summary_parse(cJSON* json, int64_t generated_ms, AgentSummary& out);

/// "2026-09-25T14:03:11.512Z" -> ms since the epoch; -1 if unparseable.
int64_t iso8601_to_ms(const char* s);

/// Outcome of POST /attention/:id/reply.
struct ReplyResult {
    int         status = 0;   // HTTP status, 0 = no answer
    bool        ok     = false;
    std::string error;

    bool stale() const { return status == 409; }   // version moved on
    bool gone()  const { return status == 410; }   // agent PTY exited
};

/// Outcome of POST /capture.
struct CaptureOutcome {
    int         status  = 0;
    bool        ok      = false;
    bool        spooled = false;   // Hester was down; Lee will deliver later
    std::string error;
};

void reply_result_parse(int status, cJSON* resp, ReplyResult& out);
void capture_outcome_parse(int status, cJSON* resp, CaptureOutcome& out);

}  // namespace dirigible
