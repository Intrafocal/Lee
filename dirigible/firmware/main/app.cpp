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

#include "brand_images.h"
#include "dirigible/state.hpp"
#include "dirigible_esp/dispatch.hpp"
#include "dirigible_esp/wifi_esp.hpp"
#include "esp_log.h"
#include "tdeck_bsp.h"
#include "theme.hpp"

static const char* TAG = "dirigible.app";

namespace dirigible_app {

App& app()
{
    static App a;
    return a;
}

const lv_font_t* mono_font()
{
    // lv_font_unscii_8 — the ASCII bitmap monospace LVGL ships, enabled via
    // CONFIG_LV_FONT_UNSCII_8 in sdkconfig.defaults.  screenschema exposed the
    // same font as SSFonts::monospace_8().  8 px advance, 9 px line height.
    return &lv_font_unscii_8;
}

const lv_font_t* mono_font_big()
{
    // lv_font_unscii_16 (CONFIG_LV_FONT_UNSCII_16, already enabled): same 8 px
    // advance, 17 px line height.  Used for text entry, where an 9 px glyph on
    // a 2.8" panel is a squint.
    return &lv_font_unscii_16;
}

const lv_font_t* sym_font()
{
    // The unscii fonts are ASCII 0x20-0x7F only — no LV_SYMBOL_* glyphs, no
    // U+2026 '…', no U+00B7 '·'.  Montserrat 14 is the one font in this build
    // (CONFIG_LV_FONT_MONTSERRAT_14, also LV_FONT_DEFAULT) that carries the
    // FontAwesome subset, so anything wanting a glyph uses this and everything
    // else stays plain ASCII.
    return &lv_font_montserrat_14;
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

lv_obj_t* make_label(lv_obj_t* parent, const char* text, lv_color_t colour)
{
    lv_obj_t* l = lv_label_create(parent);
    lv_label_set_text(l, text);
    lv_obj_set_style_text_color(l, colour, 0);
    lv_obj_set_style_text_font(l, mono_font(), 0);
    return l;
}

void chrome_set_title(const char* t)
{
    if (app().lbl_machine && t) lv_label_set_text(app().lbl_machine, t);
}

void chrome_set_centre(const char* t)
{
    if (app().lbl_centre && t) lv_label_set_text(app().lbl_centre, t);
}

void chrome_set_footer(const char* legend, const char* right)
{
    auto& a = app();
    if (legend && a.lbl_footer_l) lv_label_set_text(a.lbl_footer_l, legend);
    if (right  && a.lbl_footer_r) lv_label_set_text(a.lbl_footer_r, right);
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

/// Shrink the key legend so it never runs under the button row.
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
    lv_obj_set_pos(a.footer_btns, SCREEN_W - 2 - btn_w, 0);

    lv_coord_t avail = SCREEN_W - 3 - btn_w - (btn_w ? 6 : 3);
    if (avail < 0) avail = 0;
    lv_obj_set_width(a.lbl_footer_l, avail < 168 ? avail : 168);

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

lv_obj_t* chrome_add_footer_button(const char* text, lv_event_cb_t cb, void* user)
{
    auto& a = app();
    if (!a.footer_btns) return nullptr;
    if (a.lbl_footer_r) lv_obj_add_flag(a.lbl_footer_r, LV_OBJ_FLAG_HIDDEN);

    lv_obj_t* btn = lv_btn_create(a.footer_btns);
    lv_obj_remove_style_all(btn);
    lv_obj_set_height(btn, FOOTER_H - 2);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(btn, dg::ground3(), 0);
    lv_obj_set_style_border_width(btn, 1, 0);
    lv_obj_set_style_border_color(btn, dg::ground4(), 0);
    lv_obj_set_style_border_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(btn, DG_RADIUS, 0);
    lv_obj_set_style_pad_hor(btn, 3, 0);
    lv_obj_set_style_pad_ver(btn, 0, 0);
    dg::style_focus(btn);

    lv_obj_t* l = lv_label_create(btn);
    lv_label_set_text(l, text);
    lv_obj_set_style_text_font(l, mono_font(), 0);
    lv_obj_set_style_text_color(l, dg::text1(), 0);
    lv_obj_center(l);

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
        app_set_status("no machine — tap = for the menu");
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

    lv_label_set_text(a.lbl_machine, m->config.name.c_str());
    ESP_LOGI(TAG, "connecting to %s (%s:%d)", m->config.name.c_str(),
             m->config.host.c_str(), m->config.lee_port);
    char buf[48];
    snprintf(buf, sizeof(buf), "%s:%d", m->config.host.c_str(), m->config.lee_port);
    app_set_status(buf);
}

// ---------------------------------------------------------------------------
// Menu overlay (opened by a trackball long-press)
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
    case 0: app_show(View::Tabs); break;
    case 1: app_show(View::Hester); break;
    case 2: pairing_begin(); break;
    case 3:
        if (auto* c = activeConn()) { c->disconnect(); c->connect(); }
        app_set_status("reconnecting...");
        break;
    default: break;
    }
}

/// Opened from the tab list's back affordance — the tab list is the root, so
/// "back" there means "what else can I do".  Every other view reaches its own
/// parent instead, which is why this is no longer bound to the long-press.
static void menu_open(void*)
{
    auto& a = app();
    if (a.menu) { menu_close(); return; }

    a.menu = lv_list_create(a.screen);
    lv_obj_set_size(a.menu, 180, 120);
    lv_obj_center(a.menu);
    lv_obj_set_style_bg_color(a.menu, dg::ground2(), 0);
    lv_obj_set_style_border_width(a.menu, 1, 0);
    lv_obj_set_style_border_color(a.menu, dg::ground4(), 0);
    lv_obj_set_style_text_font(a.menu, mono_font(), 0);

    static const char* names[] = { "Tabs", "Hester", "Pairing", "Reconnect" };
    for (intptr_t i = 0; i < 4; i++) {
        lv_obj_t* btn = lv_list_add_btn(a.menu, nullptr, names[i]);
        lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(btn, dg::ground3(), 0);
        lv_obj_set_style_text_color(btn, dg::text1(), 0);
        dg::style_focus(btn);
        lv_obj_add_event_cb(btn, menu_item_cb, LV_EVENT_CLICKED, (void*)i);
        if (a.group) lv_group_add_obj(a.group, btn);
    }
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
    case View::Pairing:
        pairing_back();
        return;
    case View::Tabs:
        menu_open(nullptr);
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
    case View::Terminal: return terminal_key(ascii);
    case View::Pairing:  return pairing_key(ascii);
    case View::Hester:
        if (ascii == 0x1B) { app_back(); return true; }
        return false;
    case View::Tabs:
        if (ascii == 0x1B) { app_back(); return true; }
        return false;   // Enter activates the focused list row
    }
    return false;
}

static void ball_hook(int dx, int dy, bool click, void*)
{
    if (app().view == View::Terminal) terminal_ball(dx, dy, click);
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

void app_show(View v)
{
    auto& a = app();
    a.view = v;

    lv_obj_add_flag(a.view_tabs,     LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_terminal, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_hester,   LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_pairing,  LV_OBJ_FLAG_HIDDEN);

    // The ball is a pointer everywhere except the terminal, where it is a
    // d-pad feeding arrow keys to the PTY.
    tdeck_bsp_set_ball_hook(v == View::Terminal ? ball_hook : nullptr, nullptr);

    // Each view owns its legend; pairing replaces the buttons per step.
    if (v != View::Pairing) chrome_clear_footer_buttons();
    chrome_show_footer(v != View::Terminal);

    // The Hester hare only ever shows in the Hester view; every other view
    // gets the title back at its usual x=24, 84 px wide.  Reset here so each
    // case below only has to opt in.
    if (a.hester_icon) lv_obj_add_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);
    if (a.lbl_machine) {
        lv_obj_set_width(a.lbl_machine, 84);
        lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, 24, 0);
    }

    // The back button is the same object everywhere; only its glyph changes,
    // so its position never moves under the thumb.
    switch (v) {
    case View::Tabs:
        lv_obj_clear_flag(a.view_tabs, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph("=");          // root: back opens the menu
        chrome_set_footer("Click open  Hold menu", "tabs");
        break;
    case View::Terminal:
        lv_obj_clear_flag(a.view_terminal, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph("X");          // back here closes the PTY
        chrome_set_footer("Esc/hold exit  ball=arrows", "term");
        break;
    case View::Hester:
        lv_obj_clear_flag(a.view_hester, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph("<");
        chrome_set_footer("Enter ask  Esc tabs", "hester");
        // Make room for the 8x8 hare just left of the title: shift the title
        // from x=24 to x=34 and shrink it by the same 10 px it gave up.
        if (a.hester_icon) lv_obj_clear_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);
        if (a.lbl_machine) {
            lv_obj_set_width(a.lbl_machine, 74);
            lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, 34, 0);
        }
        hester_focus();
        break;
    case View::Pairing:
        lv_obj_clear_flag(a.view_pairing, LV_OBJ_FLAG_HIDDEN);
        chrome_set_back_glyph("<");
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

    lv_obj_t* title = lv_label_create(a.splash);
    lv_label_set_text(title, "DIRIGIBLE");
    lv_obj_set_style_text_font(title, mono_font_big(), 0);
    lv_obj_set_style_text_color(title, dg::phosphor(), 0);
    lv_obj_set_style_text_letter_space(title, 2, 0);
    lv_obj_align(title, LV_ALIGN_CENTER, 0, 26);

    lv_obj_t* sub = lv_label_create(a.splash);
    lv_label_set_text(sub, "searching for lee");
    lv_obj_set_style_text_font(sub, mono_font(), 0);
    lv_obj_set_style_text_color(sub, dg::text3(), 0);
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
                          true, mono_font());

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

    // far left: the always-on back/close button, x 2..19.  Deliberately NOT in
    // the input group's *focus order* by default — pairing and Hester focus
    // their text fields on entry and a button ahead of them in the group
    // steals that focus — but it IS added to the group (task: give it the
    // focus style) so Tab can still reach it; touch, the trackball pointer,
    // ESC and a long-press all reach it regardless.
    a.back_btn = lv_btn_create(a.header);
    lv_obj_remove_style_all(a.back_btn);
    lv_obj_set_size(a.back_btn, 18, HEADER_H - 2);
    lv_obj_set_pos(a.back_btn, 2, 1);
    lv_obj_set_style_bg_opa(a.back_btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(a.back_btn, dg::ground3(), 0);
    lv_obj_set_style_bg_color(a.back_btn, dg::ground3(), LV_STATE_PRESSED);
    lv_obj_set_style_radius(a.back_btn, DG_RADIUS, 0);
    dg::style_focus(a.back_btn);
    lv_obj_add_event_cb(a.back_btn, back_btn_cb, LV_EVENT_CLICKED, nullptr);
    if (a.group) lv_group_add_obj(a.group, a.back_btn);

    a.back_lbl = lv_label_create(a.back_btn);
    lv_label_set_text(a.back_lbl, "<");
    lv_obj_set_style_text_font(a.back_lbl, mono_font(), 0);
    lv_obj_set_style_text_color(a.back_lbl, dg::text1(), 0);
    lv_obj_center(a.back_lbl);

    // left: title, x 24..107.  Clipped to 10 chars so it can never run into
    // the centre slot, which starts at x=112.
    a.lbl_machine = make_label(a.header, "Dirigible", dg::text1());
    lv_label_set_long_mode(a.lbl_machine, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_machine, 84);
    lv_obj_align(a.lbl_machine, LV_ALIGN_LEFT_MID, 24, 0);

    // Hester's hare, 8x8, shown only while the Hester view is focused — see
    // app_show().  Sits in the same 24..32 slot the title vacates for it.
    a.hester_icon = lv_img_create(a.header);
    lv_img_set_src(a.hester_icon, &dg_img_hester8);
    lv_obj_align(a.hester_icon, LV_ALIGN_LEFT_MID, 24, 0);
    lv_obj_add_flag(a.hester_icon, LV_OBJ_FLAG_HIDDEN);

    // centre: step / status.  x 112..239 (128 px, 16 chars).
    a.lbl_centre = make_label(a.header, "", dg::text2());
    lv_label_set_long_mode(a.lbl_centre, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_centre, 128);
    lv_obj_set_style_text_align(a.lbl_centre, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(a.lbl_centre, LV_ALIGN_LEFT_MID, 112, 0);

    // right: battery %, wifi glyph, link dot.  Laid out from the right edge.
    a.lbl_battery = make_label(a.header, "", dg::text3());
    lv_obj_align(a.lbl_battery, LV_ALIGN_RIGHT_MID, -4, 0);   // 4 chars = 32 px

    a.lbl_wifi = lv_label_create(a.header);
    lv_label_set_text(a.lbl_wifi, LV_SYMBOL_WIFI);
    lv_obj_set_style_text_font(a.lbl_wifi, sym_font(), 0);
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

    a.lbl_footer_l = make_label(a.footer, "", dg::text3());
    lv_label_set_long_mode(a.lbl_footer_l, LV_LABEL_LONG_DOT);
    lv_obj_set_width(a.lbl_footer_l, 168);            // 21 chars
    lv_obj_align(a.lbl_footer_l, LV_ALIGN_LEFT_MID, 3, 0);

    a.lbl_footer_r = make_label(a.footer, "", dg::text3());
    lv_obj_align(a.lbl_footer_r, LV_ALIGN_RIGHT_MID, -3, 0);

    // Right-hand action slot: a shrink-to-fit flex row, so buttons pack from
    // the right edge and never collide with the legend.
    a.footer_btns = lv_obj_create(a.footer);
    lv_obj_remove_style_all(a.footer_btns);
    lv_obj_set_height(a.footer_btns, FOOTER_H);
    lv_obj_set_width(a.footer_btns, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_column(a.footer_btns, 3, 0);
    lv_obj_set_flex_flow(a.footer_btns, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(a.footer_btns, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER,
                          LV_FLEX_ALIGN_CENTER);
    lv_obj_clear_flag(a.footer_btns, LV_OBJ_FLAG_SCROLLABLE);
    // Style-based align (not lv_obj_align) so the row is re-anchored to the
    // right edge every time its content width changes as buttons are added.
    lv_obj_set_pos(a.footer_btns, SCREEN_W - 2, 0);   // repositioned by footer_fit_legend()

    // ---- views ---------------------------------------------------------
    tabs_build(a.content);
    terminal_build(a.content);
    hester_build(a.content);
    pairing_build(a.content);

    // ---- input ---------------------------------------------------------
    tdeck_bsp_set_key_hook(key_hook, nullptr);
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
        if (auto* c = activeConn()) tabs_render(c->currentContext());
    });
    dirigible::EventBus::instance().on(dirigible::Event::ConnectionChanged, []() {
        tabs_render(activeConn() ? activeConn()->currentContext() : nullptr);
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

    app_show(View::Tabs);

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
