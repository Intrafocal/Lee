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
 *   y   0..169  the answer, scrolling, wrapped at 38 mono columns
 *   y 172..203  the question, one line, 8x17 mono
 *
 * The ReAct phases no longer overwrite the answer area: they run in the header
 * centre slot as `prep think act ...`, which is the one place every screen
 * already reserves for status.
 */

#include <cstdio>

#include "app.hpp"
#include "esp_log.h"

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

}  // namespace

void hester_build(lv_obj_t* parent)
{
    auto& a = app();

    a.view_hester = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_hester);
    lv_obj_set_pos(a.view_hester, 0, 0);
    lv_obj_set_size(a.view_hester, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_hester, lv_color_black(), 0);
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
    lv_obj_set_style_bg_color(out, lv_color_hex(0x0a0a0a), 0);
    lv_obj_set_style_border_width(out, 1, 0);
    lv_obj_set_style_border_color(out, lv_color_hex(0x262626), 0);
    lv_obj_set_style_border_opa(out, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(out, 2, 0);
    lv_obj_set_style_pad_all(out, 4, 0);
    lv_obj_set_scroll_dir(out, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(out, LV_SCROLLBAR_MODE_AUTO);

    a.hester_output = lv_label_create(out);
    lv_label_set_long_mode(a.hester_output, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(a.hester_output, SCREEN_W - 14);   // 38 mono columns
    lv_obj_set_style_text_font(a.hester_output, mono_font(), 0);
    lv_obj_set_style_text_color(a.hester_output, lv_color_hex(0xDDDDDD), 0);
    lv_label_set_text(a.hester_output, "Ask Hester a question.\nIt sees the tab Lee has\nfocused.");

    // ---- question, below
    a.hester_input = lv_textarea_create(a.view_hester);
    lv_textarea_set_one_line(a.hester_input, true);
    lv_textarea_set_placeholder_text(a.hester_input, "ask hester");
    lv_obj_set_pos(a.hester_input, 2, BODY_H - input_h - 1);
    lv_obj_set_size(a.hester_input, SCREEN_W - 4, input_h);
    lv_obj_set_style_text_font(a.hester_input, mono_font_big(), 0);
    lv_obj_set_style_text_color(a.hester_input, lv_color_white(), 0);
    lv_obj_set_style_bg_color(a.hester_input, lv_color_hex(0x101010), 0);
    lv_obj_set_style_border_width(a.hester_input, 1, 0);
    lv_obj_set_style_border_color(a.hester_input, lv_color_hex(0x3a3a3a), 0);
    lv_obj_set_style_border_color(a.hester_input, lv_color_hex(0x6f9fe8),
                                  LV_STATE_FOCUSED);
    lv_obj_set_style_radius(a.hester_input, 2, 0);
    lv_obj_set_style_pad_all(a.hester_input, 3, 0);
    lv_obj_set_style_border_width(a.hester_input, 2, LV_PART_CURSOR);
    lv_obj_set_style_border_side(a.hester_input, LV_BORDER_SIDE_BOTTOM,
                                 LV_PART_CURSOR);
    lv_obj_set_style_border_color(a.hester_input, lv_palette_main(LV_PALETTE_AMBER),
                                  LV_PART_CURSOR);
    lv_obj_set_style_anim_time(a.hester_input, 500, LV_PART_CURSOR);
    lv_obj_add_event_cb(a.hester_input, input_event, LV_EVENT_READY, nullptr);
    if (a.group) lv_group_add_obj(a.group, a.hester_input);

    lv_obj_add_flag(a.view_hester, LV_OBJ_FLAG_HIDDEN);
}

void hester_focus()
{
    auto& a = app();
    if (a.group && a.hester_input) lv_group_focus_obj(a.hester_input);
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
        lv_label_set_text(app().hester_output, text.c_str());
    });
    a.hester->onError([](const std::string& msg) {
        std::string m2 = "error: " + msg;
        lv_label_set_text(app().hester_output, m2.c_str());
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
