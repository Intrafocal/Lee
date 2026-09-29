#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// Tether (docs/14-Deep-Work.md §8.1; docs/plans/2026-09-28-tether-review-
// voice.md §3.3; Lee's electron/src/shared/tether.ts, mirrored by hand): the
// Cockpit away from the Machine.  Lee main serves it on :9001 under /tether,
// for the followed window's workspace (?workspace=, Lee's default the
// focused window's), and answers 503 {error: 'hester_offline'} when Hester
// is down (except capture, which spools).
//
//   GET /tether
//     { workspace,
//       pick_up: { card_id, card_kind, title, area_name, stopped_at,
//                  stopped_line, last_touched_at } | null,
//       open_questions: [{ card_id, question_id, text }]   (<= 5),
//       captured_count, spooled }
//
//   GET /tether/pages?limit=50         TetherCard[], newest first
//   GET /tether/pages/:id?text_only=1  { card: TetherCard, text }
//   POST /tether/capture               { workspace?, text, card_id?, input? }
//   POST /tether/send                  SendRequest -> { send_id, delivered_to }
//
// A `{success, data}` envelope is accepted everywhere.  Strings are capped so
// a misbehaving host cannot grow the heap.
// ---------------------------------------------------------------------------

struct TetherQuestion {
    std::string card_id;
    std::string question_id;
    std::string text;
};

/// GET /tether: where you stopped, for Work's Pick up block.
struct TetherState {
    std::string workspace;
    bool        has_pick_up = false;
    std::string pick_up_id;           // the card id
    std::string pick_up_kind;         // "page", ...
    std::string pick_up_title;
    std::string area_name;            // the card's Area; empty when unknown
    std::string stopped_at;           // your last sentence ("You stopped at")
    int         stopped_line = -1;    // 1-based line in the card's page; -1 unknown
    int64_t     last_touched_ms = -1; // ms since the epoch, -1 unknown
    std::vector<TetherQuestion> questions;
    int         captured_count = 0;
    int         spooled        = 0;   // captures waiting in Lee's spool for Hester

    /// Open questions about `card_id` ("n open questions" on Pick up).
    int questions_for(const std::string& card_id) const;
};

/// One card in Review's list (GET /tether/pages) and a page's header.
struct TetherCard {
    std::string id;
    std::string kind;
    std::string title;
    std::string area_id;
    std::string area_name;
    bool        stashed = false;
    int64_t     updated_ms = -1;      // ms since the epoch, -1 unknown
    int         chars = 0;
    int         answers = 0;
    int         open_questions = 0;
};

/// GET /tether/pages/:id?text_only=1: the page's markdown, for the viewer.
struct TetherPageText {
    TetherCard  card;
    std::string text;
};

inline constexpr size_t TETHER_MAX_QUESTIONS = 5;
inline constexpr size_t TETHER_MAX_TEXT      = 600;
inline constexpr size_t TETHER_MAX_TITLE     = 120;
inline constexpr size_t TETHER_MAX_ID        = 64;
inline constexpr size_t TETHER_MAX_PAGES     = 50;
/// Lee cuts a page at 200 KB; anything past this is a misbehaving host.
inline constexpr size_t TETHER_MAX_PAGE_TEXT = 256 * 1024;

/// Parse a GET /tether body.  False (leaving `out` untouched) when it is not one.
bool tether_parse(cJSON* json, TetherState& out);

/// Parse one TetherCard object.  False when it has no id.
bool tether_card_parse(cJSON* json, TetherCard& out);

/// Parse a GET /tether/pages body (a bare array, or one under `data` or
/// `pages`), keeping at most TETHER_MAX_PAGES.  False when it is not one.
bool tether_pages_parse(cJSON* json, std::vector<TetherCard>& out);

/// Parse GET /tether/pages/:id (text_only or whole).  False when it is not one.
bool tether_page_text_parse(cJSON* json, TetherPageText& out);

// ---------------------------------------------------------------------------
// Send to Lee (§4.2, §4.6): compose into a tab.  The T-Deck only ever sends
// text into the tab it is looking at; Lee pastes it as one piece (bracketed
// paste where the program asked for it) and presses Enter only for Send.
// ---------------------------------------------------------------------------

/// The SendTarget tab_kind for a Lee tab type: "agent" (claude / agent),
/// "terminal", or "tui" (everything else that owns a PTY).
const char* tether_tab_kind(const char* tab_type);

/// The body of POST /tether/send for one text item into tab `pty_id`.
/// `submit` is Send (Enter after the text); false is Deliver.  `voice` tags
/// the item `input: 'voice'` (the text came from a transcript).  Caller owns
/// the result.
cJSON* tether_send_body(int pty_id, const std::string& label, const char* tab_kind,
                        const std::string& text, bool submit, bool voice,
                        const std::string& workspace);

/// The outcome of POST /tether/send.
struct SendOutcome {
    int         status = 0;   // HTTP status, 0 = no answer
    bool        ok = false;
    std::string send_id;
    std::string error;        // Lee's code: no_target, no_window, ...; or HTTP n
};
void send_outcome_parse(int status, cJSON* resp, SendOutcome& out);

/// A short line for a failed send ("Lee isn't open on that workspace").
std::string send_error_text(const SendOutcome& r);

}  // namespace dirigible
