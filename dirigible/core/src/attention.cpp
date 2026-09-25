#include "dirigible/attention.hpp"
#include "cJSON.h"
#include <cstdio>
#include <cstring>

namespace dirigible {

namespace {

cJSON* get(cJSON* obj, const char* key) {
    return cJSON_GetObjectItemCaseSensitive(obj, key);
}

/// Copy a string field, cut to at most `limit` bytes on a UTF-8 boundary.
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

int get_int(cJSON* obj, const char* key, int def = 0) {
    cJSON* item = get(obj, key);
    return (item && cJSON_IsNumber(item)) ? item->valueint : def;
}

bool get_bool(cJSON* obj, const char* key) {
    return cJSON_IsTrue(get(obj, key));
}

AttentionKind parse_kind(const std::string& s) {
    if (s == "approval") return AttentionKind::Approval;
    if (s == "waiting")  return AttentionKind::Waiting;
    if (s == "blocker")  return AttentionKind::Blocker;
    if (s == "decision") return AttentionKind::Decision;
    if (s == "failure")  return AttentionKind::Failure;
    if (s == "review")   return AttentionKind::Review;
    if (s == "summary")  return AttentionKind::Summary;
    if (s == "question") return AttentionKind::Question;
    return AttentionKind::Other;
}

AttentionSeverity parse_severity(const std::string& s) {
    if (s == "blocking") return AttentionSeverity::Blocking;
    if (s == "ambient")  return AttentionSeverity::Ambient;
    return AttentionSeverity::NeedsYou;
}

uint8_t parse_actions(cJSON* arr) {
    uint8_t bits = 0;
    if (!cJSON_IsArray(arr)) return bits;
    cJSON* a = nullptr;
    cJSON_ArrayForEach(a, arr) {
        if (!cJSON_IsString(a) || !a->valuestring) continue;
        const char* v = a->valuestring;
        if      (!strcmp(v, "approve")) bits |= ActApprove;
        else if (!strcmp(v, "deny"))    bits |= ActDeny;
        else if (!strcmp(v, "reply"))   bits |= ActReply;
        else if (!strcmp(v, "open"))    bits |= ActOpen;
        else if (!strcmp(v, "snooze"))  bits |= ActSnooze;
        else if (!strcmp(v, "dismiss")) bits |= ActDismiss;
        else if (!strcmp(v, "wake"))    bits |= ActWake;
        else if (!strcmp(v, "choose"))  bits |= ActChoose;
    }
    return bits;
}

int64_t days_from_civil(int y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe) - 719468;
}

/// Ms since the epoch of a JSON string field, or -1.
int64_t get_time(cJSON* obj, const char* key) {
    cJSON* item = get(obj, key);
    return (item && cJSON_IsString(item)) ? iso8601_to_ms(item->valuestring) : -1;
}

}  // namespace

int64_t iso8601_to_ms(const char* s) {
    if (!s) return -1;
    int y, mo, d, h, mi, sec;
    int consumed = 0;
    if (sscanf(s, "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &sec, &consumed) != 6) {
        return -1;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return -1;
    int ms = 0;
    const char* p = s + consumed;
    if (*p == '.') {
        p++;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            if (digits < 3) { ms = ms * 10 + (*p - '0'); digits++; }
            p++;
        }
        while (digits++ < 3) ms *= 10;
    }
    int64_t offset_s = 0;   // "Z" or absent: UTC
    if (*p == '+' || *p == '-') {
        int oh = 0, om = 0;
        if (sscanf(p + 1, "%2d:%2d", &oh, &om) >= 1) {
            offset_s = (oh * 3600 + om * 60) * (*p == '+' ? 1 : -1);
        }
    }
    const int64_t days = days_from_civil(y, static_cast<unsigned>(mo),
                                         static_cast<unsigned>(d));
    const int64_t secs = days * 86400 + h * 3600 + mi * 60 + sec - offset_s;
    return secs * 1000 + ms;
}

const AttentionItem* AttentionSnapshot::find(const std::string& id) const {
    for (const auto& it : items) {
        if (it.id == id) return &it;
    }
    return nullptr;
}

namespace {

void parse_questions(cJSON* q, std::vector<AttentionQuestion>& out) {
    out.clear();
    if (!cJSON_IsObject(q)) return;
    cJSON* arr = get(q, "questions");
    if (!cJSON_IsArray(arr)) return;
    cJSON* one = nullptr;
    cJSON_ArrayForEach(one, arr) {
        if (out.size() >= ATTENTION_MAX_QUESTIONS) break;
        if (!cJSON_IsObject(one)) continue;
        AttentionQuestion aq;
        aq.question     = get_str(one, "question", ATTENTION_MAX_QTEXT);
        aq.header       = get_str(one, "header", 48);
        aq.multi_select = get_bool(one, "multi_select");
        cJSON* opts = get(one, "options");
        cJSON* o = nullptr;
        if (cJSON_IsArray(opts)) {
            cJSON_ArrayForEach(o, opts) {
                if (aq.options.size() >= ATTENTION_MAX_OPTIONS) break;
                if (!cJSON_IsObject(o)) continue;
                AttentionOption ao;
                ao.label       = get_str(o, "label", 120);
                ao.description = get_str(o, "description", ATTENTION_MAX_QTEXT);
                aq.options.push_back(std::move(ao));
            }
        }
        out.push_back(std::move(aq));
    }
}

/// Fields shared by the snapshot's items and GET /attention/:id.
bool parse_item(cJSON* it, AttentionItem& item, size_t text_limit, bool questions) {
    if (!cJSON_IsObject(it)) return false;
    item.id = get_str(it, "id", ATTENTION_MAX_ID);
    if (item.id.empty()) return false;
    item.version  = get_int(it, "version");
    item.kind     = parse_kind(get_str(it, "kind", 16));
    item.severity = parse_severity(get_str(it, "severity", 16));
    item.title    = get_str(it, "title", ATTENTION_MAX_TITLE);
    item.text     = get_str(it, "text", text_limit);
    item.notify   = get_bool(it, "notify");
    item.parked   = get_bool(it, "parked");
    item.actions  = parse_actions(get(it, "actions"));
    if (cJSON* src = get(it, "source"); cJSON_IsObject(src)) {
        item.tab_label = get_str(src, "tab_label", ATTENTION_MAX_LABEL);
    }
    if (cJSON* tool = get(it, "tool"); cJSON_IsObject(tool)) {
        item.tool_name = get_str(tool, "name", 48);
    }
    if (questions) parse_questions(get(it, "question"), item.questions);
    return true;
}

}  // namespace

bool attention_item_parse(cJSON* json, AttentionItem& out) {
    if (!json || !cJSON_IsObject(json)) return false;
    cJSON* data = get(json, "data");
    cJSON* it = (data && cJSON_IsObject(data)) ? data : json;
    AttentionItem item;
    if (!parse_item(it, item, ATTENTION_FULL_TEXT, true)) return false;
    out = std::move(item);
    return true;
}

bool attention_snapshot_parse(cJSON* json, AttentionSnapshot& out) {
    if (!json || !cJSON_IsObject(json)) return false;
    cJSON* snap = json;
    cJSON* data = get(json, "data");
    if (data && cJSON_IsObject(data)) snap = data;

    cJSON* items = get(snap, "items");
    if (!cJSON_IsArray(items)) return false;

    AttentionSnapshot s;
    const int64_t generated = get_time(snap, "generated_at");

    size_t question_items = 0;
    cJSON* it = nullptr;
    cJSON_ArrayForEach(it, items) {
        if (s.items.size() >= ATTENTION_MAX_ITEMS) break;
        AttentionItem item;
        const bool q = question_items < ATTENTION_MAX_QUESTION_ITEMS;
        if (!parse_item(it, item, ATTENTION_MAX_TEXT, q)) continue;
        if (!item.questions.empty()) question_items++;
        const int64_t created = get_time(it, "created_at");
        if (generated >= 0 && created >= 0) {
            item.age_ms = generated > created ? generated - created : 0;
        }
        s.items.push_back(std::move(item));
    }

    if (cJSON* counts = get(snap, "counts"); cJSON_IsObject(counts)) {
        s.blocking  = get_int(counts, "blocking");
        s.needs_you = get_int(counts, "needs_you");
        s.ambient   = get_int(counts, "ambient");
        s.parked    = get_int(counts, "parked");
    } else {
        for (const auto& i : s.items) {
            if (i.parked) s.parked++;
            else if (i.severity == AttentionSeverity::Blocking) s.blocking++;
            else if (i.severity == AttentionSeverity::NeedsYou) s.needs_you++;
            else s.ambient++;
        }
    }
    if (cJSON* focus = get(snap, "focus"); cJSON_IsObject(focus)) {
        s.focus_active = get_bool(focus, "active");
        s.quiet_count  = get_int(focus, "quiet_count");
    }
    if (cJSON* away = get(snap, "away"); cJSON_IsObject(away)) {
        s.away_active = get_bool(away, "active");
    }

    out = std::move(s);
    return true;
}

bool attention_notify_rose(const AttentionSnapshot& prev,
                           const AttentionSnapshot& next) {
    for (const auto& it : next.items) {
        if (!it.notify) continue;
        const AttentionItem* was = prev.find(it.id);
        if (!was || !was->notify) return true;
    }
    return false;
}

const char* attention_kind_name(AttentionKind k) {
    switch (k) {
    case AttentionKind::Approval: return "approval";
    case AttentionKind::Waiting:  return "waiting";
    case AttentionKind::Blocker:  return "blocker";
    case AttentionKind::Decision: return "decision";
    case AttentionKind::Failure:  return "failure";
    case AttentionKind::Review:   return "review";
    case AttentionKind::Summary:  return "summary";
    case AttentionKind::Question: return "question";
    default:                      return "item";
    }
}

namespace {

std::string error_of(int status, cJSON* resp) {
    if (resp) {
        cJSON* e = get(resp, "error");
        if (e && cJSON_IsString(e) && e->valuestring && *e->valuestring) {
            std::string s = e->valuestring;
            if (s.size() > 80) s.resize(80);
            return s;
        }
    }
    switch (status) {
    case 0:   return "Lee did not answer";
    case 401: return "token rejected";
    case 403: return "not allowed";
    case 404: return "not found";
    case 409: return "stale";
    case 410: return "agent gone";
    default:  return "HTTP " + std::to_string(status);
    }
}

bool success_of(int status, cJSON* resp) {
    bool ok = status >= 200 && status < 300;
    if (ok && resp) {
        cJSON* s = get(resp, "success");
        if (s && cJSON_IsBool(s)) ok = cJSON_IsTrue(s);
    }
    return ok;
}

}  // namespace

void reply_result_parse(int status, cJSON* resp, ReplyResult& out) {
    out.status = status;
    out.ok = success_of(status, resp);
    out.error = out.ok ? std::string() : error_of(status, resp);
}

void capture_outcome_parse(int status, cJSON* resp, CaptureOutcome& out) {
    out.status = status;
    out.ok = success_of(status, resp);
    out.spooled = false;
    // Lee may answer with a bare CaptureResult or wrap it in {success, data}.
    cJSON* body = resp;
    if (resp) {
        cJSON* data = get(resp, "data");
        if (cJSON_IsObject(data)) body = data;
        out.spooled = get_bool(body, "spooled");
        if (out.ok) {
            cJSON* s = get(body, "success");
            if (s && cJSON_IsBool(s)) out.ok = cJSON_IsTrue(s);
        }
    }
    if (out.ok) {
        out.error.clear();
    } else {
        cJSON* e = body ? get(body, "error") : nullptr;
        out.error = error_of(status, cJSON_IsString(e) ? body : resp);
    }
}

}  // namespace dirigible
