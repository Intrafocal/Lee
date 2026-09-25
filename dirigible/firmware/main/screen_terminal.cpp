/*
 * screen_terminal.cpp — a real character grid over a PTY stream (E3).
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
 * to a key bar.  The size is sent to Lee as
 * {"type":"resize","cols":..,"rows":..} on the PTY WebSocket, which
 * api-server.ts forwards to PtyManager.resize().
 *
 * Key bar.  The T-Deck keyboard has no Esc and no Ctrl, yet a TUI like
 * Claude Code wants them (Esc interrupts, Shift-Tab cycles modes, Ctrl-C
 * quits, Ctrl-D ends input), and Tab for completion.  So the bottom strip
 * carries bordered touch keys for them; arrows are the trackball.  Leaving
 * the terminal is the header's close button or a trackball hold — never a
 * key, since every key belongs to the remote program.
 */

#include <cstdio>
#include <cstring>

#include "app.hpp"
#include "esp_log.h"
#include "tdeck_bsp.h"
#include "theme.hpp"

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

struct BarKey {
    const char* label;
    const char* seq;    // bytes sent to the PTY
};

const BarKey BAR_KEYS[] = {
    { "Esc",    "\x1b"    },
    { "Tab",    "\t"      },
    { "S-Tab",  "\x1b[Z"  },   // back-tab: Claude Code's mode switch
    { "Ctrl-C", "\x03"    },
    { "Ctrl-D", "\x04"    },
};

void bar_key_cb(lv_event_t* e)
{
    const auto* k = (const BarKey*)lv_event_get_user_data(e);
    if (k) pty_send(k->seq, strlen(k->seq));
}

void build_keybar(lv_obj_t* parent)
{
    const int n = (int)(sizeof(BAR_KEYS) / sizeof(BAR_KEYS[0]));
    const int gap = 3;
    const int y = CONTENT_H - KEYBAR_H;
    const int w = (SCREEN_W - 4 - (n - 1) * gap) / n;   // 60 px each

    lv_obj_t* bar = lv_obj_create(parent);
    lv_obj_remove_style_all(bar);
    lv_obj_set_pos(bar, 0, y);
    lv_obj_set_size(bar, SCREEN_W, KEYBAR_H);
    lv_obj_set_style_bg_color(bar, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(bar, LV_BORDER_SIDE_TOP, 0);
    lv_obj_set_style_border_width(bar, 1, 0);
    lv_obj_set_style_border_color(bar, dg::ground4(), 0);
    lv_obj_set_style_border_opa(bar, LV_OPA_COVER, 0);
    lv_obj_clear_flag(bar, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < n; i++) {
        lv_obj_t* b = lv_btn_create(bar);
        lv_obj_remove_style_all(b);
        // Not keyboard-focusable: in the terminal every key goes to the PTY.
        if (lv_obj_get_group(b)) lv_group_remove_obj(b);
        lv_obj_set_pos(b, 2 + i * (w + gap), 1);
        lv_obj_set_size(b, w, KEYBAR_H - 3);
        lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(b, dg::ground3(), 0);
        lv_obj_set_style_bg_color(b, dg::phosphor_deep(), LV_STATE_PRESSED);
        lv_obj_set_style_border_width(b, 1, 0);
        lv_obj_set_style_border_color(b, dg::ground5(), 0);
        lv_obj_set_style_border_opa(b, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(b, DG_RADIUS, 0);
        lv_obj_clear_flag(b, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(b, bar_key_cb, LV_EVENT_CLICKED, (void*)&BAR_KEYS[i]);
        lv_obj_t* l = make_label(b, BAR_KEYS[i].label, dg::text1(), dg::ui_font_small());
        lv_obj_center(l);
    }
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

void terminal_open(int pty_id, const char* label)
{
    auto& a = app();
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

    char buf[48];
    snprintf(buf, sizeof(buf), "%s %dx%d", label ? label : "pty",
             a.vt.cols(), a.vt.rows());
    app_set_status(buf);
    ESP_LOGI(TAG, "opened pty %d (%s)", pty_id, label ? label : "");

    app_show(View::Terminal);
    terminal_repaint();
}

void terminal_close()
{
    auto& a = app();
    if (a.pty) {
        a.pty->disconnect();
        delete a.pty;
        a.pty = nullptr;
    }
    a.active_pty_id = -1;
}

bool terminal_key(uint8_t ascii)
{
    // Every byte goes upstream verbatim, which is the only way typing into a
    // remote shell can work (an Esc, should a keyboard ever send one, is the
    // TUI's too).  Leaving is the header button or a trackball hold.
    char ch = (char)ascii;
    pty_send(&ch, 1);
    return true;
}

void terminal_ball(int dx, int dy, bool click)
{
    // In terminal mode the ball is a d-pad: one detent per arrow key, in the
    // cursor-key (not application-key) encoding, which is what a shell in its
    // default mode expects.
    (void)click;   // the click is deliberately inert here — see the docs
    for (int i = 0; i < (dx > 0 ? dx : -dx); i++) pty_send(dx > 0 ? "\x1b[C" : "\x1b[D", 3);
    for (int i = 0; i < (dy > 0 ? dy : -dy); i++) pty_send(dy > 0 ? "\x1b[B" : "\x1b[A", 3);
}

}  // namespace dirigible_app
