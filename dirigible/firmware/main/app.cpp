/*
 * app.cpp — chrome, view switching, global input routing.
 *
 * The screen is one persistent layout: a 20 px header (title, centre status,
 * battery + link dot), a 220 px content area holding every view stacked and
 * hidden, and a 16 px footer carrying a per-screen key legend.  Views are
 * swapped by toggling LV_OBJ_FLAG_HIDDEN rather than by lv_scr_load, so the
 * chrome never flickers and the LVGL input group can be rebuilt per view.
 *
 * The footer is drawn *over* the content band rather than shrinking it, so the
 * terminal view can claim the full 220 px and keep every character row; the
 * terminal hides the footer and only shows it while the menu is open.
 */

#include "app.hpp"

#include <cstdio>
#include <cstring>
#include <vector>

#include "brand_images.h"
#include "dirigible/state.hpp"
#include "dirigible_esp/dispatch.hpp"
#include "dirigible_esp/wifi_esp.hpp"
#include "esp_log.h"
#include "tdeck_bsp.h"
#include "theme.hpp"
#include "ui_text.hpp"

static const char* TAG = "dirigible.app";

namespace dirigible_app {

App& app()
{
    static App a;
    return a;
}

int rssi_to_level(int rssi)
{
    if (rssi >= -55) return 4;
    if (rssi >= -67) return 3;
    if (rssi >= -75) return 2;
    return 1;
}

lv_obj_t* make_signal(lv_obj_t* parent, int level)
{
    // Four bottom-aligned bars, 3 px wide on a 5 px pitch: 4*3 + 3*2 = 18 px,
    // one spare column so the container is an even SIGNAL_W.
    lv_obj_t* box = lv_obj_create(parent);
    lv_obj_remove_style_all(box);
    lv_obj_set_size(box, SIGNAL_W, SIGNAL_H);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_CLICKABLE);
    for (int i = 0; i < 4; i++) {
        lv_obj_t* bar = lv_obj_create(box);
        lv_obj_remove_style_all(bar);
        const int h = 3 + i * 3;                 // 3, 6, 9, 12
        lv_obj_set_size(bar, 3, h);
        lv_obj_set_pos(bar, i * 5, SIGNAL_H - h);
        lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(bar,
            i < level ? dg::phosphor() : dg::ground4(), 0);
        lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);
    }
    return box;
}

lv_obj_t* make_label(lv_obj_t* parent, const char* text, lv_color_t colour,
                     const lv_font_t* font)
{
    if (!font) font = dg::ui_font();
    lv_obj_t* l = lv_label_create(parent);
    // Monospace callers show exact ASCII (host:port, ids); everything else may
    // be wire text and is folded for Montserrat.
    if (font == dg::mono_font() || font == dg::mono_font_big()) lv_label_set_text(l, text);
    else                                                         ui_set_text(l, text);
    lv_obj_set_style_text_color(l, colour, 0);
    lv_obj_set_style_text_font(l, font, 0);
    return l;
}

// Header and footer text is often from the wire (machine and window names,
// file names, Hester phase details), so it is folded on the way in.
void chrome_set_title(const char* t)
{
    if (app().lbl_machine && t) lv_label_set_text(app().lbl_machine, ui_fold(t).c_str());
}

void chrome_set_centre(const char* t)
{
    if (app().lbl_centre && t) lv_label_set_text(app().lbl_centre, ui_fold(t).c_str());
}

static void footer_fit_legend();

void chrome_set_footer(const char* legend, const char* right)
{
    auto& a = app();
    if (legend && a.lbl_footer_l) lv_label_set_text(a.lbl_footer_l, ui_fold(legend).c_str());
    if (right  && a.lbl_footer_r) lv_label_set_text(a.lbl_footer_r, ui_fold(right).c_str());
    // The legend's room depends on the right-hand hint's width now that it is
    // proportional, so refit whenever either changes.
    if (right) footer_fit_legend();
}

void chrome_set_back_glyph(const char* glyph)
{
    if (app().back_lbl && glyph) lv_label_set_text(app().back_lbl, glyph);
}

void chrome_show_footer(bool show)
{
    auto& a = app();
    if (!a.footer) return;
    if (show) lv_obj_clear_flag(a.footer, LV_OBJ_FLAG_HIDDEN);
    else      lv_obj_add_flag(a.footer, LV_OBJ_FLAG_HIDDEN);
}

/// Size the key legend to whatever the right-hand slot (button row, else the
/// hint label) leaves, so it ellipsises instead of running under it.
static void footer_fit_legend()
{
    auto& a = app();
    if (!a.lbl_footer_l || !a.footer_btns) return;

    // Size and place the button row explicitly (LV_SIZE_CONTENT + align
    // proved unreliable on-device: the row grew past the right edge).
    lv_obj_update_layout(a.footer_btns);
    const uint32_t n = lv_obj_get_child_cnt(a.footer_btns);
    lv_coord_t btn_w = 0;
    for (uint32_t i = 0; i < n; i++) {
        lv_obj_t* c = lv_obj_get_child(a.footer_btns, i);
        lv_obj_update_layout(c);
        btn_w += lv_obj_get_width(c);
    }
    if (n > 1) btn_w += (n - 1) * 3;                 // pad_column
    lv_obj_set_width(a.footer_btns, btn_w > 0 ? btn_w : 1);
    lv_obj_set_pos(a.footer_btns, SCREEN_W - 3 - btn_w, 0);   // +1 border: x..317, y 1..15

    // Right-hand slot: the buttons when there are any (the hint is hidden
    // then), else the hint label; 8 px of air either way.
    lv_coord_t right_w = btn_w + 2;
    if (!btn_w && a.lbl_footer_r) {
        lv_obj_update_layout(a.lbl_footer_r);
        right_w = lv_obj_get_width(a.lbl_footer_r) + 3;
    }
    lv_coord_t avail = SCREEN_W - 3 - right_w - 8;
    if (avail < 0) avail = 0;
    lv_obj_set_width(a.lbl_footer_l, avail);

    lv_obj_update_layout(a.footer);
    lv_area_t la, ba; lv_obj_get_coords(a.lbl_footer_l, &la); lv_obj_get_coords(a.footer_btns, &ba);
    ESP_LOGD("dirigible.ui", "footer: legend x=%d w=%d | btns n=%u x=%d w=%d",
             (int)la.x1, (int)lv_area_get_width(&la), (unsigned)n, (int)ba.x1, (int)lv_area_get_width(&ba));
    for (uint32_t i = 0; i < n; i++) {
        lv_area_t ca; lv_obj_get_coords(lv_obj_get_child(a.footer_btns, i), &ca);
        ESP_LOGD("dirigible.ui", "  btn[%u] x=%d w=%d", (unsigned)i, (int)ca.x1, (int)lv_area_get_width(&ca));
    }
}

void chrome_clear_footer_buttons()
{
    auto& a = app();
    if (!a.footer_btns) return;
    lv_obj_clean(a.footer_btns);
    if (a.lbl_footer_r) lv_obj_clear_flag(a.lbl_footer_r, LV_OBJ_FLAG_HIDDEN);
    footer_fit_legend();
}

/// Header title slot, right of the 22 px back button; ends before x=112.
static constexpr int TITLE_X = 28;
static constexpr int TITLE_W = 80;

/// Extra touch margin around each footer button (see chrome_add_footer_button).
static constexpr int FOOTER_HIT = 7;

lv_obj_t* chrome_add_footer_button(const char* text, lv_event_cb_t cb, void* user)
{
    auto& a = app();
    if (!a.footer_btns) return nullptr;
    if (a.lbl_footer_r) lv_obj_add_flag(a.lbl_footer_r, LV_OBJ_FLAG_HIDDEN);

    // 15 px: the footer's 16 less its top hairline, which is exactly one
    // Montserrat 12 line.
    lv_obj_t* btn = lv_btn_create(a.footer_btns);
    lv_obj_remove_style_all(btn);
    lv_obj_set_height(btn, FOOTER_H - 1);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(btn, dg::ground3(), 0);
    lv_obj_set_style_border_width(btn, 1, 0);
    lv_obj_set_style_border_color(btn, dg::ground4(), 0);
    lv_obj_set_style_border_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, DG_RADIUS, 0);
    lv_obj_set_style_pad_hor(btn, 6, 0);
    lv_obj_set_style_pad_ver(btn, 0, 0);
    lv_obj_set_style_min_width(btn, 40, 0);   // "Win (W)" is still a target
    lv_obj_set_style_bg_color(btn, dg::ground4(), LV_STATE_PRESSED);
    lv_obj_set_style_border_color(btn, dg::ground5(), 0);
    dg::style_focus(btn);

    // The label is a full 15 px line in a 15 px box with a 1 px border; one
    // pixel up keeps descenders (Retry, Open) off the bottom border, and the
    // line's empty top row is what gets clipped instead.
    lv_obj_t* l = make_label(btn, text, dg::text1(), dg::ui_font_small());
    lv_obj_align(l, LV_ALIGN_CENTER, 0, -1);

    // A 15 px tall button is about 3 mm on this panel, well under a
    // fingertip.  The band cannot grow without eating the body, so the hit
    // area does instead: FOOTER_HIT px on every side, which reaches up into
    // the body (the footer and its row are OVERFLOW_VISIBLE so LVGL looks
    // there) and across the 3 px gaps.  Neighbours split the gap evenly.
    lv_obj_set_ext_click_area(btn, FOOTER_HIT);

    if (cb) lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, user);
    if (a.group) lv_group_add_obj(a.group, btn);
    footer_fit_legend();
    return btn;
}

void app_set_status(const char* left, const char* right)
{
    chrome_set_centre(left);
    chrome_set_footer(nullptr, right);
}

// ---------------------------------------------------------------------------
// Machine / connection glue
// ---------------------------------------------------------------------------

static dirigible::LeeConnection* activeConn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
}

void connect_active_machine()
{
    auto& a = app();
    if (!a.machines || a.machines->machineCount() == 0) {
        app_set_status("no machine - " LV_SYMBOL_LIST " for the menu");
        return;
    }

    auto* m = a.machines->machineAt(0);
    std::string token = a.config->getToken(m->config.name);
    if (!token.empty()) m->token = token;

    a.machines->setActive(m->config.name);
    auto* conn = a.machines->activeConnection();
    if (!conn) return;
    if (!token.empty()) conn->setToken(token);
    conn->connect();

    chrome_set_title(m->config.name.c_str());
    ESP_LOGI(TAG, "connecting to %s (%s:%d)", m->config.name.c_str(),
             m->config.host.c_str(), m->config.lee_port);
    char buf[48];
    snprintf(buf, sizeof(buf), "%s:%d", m->config.host.c_str(), m->config.lee_port);
    app_set_status(buf);
}

// ---------------------------------------------------------------------------
// Menu overlay (Waiting's back affordance: the header button or a ball hold)
// ---------------------------------------------------------------------------

static void menu_close()
{
    auto& a = app();
    if (!a.menu) return;
    lv_obj_del(a.menu);
    a.menu = nullptr;
    if (a.view == View::Hester) hester_focus();
}

static void menu_item_cb(lv_event_t* e)
{
    auto choice = (intptr_t)lv_event_get_user_data(e);
    menu_close();
    switch (choice) {
    case 0: waiting_open(); break;
    case 1: inflight_open(); break;
    case 2: review_open(); break;
    case 3: app_show(View::Tabs); break;
    case 4: files_open(View::Tabs); break;
    case 5: app_show(View::Hester); break;
    case 6: waiting_open_capture(); break;
    case 7: windows_open(); break;
    case 8: pairing_begin(); break;
    case 9:
        if (auto* c = activeConn()) { c->disconnect(); c->connect(); }
        app_set_status("reconnecting...");
        break;
#if defined(DIRIGIBLE_UI_DEMO) && DIRIGIBLE_UI_DEMO
    case 10: viewer_open_demo(); break;
#endif
    default: break;
    }
}

static void menu_style(lv_obj_t* list, int w)
{
    lv_obj_set_size(list, w, 150);
    lv_obj_center(list);
    lv_obj_set_style_bg_color(list, dg::ground2(), 0);
    lv_obj_set_style_border_width(list, 1, 0);
    lv_obj_set_style_border_color(list, dg::ground4(), 0);
    lv_obj_set_style_text_font(list, dg::ui_font(), 0);
}

static lv_obj_t* menu_add(lv_obj_t* list, const char* text, lv_event_cb_t cb, void* user)
{
    lv_obj_t* btn = lv_list_add_btn(list, nullptr, ui_fold(text).c_str());
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(btn, dg::ground3(), 0);
    lv_obj_set_style_text_color(btn, dg::text1(), 0);
    dg::style_focus(btn);
    lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, user);
    if (app().group) lv_group_add_obj(app().group, btn);
    return btn;
}

/// Opened from the Waiting view's back affordance — Waiting is the root, so
/// "back" there means "what else can I do".  Every other view reaches its own
/// parent instead, which is why this is no longer bound to the long-press.
static void menu_open(void*)
{
    auto& a = app();
    if (a.menu) { menu_close(); return; }

    a.menu = lv_list_create(a.screen);
    menu_style(a.menu, 180);

    static const char* names[] = { "Work (W)", "In flight (I)", "Review (V)", "Tabs", "Files",
                                   "Hester", "Capture", "Windows", "Pairing", "Reconnect",
                                   "MD sample" };
#if defined(DIRIGIBLE_UI_DEMO) && DIRIGIBLE_UI_DEMO
    const intptr_t n = 11;   // + the viewer's markdown sample
#else
    const intptr_t n = 10;
#endif
    for (intptr_t i = 0; i < n; i++) {
        menu_add(a.menu, names[i], menu_item_cb, (void*)i);
    }
}

// ---------------------------------------------------------------------------
// Window picker — every Lee window on the host shares one API port, so this
// is Aeronaut's WorkspaceSwitcher: pick which window's tabs, files and
// commands Dirigible follows.  Shares the menu overlay slot, so back and
// a long-press all close it the same way.
// ---------------------------------------------------------------------------

static void window_pick_cb(lv_event_t* e)
{
    const int id = (int)(intptr_t)lv_event_get_user_data(e);
    menu_close();
    if (auto* c = activeConn()) c->setActiveWindow(id);
    app_show(View::Tabs);
}

void windows_open()
{
    auto& a = app();
    if (a.menu) menu_close();

    auto* c = activeConn();
    if (!c || c->windows().empty()) {
        app_set_status(c && c->isConnected() ? "no windows" : "not connected");
        if (c) c->refreshWindows();
        return;
    }

    a.menu = lv_list_create(a.screen);
    menu_style(a.menu, 240);
    lv_obj_t* head = lv_list_add_text(a.menu, "Lee windows  " LV_SYMBOL_BULLET " = focused on the host");
    lv_obj_set_style_text_font(head, dg::ui_font_small(), 0);

    lv_obj_t* current = nullptr;
    for (const auto& w : c->windows()) {
        // [mark] name  *  — the mark (the window Dirigible follows) sits in a
        // fixed 14 px slot ahead of the label so names line up whether or not
        // the row carries it; proportional text cannot pad with a space.
        const bool following = w.id == c->activeWindowId();
        std::string text = w.name();
        if (w.focused) text += "  " LV_SYMBOL_BULLET;
        lv_obj_t* btn = menu_add(a.menu, text.c_str(), window_pick_cb, (void*)(intptr_t)w.id);
        lv_obj_t* mark = lv_label_create(btn);
        lv_label_set_text(mark, following ? LV_SYMBOL_RIGHT : "");
        lv_obj_set_width(mark, 14);
        lv_obj_set_style_text_color(mark, dg::phosphor(), 0);
        lv_obj_move_to_index(mark, 0);
        if (following) current = btn;
    }
    if (current && a.group) lv_group_focus_obj(current);

    // The list is also fetched every ping; ask now so a window opened a moment
    // ago shows up next time without waiting.
    c->refreshWindows();
}

void app_back()
{
    auto& a = app();
    if (a.menu) { menu_close(); return; }

    switch (a.view) {
    case View::Terminal:
        terminal_close();
        app_show(View::Tabs);
        return;
    case View::Hester:
        app_show(View::Tabs);
        return;
    case View::Files:
        if (a.files_from == View::Review) review_show();
        else                              app_show(View::Tabs);
        return;
    case View::Viewer: {
        // Back to wherever the file was opened from: the tree keeps its
        // expansion and selection, Review its place in the Pages, the tab
        // list is the tab list.
        const View from = viewer_return_view();
        viewer_close();
        if (from == View::Files)       files_open(a.files_from);
        else if (from == View::Review) review_show();
        else if (from == View::Waiting) waiting_open();
        else                           app_show(View::Tabs);
        return;
    }
    case View::Pairing:
        pairing_back();
        return;
    case View::Tabs:
        waiting_open();
        return;
    case View::Waiting:
        if (!waiting_back()) menu_open(nullptr);
        return;
    case View::InFlight:
        if (!inflight_back()) waiting_open();
        return;
    case View::Review:
        waiting_open();
        return;
    case View::DeepIdle:
        if (!deep_idle_back()) waiting_open();
        return;
    }
}

static void long_press_cb(void*) { app_back(); }

static void back_btn_cb(lv_event_t*) { app_back(); }

// ---------------------------------------------------------------------------
// Global key hook — runs inside the keyboard indev read, on the LVGL task.
// Returning true consumes the byte so LVGL never sees it.
// ---------------------------------------------------------------------------

static bool key_hook(uint8_t ascii, void*)
{
    auto& a = app();

    if (a.menu) {
        if (ascii == 0x1B) { menu_close(); return true; }
        return false;   // let LVGL drive the list
    }

    switch (a.view) {
    case View::Waiting:  return waiting_key(ascii);
    case View::InFlight: return inflight_key(ascii);
    case View::Review:   return review_key(ascii);
    case View::DeepIdle: return deep_idle_key(ascii);
    case View::Terminal: return terminal_key(ascii);
    case View::Pairing:  return pairing_key(ascii);
    case View::Files:    return files_key(ascii);
    case View::Viewer:   return viewer_key(ascii);
    case View::Hester:
        if (ascii == 0x1B) { app_back(); return true; }
        return false;
    case View::Tabs:
        if (ascii == 0x1B) { app_back(); return true; }
        // w stays the window picker here (Work is back, or the menu).
        if (ascii == 'w')  { windows_open(); return true; }
        if (ascii == 'i' || ascii == 'v') return cockpit_nav_key(ascii);
        return false;   // Enter activates the focused list row
    }
    return false;
}

// ---------------------------------------------------------------------------
// Trackball — a scroll wheel with a click, never a pointer.
// ---------------------------------------------------------------------------

/// Sideways detents this soon after a vertical one are the optical sensor
/// leaking, not intent (Waiting has always filtered these for its page flick).
static constexpr uint32_t BALL_DX_QUIET_MS = 200;
/// A roll that pauses this long starts a fresh accumulation / acceleration.
static constexpr uint32_t BALL_REST_MS = 400;
/// Pixels per detent at a slow roll; up to 4x on a flick.
static constexpr int BALL_SCROLL_PX = 10;

int ball_steps(BallAcc& a, int detents, int per_step)
{
    if (!detents) return 0;
    if ((a.acc > 0 && detents < 0) || (a.acc < 0 && detents > 0) ||
        lv_tick_elaps(a.tick) > BALL_REST_MS) {
        a.acc = 0;
    }
    a.tick = lv_tick_get();
    a.acc += detents;
    const int steps = a.acc / per_step;
    a.acc -= steps * per_step;
    return steps;
}

int ball_scroll_px(int detents)
{
    static uint32_t last = 0;
    const uint32_t dt = lv_tick_elaps(last);
    last = lv_tick_get();
    // The gap between detents is the roll speed: the poll runs every 10 ms,
    // so a flick lands a detent every poll or two.
    const int gain = dt >= 90 ? 1 : dt >= 50 ? 2 : dt >= 25 ? 3 : 4;
    return detents * BALL_SCROLL_PX * gain;
}

/// Visible, clickable members of the input group under `o`, in tree order.
/// A match's own children are not searched (a row's badge is not a row).
static void collect_rows(lv_obj_t* o, std::vector<lv_obj_t*>& out)
{
    const uint32_t n = lv_obj_get_child_cnt(o);
    for (uint32_t i = 0; i < n; i++) {
        lv_obj_t* c = lv_obj_get_child(o, i);
        if (lv_obj_has_flag(c, LV_OBJ_FLAG_HIDDEN)) continue;
        if (lv_obj_has_flag(c, LV_OBJ_FLAG_CLICKABLE) && lv_obj_get_group(c)) {
            out.push_back(c);
            continue;
        }
        collect_rows(c, out);
    }
}

bool ball_list(lv_obj_t* list, int dy, bool click)
{
    static BallAcc acc;
    static std::vector<lv_obj_t*> rows;   // reused: no allocation per detent
    auto& a = app();
    if (!list || !a.group || lv_obj_has_flag(list, LV_OBJ_FLAG_HIDDEN)) return false;

    rows.clear();
    collect_rows(list, rows);
    if (rows.empty()) return false;

    lv_obj_t* focused = lv_group_get_focused(a.group);
    int idx = -1;
    for (size_t i = 0; i < rows.size(); i++) {
        if (rows[i] == focused) { idx = (int)i; break; }
    }

    int target = idx;
    if (click) {
        if (idx >= 0) {
            // The handler may delete the list (the menu closes itself), so
            // nothing below touches `rows` again.
            lv_event_send(rows[idx], LV_EVENT_CLICKED, nullptr);
            return true;
        }
    } else {
        const int steps = ball_steps(acc, dy);
        if (!steps) return true;
        if (idx >= 0) {
            target = idx + steps;
            if (target < 0) target = 0;
            if (target >= (int)rows.size()) target = (int)rows.size() - 1;
            if (target == idx) return true;
        }
    }
    if (target < 0) {
        // Nothing highlighted yet: start at the first row on screen rather
        // than wherever the group's focus last was.
        lv_area_t view;
        lv_obj_get_coords(list, &view);
        target = 0;
        for (size_t i = 0; i < rows.size(); i++) {
            lv_area_t r;
            lv_obj_get_coords(rows[i], &r);
            if (r.y1 >= view.y1) { target = (int)i; break; }
        }
    }
    lv_group_focus_obj(rows[target]);
    lv_obj_scroll_to_view_recursive(rows[target], LV_ANIM_ON);
    return true;
}

static void ball_hook(int dx, int dy, bool click, void*)
{
    auto& a = app();

    // The terminal gets every detent raw: they are arrow keys there.
    if (a.view == View::Terminal && !a.menu) {
        terminal_ball(dx, dy, click);
        return;
    }

    static uint32_t last_dy = 0;
    if (dy) last_dy = lv_tick_get();
    else if (dx && lv_tick_elaps(last_dy) < BALL_DX_QUIET_MS) dx = 0;
    if (!dx && !dy && !click) return;

    if (a.menu) { ball_list(a.menu, dy, click); return; }

    switch (a.view) {
    case View::Waiting:  waiting_ball(dx, dy, click);  break;
    case View::InFlight: inflight_ball(dx, dy, click); break;
    case View::Review:   review_ball(dx, dy, click);   break;
    case View::DeepIdle: deep_idle_ball(dx, dy, click); break;
    case View::Tabs:     ball_list(a.tab_list, dy, click); break;
    case View::Hester:   hester_ball(dx, dy, click);   break;
    case View::Pairing:  pairing_ball(dx, dy, click);  break;
    case View::Files:    files_ball(dx, dy, click);    break;
    case View::Viewer:   viewer_ball(dx, dy, click);   break;
    case View::Terminal: break;
    }
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

void app_show(View v)
{
    auto& a = app();
    // Leaving the terminal by any route (menu, a jump to Waiting) must drop
    // its PTY stream: while it is open Lee treats the tab as viewed here and
    // sizes it to this screen.
    if (v != View::Terminal && a.pty) terminal_close();
    a.view = v;

    lv_obj_add_flag(a.view_waiting,  LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_inflight, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_review,   LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_deep_idle, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_tabs,     LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_terminal, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_hester,   LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_pairing,  LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_files,    LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_viewer,   LV_OBJ_FLAG_HIDDEN);

    // Each view owns its legend; pairing replaces the buttons per step.
    if (v != View::Pairing) chrome_clear_footer_buttons();
    chrome_show_footer(v != View::Terminal);

    // The Hester hare only ever shows in the Hester view; every other view
    // gets the title back at its usual TITLE_X / TITLE_W.  Reset here so each
    // case below only has to opt in.
    if (a.hester_icon) lv_obj_add_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);
    if (a.lbl_machine) {
        lv_obj_set_width(a.lbl_machine, TITLE_W);
        lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, TITLE_X, 0);
    }
    // Title defaults to the machine; Files and the viewer name themselves.
    if (auto* m = a.machines ? a.machines->activeMachine() : nullptr) {
        chrome_set_title(m->config.name.c_str());
    }

    // The back button is the same object everywhere; only its glyph changes,
    // so its position never moves under the thumb.
    switch (v) {
    case View::Waiting:
        lv_obj_clear_flag(a.view_waiting, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LIST);   // root: back opens the menu
        waiting_chrome();
        break;
    case View::InFlight:
        lv_obj_clear_flag(a.view_inflight, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);    // back: Work
        chrome_set_title("In flight");
        break;
    case View::Review:
        lv_obj_clear_flag(a.view_review, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);    // back: Work
        chrome_set_title("Review");
        break;
    case View::DeepIdle:
        lv_obj_clear_flag(a.view_deep_idle, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);    // back: Work
        chrome_set_title("At the Desk");
        break;
    case View::Tabs:
        lv_obj_clear_flag(a.view_tabs, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);
        tabs_chrome();
        break;
    case View::Terminal:
        lv_obj_clear_flag(a.view_terminal, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_CLOSE);  // back here closes the PTY
        chrome_set_footer("hold ball or " LV_SYMBOL_CLOSE " exit  ball = arrows", "term");
        break;
    case View::Hester:
        lv_obj_clear_flag(a.view_hester, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);
        chrome_set_footer("Enter ask  ball scrolls", "hester");
        // Make room for the 8x8 hare just left of the title: shift the title
        // 10 px right and shrink it by the same 10 px.
        if (a.hester_icon) lv_obj_clear_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);
        if (a.lbl_machine) {
            lv_obj_set_width(a.lbl_machine, TITLE_W - 10);
            lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, TITLE_X + 10, 0);
        }
        hester_focus();
        break;
    case View::Pairing:
        lv_obj_clear_flag(a.view_pairing, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);
        break;
    case View::Files:
        lv_obj_clear_flag(a.view_files, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);
        chrome_set_title("Files");
        chrome_set_centre("");
        chrome_set_footer("ball/tap pick  " LV_SYMBOL_LEFT LV_SYMBOL_RIGHT " fold", nullptr);
        break;
    case View::Viewer:
        lv_obj_clear_flag(a.view_viewer, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph(LV_SYMBOL_LEFT);
        chrome_set_centre("");
        chrome_set_footer("ball scroll  spc page", nullptr);
        break;
    }
}

// ---------------------------------------------------------------------------
// Periodic chrome refresh
// ---------------------------------------------------------------------------

static void chrome_timer_cb(lv_timer_t*)
{
    auto& a = app();

    tdeck_battery_t b = tdeck_bsp_battery_read();
    char buf[12];
    snprintf(buf, sizeof(buf), "%d%%", (int)b.percent);
    lv_label_set_text(a.lbl_battery, buf);
    lv_obj_set_style_text_color(a.lbl_battery,
        b.percent <= 15 ? dg::error() : dg::text3(), 0);

    const bool wifi = dirigible_esp::WifiEsp::instance().isConnected();
    lv_obj_set_style_text_color(a.lbl_wifi, wifi ? dg::text2() : dg::text3(), 0);

    auto* conn = activeConn();
    bool online = conn && conn->isConnected();
    // phosphor: Lee reachable.  ember: wifi is up but Lee is not answering.
    // error: wifi itself is down.
    lv_obj_set_style_bg_color(a.conn_dot,
        online ? dg::phosphor() : (wifi ? dg::ember() : dg::error()), 0);

    // Don't stamp over the pairing flow's own step text: it is mid-WiFi by
    // definition.
    if (!wifi && a.view != View::Pairing) chrome_set_centre("wifi down");
}

static void ping_timer_cb(lv_timer_t*)
{
    if (app().machines) app().machines->pingAll();
    // Track Lee windows opening and closing (Aeronaut polls every 10 s).
    if (auto* c = activeConn(); c && c->isConnected()) c->refreshWindows();
}

// ---------------------------------------------------------------------------
// Boot splash — airship + wordmark for ~1.2 s while WiFi/pairing/tab-list
// setup runs underneath.  Purely cosmetic: everything below app_start()'s
// "first screen" section starts immediately, the splash just covers it.
// ---------------------------------------------------------------------------

static void splash_close_cb(lv_timer_t* t)
{
    auto& a = app();
    if (a.header) lv_obj_clear_flag(a.header, LV_OBJ_FLAG_HIDDEN);
    chrome_show_footer(a.view != View::Terminal);
    if (a.splash) {
        lv_obj_del(a.splash);
        a.splash = nullptr;
    }
    lv_timer_del(t);
}

static void splash_build()
{
    auto& a = app();

    // Header/footer are hidden for the duration rather than just covered:
    // the splash is opaque so it makes no visual difference, but it keeps
    // the chrome timer from drawing battery/wifi state behind a screen that
    // is supposed to read as "not booted yet".
    if (a.header) lv_obj_add_flag(a.header, LV_OBJ_FLAG_HIDDEN);
    if (a.footer) lv_obj_add_flag(a.footer, LV_OBJ_FLAG_HIDDEN);

    a.splash = lv_obj_create(a.screen);
    lv_obj_remove_style_all(a.splash);
    lv_obj_set_pos(a.splash, 0, 0);
    lv_obj_set_size(a.splash, SCREEN_W, SCREEN_H);
    lv_obj_set_style_bg_color(a.splash, dg::ground0(), 0);
    lv_obj_set_style_bg_opa(a.splash, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.splash, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_move_foreground(a.splash);   // created after header/content/footer
                                         // anyway, but be explicit

    lv_obj_t* img = lv_img_create(a.splash);
    lv_img_set_src(img, &dg_img_airship);
    lv_obj_align(img, LV_ALIGN_CENTER, 0, -34);

    lv_obj_t* title = make_label(a.splash, "DIRIGIBLE", dg::phosphor(), dg::ui_font_title());
    lv_obj_set_style_text_letter_space(title, 3, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, 26);

    lv_obj_t* sub = make_label(a.splash, "searching for Lee", dg::text3(), dg::ui_font_small());
    lv_obj_align(sub, LV_ALIGN_CENTER, 0, 48);

    lv_timer_t* t = lv_timer_create(splash_close_cb, 1200, nullptr);
    lv_timer_set_repeat_count(t, 1);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void app_start()
{
    auto& a = app();

    // ---- chrome --------------------------------------------------------
    // Dark base theme, primary = phosphor, secondary = ember, applied before
    // any widget below is created.  This is the explicit call, not the
    // CONFIG_LV_THEME_DEFAULT_DARK Kconfig toggle: nothing in this codebase
    // invokes the Kconfig-driven LV_THEME_DEFAULT_INIT() macro, so the
    // sdkconfig flag alone has no effect — lv_disp_drv_register() never calls
    // lv_theme_default_init() on its own.  Without this, stock lv_btn /
    // lv_list / lv_textarea / lv_bar draw LVGL's unthemed base style (white
    // fill, black text) regardless of the per-object colours screen_*.cpp
    // sets, since those only override what the theme already applied.
    lv_theme_default_init(tdeck_bsp_display(), dg::phosphor(), dg::ember(),
                          true, dg::ui_font());

    a.screen = lv_scr_act();
    lv_obj_set_style_bg_color(a.screen, dg::ground0(), 0);
    lv_obj_set_style_bg_opa(a.screen, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.screen, LV_OBJ_FLAG_SCROLLABLE);

    a.group = lv_group_create();
    lv_group_set_default(a.group);
    if (auto* kbd = tdeck_bsp_keyboard_indev()) lv_indev_set_group(kbd, a.group);

    a.header = lv_obj_create(a.screen);
    lv_obj_remove_style_all(a.header);
    lv_obj_set_pos(a.header, 0, 0);
    lv_obj_set_size(a.header, SCREEN_W, HEADER_H);
    lv_obj_set_style_bg_color(a.header, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(a.header, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(a.header, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_border_width(a.header, 1, 0);
    lv_obj_set_style_border_color(a.header, dg::ground4(), 0);
    lv_obj_set_style_border_opa(a.header, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.header, LV_OBJ_FLAG_SCROLLABLE);

    // far left: the always-on back/close button, x 2..23.  There is no Esc
    // key on the T-Deck, so this (and a trackball hold) is how every view is
    // left; it is bordered like every other touch target.  Deliberately NOT in
    // the input group's *focus order* by default — pairing and Hester focus
    // their text fields on entry and a button ahead of them in the group
    // steals that focus — but it IS added to the group (task: give it the
    // focus style) so Tab can still reach it; touch and a trackball hold reach
    // it regardless.  Its hit area runs 4 px past the box into the gap before
    // the title, since it is a thumb target.
    a.back_btn = lv_btn_create(a.header);
    lv_obj_remove_style_all(a.back_btn);
    lv_obj_set_size(a.back_btn, 22, HEADER_H - 2);
    lv_obj_set_pos(a.back_btn, 2, 1);
    lv_obj_set_style_bg_opa(a.back_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(a.back_btn, dg::ground3(), 0);
    lv_obj_set_style_bg_color(a.back_btn, dg::ground3(), LV_STATE_PRESSED);
    lv_obj_set_style_radius(a.back_btn, DG_RADIUS, 0);
    dg::style_focus(a.back_btn);
    lv_obj_set_style_border_width(a.back_btn, 1, 0);
    lv_obj_set_style_border_color(a.back_btn, dg::ground5(), 0);
    lv_obj_set_style_border_opa(a.back_btn, LV_OPA_COVER, 0);
    lv_obj_set_ext_click_area(a.back_btn, 4);
    lv_obj_add_event_cb(a.back_btn, back_btn_cb, LV_EVENT_CLICKED, nullptr);
    if (a.group) lv_group_add_obj(a.group, a.back_btn);

    a.back_lbl = lv_label_create(a.back_btn);
    lv_label_set_text(a.back_lbl, LV_SYMBOL_LEFT);
    lv_obj_set_style_text_font(a.back_lbl, dg::ui_font(), 0);
    lv_obj_set_style_text_color(a.back_lbl, dg::text1(), 0);
    lv_obj_center(a.back_lbl);

    // left: title, x 28..107, Montserrat 14 with an ellipsis so it can never
    // run into the centre slot, which starts at x=112.
    a.lbl_machine = make_label(a.header, "Dirigible", dg::text1());
    lv_label_set_long_mode(a.lbl_machine, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_machine, TITLE_W);
    lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, TITLE_X, 0);

    // Hester's hare, 8x8, shown only while the Hester view is focused — see
    // app_show().  Sits in the same slot the title vacates for it.
    a.hester_icon = lv_img_create(a.header);
    lv_img_set_src(a.hester_icon, &dg_img_hester8);
    lv_obj_align(a.hester_icon, LV_ALIGN_LEFT_MID, TITLE_X, 0);
    lv_obj_add_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);

    // centre: step / status.  x 112..239 (128 px), Montserrat 12 so a status
    // line ("focus: 3 waiting", Hester's phases) fits before the ellipsis.
    a.lbl_centre = make_label(a.header, "", dg::text2(), dg::ui_font_small());
    lv_label_set_long_mode(a.lbl_centre, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_centre, 128);
    lv_obj_set_style_text_align(a.lbl_centre, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(a.lbl_centre, LV_ALIGN_LEFT_MID, 112, 0);

    // right: battery %, wifi glyph, link dot.  Laid out from the right edge.
    // A fixed, right-aligned 34 px slot ("100%" is ~30 px in Montserrat 12)
    // so the wifi glyph and dot to its left never shift as the digits change.
    a.lbl_battery = make_label(a.header, "", dg::text3(), dg::ui_font_small());
    lv_obj_set_width(a.lbl_battery, 34);
    lv_obj_set_style_text_align(a.lbl_battery, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_align(a.lbl_battery, LV_ALIGN_RIGHT_MID, -4, 0);

    a.lbl_wifi = lv_label_create(a.header);
    lv_label_set_text(a.lbl_wifi, LV_SYMBOL_WIFI);
    lv_obj_set_style_text_font(a.lbl_wifi, dg::ui_font(), 0);
    lv_obj_set_style_text_color(a.lbl_wifi, dg::text3(), 0);
    lv_obj_align(a.lbl_wifi, LV_ALIGN_RIGHT_MID, -42, 0);

    a.conn_dot = lv_obj_create(a.header);
    lv_obj_remove_style_all(a.conn_dot);
    lv_obj_set_size(a.conn_dot, 8, 8);
    lv_obj_set_style_radius(a.conn_dot, 4, 0);
    lv_obj_set_style_bg_opa(a.conn_dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(a.conn_dot, dg::ground5(), 0);
    lv_obj_clear_flag(a.conn_dot, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(a.conn_dot, LV_ALIGN_RIGHT_MID, -64, 0);

    // Content spans header-bottom to the screen bottom; the footer is drawn
    // over its last 16 px so the terminal can use the whole band.
    a.content = lv_obj_create(a.screen);
    lv_obj_remove_style_all(a.content);
    lv_obj_set_pos(a.content, 0, CONTENT_Y);
    lv_obj_set_size(a.content, SCREEN_W, CONTENT_H);
    lv_obj_clear_flag(a.content, LV_OBJ_FLAG_SCROLLABLE);

    a.footer = lv_obj_create(a.screen);
    lv_obj_remove_style_all(a.footer);
    lv_obj_set_pos(a.footer, 0, SCREEN_H - FOOTER_H);
    lv_obj_set_size(a.footer, SCREEN_W, FOOTER_H);
    lv_obj_set_style_bg_color(a.footer, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(a.footer, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(a.footer, LV_BORDER_SIDE_TOP, 0);
    lv_obj_set_style_border_width(a.footer, 1, 0);
    lv_obj_set_style_border_color(a.footer, dg::ground4(), 0);
    lv_obj_set_style_border_opa(a.footer, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.footer, LV_OBJ_FLAG_SCROLLABLE);
    // Lets touch find the footer buttons' extended hit areas above the band.
    lv_obj_add_flag(a.footer, LV_OBJ_FLAG_OVERFLOW_VISIBLE);

    // Footer text is Montserrat 12: its 15 px line is exactly the band under
    // the hairline.  LVGL offsets children by the parent's border width, so
    // TOP_* with no offset lands them at y=1, rows 1..15.
    a.lbl_footer_l = make_label(a.footer, "", dg::text3(), dg::ui_font_small());
    lv_label_set_long_mode(a.lbl_footer_l, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_footer_l, 168);            // refit by footer_fit_legend()
    lv_obj_align(a.lbl_footer_l, LV_ALIGN_TOP_LEFT, 2, 0);

    a.lbl_footer_r = make_label(a.footer, "", dg::text3(), dg::ui_font_small());
    lv_obj_align(a.lbl_footer_r, LV_ALIGN_TOP_RIGHT, -2, 0);

    // Right-hand action slot: a shrink-to-fit flex row, so buttons pack from
    // the right edge and never collide with the legend.
    a.footer_btns = lv_obj_create(a.footer);
    lv_obj_remove_style_all(a.footer_btns);
    lv_obj_set_height(a.footer_btns, FOOTER_H - 1);           // under the hairline
    lv_obj_set_width(a.footer_btns, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_column(a.footer_btns, 3, 0);
    lv_obj_set_flex_flow(a.footer_btns, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(a.footer_btns, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_clear_flag(a.footer_btns, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_flag(a.footer_btns, LV_OBJ_FLAG_OVERFLOW_VISIBLE);
    // Style-based align (not lv_obj_align) so the row is re-anchored to the
    // right edge every time its content width changes as buttons are added.
    lv_obj_set_pos(a.footer_btns, SCREEN_W - 3, 0);   // repositioned by footer_fit_legend()

    // ---- views ---------------------------------------------------------
    waiting_build(a.content);
    inflight_build(a.content);
    review_build(a.content);
    deep_idle_build(a.content);
    tabs_build(a.content);
    terminal_build(a.content);
    hester_build(a.content);
    pairing_build(a.content);
    files_build(a.content);
    viewer_build(a.content);

    // ---- input ---------------------------------------------------------
    tdeck_bsp_set_key_hook(key_hook, nullptr);
    tdeck_bsp_set_ball_hook(ball_hook, nullptr);
    tdeck_bsp_set_long_press_cb(long_press_cb, nullptr);

    // ---- protocol stack -------------------------------------------------
    a.factory = new dirigible_esp::TransportFactoryEsp();
    a.config  = new dirigible_esp::ConfigNvs();
    a.config->load();
    ESP_LOGI(TAG, "%d machines in NVS", a.config->machineCount());

    a.machines = new dirigible::MachineManager(a.factory);
    a.machines->loadFromConfig(a.config);
    a.machines->onStatusChanged([](const char* name, bool online) {
        ESP_LOGI(TAG, "machine %s: %s", name, online ? "online" : "offline");
    });

    dirigible::EventBus::instance().on(dirigible::Event::ContextUpdated, []() {
        if (auto* c = activeConn()) {
            tabs_render(c->currentContext());
            viewer_on_context(c->currentContext());
        }
    });
    dirigible::EventBus::instance().on(dirigible::Event::ConnectionChanged, []() {
        tabs_render(activeConn() ? activeConn()->currentContext() : nullptr);
        tether_fetch();
        waiting_render();
        inflight_render();
    });
    dirigible::EventBus::instance().on(dirigible::Event::AttentionChanged, []() {
        waiting_render(true);
        inflight_render();
        deep_idle_render();
    });
    dirigible::EventBus::instance().on(dirigible::Event::AttentionAlert, []() {
        waiting_alert();
    });
    dirigible::EventBus::instance().on(dirigible::Event::WindowsChanged, []() {
        if (app().view == View::Tabs) tabs_chrome();
    });

    lv_timer_create(chrome_timer_cb, 2000, nullptr);
    lv_timer_create(ping_timer_cb,  15000, nullptr);

    // ---- boot splash ------------------------------------------------------
    // Covers the chrome for ~1.2 s while everything below sets itself up
    // underneath; does not delay any of it.
    splash_build();

    // ---- first screen ---------------------------------------------------
    if (a.config->machineCount() == 0) {
        pairing_begin();
        return;
    }

    app_show(View::Waiting);

    // Dial the stored machine only once the link is actually up.  connect()
    // spawns a WebSocket task that calls getaddrinfo() immediately, and at
    // this point in boot WiFi has been initialised but has not associated, so
    // dialling here would spend the whole association window failing to
    // resolve.  The state callback is persistent and re-fires on every
    // reconnect, which doubles as the recovery path after the AP drops.
    auto& wifi = dirigible_esp::WifiEsp::instance();
    wifi.onStateChanged([](bool connected, int8_t) {
        if (!connected) return;
        auto* c = activeConn();
        if (c && c->isConnected()) return;   // already up — nothing to redial
        connect_active_machine();
    });

    if (wifi.isConnected()) connect_active_machine();
    else                    app_set_status("waiting for wifi");
}

}  // namespace dirigible_app
