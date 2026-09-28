/*
 * screen_waiting.cpp — Lee's attention queue as a pager: one item that needs
 * you per page (Copilot v0; docs/plans/2026-09-25-copilot-v0-v1-contracts.md
 * §5, §9.3).  The default view once a machine is connected.
 *
 * Data: LeeConnection keeps the compact AttentionSnapshot, pushed as
 * `attention_snapshot` on the existing /context/stream socket and fetched with
 * GET /attention?compact=1 on connect (and when this view is opened).  Nothing
 * here polls.  The device is pull-first: the only alert is a header blink when
 * an item's `notify` flips from false to true (§5.4).
 *
 * Built around how the T-Deck is actually used: touch and swipes are good, the
 * trackball scrolls fast but points badly, letters are easy and symbols are
 * not.  So one item fills the body, the ball scrolls its text, swipes and j/k
 * page, and every action is a big bordered button that names its letter:
 * "Approve (Y)".
 *
 * Page, inside the 320x204 body:
 *
 *   +------------------------------------------------------------+
 *   | [APPROVAL] Claude * lee                           4m   1/3 |  12 px meta
 *   | Claude wants to use Bash                                   |  16 px title
 *   | Run idf.py build in dirigible/firmware to check the pager  |  14 px words,
 *   | compiles. This rebuilds the demo firmware, which ...       |  ball scrolls
 *   | +----------------+ +-------------+ +-------------+         |
 *   | | Approve (Y)    | |  Deny (N)   | | Snooze (S)  |         |  40 px bar
 *   | +----------------+ +-------------+ +-------------+         |
 *   +------------------------------------------------------------+
 *
 * Pager order: blocking first, then needs-you, oldest first; parked items
 * last.  Only the kinds that want an answer page (approval, waiting, blocker,
 * decision, plus anything Lee marks blocking).  With none of those the body
 * shows Pick up on top (screen_tether.cpp: your last Desk card and where you
 * stopped; Enter or p opens it), then "Nothing needs you" over the recently
 * finished turns that still fit (tap one to read it as a page) and the
 * c / i / v hints.
 *
 * This is the device Cockpit's Work (Cockpit design §8.2).  An item that takes
 * text gets the quick replies as letter buttons, sent at once through the
 * reply path, exactly as written on the button (C3):
 *
 *   Go (G)     "Yes, go ahead"
 *   Wait (W)   "Stop and wait for me"
 *   Why (E)    "Explain first"
 *   Reply (R)  opens the reply box
 *
 * Lee's fourth, "Show me the diff", is on f (Desk D2 §9.4; d is Dismiss
 * here): a key, not a button, since the bar holds four; the footer names it
 * on a page that takes it.  Approvals keep
 * Approve (Y) / Deny (N); d dismisses and s snoozes any item from the keys.
 * The header says Work's line (cockpit_status) and "In deep work" while a
 * Deep session runs at the machine.  The old f (Focus) key is retired: Deep
 * can't start remotely.
 *
 * Every write echoes the version the page showed; a 409 means the item moved
 * on, so the queue is refetched, nothing is resent and the human looks again
 * (C3).  Reply and Capture open a full-body text box with bordered Cancel and
 * Send (Enter) buttons: Cancel (or the header back, a trackball hold, or
 * Backspace in an empty box) closes it and keeps the draft.  The T-Deck
 * keyboard has no Esc, so nothing here needs one.
 */

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>

#include "app.hpp"
#include "dirigible/activity.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

static const char* TAG = "dirigible.waiting";

namespace dirigible_app {

namespace {

using dirigible::AttentionItem;
using dirigible::AttentionKind;
using dirigible::AttentionSeverity;
using dirigible::AttentionSnapshot;
using dirigible::ReplyResult;
using dirigible::AgentState;
using dirigible::AgentSummary;

// Montserrat for everything in this view (Latin only: agent text is folded
// with ui_fold).  Short local names for the theme's accessors.
const lv_font_t* const F_META  = dg::ui_font_small();
const lv_font_t* const F_BODY  = dg::ui_font();
const lv_font_t* const F_TITLE = dg::ui_font_title();

constexpr int PAD        = 6;
constexpr int META_Y     = 4;
constexpr int CHIP_H     = 16;
constexpr int TITLE_Y    = 23;
constexpr int WORDS_Y    = 44;
constexpr int BAR_H      = 40;
constexpr int BAR_Y      = BODY_H - BAR_H - 3;          // 161
constexpr int WORDS_H    = BAR_Y - 4 - WORDS_Y;         // 113
constexpr int MAX_BTNS   = 4;
constexpr int RECENT     = 3;
constexpr int ROW_H      = 34;
constexpr int HINT_H     = 28;
constexpr int HINT_Y     = BODY_H - HINT_H - 2;
constexpr int PICKUP_Y   = 4;
constexpr int REPLY_MAX   = 1000;   // Lee takes up to 4000; the keyboard won't
constexpr int CAPTURE_MAX = 500;
constexpr int COMPOSE_BTN_H = 30;
constexpr int COMPOSE_BTN_Y = BODY_H - COMPOSE_BTN_H - 3;   // 171
constexpr int SNOOZE_MIN  = 15;
constexpr uint32_t FLASH_MS = 2500;

// Trackball paging: the optical ball leaks sideways detents into a vertical
// roll, so a page turn needs a deliberate sideways flick with no vertical
// motion around it.
constexpr int      BALL_PAGE_DETENTS = 4;
constexpr uint32_t BALL_QUIET_MS     = 250;   // since the last vertical detent
constexpr uint32_t BALL_WINDOW_MS    = 400;   // sideways detents must be this close
constexpr uint32_t BALL_COOLDOWN_MS  = 500;   // one flick, one page

/// Lee's QUICK_REPLIES (electron/src/shared/cockpit.ts; Aeronaut's
/// quickReplyChips), all four, with their letters.  Change together.  The
/// first QUICK_ON_BAR get buttons; the rest are keys only.
struct Quick {
    char        key;
    const char* name;
    const char* text;
};
constexpr Quick QUICK[] = {
    { 'g', "Go",   "Yes, go ahead" },
    { 'w', "Wait", "Stop and wait for me" },
    { 'e', "Why",  "Explain first" },
    { 'f', "Diff", "Show me the diff" },
};
constexpr int QUICK_ON_BAR = 3;

const Quick* quick_for(char k)
{
    for (const Quick& q : QUICK) {
        if (q.key == k) return &q;
    }
    return nullptr;
}

enum class Compose : uint8_t { None, Reply, Capture };

struct Btn {
    lv_obj_t* obj = nullptr;
    lv_obj_t* lbl = nullptr;
    char      key = 0;   // the letter this button stands for
};

struct Row {
    lv_obj_t* obj   = nullptr;
    lv_obj_t* title = nullptr;
    lv_obj_t* meta  = nullptr;
};

/// One option of a question item: a bordered touch button in the words.
struct Opt {
    lv_obj_t* obj  = nullptr;
    lv_obj_t* lbl  = nullptr;
    lv_obj_t* desc = nullptr;
};
constexpr int MAX_OPTS = (int)dirigible::ATTENTION_MAX_OPTIONS;

/// The whole item from GET /attention/:id: the compact snapshot clips the
/// agent's words to 280 characters and question strings to ~120.
struct Full {
    std::string id;
    int         version = -1;
    bool        gone = false;     // 404 / 410: never ask again
    std::string text;
    std::vector<dirigible::AttentionQuestion> questions;
};
constexpr int FULL_CACHE = 3;
constexpr uint32_t FULL_HINT_MS = 700;   // say "loading" only past this

struct State {
    // ---- page
    lv_obj_t* page     = nullptr;
    lv_obj_t* chip     = nullptr;
    lv_obj_t* chip_lbl = nullptr;
    lv_obj_t* source   = nullptr;
    lv_obj_t* meta     = nullptr;
    lv_obj_t* title    = nullptr;
    lv_obj_t* scroll   = nullptr;
    lv_obj_t* words    = nullptr;
    Btn       btns[MAX_BTNS];

    // ---- empty / message
    lv_obj_t* empty   = nullptr;
    lv_obj_t* e_title = nullptr;
    lv_obj_t* e_sub   = nullptr;
    Row       rows[RECENT];
    lv_obj_t* hints   = nullptr;

    // ---- compose overlay (reply or capture)
    lv_obj_t* compose  = nullptr;
    lv_obj_t* c_head   = nullptr;
    lv_obj_t* c_ta     = nullptr;
    lv_obj_t* c_hint   = nullptr;
    lv_obj_t* c_status = nullptr;
    Compose   mode = Compose::None;
    std::string reply_id;          // item the reply box answers
    int         reply_version = -1;   // the version the human was shown
    std::string reply_draft;       // kept across Cancel; capped by REPLY_MAX
    std::string reply_draft_id;
    std::string capture_draft;     // capped by CAPTURE_MAX
    lv_timer_t* compose_close = nullptr;   // closes after "captured"

    // ---- pager (indices into the snapshot; rebuilt on every render)
    int  order[dirigible::ATTENTION_MAX_ITEMS] = {};
    int  count = 0;
    int  recent[RECENT] = {};
    int  recent_count = 0;
    int  pos = 0;
    std::string cur_id;        // keeps the page on the same item across snapshots
    std::string pinned_id;     // a recent item opened from the empty state
    std::string shown_id;      // what the page is drawing right now
    int         shown_version = -1;
    uint8_t     shown_actions = 0;
    std::string acted_id;      // last item we wrote to, and at which version:
    int         acted_version = -1;   // no second write until it changes

    bool     busy = false;     // a write is in flight
    uint32_t snapshot_tick = 0;
    uint32_t flash_until = 0;  // header centre holds a transient message
    int      ticks = 0;

    std::string device_for;    // machine the cached device id belongs to
    std::string device_id;
    // Set only once a write actually comes back 403 (contracts §4.4): an empty
    // `device_id` alone just means a typed token whose id we never learned
    // (screen_pairing.cpp's manual-token path), not necessarily the legacy
    // shared token.  Don't tell the user to re-pair until a write is refused.
    bool reply_forbidden = false;

    lv_timer_t* blink = nullptr;
    int         blink_left = 0;

    // ---- full item text, cached by id + version
    Full        full[FULL_CACHE];
    int         full_next = 0;
    std::string full_pending_id;
    int         full_pending_version = -1;

    // ---- question options
    Opt opts[MAX_OPTS];
    int opt_count = 0;
    int opt_hl    = -1;    // highlighted by the ball; -1 none

    // ---- trackball paging
    int      ball_dx = 0;
    uint32_t ball_dx_tick = 0;
    uint32_t ball_dy_tick = 0;
    uint32_t ball_page_tick = 0;
};

State& st()
{
    static State s;
    return s;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

dirigible::LeeConnection* conn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
}

#if DIRIGIBLE_UI_DEMO
AttentionSnapshot& demo_snap()
{
    static AttentionSnapshot s;
    return s;
}

void demo_fill();
#endif

bool linked()
{
#if DIRIGIBLE_UI_DEMO
    return true;
#else
    auto* c = conn();
    return c && c->isConnected();
#endif
}

const AttentionSnapshot* snapshot()
{
#if DIRIGIBLE_UI_DEMO
    return &demo_snap();
#else
    auto* c = conn();
    return c && c->attentionAvailable() ? &c->attention() : nullptr;
#endif
}

/// Kinds that want an answer, plus anything Lee has escalated.
bool pages(const AttentionItem& it)
{
    if (it.severity == AttentionSeverity::Blocking) return true;
    switch (it.kind) {
    case AttentionKind::Approval:
    case AttentionKind::Question:
    case AttentionKind::Waiting:
    case AttentionKind::Blocker:
    case AttentionKind::Decision:
        return true;
    default:
        return false;
    }
}

int rank(const AttentionItem& it)
{
    if (it.parked) return 2;
    return it.severity == AttentionSeverity::Blocking ? 0 : 1;
}

/// Rebuild the pager order and the recent list from the snapshot.
void rebuild()
{
    auto& s = st();
    s.count = 0;
    s.recent_count = 0;
    const auto* snap = snapshot();
    if (!snap) return;

    int others[dirigible::ATTENTION_MAX_ITEMS];
    int n_others = 0;
    const int n = std::min((int)snap->items.size(), (int)dirigible::ATTENTION_MAX_ITEMS);
    for (int i = 0; i < n; i++) {
        if (pages(snap->items[i])) s.order[s.count++] = i;
        else                       others[n_others++] = i;
    }
    const auto& items = snap->items;
    std::stable_sort(s.order, s.order + s.count, [&](int a, int b) {
        const int ra = rank(items[a]), rb = rank(items[b]);
        if (ra != rb) return ra < rb;
        return items[a].age_ms > items[b].age_ms;   // oldest first
    });
    std::stable_sort(others, others + n_others, [&](int a, int b) {
        const int64_t aa = items[a].age_ms < 0 ? INT64_MAX : items[a].age_ms;
        const int64_t ab = items[b].age_ms < 0 ? INT64_MAX : items[b].age_ms;
        return aa < ab;                              // newest first
    });
    s.recent_count = std::min(n_others, RECENT);
    for (int i = 0; i < s.recent_count; i++) s.recent[i] = others[i];

    if (!s.pinned_id.empty() && !snap->find(s.pinned_id)) s.pinned_id.clear();

    // Stay on the same item when the order changes.  When it has gone
    // (answered here, in the tab or elsewhere), the next one slides into its
    // position.
    if (!s.cur_id.empty()) {
        for (int i = 0; i < s.count; i++) {
            if (items[s.order[i]].id == s.cur_id) { s.pos = i; break; }
        }
    }
    if (s.pos >= s.count) s.pos = s.count - 1;
    if (s.pos < 0) s.pos = 0;
    s.cur_id = s.count ? items[s.order[s.pos]].id : std::string();
}

/// The item on the page: a pinned recent item, else the pager's current one.
const AttentionItem* current()
{
    auto& s = st();
    const auto* snap = snapshot();
    if (!snap) return nullptr;
    if (!s.pinned_id.empty()) return snap->find(s.pinned_id);
    if (s.count == 0) return nullptr;
    return &snap->items[s.order[s.pos]];
}

std::string fmt_age(int64_t ms)
{
    if (ms < 0) return "";
    const int64_t m = ms / 60000;
    char b[12];
    if (m < 1)            return "now";
    if (m < 60)           snprintf(b, sizeof(b), "%dm", (int)m);
    else if (m < 48 * 60) snprintf(b, sizeof(b), "%dh", (int)(m / 60));
    else                  snprintf(b, sizeof(b), "%dd", (int)(m / 1440));
    return b;
}

int64_t live_age(const AttentionItem& it)
{
    if (it.age_ms < 0) return -1;
    return it.age_ms + (int64_t)lv_tick_elaps(st().snapshot_tick);
}

const char* kind_chip(AttentionKind k)
{
    switch (k) {
    case AttentionKind::Approval: return "APPROVAL";
    case AttentionKind::Question: return "QUESTION";
    case AttentionKind::Waiting:  return "WAITING";
    case AttentionKind::Blocker:  return "BLOCKER";
    case AttentionKind::Decision: return "DECISION";
    case AttentionKind::Failure:  return "EXITED";
    case AttentionKind::Review:   return "FINISHED";
    case AttentionKind::Summary:  return "SUMMARY";
    default:                      return "ITEM";
    }
}

lv_color_t severity_colour(const AttentionItem& it)
{
    if (it.parked) return dg::ground5();
    switch (it.severity) {
    case AttentionSeverity::Blocking: return dg::error();
    case AttentionSeverity::NeedsYou: return dg::ember();
    default:                          return dg::ground5();
    }
}

std::string source_of(const AttentionItem& it)
{
    std::string src = "Claude";
    if (!it.tab_label.empty()) src += "  " LV_SYMBOL_BULLET "  " + ui_fold(it.tab_label, false);
    return src;
}

const std::string& device_id()
{
    auto& s = st();
    auto& a = app();
    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    const std::string name = m ? m->config.name : std::string();
    if (name != s.device_for) {
        s.device_for = name;
        s.device_id = name.empty() || !a.config ? "" : a.config->getDeviceId(name);
    }
    return s.device_id;
}

// ---------------------------------------------------------------------------
// Header centre and footer
// ---------------------------------------------------------------------------

void render();

/// A transient header message ("approved", "changed - look again") that the
/// next snapshot does not immediately stamp over.
void flash(const char* msg)
{
    st().flash_until = lv_tick_get() + FLASH_MS;
    chrome_set_centre(msg);
}

void centre_status()
{
    auto& s = st();
    if (app().view != View::Waiting) return;
    if ((int32_t)(s.flash_until - lv_tick_get()) > 0) return;
    chrome_set_centre(cockpit_status().c_str());
}

/// Items the pager would show (not parked): what Work's line counts.
int waiting_count(const AttentionSnapshot& snap)
{
    int n = 0;
    for (const auto& it : snap.items) {
        if (pages(it) && !it.parked) n++;
    }
    return n;
}

bool takes_text(const AttentionItem& it);

void footer()
{
    auto& s = st();
    if (app().view != View::Waiting) return;
    switch (s.mode) {
    case Compose::Reply:   chrome_set_footer("Enter sends  hold: cancel", "reply"); return;
    case Compose::Capture: chrome_set_footer("Enter sends  hold: cancel", "idea");  return;
    default: break;
    }
    if (const auto* it = current()) {
        const bool diff = takes_text(*it);
        chrome_set_footer(s.pinned_id.empty() ? (diff ? "f diff  j/k items" : "j/k or swipe: items")
                                              : (diff ? "f diff  " LV_SYMBOL_LEFT " back" : LV_SYMBOL_LEFT " or hold: back"),
                          "c i v t");
        return;
    }
    const std::string& id = device_id();
    const lv_obj_t* pick = pick_up_obj();
    if (s.reply_forbidden) {
        chrome_set_footer("shared token: re-pair", "queue");
    } else if (pick && !lv_obj_has_flag(pick, LV_OBJ_FLAG_HIDDEN) &&
               !lv_obj_has_flag(s.empty, LV_OBJ_FLAG_HIDDEN)) {
        chrome_set_footer("Enter or p: pick up", "queue");
    } else if (!id.empty()) {
        const std::string legend = "device " + id;
        chrome_set_footer(legend.c_str(), "queue");
    } else {
        chrome_set_footer(LV_SYMBOL_LIST " menu", "queue");
    }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

using ResultCb = std::function<void(const ReplyResult&)>;

#if DIRIGIBLE_UI_DEMO
void demo_remove(const std::string& id)
{
    auto& items = demo_snap().items;
    items.erase(std::remove_if(items.begin(), items.end(),
                               [&](const AttentionItem& it) { return it.id == id; }),
                items.end());
}
#endif

/// One place every item write goes through: approve / deny / text / dismiss /
/// snooze.  `version` is the one the human was shown.
void send(const std::string& id, const char* verb, const std::string& text,
          int version, ResultCb cb, int choice = -1)
{
#if DIRIGIBLE_UI_DEMO
    (void)text; (void)version; (void)choice;
    if (strcmp(verb, "open") != 0) demo_remove(id);
    ReplyResult r;
    r.status = 200;
    r.ok = true;
    cb(r);
    ESP_LOGI(TAG, "demo %s %s", verb, id.c_str());
    render();
    return;
#else
    auto* c = conn();
    if (!c) {
        ReplyResult r;
        dirigible::reply_result_parse(0, nullptr, r);
        cb(r);
        return;
    }
    if (strcmp(verb, "dismiss") == 0)     c->attentionDismiss(id, std::move(cb));
    else if (strcmp(verb, "snooze") == 0) c->attentionSnooze(id, SNOOZE_MIN, std::move(cb));
    else if (strcmp(verb, "open") == 0)   c->attentionOpen(id, std::move(cb));
    else if (strcmp(verb, "choose") == 0) c->attentionChoose(id, choice, version, std::move(cb));
    else                                  c->attentionReply(id, verb, text, version, std::move(cb));
#endif
}

void close_compose(bool keep_draft);
void set_status(const char* text, lv_color_t colour);
const std::vector<dirigible::AttentionQuestion>& questions_of(const AttentionItem& it);
bool pickable(const AttentionItem& it);
void set_hl(int i);
void scroll_words(int px);

/// Shared failure handling for every write (C3: a 409 is never retried).
void report_failure(const std::string& id, const ReplyResult& r)
{
    auto& s = st();
    ESP_LOGW(TAG, "write %s: %d %s", id.c_str(), r.status, r.error.c_str());
    // Let the human act again once they have seen what changed.
    s.acted_id.clear();
    s.acted_version = -1;
    if (s.mode == Compose::Reply) {
        set_status(r.stale() ? "" : r.status == 403 ? "This device can't reply: re-pair"
                                                    : r.error.c_str(), dg::error());
    }
    if (r.stale()) {
        // The item moved on under us: show its new state, resend nothing.
        if (s.mode == Compose::Reply) close_compose(true);
        flash("changed - look again");
        if (auto* c = conn()) c->fetchAttention();
    } else if (r.gone()) {
        flash("agent gone");
        if (auto* c = conn()) c->fetchAttention();
    } else if (r.status == 403) {
        s.reply_forbidden = true;
        flash("re-pair to reply");
        footer();
    } else if (r.status == 401) {
        flash("token rejected");
    } else {
        flash(r.error.c_str());
    }
}

/// Act on the page's item.  `verb` is approve / deny / text / dismiss /
/// snooze / open / choose (with `choice`, 0-based).
void act(const char* verb, const std::string& text = std::string(), int choice = -1)
{
    auto& s = st();
    const auto* it = current();
    if (!it || s.busy) return;
    if (!linked()) { flash("not connected"); return; }

    const bool is_text = strcmp(verb, "text") == 0;
    const bool yes_no = strcmp(verb, "approve") == 0 || strcmp(verb, "deny") == 0;
    dirigible::AttentionAction need =
        strcmp(verb, "approve") == 0 ? dirigible::ActApprove :
        strcmp(verb, "deny") == 0    ? dirigible::ActDeny :
        strcmp(verb, "dismiss") == 0 ? dirigible::ActDismiss :
        strcmp(verb, "snooze") == 0  ? dirigible::ActSnooze :
        strcmp(verb, "open") == 0    ? dirigible::ActOpen :
        strcmp(verb, "choose") == 0  ? dirigible::ActChoose : dirigible::ActReply;
    if (!it->can(need)) return;
    // Approve on a question would press Enter on whatever option the TUI has
    // highlighted; never.  And a pick only on the one shape Lee accepts.
    if (yes_no && (it->question_as_approval() || it->kind == AttentionKind::Question)) return;
    if (need == dirigible::ActChoose && !pickable(*it)) return;

    // A reply from the box answers the version the box was opened on; a
    // quick reply and everything else the version on screen.  A snapshot
    // that lands in between makes it a 409.
    const bool from_box = is_text && s.mode == Compose::Reply;
    const std::string id = from_box ? s.reply_id : it->id;
    const int version = from_box ? s.reply_version : s.shown_version;
    if (id == s.acted_id && version == s.acted_version) {
        flash("sent - waiting on Lee");
        return;
    }

    s.busy = true;
    // Say exactly what is being sent for a pick or a quick reply.
    std::string what = "sending...";
    if (is_text && !from_box) {
        what = "sending: " + text;
    } else if (need == dirigible::ActChoose) {
        const auto& qs = questions_of(*it);
        if (!qs.empty() && choice >= 0 && choice < (int)qs[0].options.size()) {
            what = "sending: " + ui_fold(qs[0].options[choice].label, false);
        }
    }
    flash(what.c_str());
    ESP_LOGI(TAG, "%s %s v%d%s", verb, id.c_str(), version, choice >= 0 ? " (choice)" : "");
    const std::string v = verb;
    send(id, verb, text, version, [id, version, v, what, from_box](const ReplyResult& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) { report_failure(id, r); return; }
        if (v == "open") { flash("opened on Lee"); return; }   // the item stays
        s.acted_id = id;
        s.acted_version = version;
        if (v == "choose" || (v == "text" && !from_box)) {
            flash(("sent" + what.substr(7)).c_str());   // "sent: Yes, go ahead"
            return;
        }
        if (v == "text") {
            s.reply_draft.clear();
            s.reply_draft_id.clear();
            if (s.mode == Compose::Reply) close_compose(false);
        }
        flash(v == "approve" ? "approved" : v == "deny" ? "denied" :
              v == "dismiss" ? "dismissed" : v == "snooze" ? "snoozed 15m" : "sent");
    }, choice);
}

/// An item the quick replies suit: one that takes text and isn't a question
/// (those take a pick) or an approval (Approve / Deny).
bool takes_text(const AttentionItem& it)
{
    return it.can(dirigible::ActReply) && it.kind != AttentionKind::Question &&
           !it.question_as_approval() && !it.can(dirigible::ActApprove);
}

/// Go / Wait / Why / Diff: send the quick reply's words now, through the reply path.
/// Returns false when the page's item doesn't take them.
bool quick_reply(char k)
{
    const Quick* q = quick_for(k);
    const auto* it = current();
    if (!q || !it || !takes_text(*it) || st().mode != Compose::None) return false;
    act("text", q->text);
    return true;
}

// ---------------------------------------------------------------------------
// Compose overlay: reply and capture
// ---------------------------------------------------------------------------

void ta_active(bool on)
{
    auto& a = app();
    auto& s = st();
    if (!a.group || !s.c_ta) return;
    if (on) {
        lv_group_add_obj(a.group, s.c_ta);
        lv_group_focus_obj(s.c_ta);
    } else {
        lv_group_remove_obj(s.c_ta);
        lv_obj_clear_state(s.c_ta, LV_STATE_FOCUSED);
    }
}

void set_status(const char* text, lv_color_t colour)
{
    auto& s = st();
    lv_label_set_text(s.c_status, text);
    lv_obj_set_style_text_color(s.c_status, colour, 0);
}

void close_compose(bool keep_draft)
{
    auto& s = st();
    if (s.mode == Compose::None) return;
    const char* text = lv_textarea_get_text(s.c_ta);
    if (s.mode == Compose::Reply) {
        if (keep_draft) { s.reply_draft = text ? text : ""; s.reply_draft_id = s.reply_id; }
        s.reply_id.clear();
        s.reply_version = -1;
    } else if (keep_draft) {
        s.capture_draft = text ? text : "";
    }
    if (s.compose_close) { lv_timer_del(s.compose_close); s.compose_close = nullptr; }
    ta_active(false);
    lv_textarea_set_text(s.c_ta, "");
    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    s.mode = Compose::None;
    footer();
}

void open_compose(Compose mode)
{
    auto& s = st();
    if (s.mode != Compose::None) close_compose(true);
    std::string head;
    if (mode == Compose::Reply) {
        const auto* it = current();
        // Questions take a pick, never text.
        if (!it || !it->can(dirigible::ActReply) || it->kind == AttentionKind::Question) return;
        s.reply_id = it->id;
        s.reply_version = s.shown_version;
        head = "Reply to " + source_of(*it);
        lv_textarea_set_placeholder_text(s.c_ta, "Type your reply to Claude");
        lv_textarea_set_max_length(s.c_ta, REPLY_MAX);
        lv_textarea_set_text(s.c_ta, s.reply_draft_id == it->id ? s.reply_draft.c_str() : "");
    } else {
        head = "Capture to Ideas";
        lv_textarea_set_placeholder_text(s.c_ta, "An idea, a todo, a link to read later");
        lv_textarea_set_max_length(s.c_ta, CAPTURE_MAX);
        lv_textarea_set_text(s.c_ta, s.capture_draft.c_str());
    }
    s.mode = mode;
    lv_label_set_text(s.c_head, head.c_str());
    set_status("", dg::text3());
    lv_obj_clear_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s.compose);
    ta_active(true);
    footer();
}

void compose_close_cb(lv_timer_t* t)
{
    auto& s = st();
    lv_timer_del(t);
    s.compose_close = nullptr;
    if (s.mode == Compose::Capture) close_compose(false);
}

void capture_submit()
{
    auto& s = st();
    const char* raw = lv_textarea_get_text(s.c_ta);
    if (!raw || !*raw) { set_status("Type something first", dg::text3()); return; }
    if (s.busy) return;
    if (!linked()) { set_status("Not connected", dg::error()); return; }

    auto done = [](const dirigible::CaptureOutcome& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "capture: %d %s", r.status, r.error.c_str());
            // Keep the text for another try.
            set_status(r.status == 404 ? "This Lee is too old to capture"
                                       : "Capture failed - Enter to retry", dg::error());
            return;
        }
        s.capture_draft.clear();
        if (s.mode != Compose::Capture) return;
        lv_textarea_set_text(s.c_ta, "");
        set_status(r.spooled ? "Saved - reaches Ideas when Hester is back"
                             : "Captured to Ideas",
                   r.spooled ? dg::ember() : dg::phosphor());
        if (!s.compose_close) s.compose_close = lv_timer_create(compose_close_cb, 1400, nullptr);
    };

    s.busy = true;
    set_status("Capturing...", dg::text2());
#if DIRIGIBLE_UI_DEMO
    static bool spool = false;
    dirigible::CaptureOutcome r;
    r.status = 200;
    r.ok = true;
    r.spooled = (spool = !spool);
    done(r);
#else
    conn()->capture(raw, done);
#endif
}

void compose_submit()
{
    auto& s = st();
    if (s.mode == Compose::Capture) { capture_submit(); return; }
    const char* raw = lv_textarea_get_text(s.c_ta);
    if (!raw || !*raw) { set_status("Type a reply first", dg::text3()); return; }
    const auto* snap = snapshot();
    if (!snap || !snap->find(s.reply_id)) { set_status("That item has gone", dg::ember()); return; }
    set_status("Sending...", dg::text2());
    // act() replies to the page's item; the box always belongs to it (the
    // page cannot move while the box is open).
    act("text", raw);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The whole item: GET /attention/:id, once per id + version
// ---------------------------------------------------------------------------

/// A question this device can answer here: the one shape Lee takes a pick
/// for, and Lee offering "choose" on it.
bool pickable(const AttentionItem& it)
{
    return it.choosable() && it.can(dirigible::ActChoose);
}

const Full* full_for(const AttentionItem& it)
{
    for (const Full& f : st().full) {
        if (!f.id.empty() && f.id == it.id && f.version == it.version) return &f;
    }
    return nullptr;
}

const std::string& words_of(const AttentionItem& it)
{
    const Full* f = full_for(it);
    return f && !f->gone && !f->text.empty() ? f->text : it.text;
}

const std::vector<dirigible::AttentionQuestion>& questions_of(const AttentionItem& it)
{
    const Full* f = full_for(it);
    return f && !f->gone && !f->questions.empty() ? f->questions : it.questions;
}

/// Words (and, for a question, its options) for the page's item.  Keeps the
/// scroll position, so the full text can land under a reader.
void fill_words(const AttentionItem& it)
{
    auto& s = st();
    std::string w;
    s.opt_count = 0;
    if (it.question_as_approval()) {
        w = "Claude is asking a question - answer in the tab.";
        if (!words_of(it).empty()) w += "\n\n" + words_of(it);
    } else if (it.kind == AttentionKind::Question) {
        const auto& qs = questions_of(it);
        if (pickable(it) && !qs.empty()) {
            w = qs[0].header.empty() ? qs[0].question : "[" + qs[0].header + "] " + qs[0].question;
            s.opt_count = std::min((int)qs[0].options.size(), MAX_OPTS);
            for (int i = 0; i < s.opt_count; i++) {
                const auto& o = qs[0].options[i];
                ui_set_text(s.opts[i].lbl, o.label);
                ui_set_text(s.opts[i].desc, o.description);
                if (o.description.empty()) lv_obj_add_flag(s.opts[i].desc, LV_OBJ_FLAG_HIDDEN);
                else                       lv_obj_clear_flag(s.opts[i].desc, LV_OBJ_FLAG_HIDDEN);
            }
        } else {
            // Several questions, multi-select or free text: read-only.
            for (size_t q = 0; q < qs.size(); q++) {
                if (q) w += "\n\n";
                if (!qs[q].header.empty()) w += "[" + qs[q].header + "] ";
                w += qs[q].question;
                if (qs[q].multi_select) w += " (pick several)";
                for (const auto& o : qs[q].options) {
                    w += "\n  " LV_SYMBOL_BULLET " " + o.label;
                    if (!o.description.empty()) w += " - " + o.description;
                }
            }
            if (qs.empty()) w = words_of(it);
            w += "\n\nAnswer in the tab.";
        }
    } else {
        w = words_of(it);
    }
    for (int i = 0; i < MAX_OPTS; i++) {
        if (i < s.opt_count) lv_obj_clear_flag(s.opts[i].obj, LV_OBJ_FLAG_HIDDEN);
        else                 lv_obj_add_flag(s.opts[i].obj, LV_OBJ_FLAG_HIDDEN);
    }
    if (s.opt_hl >= s.opt_count) set_hl(-1);
    lv_label_set_text(s.words, w.empty() ? "(no text)" : ui_fold(w, true).c_str());
    lv_obj_set_style_text_color(s.words, w.empty() ? dg::text3() : dg::text1(), 0);
}

#if !DIRIGIBLE_UI_DEMO
void full_hint_cb(lv_timer_t* t)
{
    auto& s = st();
    lv_timer_del(t);
    if (!s.full_pending_id.empty() && s.full_pending_id == s.shown_id &&
        app().view == View::Waiting) {
        flash(LV_SYMBOL_REFRESH " loading full text");
    }
}
#endif

/// Fetch the whole item when the snapshot's copy is (probably) clipped:
/// words at the compact cap, or a question.  One request per id + version.
void want_full(const AttentionItem& it)
{
#if DIRIGIBLE_UI_DEMO
    (void)it;
#else
    auto& s = st();
    const bool clipped = it.text.size() + 8 >= dirigible::ATTENTION_MAX_TEXT ||
                         it.kind == AttentionKind::Question;
    if (!clipped || full_for(it)) return;
    if (s.full_pending_id == it.id && s.full_pending_version == it.version) return;
    auto* c = conn();
    if (!c || !c->isConnected()) return;

    s.full_pending_id = it.id;
    s.full_pending_version = it.version;
    lv_timer_t* hint = lv_timer_create(full_hint_cb, FULL_HINT_MS, nullptr);
    lv_timer_set_repeat_count(hint, 1);

    const std::string id = it.id;
    const int version = it.version;
    c->fetchAttentionItem(id, [id, version](int status, const AttentionItem* item) {
        auto& s = st();
        if (s.full_pending_id == id && s.full_pending_version == version) {
            s.full_pending_id.clear();
            s.full_pending_version = -1;
        }
        const bool gone = status == 404 || status == 410;
        if (!item && !gone) {
            ESP_LOGW(TAG, "full item %s: HTTP %d", id.c_str(), status);
            return;   // try again next time it is opened
        }
        // Oldest slot goes: a few bodies of <= 2000 characters at most.
        Full& f = s.full[s.full_next];
        s.full_next = (s.full_next + 1) % FULL_CACHE;
        f.id = id;
        f.version = version;
        f.gone = gone;
        f.text = item ? item->text : std::string();
        f.questions = item ? item->questions : std::vector<dirigible::AttentionQuestion>();
        if (gone) return;   // the next snapshot drops it
        if (s.shown_id == id && s.shown_version == version) {
            if (const auto* cur = current(); cur && cur->id == id) {
                // The chosen option must not shift under the ball, so a
                // question keeps its highlight index.
                fill_words(*cur);
                if ((int32_t)(s.flash_until - lv_tick_get()) > 0) {
                    s.flash_until = 0;
                    centre_status();
                }
            }
        }
    });
#endif
}

// ---------------------------------------------------------------------------
// Question options: touch picks one; the ball highlights and its click picks
// ---------------------------------------------------------------------------

void set_hl(int i)
{
    auto& s = st();
    if (s.opt_hl >= 0 && s.opt_hl < MAX_OPTS) lv_obj_clear_state(s.opts[s.opt_hl].obj, LV_STATE_FOCUSED);
    s.opt_hl = i;
    if (i < 0) return;
    lv_obj_add_state(s.opts[i].obj, LV_STATE_FOCUSED);
    lv_obj_scroll_to_view(s.opts[i].obj, LV_ANIM_ON);
}

void choose(int i)
{
    auto& s = st();
    if (i < 0 || i >= s.opt_count || s.mode != Compose::None) return;
    set_hl(i);
    act("choose", std::string(), i);
}

void opt_cb(lv_event_t* e)
{
    choose((int)(intptr_t)lv_event_get_user_data(e));
}

/// True when the whole first option is inside the words box.
bool first_opt_visible()
{
    auto& s = st();
    if (s.opt_count == 0) return false;
    lv_area_t box, o;
    lv_obj_get_coords(s.scroll, &box);
    lv_obj_get_coords(s.opts[0].obj, &o);
    return o.y2 <= box.y2;
}

void question_ball(int dy, bool click)
{
    static BallAcc acc;
    auto& s = st();
    if (click) {
        if (s.opt_hl >= 0) choose(s.opt_hl);
        else               set_hl(0);   // a first click only shows what the next sends
        return;
    }
    if (s.opt_hl < 0) {
        // Read the question first; the highlight starts once the options
        // are on screen.
        if (dy > 0 && first_opt_visible()) set_hl(0);
        else scroll_words(ball_scroll_px(dy));
        return;
    }
    const int n = ball_steps(acc, dy);
    if (!n) return;
    int h = s.opt_hl + n;
    if (h < 0) { set_hl(-1); scroll_words(ball_scroll_px(dy)); return; }
    if (h >= s.opt_count) h = s.opt_count - 1;
    set_hl(h);
}

void style_btn(Btn& b, bool primary)
{
    lv_obj_set_style_bg_color(b.obj, primary ? dg::phosphor() : dg::ground3(), 0);
    lv_obj_set_style_bg_color(b.obj, primary ? dg::phosphor_hi() : dg::ground4(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(b.obj, primary ? 0 : 1, 0);
    lv_obj_set_style_text_color(b.lbl, primary ? dg::on_phosphor() : dg::text1(), 0);
}

/// Up to three buttons across the bar; the first is the primary action and
/// takes the extra width.
void layout_buttons(const AttentionItem& it)
{
    auto& s = st();
    struct Spec { const char* name; char key; };
    Spec spec[MAX_BTNS];
    int n = 0;
    const bool question = it.kind == AttentionKind::Question || it.question_as_approval();
    if (question) {
        // The options are the answer (or the tab is): no Approve / Deny.
        if (!pickable(it) && it.can(dirigible::ActOpen)) spec[n++] = { "Open tab", 'o' };
        if (it.can(dirigible::ActDismiss)) spec[n++] = { "Dismiss", 'd' };
    } else if (it.can(dirigible::ActApprove)) {
        spec[n++] = { "Approve", 'y' };
        if (it.can(dirigible::ActDeny)) spec[n++] = { "Deny", 'n' };
    } else if (takes_text(it)) {
        // Go / Wait / Why / Reply; Diff, dismiss and snooze stay on f, d and s.
        for (int i = 0; i < QUICK_ON_BAR; i++) spec[n++] = { QUICK[i].name, QUICK[i].key };
        spec[n++] = { "Reply", 'r' };
    } else {
        if (it.can(dirigible::ActReply))   spec[n++] = { "Reply", 'r' };
        if (it.can(dirigible::ActDismiss)) spec[n++] = { "Dismiss", 'd' };
    }
    if (n < MAX_BTNS && it.can(dirigible::ActSnooze)) spec[n++] = { "Snooze", 's' };

    const int gap = 4;
    const int inner = SCREEN_W - 2 * 2;
    int x = 2;
    for (int i = 0; i < MAX_BTNS; i++) {
        Btn& b = s.btns[i];
        if (i >= n) { lv_obj_add_flag(b.obj, LV_OBJ_FLAG_HIDDEN); b.key = 0; continue; }
        int w;
        if (n == 1)      w = inner;
        else if (n == 2) w = (inner - gap) / 2;
        else if (n == 4) w = (inner - 3 * gap) / 4;
        else             w = i == 0 ? 124 : (inner - 2 * gap - 124) / 2;
        lv_obj_set_pos(b.obj, x, BAR_Y);
        lv_obj_set_size(b.obj, w, BAR_H);
        x += w + gap;
        b.key = spec[i].key;
        // Phosphor marks one next step (Approve); the quick replies are
        // equals, so none of them is filled.
        const bool primary = i == 0 && spec[i].key != 'd' && spec[i].key != 's' &&
                             !quick_for(spec[i].key) && !(question && pickable(it));
        style_btn(b, primary);
        // "Approve (Y)": the key after the word, capitalised for display
        // (the keyboard still takes the lowercase letter), a shade quieter.
        char text[48];
        snprintf(text, sizeof(text), "%s #%06x (%c)#", spec[i].name,
                 (unsigned)(primary ? DG_GROUND_4 : DG_TEXT_3), spec[i].key - 'a' + 'A');
        lv_label_set_text(b.lbl, text);
        lv_obj_clear_flag(b.obj, LV_OBJ_FLAG_HIDDEN);
    }
    lv_obj_set_height(s.scroll, n ? WORDS_H : BODY_H - WORDS_Y - 4);
}

void render_page(const AttentionItem& it)
{
    auto& s = st();
    lv_obj_add_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.page, LV_OBJ_FLAG_HIDDEN);

    // Meta line: kind chip, source, age and position.  Cheap, redrawn always.
    lv_label_set_text(s.chip_lbl, kind_chip(it.kind));
    lv_obj_set_style_bg_color(s.chip, severity_colour(it), 0);
    lv_obj_set_style_text_color(s.chip_lbl,
        it.severity == AttentionSeverity::Ambient || it.parked ? dg::text1() : dg::on_phosphor(), 0);
    lv_obj_update_layout(s.chip);
    const int chip_w = lv_obj_get_width(s.chip);
    lv_obj_set_x(s.source, PAD + chip_w + 6);

    char meta[40];
    const std::string age = fmt_age(live_age(it));
    if (!s.pinned_id.empty()) {
        snprintf(meta, sizeof(meta), "%s", age.c_str());
    } else {
        snprintf(meta, sizeof(meta), "%s%s   %d/%d", it.parked ? "parked  " : "",
                 age.c_str(), s.pos + 1, s.count);
    }
    lv_label_set_text(s.meta, meta);
    lv_obj_set_style_text_color(s.meta, it.notify ? dg::ember() : dg::text3(), 0);
    lv_obj_update_layout(s.meta);
    lv_obj_set_width(s.source, SCREEN_W - PAD - (PAD + chip_w + 6) - lv_obj_get_width(s.meta) - 8);

    // Words and buttons only when the item itself changed, so a snapshot or
    // the age tick never yanks the text out from under the reader.
    if (it.id == s.shown_id && it.version == s.shown_version && it.actions == s.shown_actions) return;
    const bool same_item = it.id == s.shown_id;
    s.shown_id = it.id;
    s.shown_version = it.version;
    s.shown_actions = it.actions;

    lv_label_set_text(s.source, source_of(it).c_str());
    lv_label_set_text(s.title, ui_fold(it.title, false).c_str());
    if (!same_item) set_hl(-1);
    fill_words(it);
    if (!same_item) lv_obj_scroll_to_y(s.scroll, 0, LV_ANIM_OFF);
    layout_buttons(it);
    want_full(it);
}

void render_empty(const char* title, const char* sub, bool with_recent)
{
    auto& s = st();
    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
    s.shown_id.clear();
    s.shown_version = -1;

    // Pick up sits on top when there is one (only with nothing to answer:
    // an item that needs you is the next step).  The recent turns get what
    // is left above the hint buttons, so fewer show under a pick-up.
    const int pick_h = pick_up_render(with_recent);
    const int top = pick_h ? PICKUP_Y + pick_h + 6 : 10;
    const auto* snap = snapshot();
    int n = with_recent && snap ? s.recent_count : 0;
    const int rows_y = top + 42;
    const int fit = std::max(0, (HINT_Y - 4 - rows_y + 4) / (ROW_H + 4));
    n = std::min(n, fit);
    lv_label_set_text(s.e_title, title);
    lv_label_set_text(s.e_sub, sub);
    lv_obj_set_y(s.e_title, n || pick_h ? top : 58);
    lv_obj_set_y(s.e_sub, n || pick_h ? top + 23 : 86);

    for (int i = 0; i < RECENT; i++) {
        Row& row = s.rows[i];
        if (i >= n) { lv_obj_add_flag(row.obj, LV_OBJ_FLAG_HIDDEN); continue; }
        const auto& it = snap->items[s.recent[i]];
        lv_obj_set_y(row.obj, rows_y + i * (ROW_H + 4));
        lv_obj_clear_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(row.title, ui_fold(it.title, false).c_str());
        std::string m = kind_chip(it.kind);
        for (auto& ch : m) ch = (char)((ch >= 'A' && ch <= 'Z') ? ch - 'A' + 'a' : ch);
        if (!it.tab_label.empty()) m += "  " LV_SYMBOL_BULLET "  " + ui_fold(it.tab_label, false);
        const std::string age = fmt_age(live_age(it));
        if (!age.empty()) m += "  " LV_SYMBOL_BULLET "  " + age;
        lv_label_set_text(row.meta, m.c_str());
    }
}

void render()
{
    auto& s = st();
    auto& a = app();
    rebuild();

    // A reply box whose item has gone: answered in the tab, from Lee or
    // another device.  Its draft goes with it.
    if (s.mode == Compose::Reply) {
        const auto* snap = snapshot();
        if (!snap || !snap->find(s.reply_id)) {
            s.reply_draft.clear();
            s.reply_draft_id.clear();
            close_compose(false);
            flash("handled elsewhere");
        }
    }

    if (!linked()) {
        char sub[128];
        auto* m = a.machines ? a.machines->activeMachine() : nullptr;
        if (m) {
            snprintf(sub, sizeof(sub), "%.24s  %.30s:%d\nTap = or hold the ball for the menu:\nReconnect or Pairing.",
                     m->config.name.c_str(), m->config.host.c_str(), m->config.lee_port);
            render_empty("Not connected", sub, false);
        } else {
            render_empty("No machine paired", "Tap = or hold the ball for the menu:\nPairing.", false);
        }
    } else if (!snapshot()) {
        auto* c = conn();
        if (c && c->attentionUnsupported()) {
            render_empty("No attention queue", "This Lee is older than the queue.\nUpdate Lee; t shows the tabs.", false);
        } else {
            render_empty("Loading...", "", false);
        }
    } else if (const auto* it = current()) {
        render_page(*it);
    } else {
        const auto* snap = snapshot();
        const int working = snap ? snap->working() : 0;
        std::string sub;
        if (s.recent_count) {
            sub = "Recently finished";
        } else if (working) {
            sub = dirigible::number_word(working, true) +
                  (working == 1 ? " agent is working: i shows it." : " agents are working: i shows them.");
        } else {
            sub = "Agents will show up here when they ask.";
        }
        render_empty("Nothing needs you", sub.c_str(), true);
    }
    centre_status();
    footer();
}

void go(int delta)
{
    auto& s = st();
    if (!s.pinned_id.empty() || s.count == 0 || s.mode != Compose::None) return;
    const int p = std::max(0, std::min(s.count - 1, s.pos + delta));
    if (p == s.pos) { flash(delta > 0 ? "last item" : "first item"); return; }
    s.pos = p;
    const auto* snap = snapshot();
    s.cur_id = snap->items[s.order[s.pos]].id;
    render();
}

/// Move `px` further into the agent's words (negative: back towards the top).
void scroll_words(int px)
{
    auto& s = st();
    if (lv_obj_has_flag(s.page, LV_OBJ_FLAG_HIDDEN)) return;
    lv_obj_scroll_by_bounded(s.scroll, 0, -px, LV_ANIM_OFF);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

void key_action(char k)
{
    switch (k) {
    case 'y': act("approve"); break;
    case 'n': act("deny"); break;
    case 'd': act("dismiss"); break;
    case 's': act("snooze"); break;
    case 'r': open_compose(Compose::Reply); break;
    case 'o': act("open"); break;
    case 'g': case 'w': case 'e': case 'f': quick_reply(k); break;
    default: break;
    }
}

void btn_cb(lv_event_t* e)
{
    const Btn* b = (const Btn*)lv_event_get_user_data(e);
    if (b && st().mode == Compose::None) key_action(b->key);
}

void gesture_cb(lv_event_t*)
{
    lv_indev_t* indev = lv_indev_get_act();
    if (!indev) return;
    const lv_dir_t dir = lv_indev_get_gesture_dir(indev);
    if (dir != LV_DIR_LEFT && dir != LV_DIR_RIGHT) return;
    // A swipe that starts on a button must not also click it on release.
    lv_indev_wait_release(indev);
    go(dir == LV_DIR_LEFT ? 1 : -1);
}

void row_cb(lv_event_t* e)
{
    auto& s = st();
    const int i = (int)(intptr_t)lv_event_get_user_data(e);
    const auto* snap = snapshot();
    if (!snap || i >= s.recent_count || s.mode != Compose::None) return;
    s.pinned_id = snap->items[s.recent[i]].id;
    render();
}

void hint_cb(lv_event_t* e)
{
    if (st().mode != Compose::None) return;
    switch ((char)(intptr_t)lv_event_get_user_data(e)) {
    case 'c': waiting_open_capture(); break;
    case 'i': inflight_open(); break;
    case 'v': review_open(); break;
    default: break;
    }
}

void blink_cb(lv_timer_t* t)
{
    auto& s = st();
    auto& a = app();
    if (!a.header) return;
    s.blink_left--;
    const bool on = s.blink_left > 0 && (s.blink_left % 2) == 1;
    lv_obj_set_style_bg_color(a.header, on ? dg::ember() : dg::ground1(), 0);
    if (s.blink_left <= 0) {
        lv_timer_del(t);
        s.blink = nullptr;
    }
}

/// Once a second: let a flashed header message expire; every 30 s redraw so
/// ages stay honest (the page keeps its scroll: only the meta line changes).
void tick_cb(lv_timer_t*)
{
    auto& s = st();
    if (app().view != View::Waiting) return;
    if (s.flash_until && (int32_t)(s.flash_until - lv_tick_get()) <= 0) {
        s.flash_until = 0;
        centre_status();
    }
    if (++s.ticks >= 30) {
        s.ticks = 0;
        render();
    }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

lv_obj_t* label(lv_obj_t* parent, const lv_font_t* font, lv_color_t colour, const char* text = "")
{
    lv_obj_t* l = lv_label_create(parent);
    lv_label_set_text(l, text);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, colour, 0);
    return l;
}

lv_obj_t* panel(lv_obj_t* parent)
{
    lv_obj_t* p = lv_obj_create(parent);
    lv_obj_remove_style_all(p);
    lv_obj_set_pos(p, 0, 0);
    lv_obj_set_size(p, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(p, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(p, LV_OPA_COVER, 0);
    lv_obj_clear_flag(p, LV_OBJ_FLAG_SCROLLABLE);
    return p;
}

lv_obj_t* flat_btn(lv_obj_t* parent)
{
    lv_obj_t* b = lv_btn_create(parent);
    lv_obj_remove_style_all(b);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(b, DG_RADIUS, 0);
    lv_obj_set_style_border_color(b, dg::ground4(), 0);
    lv_obj_set_style_border_opa(b, LV_OPA_COVER, 0);
    lv_obj_clear_flag(b, LV_OBJ_FLAG_SCROLLABLE);
    return b;
}

void build_page(lv_obj_t* parent)
{
    auto& s = st();
    s.page = panel(parent);
    lv_obj_add_event_cb(s.page, gesture_cb, LV_EVENT_GESTURE, nullptr);

    s.chip = lv_obj_create(s.page);
    lv_obj_remove_style_all(s.chip);
    lv_obj_set_pos(s.chip, PAD, META_Y);
    lv_obj_set_size(s.chip, LV_SIZE_CONTENT, CHIP_H);
    lv_obj_set_style_bg_opa(s.chip, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s.chip, DG_RADIUS, 0);
    lv_obj_set_style_pad_hor(s.chip, 5, 0);
    lv_obj_clear_flag(s.chip, LV_OBJ_FLAG_CLICKABLE);
    s.chip_lbl = label(s.chip, F_META, dg::on_phosphor());
    lv_obj_set_style_text_letter_space(s.chip_lbl, 1, 0);
    lv_obj_align(s.chip_lbl, LV_ALIGN_LEFT_MID, 0, 0);

    s.source = label(s.page, F_META, dg::text2());
    lv_label_set_long_mode(s.source, LV_LABEL_LONG_DOT);
    lv_obj_set_pos(s.source, PAD + 70, META_Y + 1);

    s.meta = label(s.page, F_META, dg::text3());
    lv_obj_align(s.meta, LV_ALIGN_TOP_RIGHT, -PAD, META_Y + 1);

    s.title = label(s.page, F_TITLE, dg::text1());
    lv_label_set_long_mode(s.title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.title, SCREEN_W - 2 * PAD);
    lv_obj_set_pos(s.title, PAD, TITLE_Y);

    // The agent's words: the reason this view exists.  Wrapped, proportional,
    // scrolled by the ball (vertical detents) or a finger.
    s.scroll = lv_obj_create(s.page);
    lv_obj_remove_style_all(s.scroll);
    lv_obj_set_pos(s.scroll, 0, WORDS_Y);
    lv_obj_set_size(s.scroll, SCREEN_W, WORDS_H);
    lv_obj_set_style_pad_hor(s.scroll, PAD, 0);
    lv_obj_set_style_pad_ver(s.scroll, 2, 0);
    lv_obj_set_scroll_dir(s.scroll, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.scroll, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s.scroll, dg::ground5(), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s.scroll, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s.scroll, 3, LV_PART_SCROLLBAR);
    lv_obj_set_style_pad_right(s.scroll, 1, LV_PART_SCROLLBAR);

    s.words = label(s.scroll, F_BODY, dg::text1());
    lv_label_set_long_mode(s.words, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.words, SCREEN_W - 2 * PAD - 4);
    lv_obj_set_style_text_line_space(s.words, 2, 0);

    // A question's options follow its words in the same scroll: bordered
    // touch buttons, label over a dimmed description.  Out of the input group
    // (the ball drives its own highlight here).
    lv_obj_set_flex_flow(s.scroll, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(s.scroll, 4, 0);
    for (int i = 0; i < MAX_OPTS; i++) {
        Opt& o = s.opts[i];
        o.obj = flat_btn(s.scroll);
        if (lv_obj_get_group(o.obj)) lv_group_remove_obj(o.obj);
        lv_obj_set_width(o.obj, SCREEN_W - 2 * PAD - 4);
        lv_obj_set_height(o.obj, LV_SIZE_CONTENT);
        lv_obj_set_style_min_height(o.obj, 30, 0);
        lv_obj_set_style_bg_color(o.obj, dg::ground1(), 0);
        lv_obj_set_style_bg_color(o.obj, dg::ground3(), LV_STATE_PRESSED);
        lv_obj_set_style_border_width(o.obj, 1, 0);
        lv_obj_set_style_border_color(o.obj, dg::ground5(), 0);
        dg::style_focus(o.obj);
        lv_obj_set_style_border_width(o.obj, 2, LV_STATE_FOCUSED);
        lv_obj_set_style_pad_all(o.obj, 5, 0);
        lv_obj_set_style_pad_row(o.obj, 1, 0);
        lv_obj_set_flex_flow(o.obj, LV_FLEX_FLOW_COLUMN);
        o.lbl = label(o.obj, F_BODY, dg::text1());
        lv_label_set_long_mode(o.lbl, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(o.lbl, LV_PCT(100));
        o.desc = label(o.obj, F_META, dg::text3());
        lv_label_set_long_mode(o.desc, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(o.desc, LV_PCT(100));
        lv_obj_add_event_cb(o.obj, opt_cb, LV_EVENT_CLICKED, (void*)(intptr_t)i);
        lv_obj_add_flag(o.obj, LV_OBJ_FLAG_HIDDEN);
    }

    for (auto& b : s.btns) {
        b.obj = flat_btn(s.page);
        lv_obj_set_size(b.obj, 100, BAR_H);
        b.lbl = label(b.obj, F_BODY, dg::text1());
        lv_label_set_recolor(b.lbl, true);
        lv_obj_center(b.lbl);
        lv_obj_add_event_cb(b.obj, btn_cb, LV_EVENT_CLICKED, &b);
        lv_obj_add_flag(b.obj, LV_OBJ_FLAG_HIDDEN);
    }
}

void build_empty(lv_obj_t* parent)
{
    auto& s = st();
    s.empty = panel(parent);

    s.e_title = label(s.empty, F_TITLE, dg::text1());
    lv_obj_set_width(s.e_title, SCREEN_W - 2 * PAD);
    lv_obj_set_style_text_align(s.e_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_x(s.e_title, PAD);

    s.e_sub = label(s.empty, F_META, dg::text3());
    lv_label_set_long_mode(s.e_sub, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.e_sub, SCREEN_W - 4 * PAD);
    lv_obj_set_style_text_align(s.e_sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_x(s.e_sub, 2 * PAD);

    for (int i = 0; i < RECENT; i++) {
        Row& row = s.rows[i];
        row.obj = flat_btn(s.empty);
        lv_obj_set_pos(row.obj, PAD, 52 + i * (ROW_H + 4));
        lv_obj_set_size(row.obj, SCREEN_W - 2 * PAD, ROW_H);
        lv_obj_set_style_bg_color(row.obj, dg::ground1(), 0);
        lv_obj_set_style_bg_color(row.obj, dg::ground3(), LV_STATE_PRESSED);
        dg::style_focus(row.obj);   // the ball's highlight
        lv_obj_add_event_cb(row.obj, row_cb, LV_EVENT_CLICKED, (void*)(intptr_t)i);

        row.title = label(row.obj, F_BODY, dg::text2());
        lv_label_set_long_mode(row.title, LV_LABEL_LONG_DOT);
        lv_obj_set_width(row.title, SCREEN_W - 2 * PAD - 12);
        lv_obj_set_pos(row.title, 6, 1);

        row.meta = label(row.obj, F_META, dg::text3());
        lv_label_set_long_mode(row.meta, LV_LABEL_LONG_DOT);
        lv_obj_set_width(row.meta, SCREEN_W - 2 * PAD - 12);
        lv_obj_set_pos(row.meta, 6, 18);
        lv_obj_add_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
    }

    // Three bordered buttons along the bottom, each naming its key.
    static const struct { char key; const char* text; } hints[] = {
        { 'c', "Capture (C)" }, { 'i', "In flight (I)" }, { 'v', "Review (V)" },
    };
    const int gap = 4;
    const int w = (SCREEN_W - 2 * PAD - 2 * gap) / 3;
    for (int i = 0; i < 3; i++) {
        lv_obj_t* b = flat_btn(s.empty);
        lv_obj_set_pos(b, PAD + i * (w + gap), HINT_Y);
        lv_obj_set_size(b, w, HINT_H);
        lv_obj_set_style_bg_color(b, dg::ground1(), 0);
        lv_obj_set_style_bg_color(b, dg::ground3(), LV_STATE_PRESSED);
        lv_obj_set_style_border_width(b, 1, 0);
        lv_obj_set_style_border_color(b, dg::ground5(), 0);
        dg::style_focus(b, dg::ground1());
        lv_obj_add_event_cb(b, hint_cb, LV_EVENT_CLICKED, (void*)(intptr_t)hints[i].key);
        lv_obj_t* l = label(b, F_BODY, dg::text2(), hints[i].text);
        lv_obj_center(l);
    }
}

void build_compose(lv_obj_t* parent)
{
    auto& s = st();
    s.compose = panel(parent);

    s.c_head = label(s.compose, F_META, dg::text2());
    lv_label_set_long_mode(s.c_head, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.c_head, SCREEN_W - 2 * PAD);
    lv_obj_set_pos(s.c_head, PAD, META_Y + 1);

    s.c_ta = lv_textarea_create(s.compose);
    lv_textarea_set_one_line(s.c_ta, false);   // wraps; Enter is caught and sends
    lv_obj_set_pos(s.c_ta, PAD - 2, 22);
    lv_obj_set_size(s.c_ta, SCREEN_W - 2 * (PAD - 2), COMPOSE_BTN_Y - 4 - 22);
    lv_obj_set_style_text_font(s.c_ta, F_BODY, 0);
    lv_obj_set_style_text_color(s.c_ta, dg::text1(), 0);
    lv_obj_set_style_text_color(s.c_ta, dg::text3(), LV_PART_TEXTAREA_PLACEHOLDER);
    lv_obj_set_style_bg_color(s.c_ta, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(s.c_ta, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(s.c_ta, 1, 0);
    lv_obj_set_style_border_color(s.c_ta, dg::ground4(), 0);
    lv_obj_set_style_radius(s.c_ta, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(s.c_ta, 6, 0);
    lv_obj_set_style_text_line_space(s.c_ta, 2, 0);
    dg::style_input_focus(s.c_ta);

    // Bordered touch buttons under the box: Cancel keeps the draft, Send is
    // Enter.  The status line sits between them.
    const int bw_cancel = 78, bw_send = 108;
    lv_obj_t* cancel = flat_btn(s.compose);
    lv_obj_set_pos(cancel, PAD - 2, COMPOSE_BTN_Y);
    lv_obj_set_size(cancel, bw_cancel, COMPOSE_BTN_H);
    lv_obj_set_style_bg_color(cancel, dg::ground1(), 0);
    lv_obj_set_style_bg_color(cancel, dg::ground3(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(cancel, 1, 0);
    lv_obj_set_style_border_color(cancel, dg::ground5(), 0);
    lv_obj_add_event_cb(cancel, [](lv_event_t*) { close_compose(true); }, LV_EVENT_CLICKED, nullptr);
    lv_obj_center(label(cancel, F_BODY, dg::text2(), "Cancel"));

    lv_obj_t* send = flat_btn(s.compose);
    lv_obj_set_pos(send, SCREEN_W - (PAD - 2) - bw_send, COMPOSE_BTN_Y);
    lv_obj_set_size(send, bw_send, COMPOSE_BTN_H);
    lv_obj_set_style_bg_color(send, dg::phosphor(), 0);
    lv_obj_set_style_bg_color(send, dg::phosphor_hi(), LV_STATE_PRESSED);
    lv_obj_add_event_cb(send, [](lv_event_t*) { compose_submit(); }, LV_EVENT_CLICKED, nullptr);
    s.c_hint = label(send, F_BODY, dg::on_phosphor());
    lv_label_set_recolor(s.c_hint, true);
    char send_text[40];
    snprintf(send_text, sizeof(send_text), "Send #%06x (Enter)#", (unsigned)DG_GROUND_4);
    lv_label_set_text(s.c_hint, send_text);
    lv_obj_center(s.c_hint);
    // Touch-only: the text box keeps the keyboard (Enter already sends).
    if (lv_obj_get_group(cancel)) lv_group_remove_obj(cancel);
    if (lv_obj_get_group(send))   lv_group_remove_obj(send);

    s.c_status = label(s.compose, F_META, dg::text3());
    lv_label_set_long_mode(s.c_status, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.c_status, SCREEN_W - 2 * PAD - bw_cancel - bw_send - 8);
    lv_obj_set_style_text_align(s.c_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s.c_status, PAD - 2 + bw_cancel + 6, COMPOSE_BTN_Y + 1);

    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
}

#if DIRIGIBLE_UI_DEMO
// ---------------------------------------------------------------------------
// DIRIGIBLE_UI_DEMO: a canned queue, no Lee needed.  Actions remove the item
// locally, so answering everything reaches the empty state; j there refills.
// The approval's text is longer than Lee's compact 280-character cap on
// purpose, to exercise scrolling.
// ---------------------------------------------------------------------------
AttentionItem demo_item(const char* id, AttentionKind kind, AttentionSeverity sev,
                        const char* title, const char* tab, int64_t age_min,
                        uint8_t actions, const char* text)
{
    AttentionItem it;
    it.id = id;
    it.version = 1;
    it.kind = kind;
    it.severity = sev;
    it.title = title;
    it.tab_label = tab;
    it.age_ms = age_min * 60000;
    it.actions = actions;
    it.text = text;
    return it;
}

void demo_fill()
{
    using namespace dirigible;
    auto& s = demo_snap();
    s.items.clear();
    s.items.push_back(demo_item("demo-approval", AttentionKind::Approval, AttentionSeverity::NeedsYou,
        "Claude wants to use Bash", "firmware", 4,
        ActApprove | ActDeny | ActOpen | ActSnooze | ActDismiss,
        "idf.py -B build-demo -DDIRIGIBLE_UI_DEMO=1 build\n\n"
        "I want to rebuild the demo firmware to check that the new Waiting pager "
        "compiles with the canned queue. This configures a fresh build directory "
        "under dirigible/firmware/build-demo, which takes about two minutes the "
        "first time and writes nothing outside it. Nothing is flashed: the device "
        "keeps the firmware it has until you flash it yourself. If the build "
        "fails I will read the first error, fix it and ask again before running "
        "anything else."));
    s.items.push_back(demo_item("demo-question", AttentionKind::Waiting, AttentionSeverity::NeedsYou,
        "Claude is waiting for you", "lee copilot", 2,
        ActReply | ActOpen | ActSnooze | ActDismiss,
        "Should the capture box keep its draft when you press Cancel, or clear it? "
        "I lean towards keeping it: a stray tap should not cost a paragraph."));
    {
        AttentionItem q = demo_item("demo-pick", AttentionKind::Question, AttentionSeverity::NeedsYou,
            "Claude asks: how should wide tables render?", "lee copilot", 1,
            ActChoose | ActOpen | ActSnooze | ActDismiss, "");
        AttentionQuestion aq;
        aq.header = "Table layout";
        aq.question = "Wide markdown tables: how should the viewer draw them when the "
                      "columns do not fit 320 px?";
        aq.options = {
            { "Monospace grid", "Pan it sideways with the ball or h/l, like code." },
            { "Wrap the cells", "Keep Montserrat and wrap each cell inside its column." },
            { "Both", "Wrap up to four columns, pan anything wider." },
        };
        q.questions.push_back(aq);
        s.items.push_back(q);
    }
    {
        AttentionItem q = demo_item("demo-ask-old", AttentionKind::Approval, AttentionSeverity::NeedsYou,
            "Claude wants to use AskUserQuestion", "hester", 3,
            ActApprove | ActDeny | ActOpen | ActSnooze | ActDismiss,
            "Which port should the daemon use?");
        q.tool_name = "AskUserQuestion";
        s.items.push_back(q);
    }
    s.items.push_back(demo_item("demo-blocker", AttentionKind::Blocker, AttentionSeverity::Blocking,
        "Claude is blocked", "design", 11,
        ActReply | ActOpen | ActSnooze | ActDismiss,
        "design/build.mjs fails: tokens.json has no \xE2\x80\x9C" "disabled\xE2\x80\x9D fill. "
        "Add one, or reuse ground-5?"));
    s.items.push_back(demo_item("demo-review", AttentionKind::Review, AttentionSeverity::Ambient,
        "Claude finished a turn", "aeronaut", 6, ActReply | ActOpen | ActDismiss,
        "Moved the Files browser to the new fs endpoints and removed the old "
        "polling path. Tests pass."));
    s.items.push_back(demo_item("demo-exit", AttentionKind::Failure, AttentionSeverity::Ambient,
        "Claude exited (code 1)", "hester", 42, ActOpen | ActDismiss, "Session ended."));
    s.focus_active = false;

    // In flight: one of each state, with and without the Cockpit-design fields.
    s.agents.clear();
    {
        AgentSummary a;
        a.pty_id = 7; a.label = "lee copilot"; a.provider = "claude";
        a.state = AgentState::Busy; a.busy_ms = 18 * 60000;
        a.has_now = true; a.now.tool = "Bash"; a.now.preview = "cd electron && npm test";
        a.last_summary = "Wiring Tether into the device snapshot; the smokes are next.";
        a.recent.push_back({ "Edit", "/ws/electron/src/main/copilot/queue.ts",
                             { "/ws/electron/src/main/copilot/queue.ts" }, false, true, 4 * 60000 });
        a.recent.push_back({ "Grep", "open_next", {}, false, true, 2 * 60000 });
        a.has_usage = true; a.usage.shown_tokens = 412345; a.usage.cost_basis = "subscription";
        s.agents.push_back(a);
    }
    {
        AgentSummary a;
        a.pty_id = 9; a.label = "firmware"; a.provider = "claude";
        a.state = AgentState::Waiting; a.busy_ms = 6 * 60000;
        a.last_summary = "I want to rebuild the demo firmware; approve the command on Work.";
        a.has_usage = true; a.usage.shown_tokens = 1234567;
        s.agents.push_back(a);
    }
    {
        AgentSummary a;
        a.pty_id = 11; a.label = "aeronaut"; a.provider = "claude";
        a.state = AgentState::Idle; a.idle_ms = 35 * 60000;
        a.last_summary = "Moved the Files browser to the new fs endpoints and removed the old "
                         "polling path. Tests pass.";
        a.updates.push_back({ "Started on the Files browser: the tree loads over /fs/list now.", 70 * 60000 });
        s.agents.push_back(a);
    }
    s.has_limits = true;
    s.limits.five_hour_pct = 42;
    st().snapshot_tick = lv_tick_get();
}
#endif

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

const AttentionSnapshot* cockpit_snapshot()
{
    return snapshot();
}

bool cockpit_linked()
{
    return linked();
}

std::string cockpit_status()
{
    const auto* snap = snapshot();
    if (!linked()) return "disconnected";
    if (!snap) {
        auto* c = conn();
        return c && c->attentionUnsupported() ? "no queue" : "loading";
    }
    // Desk D2 §9.2: the idle-end push is the one thing a Deep session sends.
    if (snap->deep_idle()) return "Still thinking?  x";
    // A Deep session at the machine: nothing is pushed here (agents park),
    // and the header says why.
    if (snap->deep_active) return "In deep work";
    const int waiting = waiting_count(*snap);
    if (snap->away_active) {
        return waiting ? "away: " + std::to_string(waiting) + " waiting" : std::string("away: clear");
    }
    return dirigible::work_line(waiting, snap->working());
}

bool cockpit_nav_key(uint8_t k)
{
    switch (k) {
    case 'w': if (app().view != View::Waiting)  waiting_open();  return true;
    case 'i': if (app().view != View::InFlight) inflight_open(); return true;
    case 'v': if (app().view != View::Review)   review_open();   return true;
    case 'x':
        if (!deep_idle_pending()) return false;
        if (app().view != View::DeepIdle) deep_idle_open();
        return true;
    default:  return false;
    }
}

void waiting_build(lv_obj_t* parent)
{
    auto& a = app();
    a.view_waiting = panel(parent);
    build_empty(a.view_waiting);
    pick_up_build(st().empty, PICKUP_Y);
    lv_obj_move_to_index(pick_up_obj(), 0);   // first row the ball reaches
    build_page(a.view_waiting);
    build_compose(a.view_waiting);
    lv_obj_add_flag(st().page, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_waiting, LV_OBJ_FLAG_HIDDEN);
    lv_timer_create(tick_cb, 1000, nullptr);
#if DIRIGIBLE_UI_DEMO
    demo_fill();
#endif
}

void waiting_open()
{
    auto& s = st();
    close_compose(true);
    s.pinned_id.clear();
    s.device_for.clear();        // re-read after a re-pair
    s.reply_forbidden = false;   // give a fresh token the benefit of the doubt
    app_show(View::Waiting);
    if (auto* c = conn(); c && c->isConnected()) c->fetchAttention();
    tether_fetch();
}

void waiting_open_capture()
{
    if (app().view != View::Waiting) waiting_open();
    open_compose(Compose::Capture);
}

void waiting_render(bool new_snapshot)
{
    if (new_snapshot) st().snapshot_tick = lv_tick_get();
    render();
}

void waiting_chrome()
{
    render();
}

bool waiting_back()
{
    auto& s = st();
    if (s.mode != Compose::None) { close_compose(true); return true; }
    if (!s.pinned_id.empty()) { s.pinned_id.clear(); render(); return true; }
    return false;
}

void waiting_alert()
{
    auto& s = st();
    // Lee already holds notify while you are deep (focus stays active); this
    // is belt and braces, since the device gets no pushes then (14 §8.1).
    if (const auto* snap = snapshot(); snap && snap->deep_active) {
        ESP_LOGI(TAG, "attention: notify held (in deep work)");
        return;
    }
    s.blink_left = 8;   // four ember flashes, 250 ms apart
    if (!s.blink) s.blink = lv_timer_create(blink_cb, 250, nullptr);
    ESP_LOGI(TAG, "attention: notify");
}

bool waiting_key(uint8_t k)
{
    auto& s = st();

    if (s.mode != Compose::None) {
        if (k == 0x1B) { close_compose(true); return true; }
        if (k == '\r' || k == '\n') { compose_submit(); return true; }
        // Backspace in an empty box is the keyboard's way out (no Esc key).
        if (k == 0x08 || k == 0x7F) {
            const char* t = lv_textarea_get_text(s.c_ta);
            if (!t || !*t) { close_compose(true); return true; }
        }
        return false;   // the text box types
    }

    if (k == 0x1B) { app_back(); return true; }
    const auto* it = current();
    switch (k) {
    case 'j': go(1);  return true;
    case 'k': go(-1); return true;
    case 'c': waiting_open_capture(); return true;
    case 't': app_show(View::Tabs); return true;
    case 'i': case 'v':
        cockpit_nav_key(k);
        return true;
    case 'p':
        if (!pick_up_open()) flash("nothing to pick up");
        return true;
    case 'g': case 'w': case 'e': case 'f':
        // Go / Wait / Why / Diff.  On Work already, so w is Wait, not "go to Work".
        if (!quick_reply((char)k) && it && !takes_text(*it)) flash("no quick reply here");
        return true;
    case ' ': scroll_words(WORDS_H - 24);    return true;
    case 'b': scroll_words(-(WORDS_H - 24)); return true;
    case '\r': case '\n':
        if (it && pickable(*it)) {
            if (s.opt_hl >= 0) choose(s.opt_hl);
            else               flash("roll or tap an option");
        } else if (it && it->kind != AttentionKind::Question && it->can(dirigible::ActReply)) {
            open_compose(Compose::Reply);
        } else if (!it) {
            // Nothing to answer: Enter opens the pick-up, unless the ball
            // has highlighted another row (a recent turn, a hint button).
            lv_obj_t* f = app().group ? lv_group_get_focused(app().group) : nullptr;
            if (f && f != pick_up_obj() && lv_obj_get_parent(f) == s.empty &&
                !lv_obj_has_flag(f, LV_OBJ_FLAG_HIDDEN) && !lv_obj_has_flag(s.empty, LV_OBJ_FLAG_HIDDEN)) {
                lv_event_send(f, LV_EVENT_CLICKED, nullptr);
            } else {
                pick_up_open();
            }
        }
        return true;
    case 'y': case 'n':
        // Never on a question: Approve would pick the TUI's highlighted option.
        if (it && (it->question_as_approval() || it->kind == AttentionKind::Question)) {
            flash("answer the question in the tab");
            return true;
        }
        key_action((char)k);
        return true;
    case 'o': case 'd': case 's': case 'r':
        key_action((char)k);
        return true;
    case '\t':
        return false;
    default:
#if DIRIGIBLE_UI_DEMO
        if (k == 'x' && !it) { demo_fill(); render(); }
        if (k == 'z') {   // demo: a Deep session starts or ends at the machine
            auto& d = demo_snap();
            d.deep_active = !d.deep_active;
            d.deep_title = d.deep_active ? "Tether the T-Deck" : "";
            d.focus_active = d.deep_active;
            render();
        }
#endif
        return true;   // nothing strays into a hidden widget
    }
}

void waiting_ball(int dx, int dy, bool click)
{
    auto& s = st();
    if (s.mode != Compose::None) return;

    // Nothing paged: the ball walks the recent turns and the three buttons
    // under them (highlight, click opens), so the screen works without touch.
    if (lv_obj_has_flag(s.page, LV_OBJ_FLAG_HIDDEN)) {
        ball_list(s.empty, dy, click);
        return;
    }

    const uint32_t now = lv_tick_get();
    const auto* cur = current();
    if (dy || click) {
        if (cur && pickable(*cur) && s.opt_count > 0) {
            s.ball_dx = 0;
            s.ball_dy_tick = now;
            question_ball(dy, click);
            return;
        }
    }
    if (dy) {
        s.ball_dx = 0;
        s.ball_dy_tick = now;
        scroll_words(ball_scroll_px(dy));
    } else if (dx && lv_tick_elaps(s.ball_dy_tick) >= BALL_QUIET_MS) {
        if (lv_tick_elaps(s.ball_dx_tick) > BALL_WINDOW_MS) s.ball_dx = 0;
        s.ball_dx_tick = now;
        s.ball_dx += dx;
        if (std::abs(s.ball_dx) >= BALL_PAGE_DETENTS &&
            lv_tick_elaps(s.ball_page_tick) >= BALL_COOLDOWN_MS) {
            s.ball_page_tick = now;
            const int dir = s.ball_dx > 0 ? 1 : -1;
            s.ball_dx = 0;
            go(dir);
        }
    }
    // A click never approves (that is a letter or a tap); it only opens a
    // reply box, which sends nothing by itself.
    if (click) {
        const auto* it = current();
        if (it && it->can(dirigible::ActReply)) open_compose(Compose::Reply);
    }
}

}  // namespace dirigible_app
