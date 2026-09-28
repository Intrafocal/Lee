/*
 * screen_terminal.cpp — a tab's view: a real character grid over a PTY
 * stream (E3), and the compose line you write into it with (plan 2026-09-28
 * §4.6).
 *
 * The old screenschema handler appended PTY bytes to one wrapping label and
 * stripped CSI sequences with a regex-ish loop, so anything that moved the
 * cursor (a prompt redraw, lazygit, htop) turned into noise.  This view keeps
 * a COLS x ROWS cell buffer in VtScreen and paints one LVGL label per row, so
 * cursor addressing, erases and scrolling land where they should.
 *
 * Rendering (E15).  Each row is one LVGL label in recolour mode, fed the
 * markup VtScreen::rowMarkup() builds from the cell attributes, so ANSI
 * foreground colour survives the trip.  Only rows VtScreen marked dirty are
 * re-set: at 24 rows of ~400-byte markup, repainting the lot every 60 ms was
 * most of the LVGL frame budget.  A translucent block follows the cursor,
 * which a character grid otherwise has no way to show.
 *
 * Grid size is measured, not assumed: the lifted monospace font is
 * lv_font_unscii_8, whose advance width LVGL reports at run time, so the same
 * code gives the right COLSxROWS if the font is ever swapped.  On a T-Deck
 * that works out at 320/8 = 40 columns and (220-22)/9 = 22 rows — the view
 * claims the whole content band, footer included, and gives its bottom 22 px
 * to the compose line or the key bar.  The size is sent to Lee as
 * {"type":"resize","cols":..,"rows":..} on the PTY WebSocket, which
 * api-server.ts forwards to PtyManager.resize().
 *
 * Two modes share that bottom strip:
 *
 *   Compose (the default for agents and shells).  Typing fills a local
 *   buffer, a text box that grows upward over the grid to four lines; the
 *   ball moves its caret.  Nothing reaches the tab until you send it, and
 *   then it goes as one piece through Lee's POST /tether/send, which pastes
 *   it (bracketed where the program asked, so Claude Code takes a multi-line
 *   message whole):
 *
 *     Enter     Send: the text, then Enter in the tab.  An empty buffer
 *               sends a bare Enter over the PTY.
 *     Deliver   the touch button: the text without Enter, for you to finish.
 *     newline   a line feed from the keypad (0x0A) adds a line.  The stock
 *               keypad firmware resolves Shift and Alt itself and reports no
 *               modifiers, so Shift+Enter and Alt+Enter arrive as whatever
 *               byte it chose; an LF is a newline, a CR is Send.
 *
 *   Keys (the default for other TUIs: lazygit, k9s).  Every byte goes
 *   upstream verbatim and the ball is a d-pad, as before.  The bar carries
 *   bordered touch keys for what the keyboard lacks: Esc (Claude Code's
 *   interrupt), Tab, Shift-Tab (its mode switch), Ctrl-C, Ctrl-D.
 *
 * The trackball click toggles between them (every letter belongs to the
 * buffer or the program, so no letter can), and so do the Keys / Type
 * buttons on the strip.  The mode is remembered per tab until reboot.
 * Leaving is the header's close button or a trackball hold — never a key.
 */

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>

#include "app.hpp"
#include "esp_log.h"
#include "tdeck_bsp.h"
#include "theme.hpp"
#include "voice_input.hpp"

static const char* TAG = "dirigible.term";

namespace dirigible_app {

namespace {

void repaint_timer_cb(lv_timer_t*)
{
    if (app().view == View::Terminal) terminal_repaint();
}

void pty_send(const char* s, size_t n)
{
    auto& a = app();
    if (a.pty && a.pty->isConnected()) a.pty->sendInput(s, n);
}

constexpr int KEYBAR_H = 22;
constexpr int STRIP_Y  = CONTENT_H - KEYBAR_H;     // 198
constexpr int COMPOSE_MAX   = 4000;                // Lee takes 20 000; the keyboard won't
constexpr int COMPOSE_LINES = 4;                   // the box grows to this, then scrolls
constexpr int TA_PAD   = 2;
constexpr int BTN_GAP  = 3;

struct BarKey {
    const char* label;
    const char* seq;    // bytes sent to the PTY; null: back to compose
};

const BarKey BAR_KEYS[] = {
    { "Esc",    "\x1b"    },
    { "Tab",    "\t"      },
    { "S-Tab",  "\x1b[Z"  },   // back-tab: Claude Code's mode switch
    { "Ctrl-C", "\x03"    },
    { "Ctrl-D", "\x04"    },
    { "Type",   nullptr   },   // compose
};

struct Compose {
    lv_obj_t* keybar  = nullptr;
    lv_obj_t* strip   = nullptr;
    lv_obj_t* ta      = nullptr;
    lv_obj_t* mic     = nullptr;
    lv_obj_t* mic_lbl = nullptr;
    int       ta_w    = 0;

    bool        on = true;         // compose; false = keys
    std::string type;              // the Lee tab type
    std::string label;
    int         draft_pty = -1;    // the tab the buffer was typed for
    bool        busy = false;      // a send is in flight
    bool        voiced = false;    // the buffer holds a transcript
    std::map<int, bool> keys_for;  // pty -> keys mode, chosen this boot
};

Compose& cs()
{
    static Compose c;
    return c;
}

dirigible::LeeConnection* conn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
}

void status(const char* text)
{
    if (app().view == View::Terminal) chrome_set_centre(text);
}

// ---------------------------------------------------------------------------
// Keys mode
// ---------------------------------------------------------------------------

void set_mode(bool compose);

void bar_key_cb(lv_event_t* e)
{
    const auto* k = (const BarKey*)lv_event_get_user_data(e);
    if (!k) return;
    if (!k->seq) { set_mode(true); return; }
    pty_send(k->seq, strlen(k->seq));
}

lv_obj_t* strip(lv_obj_t* parent)
{
    lv_obj_t* bar = lv_obj_create(parent);
    lv_obj_remove_style_all(bar);
    lv_obj_set_pos(bar, 0, STRIP_Y);
    lv_obj_set_size(bar, SCREEN_W, KEYBAR_H);
    lv_obj_set_style_bg_color(bar, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(bar, LV_BORDER_SIDE_TOP, 0);
    lv_obj_set_style_border_width(bar, 1, 0);
    lv_obj_set_style_border_color(bar, dg::ground4(), 0);
    lv_obj_set_style_border_opa(bar, LV_OPA_COVER, 0);
    lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);
    return bar;
}

lv_obj_t* bar_button(lv_obj_t* bar, int x, int w, const char* text, bool primary,
                     lv_event_cb_t cb, void* user, lv_obj_t** lbl_out = nullptr)
{
    lv_obj_t* b = lv_btn_create(bar);
    lv_obj_remove_style_all(b);
    // Not keyboard-focusable: the keys belong to the buffer or the PTY.
    if (lv_obj_get_group(b)) lv_group_remove_obj(b);
    lv_obj_set_pos(b, x, 1);
    lv_obj_set_size(b, w, KEYBAR_H - 3);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(b, primary ? dg::phosphor() : dg::ground3(), 0);
    lv_obj_set_style_bg_color(b, primary ? dg::phosphor_hi() : dg::phosphor_deep(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(b, primary ? 0 : 1, 0);
    lv_obj_set_style_border_color(b, dg::ground5(), 0);
    lv_obj_set_style_border_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(b, DG_RADIUS, 0);
    lv_obj_clear_flag(b, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_ext_click_area(b, 2);
    lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, user);
    lv_obj_t* l = make_label(b, text, primary ? dg::on_phosphor() : dg::text1(), dg::ui_font_small());
    lv_obj_center(l);
    if (lbl_out) *lbl_out = l;
    return b;
}

void build_keybar(lv_obj_t* parent)
{
    auto& c = cs();
    const int n = (int)(sizeof(BAR_KEYS) / sizeof(BAR_KEYS[0]));
    const int w = (SCREEN_W - 4 - (n - 1) * BTN_GAP) / n;   // 50 px each

    c.keybar = strip(parent);
    for (int i = 0; i < n; i++) {
        bar_button(c.keybar, 2 + i * (w + BTN_GAP), w, BAR_KEYS[i].label, false,
                   bar_key_cb, (void*)&BAR_KEYS[i]);
    }
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

/// Grow the box upward with its text, one to COMPOSE_LINES lines.
void fit_box()
{
    auto& c = cs();
    if (!c.ta) return;
    const lv_font_t* f = dg::ui_font_italic();
    const int line_h = lv_font_get_line_height(f);
    const char* text = lv_textarea_get_text(c.ta);
    lv_point_t size = { 0, 0 };
    if (text && *text) {
        lv_txt_get_size(&size, text, f, 0, 0, c.ta_w - 2 * TA_PAD - 4, LV_TEXT_FLAG_NONE);
    }
    int lines = std::max(1, (int)((size.y + line_h - 1) / line_h));
    // A trailing newline starts a line lv_txt_get_size does not count.
    if (text && *text && text[strlen(text) - 1] == '\n') lines++;
    lines = std::min(lines, COMPOSE_LINES);
    const int h = lines * line_h + 2 * TA_PAD + 2;
    lv_obj_set_height(c.ta, h);
    lv_obj_set_y(c.ta, CONTENT_H - 1 - h);
}

void ta_event(lv_event_t*)
{
    fit_box();
}

void send(bool submit)
{
    auto& c = cs();
    auto& a = app();
#if CONFIG_DIRIGIBLE_VOICE
    if (voice::busy()) return;
#endif
    const char* raw = lv_textarea_get_text(c.ta);
    const std::string text = raw ? raw : "";
    if (text.empty()) {
        // Enter on an empty line is still Enter: confirm a prompt, run the
        // shell's last line.  Deliver has nothing to deliver.
        if (submit) pty_send("\r", 1);
        else        status("nothing to deliver");
        return;
    }
    if (c.busy) return;
    auto* lc = conn();
    if (!lc || !lc->isConnected()) { status("not connected"); return; }

    c.busy = true;
    status(submit ? "sending..." : "delivering...");
    const int pty = a.active_pty_id;
    lc->tetherSend(pty, c.label, c.type.c_str(), text, submit, c.voiced,
                   [submit, pty](const dirigible::SendOutcome& r) {
        auto& c = cs();
        c.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "send: %d %s", r.status, r.error.c_str());
            // Keep the text for another try (or for Keys mode, on a Lee too
            // old to take a send).
            if (app().active_pty_id == pty) status(dirigible::send_error_text(r).c_str());
            return;
        }
        if (c.draft_pty == pty) {
            lv_textarea_set_text(c.ta, "");
            c.voiced = false;
            fit_box();
        }
        if (app().active_pty_id == pty) status(submit ? "sent" : "delivered: not submitted");
    });
}

void send_cb(lv_event_t*)    { send(true); }
void deliver_cb(lv_event_t*) { send(false); }
void keys_cb(lv_event_t*)    { set_mode(false); }

#if CONFIG_DIRIGIBLE_VOICE
void mic_label()
{
    auto& c = cs();
    if (!c.mic_lbl) return;
    lv_label_set_text(c.mic_lbl, voice::button_label());
    lv_obj_set_style_text_color(c.mic_lbl, voice::recording() ? dg::ember() : dg::text1(), 0);
}

void mic_visible()
{
    auto& c = cs();
    if (!c.mic) return;
    if (voice::available()) lv_obj_clear_flag(c.mic, LV_OBJ_FLAG_HIDDEN);
    else                    lv_obj_add_flag(c.mic, LV_OBJ_FLAG_HIDDEN);
}

void mic_cb(lv_event_t*)
{
    auto& c = cs();
    if (voice::recording()) { voice::stop(); mic_label(); return; }
    if (voice::busy() || !c.on) return;
    const int pty = app().active_pty_id;
    const bool ok = voice::start(dirigible::VoicePurpose::Send, "",
        [pty](bool ok, const std::string& text) {
            auto& c = cs();
            mic_label();
            if (app().active_pty_id != pty) return;
            if (!ok) { status(text.c_str()); return; }
            voice::fill(c.ta, text);
            c.voiced = true;
            fit_box();
            status("check it, then Enter");   // voice never sends
        },
        [](int ms) { status(voice::elapsed_text(ms).c_str()); });
    if (ok) mic_label();
}
#endif

void build_compose(lv_obj_t* parent)
{
    auto& c = cs();
    c.strip = strip(parent);

    // Right to left: Send (the one next step), Deliver, Keys, and the mic
    // when voice is built in.  The box takes the rest.
    const int w_send = 42, w_deliver = 50, w_keys = 36;
    int x = SCREEN_W - 2 - w_send;
    bar_button(c.strip, x, w_send, "Send", true, send_cb, nullptr);
    x -= BTN_GAP + w_deliver;
    bar_button(c.strip, x, w_deliver, "Deliver", false, deliver_cb, nullptr);
    x -= BTN_GAP + w_keys;
    bar_button(c.strip, x, w_keys, "Keys", false, keys_cb, nullptr);
#if CONFIG_DIRIGIBLE_VOICE
    const int w_mic = 24;
    x -= BTN_GAP + w_mic;
    c.mic = bar_button(c.strip, x, w_mic, voice::MIC_LABEL, false, mic_cb, nullptr, &c.mic_lbl);
    lv_obj_set_style_text_font(c.mic_lbl, dg::ui_font(), 0);
    lv_obj_add_flag(c.mic, LV_OBJ_FLAG_HIDDEN);
#endif
    c.ta_w = x - BTN_GAP - 2;

    // The box is the view's child, not the strip's, so it can grow up over
    // the grid while you write.  Your words, so the writing face.
    c.ta = lv_textarea_create(parent);
    lv_textarea_set_one_line(c.ta, false);   // LF adds a line; CR is caught and sends
    lv_textarea_set_max_length(c.ta, COMPOSE_MAX);
    lv_textarea_set_placeholder_text(c.ta, "Enter sends");
    lv_obj_set_width(c.ta, c.ta_w);
    lv_obj_set_x(c.ta, 2);
    lv_obj_set_style_text_font(c.ta, dg::ui_font_italic(), 0);
    lv_obj_set_style_text_color(c.ta, dg::text1(), 0);
    lv_obj_set_style_text_color(c.ta, dg::text3(), LV_PART_TEXTAREA_PLACEHOLDER);
    lv_obj_set_style_bg_color(c.ta, dg::ground3(), 0);
    lv_obj_set_style_bg_opa(c.ta, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(c.ta, 1, 0);
    lv_obj_set_style_border_color(c.ta, dg::ground4(), 0);
    lv_obj_set_style_radius(c.ta, DG_RADIUS, 0);
    lv_obj_set_style_pad_hor(c.ta, 4, 0);
    lv_obj_set_style_pad_ver(c.ta, TA_PAD, 0);
    lv_obj_set_style_text_line_space(c.ta, 0, 0);
    dg::style_input_focus(c.ta);
    if (lv_obj_get_group(c.ta)) lv_group_remove_obj(c.ta);
    lv_obj_add_event_cb(c.ta, ta_event, LV_EVENT_VALUE_CHANGED, nullptr);
    fit_box();
}

/// Show one mode's strip and route the keyboard to match.
void set_mode(bool compose)
{
    auto& c = cs();
    auto& a = app();
#if CONFIG_DIRIGIBLE_VOICE
    if (!compose && voice::busy()) voice::cancel();
#endif
    c.on = compose;
    if (a.active_pty_id >= 0) c.keys_for[a.active_pty_id] = !compose;
    if (compose) {
        lv_obj_add_flag(c.keybar, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(c.strip, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(c.ta, LV_OBJ_FLAG_HIDDEN);
        lv_obj_move_foreground(c.ta);
        if (a.group) {
            lv_group_add_obj(a.group, c.ta);
            lv_group_focus_obj(c.ta);
        }
#if CONFIG_DIRIGIBLE_VOICE
        mic_visible();
        voice::refresh([] { mic_visible(); });
#endif
    } else {
        if (lv_obj_get_group(c.ta)) lv_group_remove_obj(c.ta);
        lv_obj_clear_state(c.ta, LV_STATE_FOCUSED);
        lv_obj_add_flag(c.ta, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(c.strip, LV_OBJ_FLAG_HIDDEN);
        lv_obj_clear_flag(c.keybar, LV_OBJ_FLAG_HIDDEN);
    }
    char buf[48];
    snprintf(buf, sizeof(buf), "%s  %s", c.label.c_str(), compose ? "compose" : "keys");
    status(buf);
}

}  // namespace

void terminal_build(lv_obj_t* parent)
{
    auto& a = app();

    a.view_terminal = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_terminal);
    lv_obj_set_pos(a.view_terminal, 0, 0);
    lv_obj_set_size(a.view_terminal, SCREEN_W, CONTENT_H);
    lv_obj_set_style_bg_color(a.view_terminal, dg::ground0(), 0);
    lv_obj_set_style_bg_opa(a.view_terminal, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_terminal, LV_OBJ_FLAG_SCROLLABLE);

    const lv_font_t* f = dg::mono_font();   // the grid: stays monospace
    a.term_char_w = lv_font_get_glyph_width(f, 'M', 'M');
    if (a.term_char_w <= 0) a.term_char_w = 6;
    a.term_line_h = lv_font_get_line_height(f);
    if (a.term_line_h <= 0) a.term_line_h = 8;

    int cols = SCREEN_W / a.term_char_w;
    int rows = (CONTENT_H - KEYBAR_H) / a.term_line_h;
    a.vt.resize(cols, rows);
    cols = a.vt.cols();
    rows = a.vt.rows();

    a.term_rows.reserve(rows);
    for (int r = 0; r < rows; r++) {
        lv_obj_t* l = lv_label_create(a.view_terminal);
        lv_label_set_long_mode(l, LV_LABEL_LONG_CLIP);
        lv_obj_set_pos(l, 0, r * a.term_line_h);
        lv_obj_set_size(l, SCREEN_W, a.term_line_h);
        lv_obj_set_style_text_font(l, f, 0);
        lv_obj_set_style_text_color(l, dg::text1(), 0);
        // Colour arrives per span in the text itself; the style colour above
        // is only the fallback for a row that carries no markup.
        lv_label_set_recolor(l, true);
        lv_label_set_text(l, "");
        a.term_rows.push_back(l);
    }

    // Cursor block, drawn over the grid.  Translucent so the character under
    // it stays readable, and non-clickable so it never eats a tap.
    a.term_cursor = lv_obj_create(a.view_terminal);
    lv_obj_remove_style_all(a.term_cursor);
    lv_obj_set_size(a.term_cursor, a.term_char_w, a.term_line_h);
    lv_obj_set_style_bg_color(a.term_cursor, dg::lit(), 0);
    lv_obj_set_style_bg_opa(a.term_cursor, LV_OPA_40, 0);
    lv_obj_clear_flag(a.term_cursor, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(a.term_cursor, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_pos(a.term_cursor, 0, 0);

    build_keybar(a.view_terminal);
    build_compose(a.view_terminal);   // after the grid: the box draws over it

    ESP_LOGI(TAG, "grid %dx%d (glyph %dx%d)", cols, rows,
             a.term_char_w, a.term_line_h);

    lv_timer_create(repaint_timer_cb, 60, nullptr);
    lv_obj_add_flag(a.view_terminal, LV_OBJ_FLAG_HIDDEN);
}

void terminal_repaint()
{
    auto& a = app();

    // The cursor moves on sequences that dirty no row at all (a bare CUP), so
    // it is repositioned outside the dirty check.
    if (a.term_cursor) {
        lv_obj_set_pos(a.term_cursor, a.vt.cursorCol() * a.term_char_w,
                       a.vt.cursorRow() * a.term_line_h);
    }

    if (!a.vt.dirty()) return;
    for (int r = 0; r < a.vt.rows() && r < (int)a.term_rows.size(); r++) {
        if (!a.vt.rowDirty(r)) continue;
        lv_label_set_text(a.term_rows[r], a.vt.rowMarkup(r));
    }
    a.vt.clearDirty();
}

void terminal_open(int pty_id, const char* label, const char* type)
{
    auto& a = app();
    auto& c = cs();
    terminal_close();

    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    if (!m) return;

    a.vt.reset();
    a.active_pty_id = pty_id;
    a.pty = new dirigible::PTYClient(a.factory, m->config.host,
                                     m->config.lee_port, pty_id, m->token);
    a.pty->onData([](const uint8_t* data, size_t len) {
        app().vt.feed(data, len);
    });
    a.pty->onExit([](int code) {
        char buf[32];
        snprintf(buf, sizeof(buf), "pty exited (%d)", code);
        app_set_status(buf);
    });
    a.pty->connect();
    // Latest-wins state; PTYClient replays it from its onConnect hook once the
    // socket is actually open.
    a.pty->sendResize(a.vt.cols(), a.vt.rows());

    c.label = label ? label : "pty";
    c.type  = type ? type : "";
    // A buffer typed for another tab doesn't follow you into this one.
    if (c.draft_pty != pty_id) {
        lv_textarea_set_text(c.ta, "");
        c.voiced = false;
        c.draft_pty = pty_id;
    }
    ESP_LOGI(TAG, "opened pty %d (%s) %dx%d", pty_id, c.label.c_str(), a.vt.cols(), a.vt.rows());

    app_show(View::Terminal);
    // Agents and shells open in compose; other TUIs in keys.  Whatever you
    // last chose for this tab wins.
    auto it = c.keys_for.find(pty_id);
    const bool keys = it != c.keys_for.end() ? it->second
                                             : strcmp(dirigible::tether_tab_kind(c.type.c_str()), "tui") == 0;
    set_mode(!keys);
    fit_box();
    terminal_repaint();
}

void terminal_close()
{
    auto& a = app();
    auto& c = cs();
#if CONFIG_DIRIGIBLE_VOICE
    if (voice::busy()) voice::cancel();
#endif
    if (a.pty) {
        a.pty->disconnect();
        delete a.pty;
        a.pty = nullptr;
    }
    a.active_pty_id = -1;
    if (c.ta && lv_obj_get_group(c.ta)) lv_group_remove_obj(c.ta);
}

bool terminal_key(uint8_t ascii)
{
    auto& c = cs();
    if (!c.on) {
        // Keys: every byte goes upstream verbatim, which is the only way
        // typing into a remote TUI can work (an Esc, should a keyboard ever
        // send one, is the TUI's too).
        char ch = (char)ascii;
        pty_send(&ch, 1);
        return true;
    }
#if CONFIG_DIRIGIBLE_VOICE
    if (voice::recording()) {
        // Enter stops and transcribes; Backspace throws the clip away.
        if (ascii == '\r' || ascii == '\n') voice::stop();
        else if (ascii == 0x08 || ascii == 0x7F) voice::cancel();
        mic_label();
        return true;
    }
#endif
    switch (ascii) {
    case '\r': send(true); return true;               // Send
    case 0x1B: pty_send("\x1b", 1); return true;      // still the program's interrupt
    case '\t': return true;                           // not a focus move
    default:   return false;                          // the box types (LF adds a line)
    }
}

void terminal_ball(int dx, int dy, bool click)
{
    auto& c = cs();
    if (click) { set_mode(!c.on); return; }
    if (c.on) {
        // Compose: the ball walks the caret through the buffer.
        for (int i = 0; i < std::abs(dx); i++) {
            if (dx > 0) lv_textarea_cursor_right(c.ta);
            else        lv_textarea_cursor_left(c.ta);
        }
        for (int i = 0; i < std::abs(dy); i++) {
            if (dy > 0) lv_textarea_cursor_down(c.ta);
            else        lv_textarea_cursor_up(c.ta);
        }
        return;
    }
    // Keys: the ball is a d-pad, one detent per arrow key, in the cursor-key
    // (not application-key) encoding, which is what a shell in its default
    // mode expects.
    for (int i = 0; i < (dx > 0 ? dx : -dx); i++) pty_send(dx > 0 ? "\x1b[C" : "\x1b[D", 3);
    for (int i = 0; i < (dy > 0 ? dy : -dy); i++) pty_send(dy > 0 ? "\x1b[B" : "\x1b[A", 3);
}

}  // namespace dirigible_app
