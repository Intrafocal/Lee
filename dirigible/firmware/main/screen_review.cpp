/*
 * screen_review.cpp — Review (plan 2026-09-28 §3.2): reading what you wrote
 * at the Desk, away from it.  Read-only, like everything on the device.
 *
 * Data: Lee's GET /tether/pages?limit=50 for the followed window's workspace:
 * every Page, stashed ones too, newest first.  Fetched when the view opens and
 * on r; back from a Page keeps the list and its highlight.
 *
 *   +------------------------------------------------------------+
 *   | Mesh sync                                                  |  the Page
 *   | Mesh  *  Sep 28  *  2 open questions                       |  Area, day,
 *   +------------------------------------------------------------+  questions
 *   | Tether the T-Deck                                          |
 *   | Devices  *  Sep 27                                         |
 *   +------------------------------------------------------------+
 *   | ...                                                        |
 *   +------------------------------------------------------------+
 *   | Files                                                      |  then the
 *   | The workspace tree                                         |  tree (f)
 *   +------------------------------------------------------------+
 *
 * j / k or the ball move the highlight, Enter / a click / a tap opens it: a
 * Page's markdown in the viewer (GET /tether/pages/:id?text_only=1), or
 * Files.  The day is UTC from Lee's updated_at: the device keeps no clock of
 * its own, so "3h ago" would be a guess.
 */

#include <cstdio>
#include <ctime>
#include <string>
#include <vector>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

[[maybe_unused]] static const char* TAG = "dirigible.review";

namespace dirigible_app {

namespace {

using dirigible::TetherCard;

const lv_font_t* const F_META  = dg::ui_font_small();
const lv_font_t* const F_BODY  = dg::ui_font();
const lv_font_t* const F_TITLE = dg::ui_font_title();

constexpr int ROW_H = 36;
constexpr int FILES_ROW = -1;   // user data of the Files row

enum class Load : uint8_t { Idle, Loading, Ok, Offline, Missing, Failed };

struct State {
    lv_obj_t* list = nullptr;

    std::vector<TetherCard> pages;
    Load        load = Load::Idle;
    int         gen = 0;
    std::string sel_id;          // the highlighted Page, kept across refetches
    bool        sel_files = false;
};

State& st()
{
    static State s;
    return s;
}

[[maybe_unused]] dirigible::LeeConnection* conn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
}

std::string fmt_day(int64_t ms)
{
    if (ms <= 0) return "";
    time_t t = (time_t)(ms / 1000);
    struct tm tmv;
    gmtime_r(&t, &tmv);
    char buf[12];
    strftime(buf, sizeof(buf), "%b %d", &tmv);
    return buf;
}

void footer()
{
    if (app().view != View::Review) return;
    chrome_set_footer("j/k pages  f Files  r reload", "review");
    chrome_set_centre(cockpit_status().c_str());
}

void row_cb(lv_event_t* e)
{
    auto& s = st();
    const int i = (int)(intptr_t)lv_event_get_user_data(e);
    if (i == FILES_ROW) {
        s.sel_files = true;
        files_open(View::Review);
        return;
    }
    if (i < 0 || i >= (int)s.pages.size()) return;
    const TetherCard& c = s.pages[i];
    s.sel_id = c.id;
    s.sel_files = false;
    viewer_open_page(c.id, c.title, View::Review);
}

lv_obj_t* add_row(lv_obj_t* list, const std::string& title, const std::string& meta, int index,
                  bool dim)
{
    lv_obj_t* btn = lv_btn_create(list);
    lv_obj_remove_style_all(btn);
    lv_obj_set_size(btn, LV_PCT(100), ROW_H);
    dg::style_row(btn, dg::ground1());
    dg::style_focus(btn);
    lv_obj_set_style_pad_all(btn, 0, 0);
    lv_obj_clear_flag(btn, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* t = make_label(btn, title.c_str(), dim ? dg::text2() : dg::text1(), F_BODY);
    lv_label_set_long_mode(t, LV_LABEL_LONG_DOT);
    lv_obj_set_width(t, SCREEN_W - 4 - 12);
    lv_obj_set_pos(t, 6, 1);

    lv_obj_t* m = make_label(btn, meta.c_str(), dg::text3(), F_META);
    lv_label_set_long_mode(m, LV_LABEL_LONG_DOT);
    lv_obj_set_width(m, SCREEN_W - 4 - 12);
    lv_obj_set_pos(m, 6, 19);

    lv_obj_add_event_cb(btn, row_cb, LV_EVENT_CLICKED, (void*)(intptr_t)index);
    if (app().group) lv_group_add_obj(app().group, btn);
    return btn;
}

void message(lv_obj_t* list, const char* title, const char* body)
{
    lv_obj_t* panel = lv_obj_create(list);
    lv_obj_remove_style_all(panel);
    lv_obj_set_width(panel, LV_PCT(100));
    lv_obj_set_height(panel, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(panel, 6, 0);
    lv_obj_set_style_pad_row(panel, 6, 0);
    lv_obj_set_flex_flow(panel, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(panel, LV_OBJ_FLAG_CLICKABLE);

    lv_obj_t* h = make_label(panel, title, dg::text1(), F_TITLE);
    lv_label_set_long_mode(h, LV_LABEL_LONG_DOT);
    lv_obj_set_width(h, SCREEN_W - 20);
    if (body && *body) {
        lv_obj_t* b = make_label(panel, body, dg::text2(), F_META);
        lv_label_set_long_mode(b, LV_LABEL_LONG_WRAP);
        lv_obj_set_width(b, SCREEN_W - 20);
    }
}

void render()
{
    auto& s = st();
    if (!s.list) return;
    lv_obj_clean(s.list);   // rows leave the input group with their objects

    lv_obj_t* focus = nullptr;
    if (!cockpit_linked()) {
        message(s.list, "Not connected", "Connect to Lee.  Files needs it too.");
    } else if (s.load == Load::Loading && s.pages.empty()) {
        message(s.list, "Loading...", "");
    } else if (s.load == Load::Offline) {
        message(s.list, "Hester is offline", "Your Pages come back when it does.  Files still works.");
    } else if (s.load == Load::Missing) {
        message(s.list, "This Lee is too old", "Update Lee to read your Pages here.  Files still works.");
    } else if (s.load == Load::Failed && s.pages.empty()) {
        message(s.list, "Couldn't load your Pages", "r tries again.");
    } else if (s.pages.empty() && s.load == Load::Ok) {
        message(s.list, "Nothing on the Desk yet",
                "Pages you write at the Desk show up here.  c captures a thought to Ideas.");
    }

    for (int i = 0; i < (int)s.pages.size(); i++) {
        const TetherCard& c = s.pages[i];
        std::string meta;
        auto add = [&](const std::string& part) {
            if (part.empty()) return;
            if (!meta.empty()) meta += "  " LV_SYMBOL_BULLET "  ";
            meta += part;
        };
        add(c.area_name.empty() ? std::string() : ui_fold(c.area_name));
        add(fmt_day(c.updated_ms));
        if (c.open_questions > 0) {
            add(std::to_string(c.open_questions) +
                (c.open_questions == 1 ? " open question" : " open questions"));
        }
        if (c.stashed) add("stashed");
        lv_obj_t* row = add_row(s.list, c.title.empty() ? std::string("Untitled") : c.title,
                                meta, i, c.stashed);
        if (!s.sel_files && c.id == s.sel_id) focus = row;
    }

    lv_obj_t* files = add_row(s.list, "Files", "The workspace tree", FILES_ROW, false);
    if (s.sel_files) focus = files;

    if (focus && app().group) {
        lv_group_focus_obj(focus);
        lv_obj_scroll_to_view(focus, LV_ANIM_OFF);
    }
    footer();
}

#if DIRIGIBLE_UI_DEMO
void demo_fill(std::vector<TetherCard>& pages)
{
    pages.clear();
    auto card = [&](const char* id, const char* title, const char* area, int64_t ms, int q, bool stashed) {
        TetherCard c;
        c.id = id;
        c.kind = "page";
        c.title = title;
        c.area_name = area;
        c.updated_ms = ms;
        c.open_questions = q;
        c.stashed = stashed;
        pages.push_back(c);
    };
    card("pg-0000ca77", "Tether the T-Deck", "Devices", 1790590000000LL, 2, false);
    card("pg-00000b0e", "Mesh sync", "Mesh", 1790500000000LL, 1, false);
    card("pg-000011aa", "Voice on the walk", "Devices", 1790400000000LL, 0, false);
    card("pg-000022bb", "Old launch notes", "", 1780000000000LL, 0, true);
}
#endif

void fetch()
{
    auto& s = st();
    const int gen = ++s.gen;
    s.load = Load::Loading;
#if DIRIGIBLE_UI_DEMO
    demo_fill(s.pages);
    s.load = Load::Ok;
    (void)gen;
    render();
#else
    auto* c = conn();
    if (!c || !c->isConnected()) { s.load = Load::Idle; render(); return; }
    render();
    c->fetchTetherPages([gen](int status, const std::vector<TetherCard>* pages) {
        auto& s = st();
        if (gen != s.gen) return;
        if (pages) {
            s.pages = *pages;
            s.load = Load::Ok;
        } else if (status == 503) {
            s.load = Load::Offline;
        } else if (status == 404) {
            s.load = Load::Missing;
        } else {
            ESP_LOGW(TAG, "pages: HTTP %d", status);
            s.load = Load::Failed;
        }
        if (app().view == View::Review) render();
    });
#endif
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void review_build(lv_obj_t* parent)
{
    auto& a = app();
    auto& s = st();
    a.view_review = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_review);
    lv_obj_set_pos(a.view_review, 0, 0);
    lv_obj_set_size(a.view_review, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_review, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(a.view_review, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_review, LV_OBJ_FLAG_SCROLLABLE);

    s.list = lv_obj_create(a.view_review);
    lv_obj_remove_style_all(s.list);
    lv_obj_set_pos(s.list, 2, 2);
    lv_obj_set_size(s.list, SCREEN_W - 4, BODY_H - 4);
    lv_obj_set_style_pad_row(s.list, 2, 0);
    lv_obj_set_flex_flow(s.list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(s.list, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.list, LV_SCROLLBAR_MODE_AUTO);
    lv_obj_set_style_bg_color(s.list, dg::ground5(), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(s.list, LV_OPA_COVER, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(s.list, 3, LV_PART_SCROLLBAR);

    lv_obj_add_flag(a.view_review, LV_OBJ_FLAG_HIDDEN);
}

void review_open()
{
    app_show(View::Review);
    render();
    fetch();
}

void review_show()
{
    app_show(View::Review);
    render();
}

bool review_key(uint8_t k)
{
    auto& s = st();
    if (k == 0x1B) { app_back(); return true; }
    if (cockpit_nav_key(k)) return true;
    switch (k) {
    case 'j': ball_list(s.list, BALL_ROW_DETENTS, false);  return true;
    case 'k': ball_list(s.list, -BALL_ROW_DETENTS, false); return true;
    case '\r': case '\n':
        // The group's focus may be anything (the header button, another
        // view's row): only a row of this list opens, else it highlights one.
        ball_list(s.list, 0, true);
        return true;
    case ' ': case 'b': {
        const int h = BODY_H - ROW_H;
        lv_obj_scroll_by_bounded(s.list, 0, k == ' ' ? -h : h, LV_ANIM_OFF);
        return true;
    }
    case 'f': s.sel_files = true; files_open(View::Review); return true;
    case 'r': fetch(); return true;
    case 'c': waiting_open_capture(); return true;
    case 't': app_show(View::Tabs); return true;
    case '\t': return false;
    default:  return true;   // nothing strays into a hidden widget
    }
}

void review_ball(int, int dy, bool click)
{
    ball_list(st().list, dy, click);
}

}  // namespace dirigible_app
