#include "dirigible/carry.hpp"
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

/// `card_id` when present, else the pre-Desk `exploration_id`.
std::string get_id(cJSON* obj, size_t limit) {
    std::string id = get_str(obj, "card_id", limit);
    return id.empty() ? get_str(obj, "exploration_id", limit) : id;
}

}  // namespace

std::vector<std::string> CarryState::explorations() const {
    std::vector<std::string> out;
    auto add = [&](const std::string& id) {
        if (id.empty()) return;
        for (const auto& have : out) {
            if (have == id) return;
        }
        out.push_back(id);
    };
    if (has_pick_up) add(pick_up_id);
    for (const auto& q : questions) add(q.exploration_id);
    return out;
}

const CarryQuestion* CarryState::question_for(const std::string& exploration_id) const {
    for (const auto& q : questions) {
        if (q.exploration_id == exploration_id) return &q;
    }
    return nullptr;
}

bool carry_parse(cJSON* json, CarryState& out) {
    if (!json || !cJSON_IsObject(json)) return false;
    cJSON* body = json;
    if (cJSON* data = get(json, "data"); cJSON_IsObject(data)) body = data;

    // A carry body has at least one of its own keys; an error body has none.
    cJSON* pick = get(body, "pick_up");
    cJSON* qs = get(body, "open_questions");
    if (!pick && !qs && !get(body, "open_next") && !get(body, "captured_count")) return false;

    CarryState s;
    s.workspace = get_str(body, "workspace", 256);
    if (cJSON_IsObject(pick)) {
        s.pick_up_id    = get_id(pick, CARRY_MAX_ID);
        s.pick_up_title = get_str(pick, "title", CARRY_MAX_TITLE);
        s.area_name     = get_str(pick, "area_name", CARRY_MAX_TITLE);
        s.stopped_at    = get_str(pick, "stopped_at", CARRY_MAX_TEXT);
        cJSON* line = get(pick, "stopped_line");
        s.stopped_line = (cJSON_IsNumber(line) && line->valueint >= 1) ? line->valueint : -1;
        cJSON* t = get(pick, "last_touched_at");
        s.last_touched_ms = cJSON_IsString(t) ? iso8601_to_ms(t->valuestring) : -1;
        s.has_pick_up = !s.pick_up_id.empty();
    }
    if (cJSON_IsArray(qs)) {
        cJSON* q = nullptr;
        cJSON_ArrayForEach(q, qs) {
            if (s.questions.size() >= CARRY_MAX_QUESTIONS) break;
            if (!cJSON_IsObject(q)) continue;
            CarryQuestion cq;
            cq.exploration_id = get_id(q, CARRY_MAX_ID);
            cq.question_id    = get_str(q, "question_id", CARRY_MAX_ID);
            cq.text           = get_str(q, "text", CARRY_MAX_TEXT);
            if (cq.text.empty()) continue;
            s.questions.push_back(std::move(cq));
        }
    }
    s.captured_count = get_int(body, "captured_count");
    s.reading_count  = get_int(body, "reading_count");
    s.spooled        = get_int(body, "spooled");
    if (cJSON* next = get(body, "open_next"); cJSON_IsObject(next)) {
        s.open_next_exploration_id = get_id(next, CARRY_MAX_ID);
        s.open_next_someday_id     = get_str(next, "someday_id", CARRY_MAX_ID);
        s.has_open_next = !s.open_next_exploration_id.empty() || !s.open_next_someday_id.empty();
    }
    out = std::move(s);
    return true;
}

}  // namespace dirigible
