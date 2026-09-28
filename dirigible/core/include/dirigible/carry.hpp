#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// Tether (Carry in the code and routes; docs/14-Deep-Work.md §8.1; Cockpit
// design §8.2; Desk D2 §9.3): where the last Deep session stopped, from Lee's
// GET /carry?workspace=<ws>.  The pick-up is your last Desk card:
//
//   { workspace,
//     pick_up: { card_id, card_kind, title, area_name, stopped_at,
//                stopped_line, last_touched_at, exploration_id } | null,
//     open_questions: [{ card_id, exploration_id, question_id, text }]  (<= 5),
//     captured_count, reading_count, spooled,
//     open_next: { card_id?, exploration_id?, someday_id?, set_at } | null }
//
// A Lee from before the Desk sends exploration_id only; it stands in for
// card_id (the `exploration_id` names below hold whichever came).
// Lee forwards to Hester and answers 503 {error: 'hester_offline'} when it is
// down.  A `{success, data}` envelope is accepted too.  Strings are capped so
// a misbehaving host cannot grow the heap.
// ---------------------------------------------------------------------------

struct CarryQuestion {
    std::string exploration_id;       // the card id (exploration id pre-Desk)
    std::string question_id;
    std::string text;
};

struct CarryState {
    std::string workspace;
    bool        has_pick_up = false;
    std::string pick_up_id;           // card_id, else exploration_id
    std::string pick_up_title;
    std::string area_name;            // the card's Area; empty when unknown
    std::string stopped_at;           // your last sentence ("You stopped at")
    int         stopped_line = -1;    // 1-based line in the card's page; -1 unknown
    int64_t     last_touched_ms = -1; // ms since the epoch, -1 unknown
    std::vector<CarryQuestion> questions;
    int         captured_count = 0;
    int         reading_count  = 0;
    int         spooled        = 0;   // captures waiting in Lee's spool for Hester
    bool        has_open_next = false;
    std::string open_next_exploration_id;
    std::string open_next_someday_id;

    /// The explorations Tether has something for, in order: the
    /// pick-up first, then each other exploration an open question names.
    std::vector<std::string> explorations() const;
    /// The first open question about `exploration_id`, or null.
    const CarryQuestion* question_for(const std::string& exploration_id) const;
};

inline constexpr size_t CARRY_MAX_QUESTIONS = 5;
inline constexpr size_t CARRY_MAX_TEXT      = 600;
inline constexpr size_t CARRY_MAX_TITLE     = 120;
inline constexpr size_t CARRY_MAX_ID        = 64;

/// Parse a GET /carry body.  False (leaving `out` untouched) when it is not one.
bool carry_parse(cJSON* json, CarryState& out);

}  // namespace dirigible
