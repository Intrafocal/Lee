/*
 * screen_pairing.cpp — on-device pairing (E5, device half; E14 layout pass).
 *
 * Steps, driven entirely by the physical keyboard and the trackball:
 *
 *   0  WiFi      scan and pick an SSID (or rescan)
 *   1  Password  type it, Enter connects, credentials go to NVS "ss_wifi"
 *   2  Discover  mDNS PTR for _lee._tcp, pick a host — or "Manual entry"
 *   3  Host      "host" or "host:port" when discovery found nothing
 *   4  Approve   show a 6-digit code, poll until the user approves it on Lee
 *   5  Save      machine written to NVS, connection opened, view → Tabs
 *   6  Token     fallback: type the 36-char bearer by hand
 *
 * Step 4 is the code-approval flow (E19).  The device invents a 6-digit code
 * and a 16-byte nonce, POSTs them to Lee's unauthenticated /pair/request, and
 * shows the code big on screen; Lee raises a native "Pair a device" dialog
 * carrying the same code, and an Approve there releases the bearer to the next
 * /pair/poll.  Nobody types 36 characters on a thumb keyboard, and the code
 * has to be read off the device's own screen, so a machine on the LAN that
 * merely knows Lee's address cannot pair itself.
 *
 * The typed-token step survives as step 6, reachable from the "Token" footer
 * button — it is the way in when Lee is older than E19, has
 * `hester.pairing_enabled: false`, or is behind something that eats POSTs.
 *
 * Neither path ever reads the token off the network: Lee's `_lee._tcp`
 * advertisement carries the name, host and port but deliberately no `token`
 * TXT record, because anything on the LAN can read a TXT record.
 *
 * Layout (the 320x204 body under the shared 20 px header, above the 16 px
 * shared footer):
 *
 *   y   0..17   four step chips — WiFi | Pass | Lee | Pair
 *   y  20..203  x   2..185  the interactive column (list or text entry)
 *               x 190..317  the summary card, which fills in as steps
 *                           complete and carries failures in red
 *
 * Everything in the interactive column is rebuilt per step; the chips and the
 * card are persistent, which is what makes progress legible.  `pair_gen` is
 * still bumped on every rebuild so an async scan/discovery result that lands
 * after the user has moved on cannot touch a freed widget.
 *
 * There is no on-screen keyboard — the T-Deck has a real one, and LVGL's
 * would eat two thirds of a 320x240 panel.
 *
 * Back is available three ways: the ESC key, the footer "Back" button (in the
 * input group, so trackball and touch both reach it), and — at step 0 with a
 * machine already stored — a straight exit to Tabs.
 *
 * Build with -DDIRIGIBLE_UI_DEMO=1 to cycle every step with canned data every
 * 3 s, so the layout can be eyeballed on a device with no network.
 */

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "app.hpp"
#include "dirigible/pairing_client.hpp"
#include "dirigible_esp/wifi_esp.hpp"
#include "esp_log.h"
#include "esp_random.h"
#include "theme.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

static const char* TAG = "dirigible.pair";

namespace dirigible_app {

namespace {

dirigible::IDiscovery* g_discovery = nullptr;
bool                   g_pw_shown  = false;

// ---- step 4 (approve) state ----------------------------------------------
//
// The PairingClient is created once and kept for the lifetime of the app: its
// HTTP transport spawns a task per request, so deleting it between attempts
// could free the object a running request is about to call back into.  Only
// the host/port move, via setHost().
dirigible::PairingClient* g_pairing     = nullptr;
lv_timer_t*               g_poll_timer  = nullptr;
std::string               g_code;
std::string               g_nonce;
uint32_t                  g_approve_t0  = 0;   // lv_tick at request time
bool                      g_poll_busy   = false;
int                       g_poll_errors = 0;   // consecutive transport failures
lv_obj_t*                 g_code_lbl    = nullptr;
lv_obj_t*                 g_code_bar    = nullptr;

/// How long Lee keeps a pairing request open (api-server.ts PAIRING_TTL_MS).
constexpr int APPROVE_WINDOW_S = 120;
/// Poll cadence.  80 polls over the window; Lee's poll handler is a map lookup.
constexpr uint32_t APPROVE_POLL_MS = 1500;
/// Give up only after this many polls in a row fail at the transport level —
/// a single dropped packet on a busy 2.4 GHz band should not end the flow.
constexpr int APPROVE_MAX_ERRORS = 3;

void step_wifi();
void step_password();
void step_discover();
void step_host();
void step_approve();
void step_token();
void step_save();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// LVGL's label recolour markup treats '#' as an escape, so any value coming
/// off the wire (an SSID, a workspace name) is scrubbed before it lands in the
/// summary card.
std::string safe(const std::string& in, size_t limit = 40)
{
    std::string out;
    out.reserve(in.size());
    for (char c : in) {
        if (out.size() >= limit) break;
        out += (c == '#' || (unsigned char)c < 0x20 || (unsigned char)c > 0x7E)
             ? '+' : c;
    }
    if (out.empty()) out = "-";
    return out;
}

void set_centre(const char* t) { chrome_set_centre(t); }

// ---- step chips -----------------------------------------------------------

// Steps 2 (discover) and 3 (manual host) share the "Lee" chip.
int chip_for_step(int step)
{
    switch (step) {
    case 0:  return 0;
    case 1:  return 1;
    case 2:
    case 3:  return 2;
    case 4:  return 3;   // approve
    case 6:  return 3;   // typed-token fallback, same chip
    default: return 4;   // done
    }
}

void chips_update()
{
    auto& a = app();
    const int cur = chip_for_step(a.pair_step);
    for (int i = 0; i < 4; i++) {
        if (!a.pair_chip[i]) continue;
        const bool done    = i < cur;
        const bool current = i == cur;
        // "current" borrows the focus look (raised + lit border) — it is the
        // step the user's attention is on, same idea as a focused row.  A
        // completed step needs no border treatment, just its phosphor tick
        // and phosphor label; anything still ahead stays muted.
        lv_obj_set_style_bg_color(a.pair_chip[i],
            current ? dg::ground3() : dg::ground1(), 0);
        lv_obj_set_style_border_color(a.pair_chip[i],
            current ? dg::lit() : dg::ground4(), 0);
        lv_obj_set_style_text_color(a.pair_chip_lbl[i],
            current ? dg::text1() : (done ? dg::phosphor() : dg::text3()), 0);
        if (done) lv_obj_clear_flag(a.pair_chip_tick[i], LV_OBJ_FLAG_HIDDEN);
        else      lv_obj_add_flag(a.pair_chip_tick[i], LV_OBJ_FLAG_HIDDEN);
    }
}

// ---- summary card ---------------------------------------------------------

void card_update()
{
    auto& a = app();
    if (!a.pair_card_lbl) return;

    // Recolour markup is plain "#RRGGBB text#" — the tokens have to be
    // formatted as literal hex here, lv_color_hex() has nothing to do with
    // it.  Section headers and empty-value dashes use text-3 (muted hint);
    // rssi/workspace secondary values use text-2 (one step brighter, same
    // relationship the old 0x666666/0x888888 pair had); failures use error.
    std::string t;
    t.reserve(256);

    char hdr[24];
    snprintf(hdr, sizeof(hdr), "#%06X ", DG_TEXT_3);
    char sec[24];
    snprintf(sec, sizeof(sec), "#%06X ", DG_TEXT_2);

    t += hdr; t += "WIFI#\n";
    if (a.pair_ssid.empty()) {
        t += hdr; t += "-#\n";
    } else {
        t += safe(a.pair_ssid, 30) + "\n";
        if (a.pair_rssi != 0) {
            char b[32];
            snprintf(b, sizeof(b), "%s%d dBm#\n", sec, a.pair_rssi);
            t += b;
        }
    }

    t += hdr; t += "IP#\n";
    t += a.pair_ip.empty() ? (std::string(hdr) + "-#\n") : safe(a.pair_ip, 24) + "\n";

    t += hdr; t += "LEE#\n";
    if (a.pair_host.empty()) {
        t += hdr; t += "-#\n";
    } else {
        if (!a.pair_name.empty()) t += safe(a.pair_name, 20) + "\n";
        char b[64];
        snprintf(b, sizeof(b), "%.30s:%d\n", safe(a.pair_host, 30).c_str(),
                 a.pair_port);
        t += b;
        if (!a.pair_ws.empty()) t += std::string(sec) + safe(a.pair_ws, 20) + "#\n";
        char h[48];
        snprintf(h, sizeof(h), "%sHESTER %d#\n", hdr, a.pair_hester_port);
        t += h;
    }

    if (!a.pair_error.empty()) {
        char err[16];
        snprintf(err, sizeof(err), "#%06X ", DG_ERROR);
        t += "\n"; t += err; t += safe(a.pair_error, 60) + "#";
    }

    lv_label_set_text(a.pair_card_lbl, t.c_str());
}

void set_error(const char* msg)
{
    app().pair_error = msg ? msg : "";
    card_update();
}

// ---- interactive column ---------------------------------------------------

/// Stop the approve-step poll timer, if one is running.  Safe to call from
/// anywhere, including from inside a poll callback.
void poll_timer_stop()
{
    if (g_poll_timer) {
        lv_timer_del(g_poll_timer);
        g_poll_timer = nullptr;
    }
}

/// Wipe the left column and drop whatever it had in the input group.
lv_obj_t* fresh_body()
{
    auto& a = app();
    // Leaving the approve step for any reason must stop its timer — the
    // widgets it paints into are about to be freed.  pair_gen still guards the
    // in-flight HTTP callback, which the timer cannot cancel.
    poll_timer_stop();
    g_code_lbl = nullptr;
    g_code_bar = nullptr;
    lv_obj_clean(a.pair_body);
    a.pair_input = nullptr;
    a.pair_meter = nullptr;
    a.pair_gen++;
    chrome_clear_footer_buttons();
    return a.pair_body;
}

void back_cb(lv_event_t*) { pairing_back(); }

/// Every step gets a Back button, added last so it sits at the right edge.
void add_back_button()
{
    chrome_add_footer_button("Back", back_cb, nullptr);
}

lv_obj_t* add_list(lv_obj_t* parent)
{
    lv_obj_t* list = lv_list_create(parent);
    lv_obj_set_size(list, PAIR_LEFT_W, PAIR_ROW_H);
    lv_obj_set_pos(list, 0, 0);
    lv_obj_set_style_bg_color(list, dg::ground0(), 0);
    lv_obj_set_style_border_width(list, 1, 0);
    lv_obj_set_style_border_color(list, dg::ground4(), 0);
    lv_obj_set_style_radius(list, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(list, 1, 0);
    lv_obj_set_style_pad_row(list, 2, 0);
    lv_obj_set_style_text_font(list, mono_font(), 0);
    return list;
}

/// A blank, full-width row button styled for the trackball focus state.
lv_obj_t* add_row(lv_obj_t* list, int height)
{
    lv_obj_t* btn = lv_btn_create(list);
    lv_obj_remove_style_all(btn);
    lv_obj_set_width(btn, LV_PCT(100));
    lv_obj_set_height(btn, height);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(btn, dg::ground1(), 0);
    lv_obj_set_style_bg_color(btn, dg::ground3(), LV_STATE_PRESSED);
    lv_obj_set_style_radius(btn, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(btn, 0, 0);
    lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);
    dg::style_focus(btn);
    if (app().group) lv_group_add_obj(app().group, btn);
    return btn;
}

/// A heading line at the top of the interactive column.
lv_obj_t* add_heading(lv_obj_t* parent, const char* text)
{
    lv_obj_t* l = make_label(parent, text, dg::text2());
    lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(l, PAIR_LEFT_W - 4);
    lv_obj_set_pos(l, 2, 0);
    return l;
}

/// Text entry: 34 px tall, 8x17 mono, visible caret, placeholder.
lv_obj_t* add_input(lv_obj_t* parent, const char* placeholder, bool password,
                    int y)
{
    auto& a = app();
    lv_obj_t* ta = lv_textarea_create(parent);
    lv_textarea_set_one_line(ta, true);
    lv_textarea_set_password_mode(ta, password);
    lv_textarea_set_placeholder_text(ta, placeholder);
    lv_obj_set_pos(ta, 2, y);
    lv_obj_set_size(ta, PAIR_LEFT_W - 4, 34);
    lv_obj_set_style_text_font(ta, mono_font_big(), 0);
    lv_obj_set_style_text_color(ta, dg::text1(), 0);
    lv_obj_set_style_bg_color(ta, dg::ground3(), 0);
    lv_obj_set_style_border_width(ta, 1, 0);
    lv_obj_set_style_border_color(ta, dg::ground4(), 0);
    lv_obj_set_style_radius(ta, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(ta, 4, 0);
    // A visible, blinking block caret — the default 2 px line is invisible on
    // this panel at arm's length.  Focus border and caret both use `lit`.
    dg::style_input_focus(ta);
    if (a.group) { lv_group_add_obj(a.group, ta); lv_group_focus_obj(ta); }
    a.pair_input = ta;
    return ta;
}

/// The small line under an input: counter, validity, hint.
lv_obj_t* add_meter(lv_obj_t* parent, int y)
{
    lv_obj_t* l = make_label(parent, "", dg::text3());
    lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(l, PAIR_LEFT_W - 4);
    lv_obj_set_pos(l, 2, y);
    app().pair_meter = l;
    return l;
}

/// An indeterminate-looking progress strip, driven by an LVGL animation.
lv_obj_t* add_progress(lv_obj_t* parent, int y, uint32_t ms)
{
    lv_obj_t* bar = lv_bar_create(parent);
    lv_obj_set_pos(bar, 2, y);
    lv_obj_set_size(bar, PAIR_LEFT_W - 4, 6);
    lv_obj_set_style_bg_color(bar, dg::ground3(), 0);
    lv_obj_set_style_bg_color(bar, dg::phosphor(), LV_PART_INDICATOR);
    lv_bar_set_range(bar, 0, 100);
    lv_bar_set_value(bar, 0, LV_ANIM_OFF);

    lv_anim_t anim;
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, bar);
    lv_anim_set_values(&anim, 0, 100);
    lv_anim_set_time(&anim, ms);
    lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&anim, [](void* obj, int32_t v) {
        lv_bar_set_value((lv_obj_t*)obj, v, LV_ANIM_OFF);
    });
    lv_anim_start(&anim);
    return bar;
}

// ---------------------------------------------------------------------------
// step 0: WiFi
// ---------------------------------------------------------------------------

void wifi_pick_cb(lv_event_t* e)
{
    auto* ap = (dirigible_esp::WifiEsp::AP*)lv_event_get_user_data(e);
    app().pair_ssid = ap->ssid;
    app().pair_rssi = ap->rssi;
    app().pair_ip.clear();
    step_password();
}

void wifi_row(lv_obj_t* list, const dirigible_esp::WifiEsp::AP& ap)
{
    lv_obj_t* btn = add_row(list, 24);

    lv_obj_t* lock = make_label(btn, ap.secured ? "*" : " ", dg::ember());
    lv_obj_align(lock, LV_ALIGN_LEFT_MID, 3, 0);

    // 3 + 8 (lock) + 3 = 14 left of the SSID; SIGNAL_W + 4 reserved right.
    lv_obj_t* name = make_label(btn, ap.ssid.c_str(), dg::text1());
    lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
    lv_obj_set_width(name, PAIR_LEFT_W - 14 - SIGNAL_W - 10);
    lv_obj_align(name, LV_ALIGN_LEFT_MID, 14, 0);

    lv_obj_t* sig = make_signal(btn, rssi_to_level(ap.rssi));
    lv_obj_align(sig, LV_ALIGN_RIGHT_MID, -3, 0);

    // The AP must outlive the callback; park a copy on the button and let
    // LVGL free it with the object.
    auto* owned = new dirigible_esp::WifiEsp::AP(ap);
    lv_obj_add_event_cb(btn, wifi_pick_cb, LV_EVENT_CLICKED, owned);
    lv_obj_add_event_cb(btn, [](lv_event_t* ev) {
        delete (dirigible_esp::WifiEsp::AP*)lv_event_get_user_data(ev);
    }, LV_EVENT_DELETE, owned);
}

void wifi_empty(lv_obj_t* list, const char* msg)
{
    lv_obj_t* row = lv_label_create(list);
    lv_label_set_text(row, msg);
    lv_label_set_long_mode(row, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(row, PAIR_LEFT_W - 8);
    lv_obj_set_style_text_font(row, mono_font(), 0);
    lv_obj_set_style_text_color(row, dg::text2(), 0);
}

void step_wifi()
{
    auto& a = app();
    a.pair_step = 0;
    chips_update();
    set_centre("1/4 WiFi");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Click to pick", nullptr);
    chrome_add_footer_button("Rescan", [](lv_event_t*) { step_wifi(); }, nullptr);
    add_back_button();

    lv_obj_t* list = add_list(body);
    wifi_empty(list, "scanning...");
    lv_obj_t* bar = add_progress(body, PAIR_ROW_H - 8, 1500);

    const int gen = a.pair_gen;
    dirigible_esp::WifiEsp::instance().scan(
        [list, bar, gen](std::vector<dirigible_esp::WifiEsp::AP> aps) {
            // The column is rebuilt on every step change, so these widgets are
            // only safe to touch while the generation still matches.
            if (app().pair_gen != gen) return;
            lv_obj_del(bar);
            lv_obj_clean(list);
            if (aps.empty()) {
                wifi_empty(list, "No networks found.\nMove closer to the AP\nand press Rescan.");
                return;
            }
            for (auto& ap : aps) wifi_row(list, ap);
        });
}

// ---------------------------------------------------------------------------
// step 1: password
// ---------------------------------------------------------------------------

void password_show_cb(lv_event_t*)
{
    auto& a = app();
    if (!a.pair_input) return;
    g_pw_shown = !g_pw_shown;
    lv_textarea_set_password_mode(a.pair_input, !g_pw_shown);
    if (a.group) lv_group_focus_obj(a.pair_input);
}

void password_ready(lv_event_t* e)
{
    auto& a = app();
    const char* pw = lv_textarea_get_text(lv_event_get_target(e));
    std::string password = pw ? pw : "";

    set_centre("connecting...");
    set_error(nullptr);
    if (a.pair_meter) {
        lv_label_set_text(a.pair_meter, "connecting...");
        lv_obj_set_style_text_color(a.pair_meter, dg::text2(), 0);
    }
    lv_obj_t* body = a.pair_body;
    const int gen  = a.pair_gen;
    lv_obj_t* bar  = add_progress(body, PAIR_ROW_H - 8, 900);

    dirigible_esp::WifiEsp::instance().connect(a.pair_ssid, password,
        [password, bar, gen](bool ok) {
            if (app().pair_gen != gen) return;   // user stepped away
            lv_obj_del(bar);
            if (!ok) {
                set_centre("1/4 WiFi failed");
                set_error("WiFi failed. Check the\npassword and press Enter\nto retry.");
                if (app().pair_meter) {
                    lv_label_set_text(app().pair_meter,
                                      "wrong password? Enter to retry");
                    lv_obj_set_style_text_color(app().pair_meter, dg::error(), 0);
                }
                return;
            }
            dirigible_esp::WifiEsp::instance()
                .saveCredentials(app().pair_ssid, password);
            app().pair_ip = dirigible_esp::WifiEsp::instance().ipAddress();
            set_error(nullptr);
            step_discover();
        });
}

void step_password()
{
    auto& a = app();
    a.pair_step = 1;
    g_pw_shown  = false;
    chips_update();
    card_update();
    set_centre("2/4 password");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Enter connect", nullptr);
    chrome_add_footer_button("Show", password_show_cb, nullptr);
    add_back_button();

    char head[64];
    snprintf(head, sizeof(head), "Password for\n%.24s", a.pair_ssid.c_str());
    add_heading(body, head);

    lv_obj_t* ta = add_input(body, "wifi password", true, 24);
    lv_obj_add_event_cb(ta, password_ready, LV_EVENT_READY, nullptr);

    lv_obj_t* show = lv_btn_create(body);
    lv_obj_set_pos(show, 2, 62);
    lv_obj_set_size(show, 66, 20);
    lv_obj_set_style_bg_opa(show, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(show, dg::ground3(), 0);
    lv_obj_set_style_radius(show, DG_RADIUS, 0);
    dg::style_focus(show);
    lv_obj_t* sl = lv_label_create(show);
    lv_label_set_text(sl, LV_SYMBOL_EYE_OPEN " show");
    lv_obj_set_style_text_font(sl, sym_font(), 0);
    lv_obj_set_style_text_color(sl, dg::text1(), 0);
    lv_obj_center(sl);
    lv_obj_add_event_cb(show, password_show_cb, LV_EVENT_CLICKED, nullptr);
    if (a.group) lv_group_add_obj(a.group, show);

    add_meter(body, 88);
    lv_label_set_text(a.pair_meter,
                      "Enter connects and saves.\nTab reaches show / Back.");
}

// ---------------------------------------------------------------------------
// step 2: discovery
// ---------------------------------------------------------------------------

struct Found {
    std::string name;
    std::string host;
    std::string ws;
    int port;
    int hester_port;
};

void discover_pick_cb(lv_event_t* e)
{
    auto* f = (Found*)lv_event_get_user_data(e);
    auto& a = app();
    a.pair_host        = f->host;
    a.pair_port        = f->port > 0 ? f->port : 9001;
    a.pair_hester_port = f->hester_port > 0 ? f->hester_port : 9000;
    a.pair_name        = f->name.substr(0, 11);  // NVS tok_ key limit (E10)
    a.pair_ws          = f->ws;
    step_approve();
}

void discover_row(lv_obj_t* list, const Found& f)
{
    // Three stacked lines in one 30 px row: name, host:port, workspace —
    // columns side by side would give each about 6 characters at 184 px.
    lv_obj_t* btn = add_row(list, 30);

    lv_obj_t* name = make_label(btn, f.name.c_str(), dg::text1());
    lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
    lv_obj_set_width(name, PAIR_LEFT_W - 8);
    lv_obj_align(name, LV_ALIGN_TOP_LEFT, 3, 1);

    char sub[64];
    snprintf(sub, sizeof(sub), "%.24s:%d", f.host.c_str(), f.port);
    lv_obj_t* hostl = make_label(btn, sub, dg::text2());
    lv_label_set_long_mode(hostl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(hostl, PAIR_LEFT_W - 8);
    lv_obj_align(hostl, LV_ALIGN_TOP_LEFT, 3, 11);

    lv_obj_t* wsl = make_label(btn, f.ws.empty() ? "-" : f.ws.c_str(),
                               dg::text3());
    lv_label_set_long_mode(wsl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(wsl, PAIR_LEFT_W - 8);
    lv_obj_align(wsl, LV_ALIGN_TOP_LEFT, 3, 20);

    auto* owned = new Found(f);
    lv_obj_add_event_cb(btn, discover_pick_cb, LV_EVENT_CLICKED, owned);
    lv_obj_add_event_cb(btn, [](lv_event_t* ev) {
        delete (Found*)lv_event_get_user_data(ev);
    }, LV_EVENT_DELETE, owned);
}

void step_discover()
{
    auto& a = app();
    a.pair_step = 2;
    chips_update();
    card_update();
    set_centre("3/4 find Lee");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Click a Lee", nullptr);
    chrome_add_footer_button("Manual", [](lv_event_t*) { step_host(); }, nullptr);
    chrome_add_footer_button("Rescan", [](lv_event_t*) { step_discover(); }, nullptr);
    add_back_button();

    lv_obj_t* list = add_list(body);
    wifi_empty(list, "looking for _lee._tcp...\n(3s)");
    lv_obj_t* bar = add_progress(body, PAIR_ROW_H - 8, 3000);

    if (!g_discovery) g_discovery = a.factory->createDiscovery();
    const int gen = a.pair_gen;
    g_discovery->query("_lee", "_tcp", 3000,
        [list, bar, gen](std::vector<dirigible::DiscoveryResult> results) {
            if (app().pair_gen != gen) return;
            lv_obj_del(bar);
            lv_obj_clean(list);
            int shown = 0;
            for (auto& r : results) {
                std::string host = !r.ipv4.empty() ? r.ipv4 : r.hostname;
                if (host.empty()) continue;

                // Lee's advertisement (electron/src/main/mdns-advertiser.ts)
                // carries v=1, hester=<port> and ws=<workspace> — and
                // deliberately no token.
                Found f;
                f.name = r.txt.count("instance") ? r.txt.at("instance") : host;
                f.host = host;
                f.ws   = r.txt.count("ws") ? r.txt.at("ws") : "";
                f.port = r.port;
                f.hester_port = r.txt.count("hester")
                              ? atoi(r.txt.at("hester").c_str()) : 9000;
                discover_row(list, f);
                shown++;
            }
            if (shown == 0) {
                wifi_empty(list,
                    "No Lee found.\n\nIs Lee running with\nmDNS on? Press the\nManual button.");
            }
        });
}

// ---------------------------------------------------------------------------
// step 3: manual host
// ---------------------------------------------------------------------------

void host_ready(lv_event_t* e)
{
    auto& a = app();
    const char* raw = lv_textarea_get_text(lv_event_get_target(e));
    std::string s = raw ? raw : "";
    if (s.empty()) { set_error("Enter a host first."); return; }

    size_t colon = s.rfind(':');
    if (colon != std::string::npos) {
        a.pair_host = s.substr(0, colon);
        a.pair_port = atoi(s.c_str() + colon + 1);
        if (a.pair_port <= 0) a.pair_port = 9001;
    } else {
        a.pair_host = s;
        a.pair_port = 9001;
    }
    a.pair_name        = a.pair_host.substr(0, 11);
    a.pair_hester_port = 9000;
    a.pair_ws.clear();
    set_error(nullptr);
    step_approve();
}

void step_host()
{
    auto& a = app();
    a.pair_step = 3;
    chips_update();
    card_update();
    set_centre("3/4 Lee host");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Enter to accept", nullptr);
    chrome_add_footer_button("Scan", [](lv_event_t*) { step_discover(); }, nullptr);
    add_back_button();

    add_heading(body, "Lee host");
    lv_obj_t* ta = add_input(body, "192.168.1.10:9001", false, 24);
    lv_obj_add_event_cb(ta, host_ready, LV_EVENT_READY, nullptr);

    add_meter(body, 64);
    lv_label_set_text(a.pair_meter,
                      "host or host:port\n(Lee's API port is 9001,\nHester's 9000)");
}

// ---------------------------------------------------------------------------
// shared: write the paired machine to NVS
// ---------------------------------------------------------------------------

/// Both the approve step and the typed-token fallback end here.  `name`, when
/// non-empty, is Lee's own friendly instance name from the pairing grant — it
/// beats the mDNS label, and it is what the user will see in Lee's logs.
void save_machine(const std::string& token, const std::string& name,
                  int hester_port)
{
    auto& a = app();

    if (!name.empty()) a.pair_name = name.substr(0, 11);   // NVS tok_ key (E10)
    if (a.pair_name.empty()) a.pair_name = "lee";
    if (hester_port > 0) a.pair_hester_port = hester_port;

    dirigible::MachineConfig m;
    m.name        = a.pair_name;
    m.host        = a.pair_host;
    m.lee_port    = a.pair_port;
    m.hester_port = a.pair_hester_port > 0 ? a.pair_hester_port : 9000;

    a.config->addMachine(m);
    a.config->setToken(m.name, token);
    ESP_LOGI(TAG, "paired %s -> %s:%d (hester %d)", m.name.c_str(),
             m.host.c_str(), m.lee_port, m.hester_port);

    step_save();
}

// ---------------------------------------------------------------------------
// step 4: approve  (E19 — the default path; step 6 is the typed fallback)
//
//   +-- left column, 184 x 184 ------------+
//   | Approve on Lee                       |  y  0  heading
//   | +----------------------------------+ |
//   | |            4 8 3   9 1 0         | |  y 18  code box, 180 x 46
//   | +----------------------------------+ |         unscii_16, letter-spaced
//   | 192.168.1.10:9001                    |  y 68  host line
//   | [===========================-------] |  y 84  countdown bar, 120 s
//   | waiting for approval    112s         |  y 94  meter
//   | Lee will ask you to                  |  y 112 hint
//   | approve this code.                   |
//   +--------------------------------------+
//   footer:  Approve on Lee | [Token] [Retry] [Back]
// ---------------------------------------------------------------------------

/// Six digits from the hardware RNG.  Digits only: in unscii_16 a letter code
/// would put O next to 0 and I next to 1, and this code is read aloud off a
/// 2.8" panel at arm's length.
std::string gen_code()
{
    char b[8];
    snprintf(b, sizeof(b), "%06u", (unsigned)(esp_random() % 1000000u));
    return b;
}

/// 16 random bytes as 32 lowercase hex chars — Lee requires >= 16.
std::string gen_nonce()
{
    static const char hex[] = "0123456789abcdef";
    std::string out;
    out.reserve(32);
    for (int i = 0; i < 4; i++) {
        const uint32_t r = esp_random();
        for (int n = 0; n < 8; n++) out += hex[(r >> (28 - n * 4)) & 0xF];
    }
    return out;
}

/// What Lee prints in the dialog and in lee.log.  The IP's last octet keeps
/// two T-Decks on the same desk apart without a MAC lookup.
std::string device_name()
{
    const std::string& ip = app().pair_ip;
    const size_t dot = ip.rfind('.');
    if (dot == std::string::npos || dot + 1 >= ip.size()) return "T-Deck";
    return "T-Deck ." + ip.substr(dot + 1);
}

void approve_set_meter(const char* text, lv_color_t colour)
{
    auto& a = app();
    if (!a.pair_meter) return;
    lv_label_set_text(a.pair_meter, text);
    lv_obj_set_style_text_color(a.pair_meter, colour, 0);
}

/// Park the step on a failure: stop polling, grey the code, say why in red in
/// both the meter and the summary card.  Retry / Token stay in the footer.
void approve_fail(const char* why)
{
    poll_timer_stop();
    if (g_code_lbl) lv_obj_set_style_text_color(g_code_lbl, dg::text3(), 0);
    if (g_code_bar) lv_obj_add_flag(g_code_bar, LV_OBJ_FLAG_HIDDEN);
    approve_set_meter(why, dg::error());
    set_error(why);
    set_centre("pairing failed");
}

void approve_poll_done(int gen, dirigible::PairingClient::Status status,
                       const dirigible::PairingClient::Grant& grant)
{
    if (app().pair_gen != gen) return;   // user stepped away mid-request
    g_poll_busy = false;

    using S = dirigible::PairingClient::Status;
    switch (status) {
    case S::Pending:
        g_poll_errors = 0;
        return;

    case S::Approved:
        g_poll_errors = 0;
        poll_timer_stop();
        set_centre("approved");
        approve_set_meter("approved - saving...", dg::phosphor());
        save_machine(grant.token, grant.name, grant.hester_port);
        return;

    case S::Denied:
        approve_fail("Denied on Lee.\nRetry for a new code.");
        return;

    case S::Expired:
        approve_fail("Code expired.\nPress Retry.");
        return;

    case S::Error:
    default:
        // One dropped reply is nothing; three in a row means Lee went away.
        if (++g_poll_errors >= APPROVE_MAX_ERRORS) {
            approve_fail("Lost contact with Lee.\nCheck it is running.");
        } else {
            approve_set_meter("no answer - retrying", dg::ember());
        }
        return;
    }
}

void approve_tick(lv_timer_t*)
{
    auto& a = app();
    const int elapsed = (int)(lv_tick_elaps(g_approve_t0) / 1000);
    const int remain  = APPROVE_WINDOW_S - elapsed;

    if (g_code_bar) {
        lv_bar_set_value(g_code_bar, remain > 0 ? remain : 0, LV_ANIM_OFF);
        // Ember for the last 30 s, so the countdown reads without the number.
        lv_obj_set_style_bg_color(g_code_bar,
            remain <= 30 ? dg::ember() : dg::phosphor(), LV_PART_INDICATOR);
    }

    if (remain <= 0) {
        approve_fail("Code expired.\nPress Retry.");
        return;
    }

    if (g_poll_busy) return;   // one request in flight at a time
    if (g_poll_errors == 0) {
        char b[48];
        snprintf(b, sizeof(b), "waiting for approval  %ds", remain);
        approve_set_meter(b, dg::text2());
    }

    g_poll_busy = true;
    const int gen = a.pair_gen;
    g_pairing->poll(g_nonce,
        [gen](dirigible::PairingClient::Status st,
              const dirigible::PairingClient::Grant& grant) {
            approve_poll_done(gen, st, grant);
        });
}

void step_approve()
{
    auto& a = app();
    a.pair_step = 4;
    chips_update();
    set_error(nullptr);
    card_update();
    set_centre("4/4 approve");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Approve on Lee", nullptr);
    chrome_add_footer_button("Token", [](lv_event_t*) { step_token(); }, nullptr);
    chrome_add_footer_button("Retry", [](lv_event_t*) { step_approve(); }, nullptr);
    add_back_button();

    add_heading(body, "Approve on Lee");

    // ---- the code, as big as this firmware's fonts go.  unscii_16 is 8x17,
    // so six digits are only 48 px wide; letter-spacing them to 8 px and
    // grouping 3+3 gets the block to ~104 px and makes it easy to read out.
    lv_obj_t* box = lv_obj_create(body);
    lv_obj_remove_style_all(box);
    lv_obj_set_pos(box, 2, 18);
    lv_obj_set_size(box, PAIR_LEFT_W - 4, 46);
    lv_obj_set_style_bg_opa(box, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(box, dg::ground3(), 0);
    lv_obj_set_style_border_width(box, 1, 0);
    lv_obj_set_style_border_color(box, dg::lit(), 0);
    lv_obj_set_style_border_opa(box, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(box, DG_RADIUS, 0);
    lv_obj_clear_flag(box, LV_OBJ_FLAG_SCROLLABLE);

    g_code = gen_code();
    g_nonce = gen_nonce();

    g_code_lbl = lv_label_create(box);
    lv_label_set_text(g_code_lbl,
                      dirigible::PairingClient::formatCode(g_code).c_str());
    lv_obj_set_style_text_font(g_code_lbl, mono_font_big(), 0);
    lv_obj_set_style_text_color(g_code_lbl, dg::text1(), 0);
    lv_obj_set_style_text_letter_space(g_code_lbl, 8, 0);
    lv_obj_center(g_code_lbl);

    char hostline[64];
    snprintf(hostline, sizeof(hostline), "%.24s:%d", a.pair_host.c_str(), a.pair_port);
    lv_obj_t* hl = make_label(body, hostline, dg::text2());
    lv_label_set_long_mode(hl, LV_LABEL_LONG_DOT);
    lv_obj_set_width(hl, PAIR_LEFT_W - 4);
    lv_obj_set_pos(hl, 2, 68);

    // Countdown bar: value counts the seconds left, so it drains left to right.
    g_code_bar = lv_bar_create(body);
    lv_obj_set_pos(g_code_bar, 2, 84);
    lv_obj_set_size(g_code_bar, PAIR_LEFT_W - 4, 6);
    lv_obj_set_style_bg_color(g_code_bar, dg::ground3(), 0);
    lv_obj_set_style_bg_color(g_code_bar, dg::phosphor(), LV_PART_INDICATOR);
    lv_bar_set_range(g_code_bar, 0, APPROVE_WINDOW_S);
    lv_bar_set_value(g_code_bar, APPROVE_WINDOW_S, LV_ANIM_OFF);

    add_meter(body, 94);
    approve_set_meter("asking Lee...", dg::text2());

    lv_obj_t* hint = make_label(body,
        "Lee will ask you to\napprove this code.\nNo token to type.",
        dg::text3());
    lv_label_set_long_mode(hint, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(hint, PAIR_LEFT_W - 4);
    lv_obj_set_pos(hint, 2, 112);

    if (!g_pairing) g_pairing = new dirigible::PairingClient(a.factory);
    g_pairing->setHost(a.pair_host, a.pair_port);

    g_poll_busy   = false;
    g_poll_errors = 0;
    g_approve_t0  = lv_tick_get();

    const int gen = a.pair_gen;
    g_pairing->requestPair(device_name(), "dirigible", g_code, g_nonce,
        [gen](bool ok, int expires_in, const std::string& error) {
            if (app().pair_gen != gen) return;
            if (!ok) {
                std::string msg = error.empty() ? "Lee refused the request."
                                                : error;
                msg += "\nRetry, or Token to type it.";
                approve_fail(msg.c_str());
                return;
            }
            (void)expires_in;   // Lee's window is the 120 s the bar already counts
            g_approve_t0 = lv_tick_get();
            approve_set_meter("waiting for approval", dg::text2());
            if (!g_poll_timer) {
                g_poll_timer = lv_timer_create(approve_tick, APPROVE_POLL_MS,
                                               nullptr);
            }
        });
}

// ---------------------------------------------------------------------------
// step 6: typed token (fallback)
//
// Reachable only from the approve step's "Token" footer button.  It is the way
// in when Lee predates E19, has `hester.pairing_enabled: false`, or is behind
// something that will not pass the POST.
// ---------------------------------------------------------------------------

/// Lee's token is a UUID: 8-4-4-4-12 lowercase hex with dashes, 36 chars.
bool token_valid(const char* s)
{
    if (!s) return false;
    static const int dashes[] = { 8, 13, 18, 23 };
    int n = 0;
    for (; s[n]; n++) {
        if (n >= 36) return false;
        bool is_dash = false;
        for (int d : dashes) if (n == d) is_dash = true;
        const char c = s[n];
        if (is_dash) {
            if (c != '-') return false;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
                     (c >= 'A' && c <= 'F'))) {
            return false;
        }
    }
    return n == 36;
}

void token_changed(lv_event_t* e)
{
    auto& a = app();
    if (!a.pair_meter) return;
    const char* s = lv_textarea_get_text(lv_event_get_target(e));
    const int n   = s ? (int)strlen(s) : 0;
    const bool ok = token_valid(s);

    char buf[72];
    snprintf(buf, sizeof(buf), "%d/36  %s", n,
             ok ? "looks like a UUID - Enter"
                : (n == 0 ? "8-4-4-4-12 hex"
                          : (n == 36 ? "36 chars but not a UUID"
                                     : "keep typing")));
    lv_label_set_text(a.pair_meter, buf);
    lv_obj_set_style_text_color(a.pair_meter,
        ok ? dg::phosphor() : (n == 36 ? dg::error() : dg::text2()), 0);
    lv_obj_set_style_border_color(a.pair_input,
        ok ? dg::phosphor() : dg::lit(), LV_STATE_FOCUSED);
}

void token_ready(lv_event_t* e)
{
    const char* raw = lv_textarea_get_text(lv_event_get_target(e));
    if (!raw || !*raw) { set_error("Paste the token first."); return; }
    auto& a = app();

    // A non-UUID is still accepted — a future Lee may issue a different shape —
    // but it is worth flagging before the connection fails with a 401.
    if (!token_valid(raw)) set_error("Saved, but that is not a\nUUID - expect a 401.");

    // Nothing to learn from the wire here, so keep the name and Hester port
    // the discovery step found.
    save_machine(raw, "", a.pair_hester_port);
}

void step_token()
{
    auto& a = app();
    a.pair_step = 6;
    chips_update();
    card_update();
    set_centre("token (manual)");
    lv_obj_t* body = fresh_body();
    chrome_set_footer("Enter to save", nullptr);
    chrome_add_footer_button("Code", [](lv_event_t*) { step_approve(); }, nullptr);
    add_back_button();

    char head[48];
    snprintf(head, sizeof(head), "Token for\n%.22s", a.pair_host.c_str());
    add_heading(body, head);

    lv_obj_t* ta = add_input(body, "xxxxxxxx-xxxx-...", false, 24);
    lv_textarea_set_max_length(ta, 36);
    lv_obj_add_event_cb(ta, token_ready, LV_EVENT_READY, nullptr);
    lv_obj_add_event_cb(ta, token_changed, LV_EVENT_VALUE_CHANGED, nullptr);

    add_meter(body, 62);
    lv_label_set_text(a.pair_meter, "0/36  8-4-4-4-12 hex");

    lv_obj_t* where = make_label(body,
        "Fallback. On the Lee\nmachine:\n  cat ~/.lee/api-token\nCode is easier.",
        dg::text3());
    lv_label_set_long_mode(where, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(where, PAIR_LEFT_W - 4);
    lv_obj_set_pos(where, 2, 92);
}

// ---------------------------------------------------------------------------
// step 5: save
// ---------------------------------------------------------------------------

void step_save()
{
    auto& a = app();
    a.pair_step = 5;
    chips_update();
    card_update();
    set_centre("paired");
    fresh_body();

    a.config->load();
    a.machines->loadFromConfig(a.config);
    connect_active_machine();
    app_show(View::Tabs);
}

// ---------------------------------------------------------------------------
// DIRIGIBLE_UI_DEMO — cycle every step with canned data, no network needed.
// ---------------------------------------------------------------------------
#if DIRIGIBLE_UI_DEMO

/// Orphan the pending async callback and remove the progress strip a step
/// just created, so canned rows survive.
void demo_drop_progress()
{
    auto& a = app();
    a.pair_gen++;
    lv_obj_t* bar = lv_obj_get_child(a.pair_body, 1);
    if (bar) lv_obj_del(bar);
}

void demo_tick(lv_timer_t*)
{
    auto& a = app();
    static int phase = 0;
    phase = (phase + 1) % 6;

    switch (phase) {
    case 0:
        a.pair_ssid.clear(); a.pair_ip.clear(); a.pair_host.clear();
        a.pair_ws.clear();   a.pair_rssi = 0;   a.pair_error.clear();
        step_wifi();
        // Fake rows straight away.  Bumping the generation orphans the real
        // scan/query callback so it cannot wipe them when it eventually
        // returns empty on a device with no network.
        if (a.pair_body) {
            demo_drop_progress();
            lv_obj_t* list = lv_obj_get_child(a.pair_body, 0);
            if (list) {
                lv_obj_clean(list);
                wifi_row(list, { "studio-5g",        -48, true  });
                wifi_row(list, { "studio-2g",        -61, true  });
                wifi_row(list, { "AVeryLongGuestSSID", -72, false });
                wifi_row(list, { "neighbour",        -88, true  });
            }
        }
        break;
    case 1:
        a.pair_ssid = "studio-5g"; a.pair_rssi = -48;
        step_password();
        break;
    case 2:
        a.pair_ip = "192.168.1.42";
        step_discover();
        if (a.pair_body) {
            demo_drop_progress();
            lv_obj_t* list = lv_obj_get_child(a.pair_body, 0);
            if (list) {
                lv_obj_clean(list);
                discover_row(list, { "studio", "192.168.1.10", "Lee",  9001, 9000 });
                discover_row(list, { "laptop", "192.168.1.23", "hester", 9001, 9000 });
            }
        }
        break;
    case 3:
        step_host();
        break;
    case 4:
        a.pair_host = "192.168.1.10"; a.pair_port = 9001;
        a.pair_name = "studio";       a.pair_ws   = "Lee";
        // The real request goes out and fails on a device with no network,
        // which is exactly the red "Lee unreachable" state worth eyeballing.
        step_approve();
        card_update();
        break;
    case 5:
        step_token();
        set_error("Denied on Lee.\nRetry for a new code.");
        break;
    default: break;
    }
}

void demo_start()
{
    static lv_timer_t* t = nullptr;
    if (!t) t = lv_timer_create(demo_tick, 3000, nullptr);
}

#endif  // DIRIGIBLE_UI_DEMO

}  // namespace

// ---------------------------------------------------------------------------
// Build / entry
// ---------------------------------------------------------------------------

void pairing_build(lv_obj_t* parent)
{
    auto& a = app();

    a.view_pairing = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_pairing);
    lv_obj_set_pos(a.view_pairing, 0, 0);
    lv_obj_set_size(a.view_pairing, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_pairing, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(a.view_pairing, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_pairing, LV_OBJ_FLAG_SCROLLABLE);

    // ---- step chips: 4 x 77 px on a 79 px pitch from x=3 (3+3*79+77 = 317)
    static const char* chip_names[4] = { "WiFi", "Pass", "Lee", "Pair" };
    for (int i = 0; i < 4; i++) {
        lv_obj_t* c = lv_obj_create(a.view_pairing);
        lv_obj_remove_style_all(c);
        lv_obj_set_pos(c, 3 + i * 79, 0);
        lv_obj_set_size(c, 77, PAIR_CHIP_H);
        lv_obj_set_style_bg_opa(c, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(c, dg::ground1(), 0);
        lv_obj_set_style_border_width(c, 1, 0);
        lv_obj_set_style_border_color(c, dg::ground4(), 0);
        lv_obj_set_style_border_opa(c, LV_OPA_COVER, 0);
        lv_obj_set_style_radius(c, DG_RADIUS, 0);
        lv_obj_clear_flag(c, LV_OBJ_FLAG_SCROLLABLE);

        lv_obj_t* l = make_label(c, chip_names[i], dg::text3());
        lv_obj_align(l, LV_ALIGN_LEFT_MID, 6, 0);

        // The tick is the one glyph here that ASCII cannot do justice; it is
        // the only montserrat_14 object in the chip, and 16 px in an 18 px box.
        lv_obj_t* tick = lv_label_create(c);
        lv_label_set_text(tick, LV_SYMBOL_OK);
        lv_obj_set_style_text_font(tick, sym_font(), 0);
        lv_obj_set_style_text_color(tick, dg::phosphor(), 0);
        lv_obj_align(tick, LV_ALIGN_RIGHT_MID, -5, 0);
        lv_obj_add_flag(tick, LV_OBJ_FLAG_HIDDEN);

        a.pair_chip[i]      = c;
        a.pair_chip_lbl[i]  = l;
        a.pair_chip_tick[i] = tick;
    }

    // ---- interactive column (rebuilt per step)
    a.pair_body = lv_obj_create(a.view_pairing);
    lv_obj_remove_style_all(a.pair_body);
    lv_obj_set_pos(a.pair_body, PAIR_LEFT_X, PAIR_ROW_Y);
    lv_obj_set_size(a.pair_body, PAIR_LEFT_W, PAIR_ROW_H);
    lv_obj_clear_flag(a.pair_body, LV_OBJ_FLAG_SCROLLABLE);

    // ---- summary card (persistent)
    a.pair_card = lv_obj_create(a.view_pairing);
    lv_obj_remove_style_all(a.pair_card);
    lv_obj_set_pos(a.pair_card, PAIR_CARD_X, PAIR_ROW_Y);
    lv_obj_set_size(a.pair_card, PAIR_CARD_W, PAIR_ROW_H);
    lv_obj_set_style_bg_opa(a.pair_card, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(a.pair_card, dg::ground0(), 0);
    lv_obj_set_style_border_width(a.pair_card, 1, 0);
    lv_obj_set_style_border_color(a.pair_card, dg::ground4(), 0);
    lv_obj_set_style_border_opa(a.pair_card, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(a.pair_card, DG_RADIUS, 0);
    lv_obj_clear_flag(a.pair_card, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* card_title = make_label(a.pair_card, "SETUP", dg::text3());
    lv_obj_set_pos(card_title, 4, 3);

    a.pair_card_lbl = make_label(a.pair_card, "", dg::text1());
    lv_label_set_recolor(a.pair_card_lbl, true);
    lv_label_set_long_mode(a.pair_card_lbl, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(a.pair_card_lbl, PAIR_CARD_W - 8);
    lv_obj_set_pos(a.pair_card_lbl, 4, 15);

    lv_obj_add_flag(a.view_pairing, LV_OBJ_FLAG_HIDDEN);
}

void pairing_begin()
{
    dirigible_esp::WifiEsp::instance().init();
    app().pair_error.clear();
    app_show(View::Pairing);
    card_update();
#if DIRIGIBLE_UI_DEMO
    demo_start();
#endif
    step_wifi();
}

void pairing_back()
{
    auto& a = app();
    switch (a.pair_step) {
    case 0:
        // Nowhere further back; leave the flow only if there is something to
        // go back to.
        if (a.config && a.config->machineCount() > 0) app_show(View::Tabs);
        return;
    case 1: step_wifi();     return;
    case 2: step_password(); return;
    case 3: step_discover(); return;
    case 4: step_discover(); return;   // approve -> back to the host list
    case 6: step_approve();  return;   // typed-token fallback -> back to the code
    default: app_show(View::Tabs); return;
    }
}

bool pairing_key(uint8_t ascii)
{
    if (ascii != 0x1B) return false;   // let LVGL type into the textarea
    pairing_back();
    return true;
}

}  // namespace dirigible_app
