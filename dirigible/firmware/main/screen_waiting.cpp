/*
 * screen_waiting.cpp — Lee's attention queue: what is waiting on you, with
 * Reply and Capture (Copilot v0; docs/plans/2026-09-25-copilot-v0-v1-
 * contracts.md §5, §9.3).  The default view once a machine is connected.
 *
 * Data: LeeConnection keeps the compact AttentionSnapshot, pushed as
 * `attention_snapshot` on the existing /context/stream socket and fetched with
 * GET /attention?compact=1 on connect.  Nothing here polls.  The device is
 * pull-first: the only alert is a header blink when an item's `notify` flips
 * from false to true (§5.4).
 *
 * Layout, inside the 320x204 body:
 *
 *   y   0..23   capture field: type an idea, Enter sends it to Someday
 *   y  26..201  8 rows x 22 px, a fixed pool re-labelled as the list moves
 *
 *   row:  |▌ Claude wants to use Bash ................... 4m |
 *         |▌ Claude 1 · approval                            |
 *          ^ severity: error = blocking, ember = needs you, deep = ambient
 *
 * Selecting an item opens its detail over the list: the agent's own words,
 * then Approve / Deny (y / n) for an approval, or a reply field (Enter sends)
 * for anything that takes text.  Every reply echoes the item's version; a 409
 * means the item moved on, so the queue is refetched and nothing is resent —
 * the human decides again (C3).
 *
 * Keys: j/k or the ball move, Enter or a click opens, c captures, t shows the
 * tab list, r refetches, Esc steps back (detail -> list -> menu).
 */

#include <cstdio>
#include <cstring>
#include <string>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"

static const char* TAG = "dirigible.waiting";

namespace dirigible_app {

namespace {

constexpr int CAP_H   = 24;
constexpr int LIST_Y  = CAP_H + 2;
constexpr int ROW_H   = 22;
constexpr int ROWS    = (BODY_H - LIST_Y) / ROW_H;   // 8
constexpr int REPLY_H = 26;
constexpr int REPLY_MAX = 400;
constexpr int CAPTURE_MAX = 400;

enum class Mode { List, Capture, Detail };

struct Slot {
    lv_obj_t* btn;
    lv_obj_t* bar;
    lv_obj_t* title;
    lv_obj_t* meta;
    lv_obj_t* age;
};

struct State {
    lv_obj_t* capture = nullptr;
    lv_obj_t* empty   = nullptr;   // message shown instead of rows
    Slot      slots[ROWS] = {};

    lv_obj_t* detail       = nullptr;
    lv_obj_t* d_title      = nullptr;
    lv_obj_t* d_meta       = nullptr;
    lv_obj_t* d_scroll     = nullptr;
    lv_obj_t* d_text       = nullptr;
    lv_obj_t* d_reply      = nullptr;

    Mode        mode = Mode::List;
    int         sel  = 0;
    int         top  = 0;
    std::string sel_id;        // keeps the selection across snapshots
    std::string detail_id;
    int         detail_version = -1;
    bool        busy = false;  // a reply or capture is in flight

    uint32_t    snapshot_tick = 0;   // lv_tick when the snapshot arrived

    std::string device_for;    // machine the cached device id belongs to
    std::string device_id;
    // Set only once a reply actually comes back 403 (contracts §4.4): an
    // empty `device_id` alone just means a typed token whose id we never
    // learned (screen_pairing.cpp's manual-token path saves it with no
    // device_id — see save_machine(raw, "", ...)), not necessarily the
    // legacy shared token. Don't tell the user to re-pair until a write
    // has actually been rejected.
    bool        reply_forbidden = false;

    lv_timer_t* blink = nullptr;
    int         blink_left = 0;
};

State& st()
{
    static State s;
    return s;
}

dirigible::LeeConnection* conn()
{
    auto& a = app();
    return a.machines ? a.machines->activeConnection() : nullptr;
}

const dirigible::AttentionSnapshot* snapshot()
{
    auto* c = conn();
    return c && c->attentionAvailable() ? &c->attention() : nullptr;
}

const dirigible::AttentionItem* item_at(int i)
{
    const auto* s = snapshot();
    if (!s || i < 0 || i >= (int)s->items.size()) return nullptr;
    return &s->items[i];
}

const dirigible::AttentionItem* detail_item()
{
    const auto* s = snapshot();
    return s ? s->find(st().detail_id) : nullptr;
}

/// The unscii fonts are ASCII only.  Fold the punctuation agents actually use
/// and mark anything else, one '?' per code point.
std::string ascii(const std::string& in, bool keep_newlines)
{
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size();) {
        const unsigned char c = (unsigned char)in[i];
        if (c < 0x80) {
            if (c == '\n' && keep_newlines)      out += '\n';
            else if (c == '\t' || c == '\n' || c == '\r') out += ' ';
            else if (c >= 0x20 && c < 0x7F)      out += (char)c;
            i++;
            continue;
        }
        int len = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        if (i + len > in.size()) len = (int)(in.size() - i);
        const std::string cp = in.substr(i, len);
        if      (cp == "\xE2\x80\x98" || cp == "\xE2\x80\x99") out += '\'';
        else if (cp == "\xE2\x80\x9C" || cp == "\xE2\x80\x9D") out += '"';
        else if (cp == "\xE2\x80\x93" || cp == "\xE2\x80\x94") out += '-';
        else if (cp == "\xE2\x80\xA6")                           out += "...";
        else if (cp == "\xC2\xB7" || cp == "\xE2\x80\xA2")       out += '*';
        else if (cp == "\xE2\x86\x92")                           out += "->";
        else                                                     out += '?';
        i += len;
    }
    return out;
}

std::string fmt_age(int64_t ms)
{
    if (ms < 0) return "";
    const int64_t m = ms / 60000;
    char b[12];
    if (m < 1)            return "now";
    if (m < 60)           snprintf(b, sizeof(b), "%dm", (int)m);
    else if (m < 48 * 60) snprintf(b, sizeof(b), "%dh", (int)(m / 60));
    else                  snprintf(b, sizeof(b), "%dd", (int)(m / 1440));
    return b;
}

int64_t live_age(const dirigible::AttentionItem& it)
{
    if (it.age_ms < 0) return -1;
    return it.age_ms + (int64_t)lv_tick_elaps(st().snapshot_tick);
}

lv_color_t severity_colour(const dirigible::AttentionItem& it)
{
    if (it.parked) return dg::ground5();
    switch (it.severity) {
    case dirigible::AttentionSeverity::Blocking: return dg::error();
    case dirigible::AttentionSeverity::NeedsYou: return dg::ember();
    default:                                     return dg::phosphor_deep();
    }
}

const std::string& device_id()
{
    auto& s = st();
    auto& a = app();
    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    const std::string name = m ? m->config.name : std::string();
    if (name != s.device_for) {
        s.device_for = name;
        s.device_id = name.empty() || !a.config ? "" : a.config->getDeviceId(name);
    }
    return s.device_id;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

void render_list();
void render_detail();
void close_detail();

void set_capture_active(bool on)
{
    auto& a = app();
    auto& s = st();
    if (!a.group || !s.capture) return;
    if (on) {
        lv_group_add_obj(a.group, s.capture);
        lv_group_focus_obj(s.capture);
    } else {
        lv_group_remove_obj(s.capture);
        lv_obj_clear_state(s.capture, LV_STATE_FOCUSED);
    }
}

void set_reply_active(bool on)
{
    auto& a = app();
    auto& s = st();
    if (!a.group || !s.d_reply) return;
    if (on) {
        lv_group_add_obj(a.group, s.d_reply);
        lv_group_focus_obj(s.d_reply);
    } else {
        lv_group_remove_obj(s.d_reply);
        lv_obj_clear_state(s.d_reply, LV_STATE_FOCUSED);
    }
}

void send_reply(const char* action);

void approve_cb(lv_event_t*) { send_reply("approve"); }
void deny_cb(lv_event_t*)    { send_reply("deny"); }
void send_cb(lv_event_t*)    { send_reply("text"); }
void tabs_cb(lv_event_t*)    { app_show(View::Tabs); }
void capture_btn_cb(lv_event_t*) { waiting_open_capture(); }

void centre_status()
{
    if (app().view != View::Waiting) return;
    auto* c = conn();
    const auto* snap = snapshot();
    char buf[32];
    if (!c || !c->isConnected()) {
        snprintf(buf, sizeof(buf), "disconnected");
    } else if (!snap) {
        snprintf(buf, sizeof(buf), c->attentionUnsupported() ? "no queue" : "loading");
    } else {
        snprintf(buf, sizeof(buf), "%d waiting%s", snap->waiting(),
                 snap->away_active ? " away" : snap->focus_active ? " focus" : "");
    }
    chrome_set_centre(buf);
}

void chrome_for_mode()
{
    auto& s = st();
    if (app().view != View::Waiting) return;
    chrome_clear_footer_buttons();
    switch (s.mode) {
    case Mode::List:
        chrome_set_footer("Enter open  c capture", "queue");
        chrome_add_footer_button("Cap", capture_btn_cb, nullptr);
        chrome_add_footer_button("Tabs", tabs_cb, nullptr);
        break;
    case Mode::Capture:
        chrome_set_footer("Enter capture  Esc cancel", "idea");
        break;
    case Mode::Detail: {
        const auto* it = detail_item();
        if (it && it->can(dirigible::ActApprove)) {
            chrome_set_footer("y approve  n deny", nullptr);
            chrome_add_footer_button("Approve", approve_cb, nullptr);
            if (it->can(dirigible::ActDeny)) chrome_add_footer_button("Deny", deny_cb, nullptr);
        } else if (it && it->can(dirigible::ActReply)) {
            chrome_set_footer("Enter send  Esc back", nullptr);
            chrome_add_footer_button("Send", send_cb, nullptr);
        } else {
            chrome_set_footer("Esc back", "item");
        }
        break;
    }
    }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

void show_empty(const char* text)
{
    auto& s = st();
    for (auto& slot : s.slots) lv_obj_add_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
    lv_label_set_text(s.empty, text);
    lv_obj_clear_flag(s.empty, LV_OBJ_FLAG_HIDDEN);
}

void render_list()
{
    auto& s = st();
    auto* c = conn();
    auto& a = app();

    if (!c || !c->isConnected()) {
        char body[160];
        auto* m = a.machines ? a.machines->activeMachine() : nullptr;
        if (m) {
            snprintf(body, sizeof(body),
                     "Not connected to %.24s\n%.30s:%d\n\nHold for the menu:\nReconnect or Pairing.",
                     m->config.name.c_str(), m->config.host.c_str(), m->config.lee_port);
        } else {
            snprintf(body, sizeof(body), "No machine paired.\n\nHold for the menu:\nPairing.");
        }
        show_empty(body);
        return;
    }
    const auto* snap = snapshot();
    if (!snap) {
        show_empty(c->attentionUnsupported()
            ? "This Lee has no attention\nqueue yet - update Lee.\n\nt  tab list"
            : "Loading the queue...");
        return;
    }
    const int n = (int)snap->items.size();
    if (n == 0) {
        std::string body = "Nothing waiting on you.\n\nc  capture an idea\nt  tab list\n\n";
        const std::string& id = device_id();
        if (!id.empty()) {
            body += "device " + id;
        } else if (s.reply_forbidden) {
            // Confirmed by an actual 403 on reply, not guessed from a
            // blank id (contracts §4.4).
            body += "shared token: re-pair to\nreply from this device";
        } else {
            body += "device id unknown";
        }
        show_empty(body.c_str());
        return;
    }
    lv_obj_add_flag(s.empty, LV_OBJ_FLAG_HIDDEN);

    // Keep the selection on the same item when the list reorders.
    if (!s.sel_id.empty()) {
        for (int i = 0; i < n; i++) {
            if (snap->items[i].id == s.sel_id) { s.sel = i; break; }
        }
    }
    if (s.sel >= n) s.sel = n - 1;
    if (s.sel < 0) s.sel = 0;
    s.sel_id = snap->items[s.sel].id;
    if (s.sel < s.top) s.top = s.sel;
    if (s.sel >= s.top + ROWS) s.top = s.sel - ROWS + 1;
    if (s.top > n - ROWS) s.top = n > ROWS ? n - ROWS : 0;

    for (int i = 0; i < ROWS; i++) {
        Slot& slot = s.slots[i];
        const int ri = s.top + i;
        if (ri >= n) {
            lv_obj_add_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        lv_obj_clear_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
        const auto& it = snap->items[ri];
        const bool selected = ri == s.sel && s.mode == Mode::List;

        lv_obj_set_style_bg_color(slot.btn, selected ? dg::ground3() : dg::ground1(), 0);
        lv_obj_set_style_border_width(slot.btn, selected ? 1 : 0, 0);
        lv_obj_set_style_bg_color(slot.bar, severity_colour(it), 0);

        lv_label_set_text(slot.title, ascii(it.title, false).c_str());
        lv_obj_set_style_text_color(slot.title, it.parked ? dg::text3() : dg::text1(), 0);

        std::string meta = it.tab_label.empty() ? std::string("agent") : ascii(it.tab_label, false);
        meta += " - ";
        meta += dirigible::attention_kind_name(it.kind);
        if (it.parked) meta += " (parked)";
        lv_label_set_text(slot.meta, meta.c_str());

        lv_label_set_text(slot.age, fmt_age(live_age(it)).c_str());
        lv_obj_set_style_text_color(slot.age, it.notify ? dg::ember() : dg::text3(), 0);
    }
}

void move(int delta)
{
    auto& s = st();
    const auto* snap = snapshot();
    if (!snap || snap->items.empty()) return;
    s.sel += delta;
    const int n = (int)snap->items.size();
    if (s.sel >= n) s.sel = n - 1;
    if (s.sel < 0) s.sel = 0;
    s.sel_id = snap->items[s.sel].id;
    render_list();
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

void open_detail(int index)
{
    auto& s = st();
    const auto* it = item_at(index);
    if (!it) return;
    s.sel = index;
    s.sel_id = it->id;
    s.detail_id = it->id;
    s.detail_version = -1;
    if (s.mode == Mode::Capture) set_capture_active(false);
    s.mode = Mode::Detail;
    lv_textarea_set_text(s.d_reply, "");
    lv_obj_clear_flag(s.detail, LV_OBJ_FLAG_HIDDEN);
    render_detail();
}

void close_detail()
{
    auto& s = st();
    if (s.mode != Mode::Detail) return;
    set_reply_active(false);
    s.mode = Mode::List;
    s.detail_id.clear();
    lv_obj_add_flag(s.detail, LV_OBJ_FLAG_HIDDEN);
    chrome_for_mode();
    render_list();
}

void render_detail()
{
    auto& s = st();
    const auto* it = detail_item();
    if (!it) {
        // Answered in the tab, from Lee or another device, or superseded.
        close_detail();
        chrome_set_centre("handled");
        return;
    }
    // Rebuilding the footer drops the reply field's focus; only do it when
    // the item itself changed.
    if (it->version == s.detail_version) return;
    s.detail_version = it->version;

    lv_label_set_text(s.d_title, ascii(it->title, false).c_str());
    std::string meta = dirigible::attention_kind_name(it->kind);
    if (!it->tab_label.empty()) meta += " - " + ascii(it->tab_label, false);
    const std::string age = fmt_age(live_age(*it));
    if (!age.empty()) meta += " - " + age;
    if (it->parked) meta += " - parked";
    lv_label_set_text(s.d_meta, meta.c_str());
    lv_obj_set_style_text_color(s.d_meta, severity_colour(*it), 0);

    const std::string words = it->text.empty() ? std::string("(no text)") : ascii(it->text, true);
    lv_label_set_text(s.d_text, ("Claude says:\n" + words).c_str());
    lv_obj_scroll_to_y(s.d_scroll, 0, LV_ANIM_OFF);

    const bool reply = !it->can(dirigible::ActApprove) && it->can(dirigible::ActReply);
    lv_obj_set_height(s.d_scroll, BODY_H - 26 - (reply ? REPLY_H + 4 : 2));
    chrome_for_mode();
    if (reply) {
        lv_obj_clear_flag(s.d_reply, LV_OBJ_FLAG_HIDDEN);
        set_reply_active(true);
    } else {
        set_reply_active(false);
        lv_obj_add_flag(s.d_reply, LV_OBJ_FLAG_HIDDEN);
    }
}

void send_reply(const char* action)
{
    auto& s = st();
    auto* c = conn();
    const auto* it = detail_item();
    if (!c || !it || s.busy) return;

    const bool text = strcmp(action, "text") == 0;
    if (text && !it->can(dirigible::ActReply)) return;
    if (!text && !it->can(strcmp(action, "approve") == 0 ? dirigible::ActApprove
                                                         : dirigible::ActDeny)) return;
    std::string body;
    if (text) {
        body = lv_textarea_get_text(s.d_reply);
        if (body.empty()) { chrome_set_centre("type a reply"); return; }
    }

    s.busy = true;
    chrome_set_centre("sending...");
    const std::string id = it->id;
    ESP_LOGI(TAG, "reply %s %s v%d", id.c_str(), action, it->version);
    c->attentionReply(id, action, body, it->version,
        [id, text, approve = strcmp(action, "approve") == 0](const dirigible::ReplyResult& r) {
            auto& s = st();
            s.busy = false;
            if (r.ok) {
                if (s.detail_id == id) {
                    lv_textarea_set_text(s.d_reply, "");
                    close_detail();
                }
                chrome_set_centre(text ? "sent" : approve ? "approved" : "denied");
                return;
            }
            ESP_LOGW(TAG, "reply %s: %d %s", id.c_str(), r.status, r.error.c_str());
            if (r.stale()) {
                // The item moved on under us: show the new state, resend nothing.
                chrome_set_centre("changed - check");
                if (auto* c = conn()) c->fetchAttention();
            } else if (r.gone()) {
                chrome_set_centre("agent gone");
                if (auto* c = conn()) c->fetchAttention();
            } else if (r.status == 403) {
                s.reply_forbidden = true;
                chrome_set_centre("re-pair to reply");
            } else if (r.status == 401) {
                chrome_set_centre("token rejected");
            } else {
                chrome_set_centre(r.error.c_str());
            }
        });
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

void capture_submit()
{
    auto& s = st();
    auto* c = conn();
    const char* raw = lv_textarea_get_text(s.capture);
    if (!raw || !*raw || s.busy) return;
    if (!c || !c->isConnected()) { chrome_set_centre("not connected"); return; }

    s.busy = true;
    chrome_set_centre("capturing...");
    c->capture(raw, [](const dirigible::CaptureOutcome& r) {
        auto& s = st();
        s.busy = false;
        if (!r.ok) {
            ESP_LOGW(TAG, "capture: %d %s", r.status, r.error.c_str());
            chrome_set_centre(r.status == 404 ? "Lee too old" : "capture failed");
            return;   // keep the text for another try
        }
        lv_textarea_set_text(s.capture, "");
        if (s.mode == Mode::Capture) {
            set_capture_active(false);
            s.mode = Mode::List;
            chrome_for_mode();
            render_list();
        }
        chrome_set_centre(r.spooled ? "saved, syncs later" : "captured");
    });
}

void capture_ready(lv_event_t*) { capture_submit(); }
void reply_ready(lv_event_t*)   { send_reply("text"); }

void slot_clicked(lv_event_t* e)
{
    auto& s = st();
    const int i = (int)(intptr_t)lv_event_get_user_data(e);
    if (s.mode == Mode::Detail) return;
    open_detail(s.top + i);
}

void capture_clicked(lv_event_t*)
{
    if (st().mode != Mode::Capture) waiting_open_capture();
}

// ---------------------------------------------------------------------------
// Header blink — the one alert (§5.4)
// ---------------------------------------------------------------------------

void blink_cb(lv_timer_t* t)
{
    auto& s = st();
    auto& a = app();
    if (!a.header) return;
    s.blink_left--;
    const bool on = s.blink_left > 0 && (s.blink_left % 2) == 1;
    lv_obj_set_style_bg_color(a.header, on ? dg::ember() : dg::ground1(), 0);
    if (s.blink_left <= 0) {
        lv_timer_del(t);
        s.blink = nullptr;
    }
}

void age_timer_cb(lv_timer_t*)
{
    if (app().view == View::Waiting && st().mode != Mode::Detail) render_list();
}

lv_obj_t* make_textarea(lv_obj_t* parent, const char* placeholder, int max_len)
{
    lv_obj_t* ta = lv_textarea_create(parent);
    lv_textarea_set_one_line(ta, true);
    lv_textarea_set_placeholder_text(ta, placeholder);
    lv_textarea_set_max_length(ta, max_len);
    lv_obj_set_style_text_font(ta, mono_font_big(), 0);
    lv_obj_set_style_text_color(ta, dg::text1(), 0);
    lv_obj_set_style_bg_color(ta, dg::ground3(), 0);
    lv_obj_set_style_border_width(ta, 1, 0);
    lv_obj_set_style_border_color(ta, dg::ground4(), 0);
    lv_obj_set_style_radius(ta, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(ta, 3, 0);
    dg::style_input_focus(ta);
    return ta;
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void waiting_build(lv_obj_t* parent)
{
    auto& a = app();
    auto& s = st();

    a.view_waiting = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_waiting);
    lv_obj_set_pos(a.view_waiting, 0, 0);
    lv_obj_set_size(a.view_waiting, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_waiting, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(a.view_waiting, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_waiting, LV_OBJ_FLAG_SCROLLABLE);

    // ---- capture row
    s.capture = make_textarea(a.view_waiting, "c: capture an idea", CAPTURE_MAX);
    lv_obj_set_pos(s.capture, 2, 1);
    lv_obj_set_size(s.capture, SCREEN_W - 4, CAP_H - 1);
    lv_obj_add_event_cb(s.capture, capture_ready, LV_EVENT_READY, nullptr);
    lv_obj_add_event_cb(s.capture, capture_clicked, LV_EVENT_CLICKED, nullptr);

    // ---- rows
    for (int i = 0; i < ROWS; i++) {
        Slot& slot = s.slots[i];
        slot.btn = lv_btn_create(a.view_waiting);
        lv_obj_remove_style_all(slot.btn);
        lv_obj_set_pos(slot.btn, 2, LIST_Y + i * ROW_H);
        lv_obj_set_size(slot.btn, SCREEN_W - 4, ROW_H - 2);
        lv_obj_set_style_bg_opa(slot.btn, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(slot.btn, dg::ground1(), 0);
        lv_obj_set_style_radius(slot.btn, DG_RADIUS, 0);
        lv_obj_set_style_border_color(slot.btn, dg::lit(), 0);
        lv_obj_set_style_border_opa(slot.btn, LV_OPA_COVER, 0);
        lv_obj_clear_flag(slot.btn, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(slot.btn, slot_clicked, LV_EVENT_CLICKED, (void*)(intptr_t)i);

        slot.bar = lv_obj_create(slot.btn);
        lv_obj_remove_style_all(slot.bar);
        lv_obj_set_pos(slot.bar, 0, 0);
        lv_obj_set_size(slot.bar, 3, ROW_H - 2);
        lv_obj_set_style_bg_opa(slot.bar, LV_OPA_COVER, 0);
        lv_obj_clear_flag(slot.bar, LV_OBJ_FLAG_CLICKABLE);

        slot.title = make_label(slot.btn, "", dg::text1());
        lv_label_set_long_mode(slot.title, LV_LABEL_LONG_DOT);
        lv_obj_set_width(slot.title, SCREEN_W - 4 - 8 - 34);
        lv_obj_set_pos(slot.title, 8, 1);

        slot.meta = make_label(slot.btn, "", dg::text3());
        lv_label_set_long_mode(slot.meta, LV_LABEL_LONG_DOT);
        lv_obj_set_width(slot.meta, SCREEN_W - 4 - 8 - 4);
        lv_obj_set_pos(slot.meta, 8, 11);

        slot.age = make_label(slot.btn, "", dg::text3());
        lv_obj_align(slot.age, LV_ALIGN_TOP_RIGHT, -4, 1);

        lv_obj_add_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
    }

    s.empty = make_label(a.view_waiting, "", dg::text2());
    lv_label_set_long_mode(s.empty, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.empty, SCREEN_W - 16);
    lv_obj_set_pos(s.empty, 8, LIST_Y + 8);

    // ---- detail, over the whole body
    s.detail = lv_obj_create(a.view_waiting);
    lv_obj_remove_style_all(s.detail);
    lv_obj_set_pos(s.detail, 0, 0);
    lv_obj_set_size(s.detail, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(s.detail, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(s.detail, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s.detail, LV_OBJ_FLAG_SCROLLABLE);

    s.d_title = make_label(s.detail, "", dg::text1());
    lv_label_set_long_mode(s.d_title, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.d_title, SCREEN_W - 8);
    lv_obj_set_pos(s.d_title, 4, 3);

    s.d_meta = make_label(s.detail, "", dg::ember());
    lv_label_set_long_mode(s.d_meta, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.d_meta, SCREEN_W - 8);
    lv_obj_set_pos(s.d_meta, 4, 13);

    s.d_scroll = lv_obj_create(s.detail);
    lv_obj_remove_style_all(s.d_scroll);
    lv_obj_set_pos(s.d_scroll, 2, 24);
    lv_obj_set_size(s.d_scroll, SCREEN_W - 4, BODY_H - 26);
    lv_obj_set_style_bg_opa(s.d_scroll, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(s.d_scroll, dg::ground0(), 0);
    lv_obj_set_style_border_width(s.d_scroll, 1, 0);
    lv_obj_set_style_border_color(s.d_scroll, dg::ground4(), 0);
    lv_obj_set_style_border_opa(s.d_scroll, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(s.d_scroll, DG_RADIUS, 0);
    lv_obj_set_style_pad_all(s.d_scroll, 4, 0);
    lv_obj_set_scroll_dir(s.d_scroll, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(s.d_scroll, LV_SCROLLBAR_MODE_AUTO);

    s.d_text = make_label(s.d_scroll, "", dg::text2());
    lv_label_set_long_mode(s.d_text, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.d_text, SCREEN_W - 14);

    s.d_reply = make_textarea(s.detail, "reply to Claude", REPLY_MAX);
    lv_obj_set_pos(s.d_reply, 2, BODY_H - REPLY_H - 1);
    lv_obj_set_size(s.d_reply, SCREEN_W - 4, REPLY_H);
    lv_obj_add_event_cb(s.d_reply, reply_ready, LV_EVENT_READY, nullptr);
    lv_obj_add_flag(s.d_reply, LV_OBJ_FLAG_HIDDEN);

    lv_obj_add_flag(s.detail, LV_OBJ_FLAG_HIDDEN);
    lv_obj_add_flag(a.view_waiting, LV_OBJ_FLAG_HIDDEN);

    lv_timer_create(age_timer_cb, 30000, nullptr);
}

void waiting_open()
{
    auto& s = st();
    if (s.mode == Mode::Capture) set_capture_active(false);
    if (s.mode == Mode::Detail) {
        set_reply_active(false);
        s.detail_id.clear();
        lv_obj_add_flag(s.detail, LV_OBJ_FLAG_HIDDEN);
    }
    s.mode = Mode::List;
    s.device_for.clear();   // re-read after a re-pair
    s.reply_forbidden = false;   // give a fresh token the benefit of the doubt

    app_show(View::Waiting);
    if (auto* c = conn(); c && c->isConnected()) c->fetchAttention();
}

void waiting_open_capture()
{
    auto& s = st();
    if (app().view != View::Waiting || s.mode == Mode::Detail) waiting_open();
    s.mode = Mode::Capture;
    set_capture_active(true);
    chrome_for_mode();
    render_list();
}

void waiting_render(bool new_snapshot)
{
    auto& s = st();
    if (new_snapshot) s.snapshot_tick = lv_tick_get();
    centre_status();
    render_list();
    if (s.mode == Mode::Detail) render_detail();
}

void waiting_chrome()
{
    centre_status();
    chrome_for_mode();
    render_list();
}

bool waiting_back()
{
    auto& s = st();
    switch (s.mode) {
    case Mode::Detail:
        close_detail();
        centre_status();
        return true;
    case Mode::Capture:
        set_capture_active(false);
        s.mode = Mode::List;
        chrome_for_mode();
        render_list();
        return true;
    default:
        return false;
    }
}

void waiting_alert()
{
    auto& s = st();
    s.blink_left = 8;   // four ember flashes, 250 ms apart
    if (!s.blink) s.blink = lv_timer_create(blink_cb, 250, nullptr);
    ESP_LOGI(TAG, "attention: notify");
}

bool waiting_key(uint8_t ascii_key)
{
    auto& s = st();
    if (ascii_key == 0x1B) { app_back(); return true; }

    switch (s.mode) {
    case Mode::Capture:
        return false;   // the capture field types; Enter fires READY
    case Mode::Detail: {
        const auto* it = detail_item();
        if (it && it->can(dirigible::ActApprove)) {
            if (ascii_key == 'y') { send_reply("approve"); return true; }
            if (ascii_key == 'n') { send_reply("deny"); return true; }
            if (ascii_key == 'j') { lv_obj_scroll_by(s.d_scroll, 0, -27, LV_ANIM_OFF); return true; }
            if (ascii_key == 'k') { lv_obj_scroll_by(s.d_scroll, 0, 27, LV_ANIM_OFF); return true; }
            return ascii_key != '\t';
        }
        if (it && it->can(dirigible::ActReply)) return false;   // the reply field types
        return ascii_key != '\t';
    }
    case Mode::List:
    default:
        switch (ascii_key) {
        case '\r': case '\n': open_detail(s.sel); return true;
        case 'j': move(1);  return true;
        case 'k': move(-1); return true;
        case ' ': move(ROWS - 1);    return true;
        case 'b': move(-(ROWS - 1)); return true;
        case 'c': waiting_open_capture(); return true;
        case 't': app_show(View::Tabs); return true;
        case 'r':
            if (auto* c = conn()) c->fetchAttention();
            chrome_set_centre("refreshing");
            return true;
        case '\t': return false;
        default:   return true;   // no stray typing into a hidden field
        }
    }
}

void waiting_ball(int dx, int dy, bool click)
{
    auto& s = st();
    (void)dx;
    switch (s.mode) {
    case Mode::List:
        if (dy) move(dy);
        if (click) open_detail(s.sel);
        break;
    case Mode::Detail:
        // Never approve on a ball click: that is a keypress or a tap.
        if (dy) lv_obj_scroll_by(s.d_scroll, 0, -dy * 9, LV_ANIM_OFF);
        break;
    default:
        break;
    }
}

}  // namespace dirigible_app
