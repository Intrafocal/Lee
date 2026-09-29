/*
 * screen_tether.cpp — Tether on the T-Deck (docs/14-Deep-Work.md §8.1;
 * plan 2026-09-28 §3.2): where you stopped at the Desk, as the Pick up block
 * at the top of Work.  Library, the page of its own this used to be, is gone;
 * reading the Page itself is Review's job, in the markdown viewer.
 *
 * Data: Lee's GET /tether for the followed window's workspace, fetched when
 * Work opens, when the link comes up, and after a capture:
 *
 *   pick_up         your last Desk card, its Area and your stopped-at line
 *   open_questions  up to five, each naming its card
 *
 * The block, drawn inside Work's body when nothing needs you (an item that
 * does is the one next step and keeps the page):
 *
 *   +------------------------------------------------------------+
 *   | PICK UP  *  DEVICES                    2 open questions    |  eyebrow
 *   | Tether the T-Deck                                          |  the card
 *   | The pager should hold one thought, not three.  Next: wh... |  your words,
 *   | ...                                                        |  italic, 2 lines
 *   +------------------------------------------------------------+
 *
 * Your words are in Montserrat italic (dg::ui_font_italic): the T-Deck's
 * stand-in for the Newsreader Lee and Aeronaut use (design rule 3).  Enter,
 * p, a tap or a ball click on the block opens the Page in the viewer at the
 * stopped-at line; back from it lands in Review.  With Hester offline, an
 * older Lee, or nothing on the Desk yet, the block simply isn't there.
 */

#include <string>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

[[maybe_unused]] static const char* TAG = "dirigible.tether";

namespace dirigible_app {

namespace {

using dirigible::TetherState;

const lv_font_t* const F_META   = dg::ui_font_small();
const lv_font_t* const F_BODY   = dg::ui_font();
const lv_font_t* const F_WRITER = dg::ui_font_italic();

constexpr int PAD      = 6;
constexpr int INSET    = 6;                  // text inside the block
constexpr int EB_Y     = 3;
constexpr int TITLE_Y  = 19;
constexpr int STOP_Y   = 38;
constexpr int STOP_LINE_H = 18;              // the italic's 16 px line + 2
constexpr int H_SHORT  = TITLE_Y + 17 + 4;   // no stopped-at line: 40
constexpr int H_FULL   = STOP_Y + 2 * STOP_LINE_H + 2;   // 76

enum class Load : uint8_t { Idle, Loading, Ok, Offline, Missing, Failed };

struct State {
    lv_obj_t* block   = nullptr;
    lv_obj_t* eyebrow = nullptr;
    lv_obj_t* count   = nullptr;
    lv_obj_t* title   = nullptr;
    lv_obj_t* stopped = nullptr;

    TetherState tether;
    Load load = Load::Idle;
    int  gen  = 0;       // bumped per fetch; stale answers are dropped
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

#if DIRIGIBLE_UI_DEMO
void demo_fill(TetherState& t)
{
    t = TetherState();
    t.workspace = "/ws/lee";
    t.has_pick_up = true;
    t.pick_up_id = "pg-0000ca77";
    t.pick_up_kind = "page";
    t.pick_up_title = "Tether the T-Deck";
    t.area_name = "Devices";
    t.stopped_line = 12;
    t.stopped_at = "The pager should hold one thought, not three. Next: what Review "
                   "says when there's nothing on the Desk.";
    t.questions.push_back({ "pg-0000ca77", "q1", "Is v the right key for Review?" });
    t.questions.push_back({ "pg-0000ca77", "q2", "Would a voice capture on the walk beat typing?" });
    t.captured_count = 2;
}
#endif

void open_cb(lv_event_t*) { pick_up_open(); }

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void tether_fetch()
{
    auto& s = st();
    const int gen = ++s.gen;
#if DIRIGIBLE_UI_DEMO
    demo_fill(s.tether);
    s.load = Load::Ok;
    (void)gen;
    if (app().view == View::Waiting) waiting_render();
#else
    auto* c = conn();
    if (!c || !c->isConnected()) { s.load = Load::Idle; return; }
    if (s.load != Load::Ok) s.load = Load::Loading;
    c->fetchTether([gen](int status, const TetherState* t) {
        auto& s = st();
        if (gen != s.gen) return;   // a newer fetch is on its way
        if (t) {
            s.tether = *t;
            s.load = Load::Ok;
        } else if (status == 503) {
            s.load = Load::Offline;
        } else if (status == 404) {
            s.load = Load::Missing;   // a Lee from before /tether
        } else {
            ESP_LOGW(TAG, "tether: HTTP %d", status);
            s.load = Load::Failed;
        }
        if (app().view == View::Waiting) waiting_render();
    });
#endif
}

void pick_up_build(lv_obj_t* parent, int y)
{
    auto& s = st();
    s.block = lv_btn_create(parent);
    lv_obj_remove_style_all(s.block);
    lv_obj_set_pos(s.block, PAD, y);
    lv_obj_set_size(s.block, SCREEN_W - 2 * PAD, H_FULL);
    lv_obj_set_style_bg_opa(s.block, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.block, dg::ground1(), 0);
    lv_obj_set_style_bg_color(s.block, dg::ground3(), LV_STATE_PRESSED);
    lv_obj_set_style_radius(s.block, DG_RADIUS, 0);
    lv_obj_set_style_border_width(s.block, 1, 0);
    lv_obj_set_style_border_color(s.block, dg::ground4(), 0);
    lv_obj_set_style_border_opa(s.block, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s.block, LV_OBJ_FLAG_SCROLLABLE);
    dg::style_focus(s.block, dg::ground1());   // the ball's highlight
    lv_obj_add_event_cb(s.block, open_cb, LV_EVENT_CLICKED, nullptr);

    const int inner = SCREEN_W - 2 * PAD - 2 * INSET - 2;

    s.eyebrow = make_label(s.block, "PICK UP", dg::text3(), F_META);
    lv_obj_set_style_text_letter_space(s.eyebrow, 1, 0);
    lv_label_set_long_mode(s.eyebrow, LV_LABEL_LONG_DOT);
    lv_obj_set_pos(s.eyebrow, INSET, EB_Y);

    s.count = make_label(s.block, "", dg::text3(), F_META);
    lv_obj_align(s.count, LV_ALIGN_TOP_RIGHT, -INSET, EB_Y);

    s.title = make_label(s.block, "", dg::text1(), F_BODY);
    lv_label_set_long_mode(s.title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.title, inner);
    lv_obj_set_pos(s.title, INSET, TITLE_Y);

    // Two lines of your words, then an ellipsis: LONG_DOT on a label of
    // fixed height dots the last line that fits.
    s.stopped = make_label(s.block, "", dg::text1(), F_WRITER);
    lv_label_set_long_mode(s.stopped, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_line_space(s.stopped, 2, 0);
    lv_obj_set_size(s.stopped, inner, 2 * STOP_LINE_H - 2);
    lv_obj_set_pos(s.stopped, INSET, STOP_Y);

    lv_obj_add_flag(s.block, LV_OBJ_FLAG_HIDDEN);
}

lv_obj_t* pick_up_obj()
{
    return st().block;
}

int pick_up_render(bool show)
{
    auto& s = st();
    if (!s.block) return 0;
    const TetherState& t = s.tether;
    if (!show || s.load != Load::Ok || !t.has_pick_up) {
        lv_obj_add_flag(s.block, LV_OBJ_FLAG_HIDDEN);
        return 0;
    }

    // The Area, when Lee knows it, rides on the eyebrow: "PICK UP  *  MESH".
    std::string eb = "PICK UP";
    if (!t.area_name.empty()) {
        std::string area = ui_fold(t.area_name);
        if (area.size() > 24) area.resize(24);
        for (auto& ch : area) ch = (char)((ch >= 'a' && ch <= 'z') ? ch - 'a' + 'A' : ch);
        eb += "  " LV_SYMBOL_BULLET "  " + area;
    }
    lv_label_set_text(s.eyebrow, eb.c_str());

    const int n = t.questions_for(t.pick_up_id);
    std::string count;
    if (n > 0) count = std::to_string(n) + (n == 1 ? " open question" : " open questions");
    lv_label_set_text(s.count, count.c_str());
    lv_obj_update_layout(s.count);
    lv_obj_set_width(s.eyebrow, SCREEN_W - 2 * PAD - 2 * INSET - 2 - lv_obj_get_width(s.count) - 8);

    ui_set_text(s.title, t.pick_up_title.empty() ? std::string("Your last Page") : t.pick_up_title);

    const bool words = !t.stopped_at.empty();
    if (words) {
        // One paragraph: a stopped-at note with line breaks still reads as two lines.
        std::string line = t.stopped_at;
        for (auto& ch : line) if (ch == '\n' || ch == '\r') ch = ' ';
        ui_set_text(s.stopped, line);
        lv_obj_clear_flag(s.stopped, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s.stopped, LV_OBJ_FLAG_HIDDEN);
    }
    const int h = words ? H_FULL : H_SHORT;
    lv_obj_set_height(s.block, h);
    lv_obj_clear_flag(s.block, LV_OBJ_FLAG_HIDDEN);
    return h;
}

bool pick_up_open()
{
    auto& s = st();
    if (s.load != Load::Ok || !s.tether.has_pick_up) return false;
    const TetherState& t = s.tether;
    viewer_open_page(t.pick_up_id, t.pick_up_title, View::Review,
                     t.stopped_line > 0 ? t.stopped_line : 0);
    return true;
}

}  // namespace dirigible_app
