/*
 * screen_hester.cpp — one-line query to Hester, phases and answer streamed
 * back over SSE (E4).
 *
 * POSTs to http://<machine>:<hester_port>/context/stream with the same bearer
 * the Lee API uses (hester/daemon/main.py: require_bearer_token reads
 * ~/.lee/api-token).  dirigible-core's HesterClient parses the event stream;
 * this file only renders it.
 *
 * Layout (E14), chat-shaped inside the 320x204 body:
 *
 *   y   0..169  the answer, wrapped Montserrat 14, scrolled by the ball
 *               (accelerated) or a finger
 *   y 172..203  the question, one line, Montserrat 16
 *
 * Hester's answer is agent prose, so it is folded (ui_fold) for Montserrat's
 * Latin-only glyph set rather than drawn in the terminal's monospace.
 *
 * The ReAct phases no longer overwrite the answer area: they run in the header
 * centre slot as `prep think act ...`, which is the one place every screen
 * already reserves for status.
 *
 * Voice (CONFIG_DIRIGIBLE_VOICE): a mic button right of the question, shown
 * when Hester has voice.  Tap to record, tap (or Enter) to stop; the
 * transcript fills the question for you to read and ask with Enter.  No
 * letter key here: the question box has the keyboard.
 */

#include <cstdio>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"
#include "voice_input.hpp"

static const char* TAG = "dirigible.hester";

namespace dirigible_app {

namespace {

const char* phase_name(dirigible::HesterPhase p)
{
    switch (p) {
    case dirigible::HesterPhase::Preparing:  return "prep";
    case dirigible::HesterPhase::Thinking:   return "think";
    case dirigible::HesterPhase::Acting:     return "act";
    case dirigible::HesterPhase::Observing:  return "obs";
    case dirigible::HesterPhase::Responding: return "resp";
    default:                                 return "?";
    }
}

void input_event(lv_event_t* e)
{
    if (lv_event_get_code(e) == LV_EVENT_READY) hester_submit();
}

#if CONFIG_DIRIGIBLE_VOICE
constexpr int MIC_W = 30;
lv_obj_t* s_mic = nullptr;
lv_obj_t* s_mic_lbl = nullptr;

void mic_render()
{
    auto& a = app();
    if (!s_mic) return;
    const bool on = voice::available();
    if (on) lv_obj_clear_flag(s_mic, LV_OBJ_FLAG_HIDDEN);
    else    lv_obj_add_flag(s_mic, LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_width(a.hester_input, SCREEN_W - 4 - (on ? MIC_W + 3 : 0));
    lv_label_set_text(s_mic_lbl, voice::recording() ? LV_SYMBOL_STOP : LV_SYMBOL_AUDIO);
    lv_obj_set_style_text_color(s_mic_lbl, voice::recording() ? dg::ember() : dg::text1(), 0);
}

void mic_toggle()
{
    if (voice::recording()) { voice::stop(); mic_render(); return; }
    if (voice::busy()) return;
    voice::start(dirigible::VoicePurpose::Ask, "",
        [](bool ok, const std::string& text) {
            auto& a = app();
            mic_render();
            if (a.view == View::Hester) chrome_set_footer("Enter ask  ball scrolls", "hester");
            if (!ok) { chrome_set_centre(text.c_str()); return; }
            voice::fill(a.hester_input, text);
            hester_focus();
            chrome_set_centre("check it, then Enter");   // voice never asks
        },
        [](int ms) {
            if (app().view == View::Hester) chrome_set_footer(voice::elapsed_text(ms).c_str(), "voice");
        });
    mic_render();
}
#endif

}  // namespace

void hester_build(lv_obj_t* parent)
{
    auto& a = app();

    a.view_hester = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_hester);
    lv_obj_set_pos(a.view_hester, 0, 0);
    lv_obj_set_size(a.view_hester, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_hester, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(a.view_hester, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_hester, LV_OBJ_FLAG_SCROLLABLE);

    // ---- answer, above: a scrolling container so long replies are readable
    // rather than clipped.
    const int input_h = 30;
    const int out_h   = BODY_H - input_h - 4;          // 170

    lv_obj_t* out = lv_obj_create(a.view_hester);
    lv_obj_remove_style_all(out);
    lv_obj_set_pos(out, 2, 0);
    lv_obj_set_size(out, SCREEN_W - 4, out_h);
    lv_obj_set_style_bg_opa(out, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(out, dg::ground0(), 0);
    lv_obj_set_style_border_width(out, 1, 0);
    lv_obj_set_style_border_color(out, dg::ground4(), 0);
    lv_obj_set_style_border_opa(out, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(out, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(out, 4, 0);
    lv_obj_set_scroll_dir(out, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(out, LV_SCROLLBAR_MODE_AUTO);

    a.hester_output = lv_label_create(out);
    lv_label_set_long_mode(a.hester_output, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(a.hester_output, SCREEN_W - 14);   // inside the 4 px pad + border
    lv_obj_set_style_text_font(a.hester_output, dg::ui_font(), 0);
    lv_obj_set_style_text_color(a.hester_output, dg::text1(), 0);
    lv_label_set_text(a.hester_output, "Ask Hester a question. It sees the tab Lee has focused.");

    // ---- question, below
    a.hester_input = lv_textarea_create(a.view_hester);
    lv_textarea_set_one_line(a.hester_input, true);
    lv_textarea_set_placeholder_text(a.hester_input, "ask hester");
    lv_obj_set_pos(a.hester_input, 2, BODY_H - input_h - 1);
    lv_obj_set_size(a.hester_input, SCREEN_W - 4, input_h);
    lv_obj_set_style_text_font(a.hester_input, dg::ui_font_title(), 0);
    lv_obj_set_style_text_color(a.hester_input, dg::text1(), 0);
    lv_obj_set_style_bg_color(a.hester_input, dg::ground3(), 0);
    lv_obj_set_style_border_width(a.hester_input, 1, 0);
    lv_obj_set_style_border_color(a.hester_input, dg::ground4(), 0);
    lv_obj_set_style_radius(a.hester_input, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(a.hester_input, 4, 0);
    dg::style_input_focus(a.hester_input);
    lv_obj_add_event_cb(a.hester_input, input_event, LV_EVENT_READY, nullptr);
    if (a.group) lv_group_add_obj(a.group, a.hester_input);

#if CONFIG_DIRIGIBLE_VOICE
    s_mic = lv_btn_create(a.view_hester);
    lv_obj_remove_style_all(s_mic);
    if (lv_obj_get_group(s_mic)) lv_group_remove_obj(s_mic);   // touch: the box keeps the keyboard
    lv_obj_set_size(s_mic, MIC_W, input_h);
    lv_obj_set_pos(s_mic, SCREEN_W - 2 - MIC_W, BODY_H - input_h - 1);
    lv_obj_set_style_bg_opa(s_mic, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s_mic, dg::ground3(), 0);
    lv_obj_set_style_bg_color(s_mic, dg::ground4(), LV_STATE_PRESSED);
    lv_obj_set_style_border_width(s_mic, 1, 0);
    lv_obj_set_style_border_color(s_mic, dg::ground5(), 0);
    lv_obj_set_style_radius(s_mic, DG_RADIUS, 0);
    s_mic_lbl = make_label(s_mic, LV_SYMBOL_AUDIO, dg::text1());
    lv_obj_center(s_mic_lbl);
    lv_obj_add_event_cb(s_mic, [](lv_event_t*) { mic_toggle(); }, LV_EVENT_CLICKED, nullptr);
    lv_obj_add_flag(s_mic, LV_OBJ_FLAG_HIDDEN);
#endif

    lv_obj_add_flag(a.view_hester, LV_OBJ_FLAG_HIDDEN);
}

void hester_focus()
{
    auto& a = app();
    if (a.group && a.hester_input) lv_group_focus_obj(a.hester_input);
#if CONFIG_DIRIGIBLE_VOICE
    mic_render();
    voice::refresh([] { mic_render(); });
#endif
}

bool hester_key(uint8_t ascii)
{
#if CONFIG_DIRIGIBLE_VOICE
    if (voice::recording()) {
        if (ascii == '\r' || ascii == '\n') mic_toggle();
        else if (ascii == 0x08 || ascii == 0x7F) { voice::cancel(); mic_render(); }
        return true;
    }
    if (voice::busy() && (ascii == '\r' || ascii == '\n')) return true;   // the transcript isn't in yet
#endif
    if (ascii == 0x1B) { app_back(); return true; }
    return false;
}

void hester_ball(int, int dy, bool)
{
    // Vertical rolls scroll the answer; the question keeps the keyboard.
    auto& a = app();
    if (!dy || !a.hester_output) return;
    lv_obj_scroll_by_bounded(lv_obj_get_parent(a.hester_output), 0, -ball_scroll_px(dy),
                             LV_ANIM_OFF);
}

void hester_submit()
{
    auto& a = app();
    const char* text = lv_textarea_get_text(a.hester_input);
    if (!text || !*text) return;

    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    if (!m) { lv_label_set_text(a.hester_output, "no machine paired"); return; }

    // The SSE reader runs on its own FreeRTOS task holding a pointer into the
    // client, so the client is created once and never destroyed while a query
    // is in flight.
    if (a.hester_busy) { chrome_set_centre("hester busy"); return; }
    if (!a.hester) {
        a.hester = new dirigible::HesterClient(a.factory, m->config.host,
                                               m->config.hester_port);
    }
    a.hester_busy = true;

    if (a.hester_session.empty()) {
        // Stable per-boot session so follow-up questions keep context.
        char sid[32];
        snprintf(sid, sizeof(sid), "dirigible-%lu",
                 (unsigned long)lv_tick_get());
        a.hester_session = sid;
    }

    a.hester_phases.clear();
    chrome_set_centre("thinking");
    lv_label_set_text(a.hester_output, "...");

    a.hester->onPhase([](dirigible::HesterPhase p, const std::string& detail) {
        auto& b = app();
        if (!b.hester_phases.empty()) b.hester_phases += " ";
        b.hester_phases += phase_name(p);
        if (!detail.empty()) { b.hester_phases += ":"; b.hester_phases += detail; }
        // Phases belong in the header's status slot, not on top of the answer.
        chrome_set_centre(b.hester_phases.c_str());
    });
    a.hester->onResponse([](const std::string& text) {
        ui_set_text(app().hester_output, text);
    });
    a.hester->onError([](const std::string& msg) {
        ui_set_text(app().hester_output, "error: " + msg);
    });
    a.hester->onDone([](bool ok) {
        app().hester_busy = false;
        chrome_set_centre(ok ? "hester" : "stream failed");
    });

    std::string token = m->token;
    if (token.empty()) token = a.config->getToken(m->config.name);
    a.hester->setToken(token);
    a.hester->send(text, a.hester_session);

    ESP_LOGI(TAG, "asked hester at %s:%d", m->config.host.c_str(),
             m->config.hester_port);
    lv_textarea_set_text(a.hester_input, "");
}

}  // namespace dirigible_app
