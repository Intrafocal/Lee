#include "dirigible/voice.hpp"
#include "cJSON.h"
#include <cstdlib>
#include <cstring>

namespace dirigible {

namespace {

cJSON* get(cJSON* obj, const char* key) {
    return cJSON_GetObjectItemCaseSensitive(obj, key);
}

std::string get_str(cJSON* obj, const char* key, size_t limit) {
    cJSON* item = get(obj, key);
    if (!item || !cJSON_IsString(item) || !item->valuestring) return {};
    std::string s = item->valuestring;
    if (s.size() > limit) s.resize(limit);
    return s;
}

int64_t get_num(cJSON* obj, const char* key, int64_t fallback) {
    cJSON* item = get(obj, key);
    return (item && cJSON_IsNumber(item)) ? (int64_t)item->valuedouble : fallback;
}

void put_le16(uint8_t* p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }
void put_le32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
uint16_t le16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
uint32_t le32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

bool is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) b++;
    while (e > b && is_space(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::string pct_encode(const std::string& s) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~' || c == '/') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

}  // namespace

const char* voice_purpose_name(VoicePurpose p) {
    switch (p) {
    case VoicePurpose::Reply:   return "reply";
    case VoicePurpose::Capture: return "capture";
    case VoicePurpose::Ask:     return "ask";
    case VoicePurpose::Send:    return "send";
    }
    return "reply";
}

bool voice_capabilities_parse(cJSON* json, VoiceCapabilities& out) {
    if (!cJSON_IsObject(json)) return false;
    cJSON* body = json;
    if (cJSON* data = get(json, "data"); cJSON_IsObject(data)) body = data;
    cJSON* enabled = get(body, "enabled");
    cJSON* available = get(body, "available");
    if (!cJSON_IsBool(enabled) && !cJSON_IsBool(available)) return false;
    VoiceCapabilities c;
    c.enabled     = cJSON_IsTrue(enabled);
    c.available   = cJSON_IsTrue(available);
    c.reason      = get_str(body, "reason", 48);
    c.provider    = get_str(body, "provider", 32);
    c.model       = get_str(body, "model", 64);
    c.sample_rate = (int)get_num(body, "sample_rate", VOICE_SAMPLE_RATE);
    c.max_seconds = (int)get_num(body, "max_seconds", 60);
    c.max_bytes   = get_num(body, "max_bytes", 0);
    // A daemon that wants another rate than the wire format can't take ours.
    if (c.sample_rate != VOICE_SAMPLE_RATE) c.available = false;
    out = std::move(c);
    return true;
}

void transcribe_result_parse(int status, cJSON* json, TranscribeResult& out) {
    out = TranscribeResult();
    out.status = status;
    cJSON* body = json;
    if (cJSON_IsObject(json)) {
        if (cJSON* data = get(json, "data"); cJSON_IsObject(data)) body = data;
    }
    if (status >= 200 && status < 300 && cJSON_IsObject(body) && cJSON_IsString(get(body, "text"))) {
        out.ok = true;
        out.text = get_str(body, "text", 4000);
        out.audio_ms = get_num(body, "audio_ms", 0);
        out.latency_ms = get_num(body, "latency_ms", 0);
        return;
    }
    std::string e;
    if (cJSON_IsObject(body)) {
        e = get_str(body, "error", 80);
        if (e.empty()) e = get_str(body, "detail", 80);   // FastAPI's HTTPException shape
    }
    if (e.empty()) {
        switch (status) {
        case 0:   e = "network"; break;
        case 413: e = "too_large"; break;
        case 415: e = "unsupported_media_type"; break;
        case 422: e = "too_short"; break;
        case 502: e = "provider_error"; break;
        case 503: e = "voice_unavailable"; break;
        case 504: e = "timeout"; break;
        default:  e = "HTTP " + std::to_string(status); break;
        }
    }
    out.error = e;
}

std::string voice_error_text(const TranscribeResult& r) {
    const std::string& e = r.error;
    if (e == "silence")   return "Didn't hear anything";
    if (e == "too_short") return "Too short - hold on a little longer";
    if (e == "too_long" || e == "too_large") return "Too long for one clip";
    if (e == "cancelled") return "Cancelled";
    if (e == "network")   return "Hester did not answer";
    if (e == "timeout")   return "Hester took too long";
    if (e == "voice_disabled" || e.rfind("voice_unavailable", 0) == 0) return "Voice is off in Hester";
    if (e == "mic")       return "The mic didn't start";
    if (r.status == 401 || r.status == 403) return "Token rejected - re-pair";
    return "Couldn't transcribe";
}

void wav_write_header(uint8_t* out, uint32_t data_bytes, int sample_rate, int channels, int bits) {
    const uint32_t block = (uint32_t)(channels * bits / 8);
    memcpy(out, "RIFF", 4);
    put_le32(out + 4, 36 + data_bytes);
    memcpy(out + 8, "WAVE", 4);
    memcpy(out + 12, "fmt ", 4);
    put_le32(out + 16, 16);                             // PCM fmt chunk size
    put_le16(out + 20, 1);                              // PCM
    put_le16(out + 22, (uint16_t)channels);
    put_le32(out + 24, (uint32_t)sample_rate);
    put_le32(out + 28, (uint32_t)sample_rate * block);  // byte rate
    put_le16(out + 32, (uint16_t)block);
    put_le16(out + 34, (uint16_t)bits);
    memcpy(out + 36, "data", 4);
    put_le32(out + 40, data_bytes);
}

bool wav_read_header(const uint8_t* d, size_t len, WavInfo& out) {
    if (!d || len < WAV_HEADER_BYTES) return false;
    if (memcmp(d, "RIFF", 4) != 0 || memcmp(d + 8, "WAVE", 4) != 0) return false;
    size_t p = 12;
    WavInfo w;
    bool fmt = false;
    while (p + 8 <= len) {
        const uint32_t size = le32(d + p + 4);
        if (memcmp(d + p, "fmt ", 4) == 0) {
            if (size < 16 || p + 8 + 16 > len) return false;
            if (le16(d + p + 8) != 1) return false;       // PCM only
            w.channels    = le16(d + p + 10);
            w.sample_rate = (int)le32(d + p + 12);
            w.bits        = le16(d + p + 22);
            fmt = true;
        } else if (memcmp(d + p, "data", 4) == 0) {
            if (!fmt) return false;
            w.data_offset = (uint32_t)(p + 8);
            w.data_bytes  = size;
            out = w;
            return true;
        }
        p += 8 + size + (size & 1);
    }
    return false;
}

int64_t voice_pcm_ms(size_t pcm_bytes) {
    return (int64_t)(pcm_bytes / VOICE_BYTES_PER_MS);
}

int voice_peak(const int16_t* pcm, size_t n) {
    int peak = 0;
    for (size_t i = 0; i < n; i++) {
        const int v = std::abs((int)pcm[i]);
        if (v > peak) peak = v;
    }
    return peak;
}

bool voice_is_silent(const int16_t* pcm, size_t n, int threshold) {
    return !pcm || n == 0 || voice_peak(pcm, n) < threshold;
}

std::string append_transcript(const std::string& draft, const std::string& transcript) {
    const std::string add = trim(transcript);
    if (add.empty()) return draft;
    if (trim(draft).empty()) return add;
    if (is_space(draft.back())) return draft + add;
    return draft + " " + add;
}

// ---------------------------------------------------------------------------
// VoiceClient
// ---------------------------------------------------------------------------

VoiceClient::VoiceClient(ITransportFactory* factory, const std::string& host, int hester_port)
    : host_(host), port_(hester_port) {
    // Long enough for a 30 s clip's upload plus Hester's own 30 s budget.
    if (factory) http_ = factory->createHttpClient(35000);
}

VoiceClient::~VoiceClient() {
    delete http_;
}

void VoiceClient::setToken(const std::string& token) {
    if (http_) http_->setAuthToken(token);
}

std::string VoiceClient::url(const char* path) const {
    return "http://" + host_ + ":" + std::to_string(port_) + path;
}

const VoiceCapabilities* VoiceClient::capabilities(uint32_t now_ms) const {
    if (!have_caps_ || now_ms - caps_at_ > VOICE_CAPABILITIES_TTL_MS) return nullptr;
    return &caps_;
}

void VoiceClient::refreshCapabilities(uint32_t now_ms, std::function<void(const VoiceCapabilities*)> cb) {
    if (const VoiceCapabilities* c = capabilities(now_ms)) {
        if (cb) cb(c);
        return;
    }
    if (!http_) {
        if (cb) cb(nullptr);
        return;
    }
    http_->get(url("/voice"), [this, now_ms, cb](int status, cJSON* resp) {
        VoiceCapabilities c;
        if (status >= 200 && status < 300 && voice_capabilities_parse(resp, c)) {
            caps_ = std::move(c);
            have_caps_ = true;
            caps_at_ = now_ms;
            if (cb) cb(&caps_);
            return;
        }
        have_caps_ = false;
        if (cb) cb(nullptr);
    });
}

void VoiceClient::transcribe(std::vector<uint8_t> wav, VoicePurpose purpose,
                             const std::string& item_id, const std::string& workspace,
                             std::function<void(const TranscribeResult&)> cb) {
    if (!http_) {
        TranscribeResult r;
        transcribe_result_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    std::string u = url("/voice/transcribe") + "?purpose=" + voice_purpose_name(purpose);
    if (!item_id.empty())   u += "&item_id=" + pct_encode(item_id);
    if (!workspace.empty()) u += "&workspace=" + pct_encode(workspace);
    http_->postBody(u, "audio/wav", std::move(wav), [this, cb](int status, cJSON* resp) {
        TranscribeResult r;
        transcribe_result_parse(status, resp, r);
        // A 503 means voice went away: ask again before showing the mic.
        if (status == 503) have_caps_ = false;
        if (cb) cb(r);
    });
}

}  // namespace dirigible
