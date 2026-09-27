#pragma once

#include <string>
#include <vector>

#include "lvgl.h"

#include "dirigible/hester_client.hpp"
#include "dirigible/lee_client.hpp"
#include "dirigible/machine.hpp"
#include "dirigible/pty_client.hpp"
#include "dirigible_esp/config_nvs.hpp"
#include "dirigible_esp/transport_esp.hpp"
#include "vt.hpp"

namespace dirigible_app {

// ---------------------------------------------------------------------------
// Chrome geometry.  320x240 landscape, keyboard at the bottom.
//
//   y   0..19    header    title | centre status | battery + link dot
//   y  20..223   body      every view except the terminal
//   y 224..239   footer    per-screen key legend (overlay; hidden in the
//                          terminal so its grid keeps every row)
//
// The terminal view is the exception: it is CONTENT_H tall (it runs under the
// footer band) so the character grid keeps its full height, and the footer is
// only drawn over it while the menu is open.
// ---------------------------------------------------------------------------
inline constexpr int SCREEN_W = 320;
inline constexpr int SCREEN_H = 240;
inline constexpr int HEADER_H = 20;
inline constexpr int FOOTER_H = 16;
inline constexpr int CONTENT_Y = HEADER_H;
inline constexpr int CONTENT_H = SCREEN_H - HEADER_H;          // 220
inline constexpr int BODY_H    = CONTENT_H - FOOTER_H;         // 204

// Pairing body split: a 184 px interactive column and a 128 px summary card,
// with a 4 px gutter and 2 px screen margins (2+184+4+128+2 = 320).
inline constexpr int PAIR_CHIP_H  = 18;
inline constexpr int PAIR_ROW_Y   = PAIR_CHIP_H + 2;           // 20
inline constexpr int PAIR_ROW_H   = BODY_H - PAIR_ROW_Y;       // 184
inline constexpr int PAIR_LEFT_X  = 2;
inline constexpr int PAIR_LEFT_W  = 184;
inline constexpr int PAIR_CARD_X  = PAIR_LEFT_X + PAIR_LEFT_W + 4;   // 190
inline constexpr int PAIR_CARD_W  = SCREEN_W - PAIR_CARD_X - 2;      // 128

enum class View { Waiting, InFlight, Library, Tabs, Terminal, Hester, Pairing, Files, Viewer, DeepIdle };

// ---------------------------------------------------------------------------
// Everything the firmware owns.  One instance, built on the LVGL task.
// ---------------------------------------------------------------------------
struct App {
    // --- transport / protocol ------------------------------------------
    dirigible_esp::TransportFactoryEsp* factory  = nullptr;
    dirigible_esp::ConfigNvs*           config   = nullptr;
    dirigible::MachineManager*          machines = nullptr;
    dirigible::PTYClient*               pty      = nullptr;
    dirigible::HesterClient*            hester   = nullptr;

    int active_pty_id = -1;

    // --- chrome ---------------------------------------------------------
    lv_obj_t* screen        = nullptr;
    lv_obj_t* header        = nullptr;
    lv_obj_t* back_btn      = nullptr;   // header left: always-on back/close
    lv_obj_t* back_lbl      = nullptr;
    lv_obj_t* lbl_machine   = nullptr;   // header left: title
    lv_obj_t* hester_icon   = nullptr;   // header left: dg_img_hester8, Hester view only
    lv_obj_t* lbl_centre    = nullptr;   // header centre: step / status
    lv_obj_t* conn_dot      = nullptr;   // header right: link state dot
    lv_obj_t* lbl_wifi      = nullptr;   // header right: wifi glyph
    lv_obj_t* lbl_battery   = nullptr;
    lv_obj_t* content       = nullptr;
    lv_obj_t* footer        = nullptr;
    lv_obj_t* lbl_footer_l  = nullptr;   // key legend
    lv_obj_t* lbl_footer_r  = nullptr;   // right-hand hint
    lv_obj_t* footer_btns   = nullptr;   // right-hand action buttons
    lv_obj_t* splash        = nullptr;   // boot splash overlay, nullptr once dismissed
    lv_group_t* group       = nullptr;

    // --- views ----------------------------------------------------------
    lv_obj_t* view_waiting  = nullptr;
    lv_obj_t* view_tabs     = nullptr;
    lv_obj_t* view_terminal = nullptr;
    lv_obj_t* view_hester   = nullptr;
    lv_obj_t* view_pairing  = nullptr;
    lv_obj_t* view_files    = nullptr;
    lv_obj_t* view_viewer   = nullptr;
    lv_obj_t* view_inflight = nullptr;
    lv_obj_t* view_library  = nullptr;
    lv_obj_t* view_deep_idle = nullptr;
    lv_obj_t* menu          = nullptr;   // overlay, nullptr when closed

    View view = View::Waiting;

    // --- tab list -------------------------------------------------------
    lv_obj_t*        tab_list = nullptr;
    std::vector<int> tab_ids;

    // --- terminal -------------------------------------------------------
    VtScreen               vt;
    std::vector<lv_obj_t*> term_rows;
    lv_obj_t*              term_cursor = nullptr;
    int term_char_w = 6;
    int term_line_h = 8;

    // --- hester ---------------------------------------------------------
    lv_obj_t*   hester_input  = nullptr;
    lv_obj_t*   hester_output = nullptr;
    std::string hester_session;
    std::string hester_phases;
    bool        hester_busy = false;

    // --- pairing --------------------------------------------------------
    lv_obj_t*   pair_body      = nullptr;   // left column, rebuilt per step
    lv_obj_t*   pair_chip[4]   = { nullptr, nullptr, nullptr, nullptr };
    lv_obj_t*   pair_chip_lbl[4] = { nullptr, nullptr, nullptr, nullptr };
    lv_obj_t*   pair_chip_tick[4] = { nullptr, nullptr, nullptr, nullptr };
    lv_obj_t*   pair_card      = nullptr;   // persistent summary panel
    lv_obj_t*   pair_card_col  = nullptr;   // card rows, rebuilt by card_update()
    lv_obj_t*   pair_input     = nullptr;
    lv_obj_t*   pair_meter     = nullptr;   // token n/36 or password hint
    int         pair_step      = 0;
    int         pair_gen    = 0;   // bumped on every body rebuild; async
                                    // scan/discovery results check it before
                                    // touching widgets that may be gone
    std::string pair_ssid;
    std::string pair_host;
    int         pair_port   = 9001;
    int         pair_hester_port = 9000;
    std::string pair_name;
    std::string pair_ws;        // workspace basename from the mDNS ws= TXT
    std::string pair_ip;        // device IP once WiFi is up
    int         pair_rssi   = 0;
    std::string pair_error;     // shown in red in the summary card
    std::string pair_device_id; // from the grant; shown in the summary card
};

App& app();

// Lifecycle -----------------------------------------------------------------
void app_start();                 // builds the chrome and every view
void app_show(View v);

/// The one way out of wherever you are.  Closes the menu if it is open,
/// otherwise steps the current view back: the terminal drops its PTY and
/// returns to the tab list, Hester and pairing unwind, the tab list returns to
/// Waiting, and Waiting (which has nowhere further back once its reply/capture
/// box or an opened finished turn is closed) opens the menu.
///
/// Two things call this and they must stay in agreement: the header's
/// on-screen button and a trackball long-press.  (The T-Deck keyboard has no
/// Esc; a 0x1B byte, should another keyboard send one, is only a silent alias.)
void app_back();

// Chrome ---------------------------------------------------------------------
// One header/footer pair is shared by all four views; each view sets its own
// title, centre status and key legend rather than hand-rolling a bar.
void chrome_set_title(const char* t);
void chrome_set_centre(const char* t);
void chrome_set_footer(const char* legend, const char* right = nullptr);
void chrome_show_footer(bool show);

/// Glyph on the header's always-present back button.  Lives in the header, not
/// the body, so even the terminal — which spends every pixel below on the
/// character grid — keeps a tappable way out.
void chrome_set_back_glyph(const char* glyph);

/// Footer action buttons (right-hand slot).  Views own their own set; adding
/// one hides the right-hand hint label.  They are touch targets first: the
/// 15 px band is all the chrome allows, so each carries an extended hit area
/// that reaches into the body above.  Buttons also join the input group, so
/// Tab and Enter reach them.  A button that has a key names it after the word,
/// capitalised: "Reload (R)".
void      chrome_clear_footer_buttons();
lv_obj_t* chrome_add_footer_button(const char* text, lv_event_cb_t cb, void* user);

/// Legacy shim: left -> header centre, right -> footer right hint.
void app_set_status(const char* left, const char* right = nullptr);

// Trackball ------------------------------------------------------------------
// The ball is never a pointer (tdeck_bsp_set_ball_hook).  Everywhere except
// the terminal it scrolls: lists move a highlighted row, text scrolls by
// pixels.  These are the shared pieces every screen uses so the feel is the
// same on each.

/// Detents of roll per list row.  One per detent made a five-row menu
/// twitchy; two keeps a slow roll precise and a flick still covers a list.
inline constexpr int BALL_ROW_DETENTS = 2;

/// A per-axis detent accumulator for whole-step moves (rows, expand/collapse,
/// pan columns).  Resets when the direction flips or the ball rests.
struct BallAcc {
    int      acc  = 0;
    uint32_t tick = 0;
};
int ball_steps(BallAcc& a, int detents, int per_step = BALL_ROW_DETENTS);

/// Pixels to scroll for `detents` of vertical roll: ~10 px a detent when
/// rolled slowly, up to 4x that on a fast flick.
int ball_scroll_px(int detents);

/// The ball over a list of touch rows (tabs, menu, window picker, pairing
/// lists, Waiting's empty state): a vertical roll moves the highlight — LVGL
/// group focus, drawn by dg::style_focus — among the visible, focusable
/// descendants of `list` and keeps it in view; a click activates the
/// highlighted row, or just highlights the first visible one if nothing is.
/// Touch taps a row directly (LVGL focuses it on the way).  Returns false if
/// `list` has no rows, so a caller can fall back to something else.
bool ball_list(lv_obj_t* list, int dy, bool click);

// Views ---------------------------------------------------------------------

// The device Cockpit (Cockpit design §8.2): three views a plain letter apart,
// from each other and from Tabs.
//   w  Work       the waiting pager (screen_waiting.cpp, View::Waiting)
//   i  In flight  the running agents (screen_inflight.cpp)
//   l  Library    Carry: what to take away from the last Deep session
//                 (screen_carry.cpp)
//   x  Still thinking?  the idle-end push, while one is open
//                 (screen_deep_idle.cpp)
// On Work, a question page takes w as Wait (you are already on Work).

/// The snapshot the three views draw (Lee's, or the demo build's canned one);
/// null until one has arrived.
const dirigible::AttentionSnapshot* cockpit_snapshot();
/// Lee is reachable (always, in the demo build).
bool cockpit_linked();
/// Header centre for the three views: "In deep work" while a Deep session
/// runs at the machine, else Work's line ("One thing needs you.", "Working
/// on it.", "All clear."), with the away / link states ahead of it.
std::string cockpit_status();
/// w / i / l from any of the three views (and i / l from Tabs), and x for
/// the idle-end push while one is open.  True when the key moved somewhere.
bool cockpit_nav_key(uint8_t ascii);

// Waiting ("Work"): Lee's attention queue (Copilot v0, contracts §9.3), the
// default view once connected.  A pager, one needs-you item per page, with
// big lettered action buttons; reply and capture open a full-body text box.
// State lives in screen_waiting.cpp.
void waiting_build(lv_obj_t* parent);
void waiting_open();                       // show it, refetch the queue
void waiting_open_capture();               // show it with the capture box open
void waiting_render(bool new_snapshot = false);   // snapshot or link changed
void waiting_chrome();                     // header centre, footer, page
bool waiting_back();                       // close a box / opened item; false at root
void waiting_alert();                      // an item's notify flipped: blink
bool waiting_key(uint8_t ascii);
void waiting_ball(int dx, int dy, bool click);

// In flight: agents[] from the snapshot as a trackball list (state dot, name,
// what it is doing now, age, tokens); a press opens the agent's words as a
// page; c checks in.  State lives in screen_inflight.cpp.
void inflight_build(lv_obj_t* parent);
void inflight_open();
void inflight_render();                    // a new snapshot
bool inflight_back();                      // close an opened agent; false at the list
bool inflight_key(uint8_t ascii);
void inflight_ball(int dx, int dy, bool click);

// Library (Carry): GET /carry, your last Desk card first, one card per page
// (j/k): "You stopped at" in italic, one open question, Add a thought (C),
// Open next (O).  State lives in screen_carry.cpp.
void library_build(lv_obj_t* parent);
void library_open();                       // show it and refetch
bool library_back();                       // close the thought box; false otherwise
bool library_key(uint8_t ascii);
void library_ball(int dx, int dy, bool click);

// Still thinking? (Desk D2 §9.2): the idle-end push as its own page: e
// extend, d / m / s end and rate (then an optional stopped-at line), c
// capture into the card.  State lives in screen_deep_idle.cpp.
void deep_idle_build(lv_obj_t* parent);
bool deep_idle_pending();                  // the snapshot has an open push
void deep_idle_open();
void deep_idle_render();                   // a new snapshot
bool deep_idle_back();                     // close the text box; false otherwise
bool deep_idle_key(uint8_t ascii);
void deep_idle_ball(int dx, int dy, bool click);

void tabs_build(lv_obj_t* parent);
void tabs_render(const dirigible::LeeContext* ctx);
/// Tab-list header centre and footer: the active Lee window when there is
/// more than one (with a Win button), otherwise the idle time.
void tabs_chrome();

/// Overlay listing the host's Lee windows; picking one makes it the window
/// Dirigible follows (tabs, files, commands).  'w' on the tab list, or Menu.
void windows_open();

void terminal_build(lv_obj_t* parent);
void terminal_open(int pty_id, const char* label);
void terminal_close();
void terminal_repaint();
bool terminal_key(uint8_t ascii);          // true = consumed
void terminal_ball(int dx, int dy, bool click);

void hester_build(lv_obj_t* parent);
void hester_focus();
void hester_submit();
void hester_ball(int dx, int dy, bool click);   // scrolls the answer

void pairing_build(lv_obj_t* parent);
void pairing_begin();                      // restart the flow at step 0
void pairing_back();                       // one step back (Back buttons, hold)
bool pairing_key(uint8_t ascii);
void pairing_ball(int dx, int dy, bool click);  // list steps: highlight + pick

// Files: the workspace tree over GET /fs/list (Aeronaut's FilesBrowserBody).
// Its own state lives in screen_files.cpp.
void files_build(lv_obj_t* parent);
void files_open();                         // show the tree for the workspace
bool files_key(uint8_t ascii);
void files_ball(int dx, int dy, bool click);

// Viewer: one file over GET /fs/read (Aeronaut's FileViewerScreen): code in a
// monospace cell window with a gutter, prose and rendered markdown in wrapped
// Montserrat, all scrolled by the pixel.  State lives in screen_viewer.cpp;
// markdown is parsed by dirigible/markdown.hpp (host-tested, tools/md-test).
void viewer_build(lv_obj_t* parent);
/// Open `path`; back returns to `from` (Files or Tabs).
void viewer_open_path(const std::string& path, View from);
/// Follow an editor-like tab: shows `editors[tab_id].file`, reloads when the
/// tab switches file, and tracks its modified flag and cursor line.
void viewer_open_tab(int tab_id);
void viewer_on_context(const dirigible::LeeContext* ctx);
void viewer_close();                       // drop the file and any tab binding
View viewer_return_view();
#if defined(DIRIGIBLE_UI_DEMO) && DIRIGIBLE_UI_DEMO
void viewer_open_demo();                   // demo build: a markdown sample
#endif
bool viewer_key(uint8_t ascii);
void viewer_ball(int dx, int dy, bool click);

// Helpers -------------------------------------------------------------------
// Fonts are named in theme.hpp (dg::ui_font*, dg::mono_font*).

/// A label in `font` (nullptr: dg::ui_font(), Montserrat 14).  Text goes
/// through ui_fold() unless the font is monospace, so wire text is safe here.
lv_obj_t* make_label(lv_obj_t* parent, const char* text, lv_color_t colour,
                     const lv_font_t* font = nullptr);

/// A 4-bar signal strength indicator, `level` of 4 filled.  Returns the
/// container, sized SIGNAL_W x SIGNAL_H; caller positions it.
inline constexpr int SIGNAL_W = 19;
inline constexpr int SIGNAL_H = 12;
lv_obj_t* make_signal(lv_obj_t* parent, int level);
int rssi_to_level(int rssi);
void connect_active_machine();

}  // namespace dirigible_app
