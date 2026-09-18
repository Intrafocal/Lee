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

enum class View { Tabs, Terminal, Hester, Pairing };

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
    lv_obj_t* lbl_centre    = nullptr;   // header centre: step / status
    lv_obj_t* conn_dot      = nullptr;   // header right: link state dot
    lv_obj_t* lbl_wifi      = nullptr;   // header right: wifi glyph
    lv_obj_t* lbl_battery   = nullptr;
    lv_obj_t* content       = nullptr;
    lv_obj_t* footer        = nullptr;
    lv_obj_t* lbl_footer_l  = nullptr;   // key legend
    lv_obj_t* lbl_footer_r  = nullptr;   // right-hand hint
    lv_obj_t* footer_btns   = nullptr;   // right-hand action buttons
    lv_group_t* group       = nullptr;

    // --- views ----------------------------------------------------------
    lv_obj_t* view_tabs     = nullptr;
    lv_obj_t* view_terminal = nullptr;
    lv_obj_t* view_hester   = nullptr;
    lv_obj_t* view_pairing  = nullptr;
    lv_obj_t* menu          = nullptr;   // overlay, nullptr when closed

    View view = View::Tabs;

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
    lv_obj_t*   pair_card_lbl  = nullptr;
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
};

App& app();

// Lifecycle -----------------------------------------------------------------
void app_start();                 // builds the chrome and every view
void app_show(View v);

/// The one way out of wherever you are.  Closes the menu if it is open,
/// otherwise steps the current view back: the terminal drops its PTY and
/// returns to the tab list, Hester and pairing unwind, and the tab list (which
/// has nowhere further back) opens the menu.
///
/// Three things call this and they must stay in agreement: the header's
/// on-screen button, the ESC key, and a trackball long-press.  Before E15 the
/// long-press opened the menu and did nothing at all in the terminal — the
/// d-pad hook returned before the BSP's long-press detector ran — so a PTY tab
/// was a dead end for anyone not reaching for ESC.
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
/// one hides the right-hand hint label.  Buttons join the input group, so the
/// trackball, touch and Tab all reach them — this is how pairing gets a
/// visible "Back" affordance rather than only the ESC key.
void      chrome_clear_footer_buttons();
lv_obj_t* chrome_add_footer_button(const char* text, lv_event_cb_t cb, void* user);

/// Legacy shim: left -> header centre, right -> footer right hint.
void app_set_status(const char* left, const char* right = nullptr);

// Views ---------------------------------------------------------------------
void tabs_build(lv_obj_t* parent);
void tabs_render(const dirigible::LeeContext* ctx);

void terminal_build(lv_obj_t* parent);
void terminal_open(int pty_id, const char* label);
void terminal_close();
void terminal_repaint();
bool terminal_key(uint8_t ascii);          // true = consumed
void terminal_ball(int dx, int dy, bool click);

void hester_build(lv_obj_t* parent);
void hester_focus();
void hester_submit();

void pairing_build(lv_obj_t* parent);
void pairing_begin();                      // restart the flow at step 0
void pairing_back();                       // one step back (ESC / Back button)
bool pairing_key(uint8_t ascii);

// Helpers -------------------------------------------------------------------
const lv_font_t* mono_font();      // lv_font_unscii_8  — 8x9,  dense UI
const lv_font_t* mono_font_big();  // lv_font_unscii_16 — 8x17, text entry
const lv_font_t* sym_font();       // montserrat_14 — the only font with glyphs
lv_obj_t* make_label(lv_obj_t* parent, const char* text, lv_color_t colour);

/// A 4-bar signal strength indicator, `level` of 4 filled.  Returns the
/// container, sized SIGNAL_W x SIGNAL_H; caller positions it.
inline constexpr int SIGNAL_W = 19;
inline constexpr int SIGNAL_H = 12;
lv_obj_t* make_signal(lv_obj_t* parent, int level);
int rssi_to_level(int rssi);
void connect_active_machine();

}  // namespace dirigible_app
