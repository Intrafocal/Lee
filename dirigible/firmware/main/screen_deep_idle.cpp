/*
 * screen_deep_idle.cpp — "Still thinking?" (Desk D2 §9.2, §9.4): the one
 * push Lee sends when a Deep session at the Mac has been idle for 40 of its
 * 45 minutes.  A Tether-style page of its own, so its keys don't clash with
 * Work's pager (d is Dismiss there, a rating here).
 *
 * Data: the snapshot's open deep_idle item (AttentionSnapshot::deep_idle()):
 * the card you were in and how long until the session ends.  The device stays
 * pull-first: the item's notify blinks the header like any other, Work's
 * header centre says "Still thinking? x", and x opens this page from Work,
 * In flight or Library.
 *
 *   +------------------------------------------------------------+
 *   | Still thinking?                                  ends 4m   |  title
 *   | YOUR CARD                                                  |
 *   | Mesh sync                                   (italic)       |  your words
 *   | The session ends if you stay away.                         |
 *   | +---------------------------+ +--------------------------+ |
 *   | | Extend (E)                | | Capture (C)              | |
 *   | +---------------------------+ +--------------------------+ |
 *   | | Deep (D)       | | Mixed (M)       | | Shallow (S)     |   |
 *   +------------------------------------------------------------+
 *
 *   e      POST /deep/idle-end {action: extend}: 45 more minutes from now.
 *   d m s  End and rate: a box asks where you stopped (optional); Enter
 *          sends POST /deep/idle-end {action: end_rate, rating, stopped_at?}.
 *   c      a thought into the card (POST /carry/capture with its card_id);
 *          the push stays open.
 *
 * Every answer echoes the item's version; a 409 means the push was answered
 * elsewhere or you came back to the Mac, and the page says so.
 */

#include <cstdio>
#include <cstring>
#include <string>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

static const char* TAG = "dirigible.deepidle";

namespace dirigible_app {

namespace {

using dirigible::AttentionItem;

const lv_font_t* const F_META   = dg::ui_font_small();
const lv_font_t* const F_BODY   = dg::ui_font();
const lv_font_t* const F_TITLE  = dg::ui_font_title();
const lv_font_t* const F_WRITER = dg::ui_font_italic();

constexpr int PAD    = 6;
constexpr int BTN_H  = 30;
constexpr int GAP    = 4;
constexpr int ROW2_Y = BODY_H - BTN_H - 3;
constexpr int ROW1_Y = ROW2_Y - BTN_H - GAP;
constexpr int TEXT_MAX = 1000;
constexpr int COMPOSE_BTN_H = 30;
constexpr int COMPOSE_BTN_Y = BODY_H - COMPOSE_BTN_H - 3;
constexpr uint32_t FLASH_MS = 2500;

enum class Box : uint8_t { None, StoppedAt, Capture };

struct State {
    lv_obj_t* page    = nullptr;
    lv_obj_t* ends    = nullptr;
    lv_obj_t* card_eb = nullptr;
    lv_obj_t* card    = nullptr;
    lv_obj_t* note    = nullptr;
    lv_obj_t* buttons = nullptr;   // the two rows, hidden once the push is gone

    lv_obj_t* compose  = nullptr;
    lv_obj_t* c_head   = nullptr;
    lv_obj_t* c_ta     = nullptr;
    lv_obj_t* c_status = nullptr;
    Box       box = Box::None;
    const char* rating = nullptr;   // "deep" | "mixed" | "shallow" while the stopped-at box is open

    bool     busy = false;
    uint32_t flash_until = 0;
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

const AttentionItem* item()
{
    const auto* sn = cockpit_snapshot();
    return sn ? sn->deep_idle() : nullptr;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

void flash(const char* msg)
{
    st().flash_until = lv_tick_get() + FLASH_MS;
    chrome_set_centre(msg);
}

void footer()
{
    if (app().view != View::DeepIdle) return;
    switch (st().box) {
    case Box::StoppedAt: chrome_set_footer("Enter ends  empty: no note", "stopped at"); return;
    case Box::Capture:   chrome_set_footer("Enter sends  hold: cancel", "thought");  return;
    default: break;
    }
    chrome_set_footer(item() ? "e extend  d/m/s end + rate  c capture" : "w Work", "deep");
}

/// "4m", "under a minute"; "" when unknown.
std::string ends_in(int64_t ms)
{
    if (ms < 0) return "";
    if (ms < 60000) return "under a minute";
    char b[16];
    snprintf(b, sizeof(b), "%dm", (int)((ms + 59999) / 60000));
    return b;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

void render()
{
    auto& s = st();
    if (app().view != View::DeepIdle) return;
    const AttentionItem* it = item();
    if (!it) {
        lv_label_set_text(s.ends, "");
        lv_obj_add_flag(s.card_eb, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s.card, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s.note, "Answered, or you're back at the Mac.\nw goes to Work.");
        lv_obj_add_flag(s.buttons, LV_OBJ_FLAG_HIDDEN);
    } else {
        const std::string in = ends_in(it->deep_ends_in_ms);
        lv_label_set_text(s.ends, in.empty() ? "" : ("ends " + in).c_str());
        const std::string& title = it->deep_card_title.empty() ? it->text : it->deep_card_title;
        if (title.empty()) {
            lv_obj_add_flag(s.card_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s.card, LV_OBJ_FLAG_HIDDEN);
        } else {
            ui_set_text(s.card, title);
            lv_obj_clear_flag(s.card_eb, LV_OBJ_FLAG_HIDDEN);
            lv_obj_clear_flag(s.card, LV_OBJ_FLAG_HIDDEN);
        }
        lv_label_set_text(s.note, "Your Deep session at the Mac ends if you stay away.");
        lv_obj_clear_flag(s.buttons, LV_OBJ_FLAG_HIDDEN);
    }
    if ((int32_t)(s.flash_until - lv_tick_get()) <= 0) chrome_set_centre(cockpit_status().c_str());
    footer();
}

// ---------------------------------------------------------------------------
// The text box: where you stopped, or a thought into the card
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

void close_box()
{
    auto& s = st();
    if (s.box == Box::None) return;
    ta_active(false);
    lv_textarea_set_text(s.c_ta, "");
    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    s.box = Box::None;
    s.rating = nullptr;
    render();
}

void open_box(Box box, const char* rating)
{
    auto& s = st();
    if (s.box != Box::None || !item()) return;
    s.box = box;
    s.rating = rating;
    if (box == Box::StoppedAt) {
        char head[64];
        snprintf(head, sizeof(head), "Ending as %s. Where did you stop? (optional)", rating);
        lv_label_set_text(s.c_head, head);
        lv_textarea_set_placeholder_text(s.c_ta, "The last thing you were thinking");
    } else {
        const AttentionItem* it = item();
        const std::string& t = it->deep_card_title;
        ui_set_text(s.c_head, t.empty() ? std::string("A thought for next time") : "A thought into " + t);
        lv_textarea_set_placeholder_text(s.c_ta, "A paragraph for next time");
    }
    lv_textarea_set_text(s.c_ta, "");
    set_status("", dg::text3());
    lv_obj_clear_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
    lv_obj_move_foreground(s.compose);
    ta_active(true);
    footer();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Extend, or End and rate with `stopped_at` (may be empty).
void answer(const char* action, const char* rating, const std::string& stopped_at)
{
    auto& s = st();
    const AttentionItem* it = item();
    if (!it) { flash("the push is gone"); return; }
    if (s.busy) return;
    if (!cockpit_linked()) { flash("not connected"); return; }
    const bool extend = strcmp(action, "extend") == 0;
    auto done = [extend](const dirigible::ReplyResult& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "idle-end: %d %s", r.status, r.error.c_str());
            if (s.box == Box::StoppedAt) {
                set_status(r.stale() ? "The session moved on" : "Didn't send - Enter to retry", dg::error());
            }
            flash(r.stale() || r.status == 404 ? "already answered" :
                  r.status == 403 ? "re-pair to answer" : "didn't send");
            return;
        }
        close_box();
        flash(extend ? "45 more minutes" : "session ended");
        waiting_open();
    };
    s.busy = true;
    flash(extend ? "extending..." : "ending...");
#if DIRIGIBLE_UI_DEMO
    (void)rating;
    (void)stopped_at;
    dirigible::ReplyResult r;
    r.status = 200;
    r.ok = true;
    done(r);
#else
    auto* c = conn();
    if (!c) { s.busy = false; flash("not connected"); return; }
    c->deepIdleEnd(it->id, it->version, action, rating, stopped_at, done);
#endif
}

void submit()
{
    auto& s = st();
    const char* raw = lv_textarea_get_text(s.c_ta);
    const std::string text = raw ? raw : "";
    if (s.box == Box::StoppedAt) {
        set_status("Sending...", dg::text2());
        answer("end_rate", s.rating, text);
        return;
    }
    if (text.empty()) { set_status("Type something first", dg::text3()); return; }
    const AttentionItem* it = item();
    if (!it) { set_status("The push is gone", dg::text3()); return; }
    if (s.busy) return;
    s.busy = true;
    set_status("Sending...", dg::text2());
    auto done = [](const dirigible::CaptureOutcome& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "capture: %d %s", r.status, r.error.c_str());
            set_status("Didn't send - Enter to retry", dg::error());
            return;
        }
        close_box();
        flash(r.spooled ? "saved; syncs when Hester is back" : "added to the card");
    };
#if DIRIGIBLE_UI_DEMO
    dirigible::CaptureOutcome r;
    r.status = 200;
    r.ok = true;
    done(r);
#else
    auto* c = conn();
    if (!c) { s.busy = false; set_status("Not connected", dg::error()); return; }
    c->carryCapture(text, it->deep_card_id, done);
#endif
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

/// A bordered button naming its key: "Extend (E)".  Touch-only; the keys act.
lv_obj_t* button(lv_obj_t* parent, bool primary, const char* name, char key,
                 int x, int y, int w, lv_event_cb_t cb)
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
    if (lv_obj_get_group(b)) lv_group_remove_obj(b);
    lv_obj_set_pos(b, x, y);
    lv_obj_set_size(b, w, BTN_H);
    lv_obj_t* l = label(b, F_BODY, primary ? dg::on_phosphor() : dg::text1());
    lv_label_set_recolor(l, true);
    char text[48];
    if (key) snprintf(text, sizeof(text), "%s #%06x (%c)#", name, (unsigned)(primary ? DG_GROUND_4 : DG_TEXT_3), key);
    else     snprintf(text, sizeof(text), "%s", name);
    lv_label_set_text(l, text);
    lv_obj_center(l);
    lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, nullptr);
    return b;
}

void build_page(lv_obj_t* parent)
{
    auto& s = st();
    s.page = parent;

    lv_obj_t* title = label(s.page, F_TITLE, dg::text1(), "Still thinking?");
    lv_obj_set_pos(title, PAD, 3);
    s.ends = label(s.page, F_META, dg::text3());
    lv_obj_align(s.ends, LV_ALIGN_TOP_RIGHT, -PAD, 6);

    s.card_eb = label(s.page, F_META, dg::text3(), "YOUR CARD");
    lv_obj_set_style_text_letter_space(s.card_eb, 1, 0);
    lv_obj_set_pos(s.card_eb, PAD, 28);
    // The card's title is your words: the writing face.
    s.card = label(s.page, F_WRITER, dg::text1());
    lv_label_set_long_mode(s.card, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.card, SCREEN_W - 2 * PAD);
    lv_obj_set_pos(s.card, PAD, 44);
    s.note = label(s.page, F_META, dg::text2());
    lv_label_set_long_mode(s.note, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.note, SCREEN_W - 2 * PAD);
    lv_obj_set_pos(s.note, PAD, 68);

    s.buttons = lv_obj_create(s.page);
    lv_obj_remove_style_all(s.buttons);
    lv_obj_set_pos(s.buttons, 0, ROW1_Y);
    lv_obj_set_size(s.buttons, SCREEN_W, BODY_H - ROW1_Y);
    lv_obj_clear_flag(s.buttons, LV_OBJ_FLAG_SCROLLABLE);

    // Extend is the one next step (phosphor); the rest are plain.
    const int half = (SCREEN_W - 4 - GAP) / 2;
    button(s.buttons, true, "Extend", 'E', 2, 0, half, [](lv_event_t*) { answer("extend", nullptr, ""); });
    button(s.buttons, false, "Capture", 'C', 2 + half + GAP, 0, half, [](lv_event_t*) { open_box(Box::Capture, nullptr); });
    const int third = (SCREEN_W - 4 - 2 * GAP) / 3;
    const int y2 = ROW2_Y - ROW1_Y;
    button(s.buttons, false, "Deep", 'D', 2, y2, third, [](lv_event_t*) { open_box(Box::StoppedAt, "deep"); });
    button(s.buttons, false, "Mixed", 'M', 2 + third + GAP, y2, third, [](lv_event_t*) { open_box(Box::StoppedAt, "mixed"); });
    button(s.buttons, false, "Shallow", 'S', 2 + 2 * (third + GAP), y2, third, [](lv_event_t*) { open_box(Box::StoppedAt, "shallow"); });
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
    lv_textarea_set_max_length(s.c_ta, TEXT_MAX);
    lv_obj_set_pos(s.c_ta, PAD - 2, 22);
    lv_obj_set_size(s.c_ta, SCREEN_W - 2 * (PAD - 2), COMPOSE_BTN_Y - 4 - 22);
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
    lv_obj_t* cancel = button(s.compose, false, "Cancel", 0, PAD - 2, COMPOSE_BTN_Y, bw_cancel,
                              [](lv_event_t*) { close_box(); });
    lv_obj_set_height(cancel, COMPOSE_BTN_H);
    lv_obj_t* send = button(s.compose, true, "Send", 0, SCREEN_W - (PAD - 2) - bw_send, COMPOSE_BTN_Y, bw_send,
                            [](lv_event_t*) { submit(); });
    lv_obj_set_height(send, COMPOSE_BTN_H);

    s.c_status = label(s.compose, F_META, dg::text3());
    lv_label_set_long_mode(s.c_status, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.c_status, SCREEN_W - 2 * PAD - bw_cancel - bw_send - 8);
    lv_obj_set_style_text_align(s.c_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_set_pos(s.c_status, PAD - 2 + bw_cancel + 6, COMPOSE_BTN_Y + 1);

    lv_obj_add_flag(s.compose, LV_OBJ_FLAG_HIDDEN);
}

void tick_cb(lv_timer_t*)
{
    auto& s = st();
    if (app().view != View::DeepIdle) return;
    if (s.flash_until && (int32_t)(s.flash_until - lv_tick_get()) <= 0) {
        s.flash_until = 0;
        chrome_set_centre(cockpit_status().c_str());
    }
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void deep_idle_build(lv_obj_t* parent)
{
    auto& a = app();
    a.view_deep_idle = panel(parent);
    build_page(a.view_deep_idle);
    build_compose(a.view_deep_idle);
    lv_obj_add_flag(a.view_deep_idle, LV_OBJ_FLAG_HIDDEN);
    lv_timer_create(tick_cb, 1000, nullptr);
}

bool deep_idle_pending()
{
    return item() != nullptr;
}

void deep_idle_open()
{
    close_box();
    app_show(View::DeepIdle);
    render();
}

void deep_idle_render()
{
    render();
}

bool deep_idle_back()
{
    if (st().box != Box::None) { close_box(); return true; }
    return false;
}

bool deep_idle_key(uint8_t k)
{
    auto& s = st();
    if (s.box != Box::None) {
        if (k == 0x1B) { close_box(); return true; }
        if (k == '\r' || k == '\n') { submit(); return true; }
        if ((k == 0x08 || k == 0x7F) && s.box == Box::Capture) {
            const char* t = lv_textarea_get_text(s.c_ta);
            if (!t || !*t) { close_box(); return true; }
        }
        return false;   // the text box types
    }
    if (k == 0x1B) { app_back(); return true; }
    switch (k) {
    case 'e': answer("extend", nullptr, ""); return true;
    case 'd': open_box(Box::StoppedAt, "deep");    return true;
    case 'm': open_box(Box::StoppedAt, "mixed");   return true;
    case 's': open_box(Box::StoppedAt, "shallow"); return true;
    case 'c': open_box(Box::Capture, nullptr);     return true;
    case 'w': case 'i': case 'l': cockpit_nav_key(k); return true;
    case '\t': return false;
    default:  return true;   // nothing strays into a hidden widget
    }
}

void deep_idle_ball(int, int, bool) {}

}  // namespace dirigible_app
