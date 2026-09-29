/*
 * screen_inflight.cpp — In flight: the agents Lee is running (Cockpit design
 * §8.2), from the compact snapshot's agents[] (AgentSummary in copilot.ts).
 *
 * A trackball list, one row per agent, in Work's order: waiting on you first,
 * then busy (longest-running first), then idle (most recent first):
 *
 *   +------------------------------------------------------------+
 *   | * lee copilot                              18m  412k tok   |  38 px row
 *   |   Running tests                                            |
 *   +------------------------------------------------------------+
 *
 * The dot is ember for "waiting on you" (the only needs-you mark), phosphor
 * while it works, text-3 idle.  The sub-line is what it's doing now in words
 * (describe_activity, the table in shared/cockpit.ts), else the first line of
 * what it last said.  The age runs from the host's timestamps plus the time
 * since the snapshot, and the token label is formatTokens(usage.shown_tokens)
 * when Lee sends usage.
 *
 * A press (the ball's click, Enter or a tap) opens the agent as a page: its
 * words (the last message, then earlier turns), and "Along the way", the last
 * few tool calls in the past tense.  j / k step between agents there, the ball
 * scrolls, and back returns to the list.  c checks in (Lee's tab-domain
 * check-in: it asks the agent where it is, and the answer arrives as its
 * words), from the list's highlighted row or the open page.
 *
 * Agents idle for more than two hours fold into one "Earlier (n)" row at the
 * bottom (Desk D2 §9.4, the Mac's rule); pressing it shows them for as long
 * as the view stays open.
 */

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>

#include "app.hpp"
#include "dirigible/activity.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

static const char* TAG = "dirigible.inflight";

namespace dirigible_app {

namespace {

using dirigible::AgentState;
using dirigible::AgentSummary;
using dirigible::AttentionSnapshot;

const lv_font_t* const F_META  = dg::ui_font_small();
const lv_font_t* const F_BODY  = dg::ui_font();
const lv_font_t* const F_TITLE = dg::ui_font_title();

constexpr int PAD      = 6;
constexpr int ROW_H    = 38;
constexpr int ROW_GAP  = 4;
constexpr int MAX_ROWS = (int)dirigible::ATTENTION_MAX_AGENTS;
constexpr int DOT      = 8;
constexpr int BTN_H    = 30;
constexpr int BTN_Y    = BODY_H - BTN_H - 3;        // 171
constexpr int WORDS_Y  = 42;
constexpr int SUMMARY_LINE_MAX = 90;
constexpr uint32_t FLASH_MS = 2500;
/// Row::pty of the "Earlier (n)" row.
constexpr int EARLIER_ROW = -2;

struct Row {
    lv_obj_t* obj  = nullptr;
    lv_obj_t* dot  = nullptr;
    lv_obj_t* name = nullptr;
    lv_obj_t* meta = nullptr;
    lv_obj_t* sub  = nullptr;
    int       pty  = -1;
};

struct State {
    lv_obj_t* list  = nullptr;   // scrolling column of rows
    lv_obj_t* empty = nullptr;
    Row       rows[MAX_ROWS];
    int       order[MAX_ROWS] = {};   // indices into snapshot agents
    int       count = 0;
    int       folded = 0;             // agents under "Earlier (n)"
    bool      show_earlier = false;

    // ---- one agent, opened
    lv_obj_t* page   = nullptr;
    lv_obj_t* p_dot  = nullptr;
    lv_obj_t* p_name = nullptr;
    lv_obj_t* p_meta = nullptr;
    lv_obj_t* p_sub  = nullptr;
    lv_obj_t* scroll = nullptr;
    lv_obj_t* words  = nullptr;
    lv_obj_t* checkin_btn = nullptr;
    int       open_pty = -1;          // -1: the list

    uint32_t snapshot_tick = 0;
    uint32_t flash_until = 0;
    bool     busy = false;
};

State& st()
{
    static State s;
    return s;
}

const AttentionSnapshot* snap()
{
    return cockpit_snapshot();
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

int rank(const AgentSummary& a)
{
    switch (a.state) {
    case AgentState::Waiting: return 0;
    case AgentState::Busy:    return 1;
    case AgentState::Idle:    return 2;
    default:                  return 3;
    }
}

lv_color_t dot_colour(const AgentSummary& a)
{
    switch (a.state) {
    case AgentState::Waiting: return dg::ember();
    case AgentState::Busy:    return dg::phosphor();
    case AgentState::Idle:    return dg::text3();
    default:                  return dg::ground5();
    }
}

int64_t live(int64_t ms)
{
    return ms < 0 ? -1 : ms + (int64_t)lv_tick_elaps(st().snapshot_tick);
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

/// The first non-empty line of `text`, clipped with an ellipsis.
std::string first_line(const std::string& text, size_t max)
{
    size_t b = 0;
    while (b < text.size()) {
        size_t e = text.find('\n', b);
        if (e == std::string::npos) e = text.size();
        std::string line = text.substr(b, e - b);
        size_t i = 0;
        while (i < line.size() && (line[i] == ' ' || line[i] == '#' || line[i] == '-' || line[i] == '*')) i++;
        line = line.substr(i);
        if (!line.empty()) {
            if (line.size() > max) {
                size_t n = max;
                while (n > 0 && (static_cast<unsigned char>(line[n]) & 0xC0) == 0x80) n--;
                line = line.substr(0, n) + "...";
            }
            return line;
        }
        b = e + 1;
    }
    return "";
}

/// What it's doing now (§7.1), else what it last said.
std::string sub_line(const AgentSummary& a)
{
    if (a.state == AgentState::Waiting) return "waiting on you";
    if (a.has_now) return dirigible::describe_activity(a.now.tool, a.now.preview, a.now.files);
    const std::string said = first_line(a.last_summary, SUMMARY_LINE_MAX);
    if (!said.empty()) return said;
    switch (a.state) {
    case AgentState::Busy: return "working";
    case AgentState::Idle: return "idle";
    default:               return a.provider.empty() ? "starting" : a.provider;
    }
}

/// "18m  412k tok": the age of its state, and its usage when Lee sends it.
std::string meta_line(const AgentSummary& a)
{
    const int64_t ms = a.state == AgentState::Idle ? a.idle_ms : a.busy_ms;
    std::string m = fmt_age(live(ms));
    if (a.has_usage) {
        const std::string tok = dirigible::format_tokens(a.usage.shown_tokens);
        if (!tok.empty()) m += (m.empty() ? "" : "  ") + tok;
    }
    return m;
}

const char* state_word(const AgentSummary& a)
{
    switch (a.state) {
    case AgentState::Waiting: return "waiting on you";
    case AgentState::Busy:    return "working";
    case AgentState::Idle:    return "idle";
    default:                  return "starting";
    }
}

const AgentSummary* agent_by_pty(int pty)
{
    const auto* s = snap();
    if (!s || pty < 0) return nullptr;
    for (const auto& a : s->agents) {
        if (a.pty_id == pty) return &a;
    }
    return nullptr;
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

void flash(const char* msg)
{
    st().flash_until = lv_tick_get() + FLASH_MS;
    chrome_set_centre(msg);
}

void centre_status()
{
    if (app().view != View::InFlight) return;
    if ((int32_t)(st().flash_until - lv_tick_get()) > 0) return;
    chrome_set_centre(cockpit_status().c_str());
}

void footer()
{
    if (app().view != View::InFlight) return;
    auto& s = st();
    // The subscription windows, when Lee has seen them: "5h 42%".
    std::string right;
    if (const auto* sn = snap(); sn && sn->has_limits) {
        char b[48];
        if (sn->limits.five_hour_pct >= 0 && sn->limits.seven_day_pct >= 0) {
            snprintf(b, sizeof(b), "5h %d%%  7d %d%%", sn->limits.five_hour_pct, sn->limits.seven_day_pct);
        } else if (sn->limits.five_hour_pct >= 0) {
            snprintf(b, sizeof(b), "5h %d%%", sn->limits.five_hour_pct);
        } else {
            snprintf(b, sizeof(b), "7d %d%%", sn->limits.seven_day_pct);
        }
        right = b;
    } else {
        right = "in flight";
    }
    if (s.open_pty >= 0) chrome_set_footer("j/k agents  c check in", right.c_str());
    else                 chrome_set_footer("ball pick  c check in  w v", right.c_str());
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

void checkin(int pty)
{
    auto& s = st();
    const AgentSummary* a = agent_by_pty(pty);
    if (!a) { flash("no agent here"); return; }
    if (s.busy) return;
    if (!cockpit_linked()) { flash("not connected"); return; }
#if DIRIGIBLE_UI_DEMO
    flash("asked for a check-in");
    ESP_LOGI(TAG, "demo checkin %d", pty);
#else
    auto* c = app().machines ? app().machines->activeConnection() : nullptr;
    if (!c) { flash("not connected"); return; }
    s.busy = true;
    flash("checking in...");
    ESP_LOGI(TAG, "checkin pty %d", pty);
    c->agentCheckin(pty, [](const dirigible::ReplyResult& r) {
        st().busy = false;
        // 202: a shared token may only propose one; Lee asks at the desk.
        if (r.status == 202) { flash("proposed on Lee"); return; }
        if (!r.ok) {
            ESP_LOGW(TAG, "checkin: %d %s", r.status, r.error.c_str());
            flash(r.status == 403 ? "re-pair to check in" : r.error.c_str());
            return;
        }
        flash("asked for a check-in");
    });
#endif
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

void rebuild_order()
{
    auto& s = st();
    s.count = 0;
    s.folded = 0;
    const auto* sn = snap();
    if (!sn) return;
    const int n = std::min((int)sn->agents.size(), MAX_ROWS);
    const int64_t since = (int64_t)lv_tick_elaps(s.snapshot_tick);
    for (int i = 0; i < n; i++) {
        if (!s.show_earlier && dirigible::agent_is_earlier(sn->agents[i], since)) {
            s.folded++;
            continue;
        }
        s.order[s.count++] = i;
    }
    const auto& agents = sn->agents;
    std::stable_sort(s.order, s.order + s.count, [&](int x, int y) {
        const AgentSummary& a = agents[x];
        const AgentSummary& b = agents[y];
        if (rank(a) != rank(b)) return rank(a) < rank(b);
        if (a.state == AgentState::Idle) {
            // Most recently finished first; unknown last.
            const int64_t ia = a.idle_ms < 0 ? INT64_MAX : a.idle_ms;
            const int64_t ib = b.idle_ms < 0 ? INT64_MAX : b.idle_ms;
            return ia < ib;
        }
        return a.busy_ms > b.busy_ms;   // longest-running first
    });
}

lv_obj_t* focused_row_obj()
{
    return app().group ? lv_group_get_focused(app().group) : nullptr;
}

void render_list()
{
    auto& s = st();
    const auto* sn = snap();

    // Keep the highlight on the same agent when the order moves.
    int focused_pty = -1;
    lv_obj_t* f = focused_row_obj();
    for (const Row& r : s.rows) {
        if (r.obj == f) focused_pty = r.pty;
    }

    rebuild_order();
    lv_obj_t* refocus = nullptr;
    for (int i = 0; i < MAX_ROWS; i++) {
        Row& row = s.rows[i];
        if (i == s.count && s.folded > 0) {
            // "Earlier (3)": a quiet row; a press unfolds it.
            row.pty = EARLIER_ROW;
            lv_obj_clear_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
            lv_obj_set_style_bg_color(row.dot, dg::ground5(), 0);
            char name[32];
            snprintf(name, sizeof(name), "Earlier (%d)", s.folded);
            lv_label_set_text(row.name, name);
            lv_label_set_text(row.meta, "");
            lv_label_set_text(row.sub, "idle over two hours");
            lv_obj_set_style_text_color(row.sub, dg::text3(), 0);
            lv_obj_set_width(row.name, SCREEN_W - 2 * PAD - 26);
            if (focused_pty == EARLIER_ROW) refocus = row.obj;
            continue;
        }
        if (i >= s.count) {
            row.pty = -1;
            lv_obj_add_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        const AgentSummary& a = sn->agents[s.order[i]];
        row.pty = a.pty_id;
        lv_obj_clear_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
        lv_obj_set_style_bg_color(row.dot, dot_colour(a), 0);
        ui_set_text(row.name, a.label.empty() ? std::string("Agent") : a.label);
        lv_label_set_text(row.meta, meta_line(a).c_str());
        ui_set_text(row.sub, sub_line(a));
        lv_obj_set_style_text_color(row.sub, a.state == AgentState::Waiting ? dg::ember() : dg::text2(), 0);
        // The name gives way to the meta on the right.
        lv_obj_update_layout(row.meta);
        lv_obj_set_width(row.name, SCREEN_W - 2 * PAD - 26 - lv_obj_get_width(row.meta) - 8);
        if (a.pty_id == focused_pty) refocus = row.obj;
    }
    if (refocus && refocus != f && app().view == View::InFlight) lv_group_focus_obj(refocus);

    const bool none = s.count == 0 && s.folded == 0;
    if (none) {
        lv_obj_t* l = lv_obj_get_child(s.empty, 0);
        if (!cockpit_linked())    lv_label_set_text(l, "Not connected");
        else if (!sn)             lv_label_set_text(l, "Loading...");
        else                      lv_label_set_text(l, "No agents running");
        lv_obj_clear_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
    }
}

void render_page()
{
    auto& s = st();
    const AgentSummary* a = agent_by_pty(s.open_pty);
    if (!a) {
        // It closed while open: back to the list.
        s.open_pty = -1;
        lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
        flash("that agent has gone");
        return;
    }
    lv_obj_set_style_bg_color(s.p_dot, dot_colour(*a), 0);
    ui_set_text(s.p_name, a->label.empty() ? std::string("Agent") : a->label);
    std::string meta = state_word(*a);
    const std::string m = meta_line(*a);
    if (!m.empty()) meta += "  " + m;
    lv_label_set_text(s.p_meta, meta.c_str());
    lv_obj_update_layout(s.p_meta);
    lv_obj_set_width(s.p_name, SCREEN_W - 2 * PAD - 16 - lv_obj_get_width(s.p_meta) - 8);
    ui_set_text(s.p_sub, sub_line(*a));

    // Its words, then earlier turns, then Along the way (newest first).
    std::string w = a->last_summary.empty() ? std::string("(nothing said yet)") : a->last_summary;
    for (int i = (int)a->updates.size() - 1; i >= 0; i--) {
        const auto& u = a->updates[i];
        if (u.summary == a->last_summary) continue;
        const std::string age = fmt_age(live(u.age_ms));
        w += "\n\n" + (age.empty() ? std::string("Earlier") : "Earlier, " + age + " ago") + ":\n" + u.summary;
    }
    if (!a->recent.empty()) {
        w += "\n\nAlong the way:";
        for (int i = (int)a->recent.size() - 1; i >= 0; i--) {
            const auto& e = a->recent[i];
            const std::string age = fmt_age(live(e.age_ms));
            w += "\n  " + (age.empty() ? std::string() : age + "  ") +
                 dirigible::describe_activity(e.tool, e.preview, e.files, e.failed, e.past);
        }
    }
    const char* old = lv_label_get_text(s.words);
    const std::string folded = ui_fold(w, true);
    if (!old || folded != old) lv_label_set_text(s.words, folded.c_str());
}

void render()
{
    auto& s = st();
    render_list();
    if (s.open_pty >= 0) render_page();
    if (s.open_pty < 0) {
        lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(s.list, LV_OBJ_FLAG_HIDDEN);
    }
    centre_status();
    footer();
}

void open_agent(int pty)
{
    auto& s = st();
    if (!agent_by_pty(pty)) return;
    const bool same = pty == s.open_pty;
    s.open_pty = pty;
    lv_obj_add_flag(s.list, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    render_page();
    if (!same) lv_obj_scroll_to_y(s.scroll, 0, LV_ANIM_OFF);
    footer();
}

/// j / k on an open page: the next or previous agent in the list's order.
void step(int delta)
{
    auto& s = st();
    const auto* sn = snap();
    if (!sn || s.count == 0) return;
    int at = -1;
    for (int i = 0; i < s.count; i++) {
        if (sn->agents[s.order[i]].pty_id == s.open_pty) at = i;
    }
    const int next = std::max(0, std::min(s.count - 1, at + delta));
    if (next == at) { flash(delta > 0 ? "last agent" : "first agent"); return; }
    open_agent(sn->agents[s.order[next]].pty_id);
}

void close_agent()
{
    auto& s = st();
    const int pty = s.open_pty;
    s.open_pty = -1;
    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.list, LV_OBJ_FLAG_HIDDEN);
    for (const Row& r : s.rows) {
        if (r.pty == pty && app().group) {
            lv_group_focus_obj(r.obj);
            lv_obj_scroll_to_view(r.obj, LV_ANIM_OFF);
        }
    }
    footer();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

void show_earlier()
{
    st().show_earlier = true;
    render_list();
}

void row_cb(lv_event_t* e)
{
    const Row* r = (const Row*)lv_event_get_user_data(e);
    if (r && r->pty == EARLIER_ROW) show_earlier();
    else if (r && r->pty >= 0) open_agent(r->pty);
}

void tick_cb(lv_timer_t*)
{
    auto& s = st();
    if (app().view != View::InFlight) return;
    if (s.flash_until && (int32_t)(s.flash_until - lv_tick_get()) <= 0) {
        s.flash_until = 0;
        centre_status();
    }
    static int ticks = 0;
    if (++ticks >= 30) {   // ages stay honest
        ticks = 0;
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

lv_obj_t* dot(lv_obj_t* parent)
{
    lv_obj_t* d = lv_obj_create(parent);
    lv_obj_remove_style_all(d);
    lv_obj_set_size(d, DOT, DOT);
    lv_obj_set_style_radius(d, DOT / 2, 0);
    lv_obj_set_style_bg_opa(d, LV_OPA_COVER, 0);
    lv_obj_clear_flag(d, LV_OBJ_FLAG_CLICKABLE);
    return d;
}

void build_list(lv_obj_t* parent)
{
    auto& s = st();
    s.list = lv_obj_create(parent);
    lv_obj_remove_style_all(s.list);
    lv_obj_set_pos(s.list, 0, 0);
    lv_obj_set_size(s.list, SCREEN_W, BODY_H);
    lv_obj_set_style_pad_all(s.list, PAD, 0);
    lv_obj_set_style_pad_row(s.list, ROW_GAP, 0);
    lv_obj_set_flex_flow(s.list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(s.list, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.list, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s.list, dg::ground5(), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s.list, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s.list, 3, LV_PART_SCROLLBAR);

    for (Row& row : s.rows) {
        row.obj = lv_btn_create(s.list);
        lv_obj_remove_style_all(row.obj);
        lv_obj_set_size(row.obj, SCREEN_W - 2 * PAD, ROW_H);
        lv_obj_set_style_bg_opa(row.obj, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(row.obj, dg::ground1(), 0);
        lv_obj_set_style_bg_color(row.obj, dg::ground3(), LV_STATE_PRESSED);
        lv_obj_set_style_radius(row.obj, DG_RADIUS, 0);
        lv_obj_set_style_border_color(row.obj, dg::ground4(), 0);
        lv_obj_clear_flag(row.obj, LV_OBJ_FLAG_SCROLLABLE);
        dg::style_focus(row.obj);   // the ball's highlight
        lv_obj_add_event_cb(row.obj, row_cb, LV_EVENT_CLICKED, &row);

        row.dot = dot(row.obj);
        lv_obj_set_pos(row.dot, 7, 6);

        row.name = label(row.obj, F_BODY, dg::text1());
        lv_label_set_long_mode(row.name, LV_LABEL_LONG_DOT);
        lv_obj_set_pos(row.name, 22, 1);

        row.meta = label(row.obj, F_META, dg::text3());
        lv_obj_align(row.meta, LV_ALIGN_TOP_RIGHT, -6, 2);

        row.sub = label(row.obj, F_META, dg::text2());
        lv_label_set_long_mode(row.sub, LV_LABEL_LONG_DOT);
        lv_obj_set_width(row.sub, SCREEN_W - 2 * PAD - 22 - 6);
        lv_obj_set_pos(row.sub, 22, 19);
        lv_obj_add_flag(row.obj, LV_OBJ_FLAG_HIDDEN);
    }

    s.empty = panel(parent);
    lv_obj_t* l = label(s.empty, F_TITLE, dg::text2(), "No agents running");
    lv_obj_align(l, LV_ALIGN_CENTER, 0, -10);
    lv_obj_t* hint = label(s.empty, F_META, dg::text3(), "Agents Lee launches show up here.\nw Work   v Review   t Tabs");
    lv_obj_set_style_text_align(hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(hint, LV_ALIGN_CENTER, 0, 22);
    lv_obj_add_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
}

void build_page(lv_obj_t* parent)
{
    auto& s = st();
    s.page = panel(parent);

    s.p_dot = dot(s.page);
    lv_obj_set_pos(s.p_dot, PAD, 9);

    s.p_name = label(s.page, F_TITLE, dg::text1());
    lv_label_set_long_mode(s.p_name, LV_LABEL_LONG_DOT);
    lv_obj_set_pos(s.p_name, PAD + 14, 3);

    s.p_meta = label(s.page, F_META, dg::text3());
    lv_obj_align(s.p_meta, LV_ALIGN_TOP_RIGHT, -PAD, 5);

    s.p_sub = label(s.page, F_META, dg::text2());
    lv_label_set_long_mode(s.p_sub, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.p_sub, SCREEN_W - 2 * PAD - 14);
    lv_obj_set_pos(s.p_sub, PAD + 14, 23);

    s.scroll = lv_obj_create(s.page);
    lv_obj_remove_style_all(s.scroll);
    lv_obj_set_pos(s.scroll, 0, WORDS_Y);
    lv_obj_set_size(s.scroll, SCREEN_W, BTN_Y - 4 - WORDS_Y);
    lv_obj_set_style_pad_hor(s.scroll, PAD, 0);
    lv_obj_set_style_pad_ver(s.scroll, 2, 0);
    lv_obj_set_scroll_dir(s.scroll, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.scroll, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s.scroll, dg::ground5(), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s.scroll, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s.scroll, 3, LV_PART_SCROLLBAR);

    s.words = label(s.scroll, F_BODY, dg::text1());
    lv_label_set_long_mode(s.words, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.words, SCREEN_W - 2 * PAD - 4);
    lv_obj_set_style_text_line_space(s.words, 2, 0);

    // One bordered button: Check in (C).  Touch-only; the key is c.
    s.checkin_btn = lv_btn_create(s.page);
    lv_obj_remove_style_all(s.checkin_btn);
    lv_obj_set_pos(s.checkin_btn, 2, BTN_Y);
    lv_obj_set_size(s.checkin_btn, SCREEN_W - 4, BTN_H);
    lv_obj_set_style_bg_opa(s.checkin_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.checkin_btn, dg::ground3(), 0);
    lv_obj_set_style_bg_color(s.checkin_btn, dg::ground4(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(s.checkin_btn, 1, 0);
    lv_obj_set_style_border_color(s.checkin_btn, dg::ground4(), 0);
    lv_obj_set_style_radius(s.checkin_btn, DG_RADIUS, 0);
    lv_obj_add_event_cb(s.checkin_btn, [](lv_event_t*) { checkin(st().open_pty); },
                        LV_EVENT_CLICKED, nullptr);
    if (lv_obj_get_group(s.checkin_btn)) lv_group_remove_obj(s.checkin_btn);
    lv_obj_t* l = label(s.checkin_btn, F_BODY, dg::text1());
    lv_label_set_recolor(l, true);
    char text[40];
    snprintf(text, sizeof(text), "Check in #%06x (C)#", (unsigned)DG_TEXT_3);
    lv_label_set_text(l, text);
    lv_obj_center(l);

    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void inflight_build(lv_obj_t* parent)
{
    auto& a = app();
    a.view_inflight = panel(parent);
    build_list(a.view_inflight);
    build_page(a.view_inflight);
    lv_obj_add_flag(a.view_inflight, LV_OBJ_FLAG_HIDDEN);
    st().snapshot_tick = lv_tick_get();
    lv_timer_create(tick_cb, 1000, nullptr);
}

void inflight_open()
{
    auto& s = st();
    s.open_pty = -1;
    s.show_earlier = false;
    app_show(View::InFlight);
    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.list, LV_OBJ_FLAG_HIDDEN);
    render();
    // Start the highlight on the first row, so a click opens something.
    if (s.count && app().group) lv_group_focus_obj(s.rows[0].obj);
    auto* c = app().machines ? app().machines->activeConnection() : nullptr;
    if (c && c->isConnected()) c->fetchAttention();
}

void inflight_render()
{
    st().snapshot_tick = lv_tick_get();
    if (app().view == View::InFlight) render();
}

bool inflight_back()
{
    if (st().open_pty < 0) return false;
    close_agent();
    return true;
}

bool inflight_key(uint8_t k)
{
    auto& s = st();
    if (k == 0x1B) { app_back(); return true; }
    if (cockpit_nav_key(k)) return true;
    switch (k) {
    case 't': app_show(View::Tabs); return true;
    case 'c':
        if (s.open_pty >= 0) {
            checkin(s.open_pty);
        } else {
            int pty = -1;
            lv_obj_t* f = focused_row_obj();
            for (const Row& r : s.rows) {
                if (r.obj == f) pty = r.pty;
            }
            if (pty >= 0) checkin(pty);
            else          flash("roll to an agent first");
        }
        return true;
    case 'j': case 'k':
        if (s.open_pty >= 0) step(k == 'j' ? 1 : -1);
        else                 ball_list(s.list, k == 'j' ? BALL_ROW_DETENTS : -BALL_ROW_DETENTS, false);
        return true;
    case ' ': case 'b':
        if (s.open_pty >= 0) {
            const int h = lv_obj_get_height(s.scroll) - 24;
            lv_obj_scroll_by_bounded(s.scroll, 0, k == ' ' ? -h : h, LV_ANIM_OFF);
        }
        return true;
    case '\r': case '\n':
        if (s.open_pty < 0) {
            lv_obj_t* f = focused_row_obj();
            for (const Row& r : s.rows) {
                if (r.obj == f && r.pty == EARLIER_ROW) { show_earlier(); break; }
                if (r.obj == f && r.pty >= 0) { open_agent(r.pty); break; }
            }
        }
        return true;
    case '\t':
        return false;
    default:
        return true;   // nothing strays into a hidden widget
    }
}

void inflight_ball(int dx, int dy, bool click)
{
    (void)dx;
    auto& s = st();
    if (s.open_pty >= 0) {
        if (dy) lv_obj_scroll_by_bounded(s.scroll, 0, -ball_scroll_px(dy), LV_ANIM_OFF);
        return;   // a click on the page does nothing: checking in is c
    }
    ball_list(s.list, dy, click);
}

}  // namespace dirigible_app
