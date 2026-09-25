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
    Approval, Waiting, Blocker, Decision, Failure, Review, Summary, Other,
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

    bool can(AttentionAction a) const { return (actions & a) != 0; }
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

    /// Items that want you now (what Lee's pill counts).
    int waiting() const { return blocking + needs_you; }
    const AttentionItem* find(const std::string& id) const;
};

inline constexpr size_t ATTENTION_MAX_ITEMS = 25;
inline constexpr size_t ATTENTION_MAX_TEXT  = 280;
inline constexpr size_t ATTENTION_MAX_TITLE = 96;
inline constexpr size_t ATTENTION_MAX_LABEL = 48;
inline constexpr size_t ATTENTION_MAX_ID    = 64;

/// Parse an AttentionSnapshot object, or a `{success, data}` envelope around
/// one.  Returns false (leaving `out` untouched) when it is not a snapshot.
bool attention_snapshot_parse(cJSON* json, AttentionSnapshot& out);

/// True when some item in `next` has notify set and did not in `prev` (absent
/// counts as not set): the one moment a device may alert (§5.4).
bool attention_notify_rose(const AttentionSnapshot& prev,
                           const AttentionSnapshot& next);

const char* attention_kind_name(AttentionKind k);

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
