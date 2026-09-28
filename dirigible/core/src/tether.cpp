#include "dirigible/tether.hpp"
#include "dirigible/attention.hpp"   // iso8601_to_ms
#include "cJSON.h"
#include <cstring>

namespace dirigible {

namespace {

cJSON* get(cJSON* obj, const char* key) {
    return cJSON_GetObjectItemCaseSensitive(obj, key);
}

/// A string field cut to at most `limit` bytes on a UTF-8 boundary.
std::string get_str(cJSON* obj, const char* key, size_t limit) {
    cJSON* item = get(obj, key);
    if (!item || !cJSON_IsString(item) || !item->valuestring) return {};
    const char* s = item->valuestring;
    size_t n = strlen(s);
    if (n > limit) {
        n = limit;
        while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) n--;
    }
    return std::string(s, n);
}

int get_int(cJSON* obj, const char* key) {
    cJSON* item = get(obj, key);
    return (item && cJSON_IsNumber(item)) ? item->valueint : 0;
}

int64_t get_time(cJSON* obj, const char* key) {
    cJSON* t = get(obj, key);
    return cJSON_IsString(t) ? iso8601_to_ms(t->valuestring) : -1;
}

/// The body under a `{success, data}` envelope, else `json` itself.
cJSON* unwrap(cJSON* json) {
    if (cJSON_IsObject(json)) {
        cJSON* data = get(json, "data");
        if (cJSON_IsObject(data) || cJSON_IsArray(data)) return data;
    }
    return json;
}

}  // namespace

int TetherState::questions_for(const std::string& card_id) const {
    int n = 0;
    for (const auto& q : questions) {
        if (q.card_id == card_id) n++;
    }
    return n;
}

bool tether_parse(cJSON* json, TetherState& out) {
    if (!json || !cJSON_IsObject(json)) return false;
    cJSON* body = unwrap(json);
    if (!cJSON_IsObject(body)) return false;

    // A tether body has at least one of its own keys; an error body has none.
    cJSON* pick = get(body, "pick_up");
    cJSON* qs = get(body, "open_questions");
    if (!pick && !qs && !get(body, "captured_count")) return false;

    TetherState s;
    s.workspace = get_str(body, "workspace", 256);
    if (cJSON_IsObject(pick)) {
        s.pick_up_id    = get_str(pick, "card_id", TETHER_MAX_ID);
        s.pick_up_kind  = get_str(pick, "card_kind", 24);
        s.pick_up_title = get_str(pick, "title", TETHER_MAX_TITLE);
        s.area_name     = get_str(pick, "area_name", TETHER_MAX_TITLE);
        s.stopped_at    = get_str(pick, "stopped_at", TETHER_MAX_TEXT);
        cJSON* line = get(pick, "stopped_line");
        s.stopped_line = (cJSON_IsNumber(line) && line->valueint >= 1) ? line->valueint : -1;
        s.last_touched_ms = get_time(pick, "last_touched_at");
        s.has_pick_up = !s.pick_up_id.empty();
    }
    if (cJSON_IsArray(qs)) {
        cJSON* q = nullptr;
        cJSON_ArrayForEach(q, qs) {
            if (s.questions.size() >= TETHER_MAX_QUESTIONS) break;
            if (!cJSON_IsObject(q)) continue;
            TetherQuestion tq;
            tq.card_id     = get_str(q, "card_id", TETHER_MAX_ID);
            tq.question_id = get_str(q, "question_id", TETHER_MAX_ID);
            tq.text        = get_str(q, "text", TETHER_MAX_TEXT);
            if (tq.text.empty()) continue;
            s.questions.push_back(std::move(tq));
        }
    }
    s.captured_count = get_int(body, "captured_count");
    s.spooled        = get_int(body, "spooled");
    out = std::move(s);
    return true;
}

bool tether_card_parse(cJSON* json, TetherCard& out) {
    if (!cJSON_IsObject(json)) return false;
    TetherCard c;
    c.id = get_str(json, "id", TETHER_MAX_ID);
    if (c.id.empty()) return false;
    c.kind       = get_str(json, "kind", 24);
    c.title      = get_str(json, "title", TETHER_MAX_TITLE);
    c.area_id    = get_str(json, "area_id", TETHER_MAX_ID);
    c.area_name  = get_str(json, "area_name", TETHER_MAX_TITLE);
    c.stashed    = cJSON_IsTrue(get(json, "stashed"));
    c.updated_ms = get_time(json, "updated_at");
    c.chars      = get_int(json, "chars");
    c.answers    = get_int(json, "answers");
    c.open_questions = get_int(json, "open_questions");
    out = std::move(c);
    return true;
}

bool tether_pages_parse(cJSON* json, std::vector<TetherCard>& out) {
    if (!json) return false;
    cJSON* list = unwrap(json);
    if (cJSON_IsObject(list)) list = get(list, "pages");
    if (!cJSON_IsArray(list)) return false;
    std::vector<TetherCard> cards;
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, list) {
        if (cards.size() >= TETHER_MAX_PAGES) break;
        TetherCard c;
        if (tether_card_parse(item, c)) cards.push_back(std::move(c));
    }
    out = std::move(cards);
    return true;
}

bool tether_page_text_parse(cJSON* json, TetherPageText& out) {
    if (!cJSON_IsObject(json)) return false;
    cJSON* body = unwrap(json);
    if (!cJSON_IsObject(body)) return false;
    TetherPageText p;
    if (!tether_card_parse(get(body, "card"), p.card)) return false;
    cJSON* text = get(body, "text");
    if (!cJSON_IsString(text)) return false;
    p.text = get_str(body, "text", TETHER_MAX_PAGE_TEXT);
    out = std::move(p);
    return true;
}

// ---------------------------------------------------------------------------
// Send to Lee
// ---------------------------------------------------------------------------

const char* tether_tab_kind(const char* type) {
    if (!type) return "tui";
    if (strcmp(type, "claude") == 0 || strcmp(type, "agent") == 0) return "agent";
    if (strcmp(type, "terminal") == 0) return "terminal";
    return "tui";
}

cJSON* tether_send_body(int pty_id, const std::string& label, const char* tab_kind,
                        const std::string& text, bool submit, bool voice,
                        const std::string& workspace) {
    cJSON* body = cJSON_CreateObject();
    if (!workspace.empty()) cJSON_AddStringToObject(body, "workspace", workspace.c_str());

    cJSON* target = cJSON_AddObjectToObject(body, "target");
    cJSON_AddStringToObject(target, "kind", "tab");
    cJSON_AddNumberToObject(target, "pty_id", pty_id);
    cJSON_AddStringToObject(target, "label", label.c_str());
    cJSON_AddStringToObject(target, "tab_kind", tab_kind ? tab_kind : "tui");
    cJSON_AddNullToObject(target, "provider");

    cJSON* items = cJSON_AddArrayToObject(body, "items");
    cJSON* item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "kind", "text");
    cJSON_AddStringToObject(item, "text", text.c_str());
    if (voice) cJSON_AddStringToObject(item, "input", "voice");
    cJSON_AddItemToArray(items, item);

    cJSON_AddBoolToObject(body, "submit", submit);
    cJSON_AddBoolToObject(body, "compose", true);  // always the tab view's compose line: no chip in Lee
    return body;
}

void send_outcome_parse(int status, cJSON* resp, SendOutcome& out) {
    out = SendOutcome();
    out.status = status;
    cJSON* body = unwrap(resp);
    const bool http_ok = status >= 200 && status < 300;
    if (http_ok && cJSON_IsObject(body)) {
        out.send_id = get_str(body, "send_id", TETHER_MAX_ID);
        cJSON* s = get(resp, "success");
        out.ok = !(s && cJSON_IsBool(s) && !cJSON_IsTrue(s));
    }
    if (out.ok) return;
    std::string e;
    if (cJSON_IsObject(body)) e = get_str(body, "error", 80);
    if (e.empty() && cJSON_IsObject(resp)) e = get_str(resp, "error", 80);
    if (e.empty()) e = status ? "HTTP " + std::to_string(status) : std::string("no answer");
    out.error = e;
}

std::string send_error_text(const SendOutcome& r) {
    if (r.ok) return {};
    if (r.status == 0)   return "Lee did not answer";
    if (r.status == 401) return "Token rejected - re-pair";
    if (r.status == 403) return "Re-pair to send";
    if (r.status == 404) return "This Lee can't take a send yet";
    if (r.error == "no_window") return "No Lee window has this workspace";
    if (r.error == "no_target") return "Nothing to send to";
    if (r.status == 504) return "Lee didn't answer in time";
    if (r.status == 413) return "Too long to send";
    return "Didn't send (" + r.error + ")";
}

}  // namespace dirigible
