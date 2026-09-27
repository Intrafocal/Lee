/*
 * screen_carry.cpp — Library, which on the T-Deck is Carry (Cockpit design
 * §8.2; docs/14-Deep-Work.md §8.1; Desk D2 §9.4): the devices carry your
 * last Desk card out of a Deep session and bring thoughts back into the next
 * one.  No Desk here.
 *
 * Data: Lee's GET /carry for the followed window's workspace (fetched when
 * the view opens, after a write, and on r):
 *
 *   pick_up         your last Desk card, its Area and your stopped-at note
 *   open_questions  up to five, each naming its card
 *   open_next       what the next session opens first
 *
 * One card per page, the pick-up first, then each other card an open
 * question names; j / k (or a sideways flick) page when there is more than
 * one.  Against a Lee from before the Desk the "cards" are explorations:
 *
 *   +------------------------------------------------------------+
 *   | Carry on the T-Deck                                   1/2  |  title
 *   | YOU STOPPED AT                                             |
 *   | The pager should hold one thought, not three.  (italic)    |  your words,
 *   | OPEN QUESTION                                              |  italic; the
 *   | Does Open next replace f?                      (italic)    |  ball scrolls
 *   | 2 captured away                                            |
 *   | +------------------------+ +------------------------+      |
 *   | | Add a thought (C)      | | Open next (O)          |      |
 *   +------------------------------------------------------------+
 *
 * Your words are in Montserrat italic (dg::ui_font_italic): the T-Deck's
 * stand-in for the Newsreader Lee and Aeronaut use (design rule 3).
 *
 *   Add a thought (C)  a text box; Enter sends POST /carry/capture with the
 *                      page's card, so it lands under Pick up with it.  With
 *                      nothing to carry it is a plain Someday capture (POST
 *                      /capture).  Lee spools either while Hester is down.
 *   Open next (O)      POST /carry/open-next: the next Deep session opens
 *                      this card first.  Replaces the old f (Focus) key:
 *                      Deep can't start from here.
 */

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "app.hpp"
#include "dirigible/activity.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

static const char* TAG = "dirigible.carry";

namespace dirigible_app {

namespace {

using dirigible::CarryState;

const lv_font_t* const F_META   = dg::ui_font_small();
const lv_font_t* const F_BODY   = dg::ui_font();
const lv_font_t* const F_TITLE  = dg::ui_font_title();
const lv_font_t* const F_WRITER = dg::ui_font_italic();

constexpr int PAD      = 6;
constexpr int TITLE_Y  = 3;
constexpr int BODY_Y   = 24;
constexpr int BTN_H    = 34;
constexpr int BTN_Y    = BODY_H - BTN_H - 3;       // 167
constexpr int THOUGHT_MAX = 1000;   // a paragraph suits the keyboard (14 §8.1)
constexpr int COMPOSE_BTN_H = 30;
constexpr int COMPOSE_BTN_Y = BODY_H - COMPOSE_BTN_H - 3;
constexpr uint32_t FLASH_MS = 2500;

// Trackball paging, as on Work: a deliberate sideways flick.
constexpr int      BALL_PAGE_DETENTS = 4;
constexpr uint32_t BALL_QUIET_MS     = 250;
constexpr uint32_t BALL_WINDOW_MS    = 400;
constexpr uint32_t BALL_COOLDOWN_MS  = 500;

enum class Load : uint8_t { Idle, Loading, Ok, Offline, Missing, Failed };

struct State {
    // ---- page
    lv_obj_t* page     = nullptr;
    lv_obj_t* title    = nullptr;
    lv_obj_t* pos      = nullptr;
    lv_obj_t* scroll   = nullptr;
    lv_obj_t* stop_eb  = nullptr;   // "YOU STOPPED AT"
    lv_obj_t* stopped  = nullptr;
    lv_obj_t* q_eb     = nullptr;   // "OPEN QUESTION"
    lv_obj_t* question = nullptr;
    lv_obj_t* counts   = nullptr;
    lv_obj_t* add_btn  = nullptr;
    lv_obj_t* add_lbl  = nullptr;
    lv_obj_t* next_btn = nullptr;
    lv_obj_t* next_lbl = nullptr;

    // ---- nothing to carry / offline
    lv_obj_t* empty   = nullptr;
    lv_obj_t* e_title = nullptr;
    lv_obj_t* e_sub   = nullptr;

    // ---- the thought box
    lv_obj_t* compose  = nullptr;
    lv_obj_t* c_head   = nullptr;
    lv_obj_t* c_ta     = nullptr;
    lv_obj_t* c_status = nullptr;
    bool      composing = false;
    std::string compose_for;     // card the box writes into ("" = Someday)
    std::string draft;           // kept across Cancel
    std::string draft_for;
    lv_timer_t* compose_close = nullptr;

    // ---- data
    CarryState carry;
    Load       load = Load::Idle;
    std::vector<std::string> ids;   // cards, in page order
    int        at = 0;
    std::string cur_id;            // keeps the page across refetches
    bool       busy = false;
    int        gen = 0;            // bumped per fetch; stale answers are dropped

    uint32_t flash_until = 0;

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

dirigible::LeeConnection* conn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
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
    if (app().view != View::Library) return;
    if ((int32_t)(st().flash_until - lv_tick_get()) > 0) return;
    chrome_set_centre(cockpit_status().c_str());
}

void footer()
{
    auto& s = st();
    if (app().view != View::Library) return;
    if (s.composing) { chrome_set_footer("Enter sends  hold: cancel", "thought"); return; }
    if (s.ids.size() > 1) chrome_set_footer("j/k cards  r reload  w i", "carry");
    else                  chrome_set_footer("r reload  w Work  i In flight", "carry");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const std::string& cur()
{
    static const std::string none;
    auto& s = st();
    return s.at >= 0 && s.at < (int)s.ids.size() ? s.ids[s.at] : none;
}

void show_empty(const char* title, const char* sub)
{
    auto& s = st();
    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    lv_obj_clear_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(s.e_title, title);
    lv_label_set_text(s.e_sub, sub);
}

void set_next_button()
{
    auto& s = st();
    const bool already = s.carry.has_open_next && s.carry.open_next_exploration_id == cur();
    char text[48];
    if (already) snprintf(text, sizeof(text), LV_SYMBOL_OK " Opens next");
    else         snprintf(text, sizeof(text), "Open next #%06x (O)#", (unsigned)DG_TEXT_3);
    lv_label_set_text(s.next_lbl, text);
    lv_obj_set_style_text_color(s.next_lbl, already ? dg::text2() : dg::text1(), 0);
}

void render()
{
    auto& s = st();
    s.ids = s.carry.explorations();
    // Stay on the same card across a refetch.
    s.at = 0;
    for (int i = 0; i < (int)s.ids.size(); i++) {
        if (s.ids[i] == s.cur_id) s.at = i;
    }

    if (!cockpit_linked()) {
        show_empty("Not connected", "Carry needs Lee.\nw Work   i In flight   t Tabs");
    } else if (s.load == Load::Loading && s.ids.empty()) {
        show_empty("Loading...", "");
    } else if (s.load == Load::Offline) {
        show_empty("Hester is offline", "Carry comes back when it is.\nc still captures a thought: Lee keeps it.");
    } else if (s.load == Load::Missing) {
        show_empty("No Carry on this Lee", "Update Lee for Carry.\nc captures a thought to Someday.");
    } else if (s.load == Load::Failed && s.ids.empty()) {
        show_empty("Couldn't load Carry", "r tries again.");
    } else if (s.ids.empty()) {
        char sub[128];
        if (s.carry.captured_count > 0) {
            snprintf(sub, sizeof(sub), "%s captured away for next time.\nc adds another.",
                     dirigible::number_word(s.carry.captured_count, true).c_str());
        } else {
            snprintf(sub, sizeof(sub), "No Desk card to pick up yet.\nc captures a thought for next time.");
        }
        show_empty("Nothing to carry", sub);
    } else {
        lv_obj_add_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(s.page, LV_OBJ_FLAG_HIDDEN);
        const std::string& id = cur();
        s.cur_id = id;
        const bool pick = s.carry.has_pick_up && id == s.carry.pick_up_id;

        if (pick && !s.carry.pick_up_title.empty()) ui_set_text(s.title, s.carry.pick_up_title);
        else lv_label_set_text(s.title, pick ? "Pick up where you left off" : "Also open");
        char pos[32] = "";
        if (s.ids.size() > 1) snprintf(pos, sizeof(pos), "%d/%d", s.at + 1, (int)s.ids.size());
        lv_label_set_text(s.pos, pos);
        lv_obj_update_layout(s.pos);
        lv_obj_set_width(s.title, SCREEN_W - 2 * PAD - lv_obj_get_width(s.pos) - 8);

        // The Area, when Lee knows it, rides on the eyebrow: "MESH  YOU STOPPED AT".
        std::string eb = "YOU STOPPED AT";
        if (pick && !s.carry.area_name.empty()) {
            std::string area = s.carry.area_name;
            if (area.size() > 24) area = area.substr(0, 24);
            for (auto& ch : area) ch = (char)toupper((unsigned char)ch);
            eb = area + "  " LV_SYMBOL_BULLET "  " + eb;
        }
        ui_set_text(s.stop_eb, eb);
        const bool has_stop = pick && !s.carry.stopped_at.empty();
        if (has_stop) {
            ui_set_text(s.stopped, s.carry.stopped_at);
            lv_obj_clear_flag(s.stop_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_clear_flag(s.stopped, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s.stop_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s.stopped, LV_OBJ_FLAG_HIDDEN);
        }
        if (const auto* q = s.carry.question_for(id)) {
            ui_set_text(s.question, q->text);
            lv_obj_clear_flag(s.q_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_clear_flag(s.question, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s.q_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s.question, LV_OBJ_FLAG_HIDDEN);
        }
        if (!has_stop && !s.carry.question_for(id)) {
            // A pick-up with neither: say so rather than show a blank page.
            lv_label_set_text(s.stopped, "No stopped-at note from the last session.");
            lv_obj_clear_flag(s.stopped, LV_OBJ_FLAG_HIDDEN);
        }

        std::string counts;
        if (s.carry.captured_count > 0) {
            counts = std::to_string(s.carry.captured_count) + " captured away";
        }
        if (s.carry.reading_count > 0) {
            if (!counts.empty()) counts += "  " LV_SYMBOL_BULLET "  ";
            counts += std::to_string(s.carry.reading_count) + (s.carry.reading_count == 1 ? " thing" : " things") + " to read";
        }
        if (s.carry.spooled > 0) {
            if (!counts.empty()) counts += "  " LV_SYMBOL_BULLET "  ";
            counts += std::to_string(s.carry.spooled) + " waiting for Hester";
        }
        lv_label_set_text(s.counts, counts.c_str());
        set_next_button();
    }
    centre_status();
    footer();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

#if DIRIGIBLE_UI_DEMO
void demo_fill(CarryState& c)
{
    c = CarryState();
    c.workspace = "/ws/lee";
    c.has_pick_up = true;
    c.pick_up_id = "pg-0000ca77";
    c.pick_up_title = "Carry on the T-Deck";
    c.area_name = "Devices";
    c.stopped_line = 12;
    c.stopped_at = "The pager should hold one thought, not three. Next: what the "
                   "Library page says when there's nothing to carry.";
    c.questions.push_back({ "pg-0000ca77", "q1", "Does Open next replace the f key, or should f just go?" });
    c.questions.push_back({ "pg-00000b0e", "q2", "Would a voice capture on the walk be better than typing?" });
    c.captured_count = 2;
    c.reading_count = 1;
}
#endif

void fetch()
{
    auto& s = st();
    const int gen = ++s.gen;
    s.load = Load::Loading;
#if DIRIGIBLE_UI_DEMO
    demo_fill(s.carry);
    s.load = Load::Ok;
    (void)gen;
    render();
#else
    auto* c = conn();
    if (!c || !c->isConnected()) { s.load = Load::Idle; render(); return; }
    render();
    c->fetchCarry([gen](int status, const CarryState* carry) {
        auto& s = st();
        if (gen != s.gen) return;   // a newer fetch is on its way
        if (carry) {
            s.carry = *carry;
            s.load = Load::Ok;
        } else if (status == 503) {
            s.load = Load::Offline;
        } else if (status == 404) {
            s.load = Load::Missing;
        } else {
            ESP_LOGW(TAG, "carry: HTTP %d", status);
            s.load = Load::Failed;
        }
        if (app().view == View::Library) render();
    });
#endif
}

void open_next()
{
    auto& s = st();
    const std::string id = cur();
    if (id.empty()) { flash("nothing to open next"); return; }
    if (s.busy) return;
    if (s.carry.has_open_next && s.carry.open_next_exploration_id == id) {
        flash("already opens next");
        return;
    }
    auto done = [id](const dirigible::ReplyResult& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "open-next: %d %s", r.status, r.error.c_str());
            flash(r.status == 503 ? "Hester is offline" :
                  r.status == 403 ? "re-pair to set this" : r.error.c_str());
            return;
        }
        s.carry.has_open_next = true;
        s.carry.open_next_exploration_id = id;
        s.carry.open_next_someday_id.clear();
        flash("opens first on the Mac");
        if (app().view == View::Library) render();
    };
    s.busy = true;
    flash("setting open next...");
#if DIRIGIBLE_UI_DEMO
    dirigible::ReplyResult r;
    r.status = 200;
    r.ok = true;
    done(r);
#else
    auto* c = conn();
    if (!c || !c->isConnected()) { s.busy = false; flash("not connected"); return; }
    c->carryOpenNext(id, done);
#endif
}

// ---------------------------------------------------------------------------
// The thought box
// ---------------------------------------------------------------------------

void set_status(const char* text, lv_color_t colour)
{
    lv_label_set_text(st().c_status, text);
    lv_obj_set_style_text_color(st().c_status, colour, 0);
}

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

void close_compose(bool keep)
{
    auto& s = st();
    if (!s.composing) return;
    if (keep) {
        const char* t = lv_textarea_get_text(s.c_ta);
        s.draft = t ? t : "";
        s.draft_for = s.compose_for;
    }
    if (s.compose_close) { lv_timer_del(s.compose_close); s.compose_close = nullptr; }
    ta_active(false);
    lv_textarea_set_text(s.c_ta, "");
    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    s.composing = false;
    footer();
}

void open_compose()
{
    auto& s = st();
    if (s.composing) return;
    // Into the page's card; with nothing to carry, into Someday.
    const bool page = !lv_obj_has_flag(s.page, LV_OBJ_FLAG_HIDDEN);
    s.compose_for = page ? cur() : std::string();
    std::string head;
    if (s.compose_for.empty()) {
        head = "A thought for next time (Someday)";
    } else {
        const bool pick = s.carry.has_pick_up && s.compose_for == s.carry.pick_up_id;
        head = "A thought into " + (pick && !s.carry.pick_up_title.empty() ? s.carry.pick_up_title
                                                                          : std::string("this card"));
    }
    ui_set_text(s.c_head, head);
    lv_textarea_set_text(s.c_ta, s.draft_for == s.compose_for ? s.draft.c_str() : "");
    set_status("", dg::text3());
    s.composing = true;
    lv_obj_clear_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s.compose);
    ta_active(true);
    footer();
}

void compose_close_cb(lv_timer_t* t)
{
    lv_timer_del(t);
    st().compose_close = nullptr;
    close_compose(false);
}

void submit()
{
    auto& s = st();
    const char* raw = lv_textarea_get_text(s.c_ta);
    if (!raw || !*raw) { set_status("Type something first", dg::text3()); return; }
    if (s.busy) return;
    if (!cockpit_linked()) { set_status("Not connected", dg::error()); return; }

    const std::string into = s.compose_for;
    auto done = [into](const dirigible::CaptureOutcome& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "thought: %d %s", r.status, r.error.c_str());
            // Keep the text for another try.
            set_status(r.status == 503 ? "Hester is offline - Enter to retry" :
                       r.status == 404 ? "This Lee can't take it yet" :
                                         "Didn't send - Enter to retry", dg::error());
            return;
        }
        s.draft.clear();
        s.draft_for.clear();
        if (!s.composing) return;
        lv_textarea_set_text(s.c_ta, "");
        set_status(r.spooled ? "Saved - reaches Lee's Library when Hester is back"
                             : into.empty() ? "Captured for next time" : "Added to the card",
                   r.spooled ? dg::ember() : dg::phosphor());
        s.carry.captured_count++;
        if (!s.compose_close) s.compose_close = lv_timer_create(compose_close_cb, 1400, nullptr);
        fetch();
    };

    s.busy = true;
    set_status("Sending...", dg::text2());
#if DIRIGIBLE_UI_DEMO
    dirigible::CaptureOutcome r;
    r.status = 200;
    r.ok = true;
    done(r);
#else
    auto* c = conn();
    if (into.empty()) c->capture(raw, done);   // Someday, spooled while Hester is down
    else              c->carryCapture(raw, into, done);
#endif
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

void go(int delta)
{
    auto& s = st();
    if (s.composing || s.ids.size() < 2) return;
    const int p = std::max(0, std::min((int)s.ids.size() - 1, s.at + delta));
    if (p == s.at) { flash(delta > 0 ? "last card" : "first card"); return; }
    s.at = p;
    s.cur_id = s.ids[p];
    render();
    lv_obj_scroll_to_y(s.scroll, 0, LV_ANIM_OFF);
}

void tick_cb(lv_timer_t*)
{
    auto& s = st();
    if (app().view != View::Library) return;
    if (s.flash_until && (int32_t)(s.flash_until - lv_tick_get()) <= 0) {
        s.flash_until = 0;
        centre_status();
    }
}

void gesture_cb(lv_event_t*)
{
    lv_indev_t* indev = lv_indev_get_act();
    if (!indev) return;
    const lv_dir_t dir = lv_indev_get_gesture_dir(indev);
    if (dir != LV_DIR_LEFT && dir != LV_DIR_RIGHT) return;
    lv_indev_wait_release(indev);
    go(dir == LV_DIR_LEFT ? 1 : -1);
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

lv_obj_t* button(lv_obj_t* parent, bool primary, lv_obj_t** lbl)
{
    lv_obj_t* b = lv_btn_create(parent);
    lv_obj_remove_style_all(b);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(b, DG_RADIUS, 0);
    lv_obj_set_style_bg_color(b, primary ? dg::phosphor() : dg::ground3(), 0);
    lv_obj_set_style_bg_color(b, primary ? dg::phosphor_hi() : dg::ground4(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(b, primary ? 0 : 1, 0);
    lv_obj_set_style_border_color(b, dg::ground4(), 0);
    lv_obj_clear_flag(b, LV_OBJ_FLAG_SCROLLABLE);
    // Touch-only: the keys are c and o.
    if (lv_obj_get_group(b)) lv_group_remove_obj(b);
    *lbl = label(b, F_BODY, primary ? dg::on_phosphor() : dg::text1());
    lv_label_set_recolor(*lbl, true);
    lv_obj_center(*lbl);
    return b;
}

lv_obj_t* eyebrow(lv_obj_t* parent, const char* text)
{
    lv_obj_t* l = label(parent, F_META, dg::text3(), text);
    lv_obj_set_style_text_letter_space(l, 1, 0);
    return l;
}

lv_obj_t* writing(lv_obj_t* parent)
{
    lv_obj_t* l = label(parent, F_WRITER, dg::text1());
    lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(l, SCREEN_W - 2 * PAD - 4);
    lv_obj_set_style_text_line_space(l, 3, 0);
    return l;
}

void build_page(lv_obj_t* parent)
{
    auto& s = st();
    s.page = panel(parent);
    lv_obj_add_event_cb(s.page, gesture_cb, LV_EVENT_GESTURE, nullptr);

    s.title = label(s.page, F_TITLE, dg::text1());
    lv_label_set_long_mode(s.title, LV_LABEL_LONG_DOT);
    lv_obj_set_pos(s.title, PAD, TITLE_Y);

    s.pos = label(s.page, F_META, dg::text3());
    lv_obj_align(s.pos, LV_ALIGN_TOP_RIGHT, -PAD, TITLE_Y + 3);

    s.scroll = lv_obj_create(s.page);
    lv_obj_remove_style_all(s.scroll);
    lv_obj_set_pos(s.scroll, 0, BODY_Y);
    lv_obj_set_size(s.scroll, SCREEN_W, BTN_Y - 4 - BODY_Y);
    lv_obj_set_style_pad_hor(s.scroll, PAD, 0);
    lv_obj_set_style_pad_ver(s.scroll, 2, 0);
    lv_obj_set_style_pad_row(s.scroll, 3, 0);
    lv_obj_set_flex_flow(s.scroll, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(s.scroll, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.scroll, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s.scroll, dg::ground5(), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s.scroll, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s.scroll, 3, LV_PART_SCROLLBAR);

    s.stop_eb  = eyebrow(s.scroll, "YOU STOPPED AT");
    s.stopped  = writing(s.scroll);
    s.q_eb     = eyebrow(s.scroll, "OPEN QUESTION");
    lv_obj_set_style_pad_top(s.q_eb, 6, 0);
    s.question = writing(s.scroll);
    s.counts   = label(s.scroll, F_META, dg::text3());
    lv_obj_set_style_pad_top(s.counts, 6, 0);

    // Add a thought is the page's one next step (phosphor); Open next is plain.
    const int gap = 4;
    const int w = (SCREEN_W - 4 - gap) / 2;
    s.add_btn = button(s.page, true, &s.add_lbl);
    lv_obj_set_pos(s.add_btn, 2, BTN_Y);
    lv_obj_set_size(s.add_btn, w, BTN_H);
    char text[48];
    snprintf(text, sizeof(text), "Add a thought #%06x (C)#", (unsigned)DG_GROUND_4);
    lv_label_set_text(s.add_lbl, text);
    lv_obj_add_event_cb(s.add_btn, [](lv_event_t*) { open_compose(); }, LV_EVENT_CLICKED, nullptr);

    s.next_btn = button(s.page, false, &s.next_lbl);
    lv_obj_set_pos(s.next_btn, 2 + w + gap, BTN_Y);
    lv_obj_set_size(s.next_btn, w, BTN_H);
    lv_obj_add_event_cb(s.next_btn, [](lv_event_t*) { open_next(); }, LV_EVENT_CLICKED, nullptr);

    lv_obj_add_flag(s.page, LV_OBJ_FLAG_HIDDEN);
}

void build_empty(lv_obj_t* parent)
{
    auto& s = st();
    s.empty = panel(parent);
    s.e_title = label(s.empty, F_TITLE, dg::text1());
    lv_obj_set_width(s.e_title, SCREEN_W - 2 * PAD);
    lv_obj_set_style_text_align(s.e_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s.e_title, PAD, 50);

    s.e_sub = label(s.empty, F_META, dg::text3());
    lv_label_set_long_mode(s.e_sub, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.e_sub, SCREEN_W - 4 * PAD);
    lv_obj_set_style_text_align(s.e_sub, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s.e_sub, 2 * PAD, 78);

    lv_obj_t* lbl = nullptr;
    lv_obj_t* b = button(s.empty, false, &lbl);
    lv_obj_set_size(b, 160, BTN_H - 4);
    lv_obj_align(b, LV_ALIGN_BOTTOM_MID, 0, -6);
    char text[48];
    snprintf(text, sizeof(text), "Add a thought #%06x (C)#", (unsigned)DG_TEXT_3);
    lv_label_set_text(lbl, text);
    lv_obj_add_event_cb(b, [](lv_event_t*) { open_compose(); }, LV_EVENT_CLICKED, nullptr);
}

void build_compose(lv_obj_t* parent)
{
    auto& s = st();
    s.compose = panel(parent);

    s.c_head = label(s.compose, F_META, dg::text2());
    lv_label_set_long_mode(s.c_head, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.c_head, SCREEN_W - 2 * PAD);
    lv_obj_set_pos(s.c_head, PAD, 5);

    s.c_ta = lv_textarea_create(s.compose);
    lv_textarea_set_one_line(s.c_ta, false);   // wraps; Enter is caught and sends
    lv_textarea_set_max_length(s.c_ta, THOUGHT_MAX);
    lv_textarea_set_placeholder_text(s.c_ta, "A paragraph for next time");
    lv_obj_set_pos(s.c_ta, PAD - 2, 22);
    lv_obj_set_size(s.c_ta, SCREEN_W - 2 * (PAD - 2), COMPOSE_BTN_Y - 4 - 22);
    // Your words, so the writing face.
    lv_obj_set_style_text_font(s.c_ta, F_WRITER, 0);
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
    if (lv_obj_get_group(s.c_ta)) lv_group_remove_obj(s.c_ta);

    const int bw_cancel = 78, bw_send = 108;
    lv_obj_t* lbl = nullptr;
    lv_obj_t* cancel = button(s.compose, false, &lbl);
    lv_obj_set_pos(cancel, PAD - 2, COMPOSE_BTN_Y);
    lv_obj_set_size(cancel, bw_cancel, COMPOSE_BTN_H);
    lv_label_set_text(lbl, "Cancel");
    lv_obj_add_event_cb(cancel, [](lv_event_t*) { close_compose(true); }, LV_EVENT_CLICKED, nullptr);

    lv_obj_t* send = button(s.compose, true, &lbl);
    lv_obj_set_pos(send, SCREEN_W - (PAD - 2) - bw_send, COMPOSE_BTN_Y);
    lv_obj_set_size(send, bw_send, COMPOSE_BTN_H);
    char text[40];
    snprintf(text, sizeof(text), "Send #%06x (Enter)#", (unsigned)DG_GROUND_4);
    lv_label_set_text(lbl, text);
    lv_obj_add_event_cb(send, [](lv_event_t*) { submit(); }, LV_EVENT_CLICKED, nullptr);

    s.c_status = label(s.compose, F_META, dg::text3());
    lv_label_set_long_mode(s.c_status, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.c_status, SCREEN_W - 2 * PAD - bw_cancel - bw_send - 8);
    lv_obj_set_style_text_align(s.c_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s.c_status, PAD - 2 + bw_cancel + 6, COMPOSE_BTN_Y + 1);

    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void library_build(lv_obj_t* parent)
{
    auto& a = app();
    a.view_library = panel(parent);
    build_empty(a.view_library);
    build_page(a.view_library);
    build_compose(a.view_library);
    lv_obj_add_flag(a.view_library, LV_OBJ_FLAG_HIDDEN);
    lv_timer_create(tick_cb, 1000, nullptr);
}

void library_open()
{
    close_compose(true);
    app_show(View::Library);
    render();
    fetch();
}

bool library_back()
{
    auto& s = st();
    if (s.composing) { close_compose(true); return true; }
    return false;
}

bool library_key(uint8_t k)
{
    auto& s = st();
    if (s.composing) {
        if (k == 0x1B) { close_compose(true); return true; }
        if (k == '\r' || k == '\n') { submit(); return true; }
        if (k == 0x08 || k == 0x7F) {
            const char* t = lv_textarea_get_text(s.c_ta);
            if (!t || !*t) { close_compose(true); return true; }
        }
        return false;   // the text box types
    }
    if (k == 0x1B) { app_back(); return true; }
    if (cockpit_nav_key(k)) return true;
    switch (k) {
    case 'j': go(1);  return true;
    case 'k': go(-1); return true;
    case 'c': open_compose(); return true;
    case 'o':
        if (lv_obj_has_flag(s.page, LV_OBJ_FLAG_HIDDEN)) flash("nothing to open next");
        else                                             open_next();
        return true;
    case 'r': fetch(); return true;
    case 't': app_show(View::Tabs); return true;
    case ' ': case 'b': {
        const int h = lv_obj_get_height(s.scroll) - 24;
        lv_obj_scroll_by_bounded(s.scroll, 0, k == ' ' ? -h : h, LV_ANIM_OFF);
        return true;
    }
    case '\t':
        return false;
    default:
        return true;   // nothing strays into a hidden widget
    }
}

void library_ball(int dx, int dy, bool click)
{
    auto& s = st();
    if (s.composing) return;
    const uint32_t now = lv_tick_get();
    if (dy) {
        s.ball_dx = 0;
        s.ball_dy_tick = now;
        lv_obj_scroll_by_bounded(s.scroll, 0, -ball_scroll_px(dy), LV_ANIM_OFF);
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
    // A click opens the thought box, which sends nothing by itself.
    if (click) open_compose();
}

}  // namespace dirigible_app
