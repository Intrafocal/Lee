/*
 * screen_tabs.cpp — the live tab list.
 *
 * Behaviour carried over from the screenschema-era handlers.cpp: rows come
 * from the LeeContext pushed over the /context/stream WebSocket, selecting one
 * sends `system.focus_tab` to Lee, and a tab that owns a PTY also opens the
 * terminal view on it.
 *
 * Layout (E14), inside the 320x204 body under the shared header:
 *
 *   row, 26 px:  [ type ] > label .......................... pty
 *                 ^badge  ^focused marker                    ^has a PTY
 *
 * When there is no connection the list is replaced by a plain state panel
 * naming the machine it is trying to reach and offering Re-pair, rather than
 * an empty black rectangle.
 */

#include <cstdio>
#include <cstring>

#include "app.hpp"
#include "esp_log.h"

static const char* TAG = "dirigible.tabs";

namespace dirigible_app {

namespace {

// Tab types whose PTY is worth streaming to a 40-column screen.
bool tab_has_pty(const char* type)
{
    if (!type) return false;
    return strcmp(type, "terminal") == 0 || strcmp(type, "git")    == 0 ||
           strcmp(type, "docker")   == 0 || strcmp(type, "k8s")    == 0 ||
           strcmp(type, "hester")   == 0 || strcmp(type, "claude") == 0 ||
           strcmp(type, "agent")    == 0 || strcmp(type, "sql")    == 0 ||
           strcmp(type, "flutter")  == 0 || strcmp(type, "devops") == 0 ||
           strcmp(type, "system")   == 0;
}

/// Badge tint per tab type, so a glance separates a git pane from an editor.
lv_color_t tab_colour(const char* type)
{
    if (!type) return lv_color_hex(0x404040);
    if (strcmp(type, "editor")   == 0) return lv_color_hex(0x2f5fa8);
    if (strcmp(type, "terminal") == 0) return lv_color_hex(0x2c6b3f);
    if (strcmp(type, "git")      == 0) return lv_color_hex(0x8a5a1f);
    if (strcmp(type, "docker")   == 0) return lv_color_hex(0x1f6a7a);
    if (strcmp(type, "browser")  == 0) return lv_color_hex(0x6a3f8a);
    if (strcmp(type, "hester")   == 0 || strcmp(type, "claude") == 0 ||
        strcmp(type, "agent")    == 0) return lv_color_hex(0x8a2f5f);
    return lv_color_hex(0x404040);
}

void row_clicked(lv_event_t* e)
{
    auto& a = app();
    int row = (int)(intptr_t)lv_event_get_user_data(e);
    if (row < 0 || row >= (int)a.tab_ids.size()) return;

    const int tab_id = a.tab_ids[row];
    auto* conn = a.machines ? a.machines->activeConnection() : nullptr;
    if (!conn) return;

    ESP_LOGI(TAG, "focus tab id=%d (row %d)", tab_id, row);
    conn->focusTab(tab_id);

    const dirigible::LeeContext* ctx = conn->currentContext();
    if (!ctx) return;

    const dirigible::TabContext* tab = nullptr;
    for (int i = 0; i < ctx->tab_count; i++) {
        if (ctx->tabs[i].id == tab_id) { tab = &ctx->tabs[i]; break; }
    }
    if (!tab) return;

    if (tab_has_pty(tab->type) && tab->pty_id >= 0) {
        terminal_open(tab->pty_id, tab->label ? tab->label : "pty");
    }
    // Editor / browser / file tabs just move focus on the host; Dirigible
    // does not try to render them.
}

}  // namespace

void tabs_build(lv_obj_t* parent)
{
    auto& a = app();

    a.view_tabs = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_tabs);
    lv_obj_set_pos(a.view_tabs, 0, 0);
    lv_obj_set_size(a.view_tabs, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_tabs, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(a.view_tabs, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_tabs, LV_OBJ_FLAG_SCROLLABLE);

    a.tab_list = lv_list_create(a.view_tabs);
    lv_obj_set_pos(a.tab_list, 2, 2);
    lv_obj_set_size(a.tab_list, SCREEN_W - 4, BODY_H - 4);
    lv_obj_set_style_bg_color(a.tab_list, lv_color_black(), 0);
    lv_obj_set_style_border_width(a.tab_list, 0, 0);
    lv_obj_set_style_pad_all(a.tab_list, 0, 0);
    lv_obj_set_style_pad_row(a.tab_list, 2, 0);
    lv_obj_set_style_text_font(a.tab_list, mono_font(), 0);

    lv_obj_add_flag(a.view_tabs, LV_OBJ_FLAG_HIDDEN);
}

namespace {

/// One 26 px tab row: type badge, focus marker, label, PTY hint.
void tab_row(lv_obj_t* list, const dirigible::TabContext& t, int index)
{
    const bool active = t.state && strcmp(t.state, "active") == 0;

    lv_obj_t* btn = lv_btn_create(list);
    lv_obj_remove_style_all(btn);
    lv_obj_set_width(btn, LV_PCT(100));
    lv_obj_set_height(btn, 26);
    lv_obj_set_style_bg_opa(btn, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(btn, active ? lv_color_hex(0x1c1c22)
                                          : lv_color_hex(0x121212), 0);
    lv_obj_set_style_bg_color(btn, lv_color_hex(0x2f5fa8), LV_STATE_FOCUSED);
    lv_obj_set_style_radius(btn, 2, 0);
    lv_obj_set_style_pad_all(btn, 0, 0);
    lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);

    // badge: x 3..57 (54 px, 6 mono chars + 3 px padding either side)
    lv_obj_t* badge = lv_obj_create(btn);
    lv_obj_remove_style_all(badge);
    lv_obj_set_size(badge, 54, 14);
    lv_obj_set_style_bg_opa(badge, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(badge, tab_colour(t.type), 0);
    lv_obj_set_style_radius(badge, 2, 0);
    lv_obj_clear_flag(badge, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_align(badge, LV_ALIGN_LEFT_MID, 3, 0);

    char badge_text[8];
    snprintf(badge_text, sizeof(badge_text), "%.6s", t.type ? t.type : "tab");
    lv_obj_t* bl = make_label(badge, badge_text, lv_color_white());
    lv_obj_center(bl);

    // focus marker at x 60, label from x 70
    lv_obj_t* mark = make_label(btn, active ? ">" : " ",
                                lv_palette_main(LV_PALETTE_GREEN));
    lv_obj_align(mark, LV_ALIGN_LEFT_MID, 60, 0);

    const bool pty = tab_has_pty(t.type) && t.pty_id >= 0;
    lv_obj_t* label = make_label(btn, t.label ? t.label : "(unnamed)",
                                 active ? lv_color_white() : lv_color_hex(0xBBBBBB));
    lv_label_set_long_mode(label, LV_LABEL_LONG_DOT);
    // 70 left, 34 px reserved on the right for the "pty" hint + 4 px margin.
    lv_obj_set_width(label, SCREEN_W - 4 - 70 - (pty ? 34 : 4));
    lv_obj_align(label, LV_ALIGN_LEFT_MID, 70, 0);

    if (pty) {
        lv_obj_t* hint = make_label(btn, "pty", lv_color_hex(0x707070));
        lv_obj_align(hint, LV_ALIGN_RIGHT_MID, -4, 0);
    }

    lv_obj_add_event_cb(btn, row_clicked, LV_EVENT_CLICKED,
                        (void*)(intptr_t)index);
    if (app().group) lv_group_add_obj(app().group, btn);
}

/// Full-width message panel used for the empty and disconnected states.
void tabs_state_panel(const char* title, const char* body, bool offer_repair)
{
    auto& a = app();
    lv_obj_t* panel = lv_obj_create(a.tab_list);
    lv_obj_remove_style_all(panel);
    lv_obj_set_width(panel, LV_PCT(100));
    lv_obj_set_height(panel, 120);
    lv_obj_set_style_pad_all(panel, 6, 0);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* h = make_label(panel, title, lv_color_white());
    lv_label_set_long_mode(h, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(h, SCREEN_W - 20);
    lv_obj_set_pos(h, 0, 0);

    lv_obj_t* b = make_label(panel, body, lv_color_hex(0x888888));
    lv_label_set_long_mode(b, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(b, SCREEN_W - 20);
    lv_obj_set_pos(b, 0, 16);

    if (!offer_repair) return;

    lv_obj_t* btn = lv_btn_create(panel);
    lv_obj_set_pos(btn, 0, 62);
    lv_obj_set_size(btn, 90, 22);
    lv_obj_set_style_bg_color(btn, lv_color_hex(0x2f5fa8), 0);
    lv_obj_set_style_radius(btn, 2, 0);
    lv_obj_t* l = lv_label_create(btn);
    lv_label_set_text(l, "Re-pair");
    lv_obj_set_style_text_font(l, mono_font(), 0);
    lv_obj_center(l);
    lv_obj_add_event_cb(btn, [](lv_event_t*) { pairing_begin(); },
                        LV_EVENT_CLICKED, nullptr);
    if (a.group) lv_group_add_obj(a.group, btn);

    lv_obj_t* btn2 = lv_btn_create(panel);
    lv_obj_set_pos(btn2, 96, 62);
    lv_obj_set_size(btn2, 100, 22);
    lv_obj_set_style_bg_color(btn2, lv_color_hex(0x262626), 0);
    lv_obj_set_style_radius(btn2, 2, 0);
    lv_obj_t* l2 = lv_label_create(btn2);
    lv_label_set_text(l2, "Reconnect");
    lv_obj_set_style_text_font(l2, mono_font(), 0);
    lv_obj_center(l2);
    lv_obj_add_event_cb(btn2, [](lv_event_t*) { connect_active_machine(); },
                        LV_EVENT_CLICKED, nullptr);
    if (a.group) lv_group_add_obj(a.group, btn2);
}

}  // namespace

void tabs_render(const dirigible::LeeContext* ctx)
{
    auto& a = app();
    if (!a.tab_list) return;

    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    if (m) chrome_set_title(m->config.name.c_str());

    auto* conn = a.machines ? a.machines->activeConnection() : nullptr;
    const bool online = conn && conn->isConnected();

    if (ctx && ctx->activity) {
        char buf[32];
        snprintf(buf, sizeof(buf), "idle %ds", (int)ctx->activity->idle_seconds);
        chrome_set_centre(buf);
    }

    // Rebuilding the list drops LVGL focus; only do it when the tab set
    // actually changed (or the link state flipped, which swaps the whole view
    // for the disconnected panel).
    static bool was_online = false;
    bool changed = !ctx || (int)a.tab_ids.size() != ctx->tab_count ||
                   online != was_online;
    if (!changed && ctx) {
        for (int i = 0; i < ctx->tab_count; i++) {
            if (a.tab_ids[i] != ctx->tabs[i].id) { changed = true; break; }
        }
    }
    if (!changed) return;
    was_online = online;

    lv_obj_clean(a.tab_list);
    a.tab_ids.clear();

    if (!online) {
        char body[128];
        if (m) {
            snprintf(body, sizeof(body),
                     "%s:%d is not answering.\nCheck Lee is running, then\nReconnect - or Re-pair if\nthe token changed.",
                     m->config.host.c_str(), m->config.lee_port);
        } else {
            snprintf(body, sizeof(body),
                     "No machine stored.\nRe-pair to add one.");
        }
        tabs_state_panel(m ? m->config.name.c_str() : "Not paired", body, true);
        chrome_set_centre("disconnected");
        return;
    }

    if (!ctx || ctx->tab_count == 0) {
        tabs_state_panel("Connected", "No tabs open in Lee yet.", false);
        return;
    }

    a.tab_ids.reserve(ctx->tab_count);
    for (int i = 0; i < ctx->tab_count; i++) {
        tab_row(a.tab_list, ctx->tabs[i], i);
        a.tab_ids.push_back(ctx->tabs[i].id);
    }
}

}  // namespace dirigible_app
