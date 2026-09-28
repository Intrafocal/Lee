// Host tests for dirigible/core/src/voice.cpp (plan 2026-09-28 §5.6):
//   the 44-byte WAV header a clip goes up with, and reading it back;
//   the clip length and silence gate that keep empty clips off the wire;
//   append_transcript, the same cases as Lee's appendTranscript;
//   GET /voice and POST /voice/transcribe answers, and the error lines;
//   VoiceClient against a fake transport: the URL, the raw body, the cache.
// Pure C++17 plus ESP-IDF's copy of cJSON, no LVGL:  make check
#include "dirigible/voice.hpp"
#include "cJSON.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace dirigible;

static int fails = 0;

static void expect(const std::string& what, const std::string& got, const std::string& want)
{
    if (got != want) {
        printf("FAIL %s\n  got  [%s]\n  want [%s]\n", what.c_str(), got.c_str(), want.c_str());
        fails++;
    } else {
        printf("ok   %s\n", what.c_str());
    }
}

static void expect_int(const std::string& what, long long got, long long want)
{
    if (got != want) {
        printf("FAIL %s: got %lld want %lld\n", what.c_str(), got, want);
        fails++;
    } else {
        printf("ok   %s\n", what.c_str());
    }
}

static void test_header()
{
    uint8_t h[WAV_HEADER_BYTES];
    const uint32_t data = 32000;   // one second
    wav_write_header(h, data);
    expect("RIFF", std::string((const char*)h, 4), "RIFF");
    expect("WAVE", std::string((const char*)h + 8, 4), "WAVE");
    expect("fmt ", std::string((const char*)h + 12, 4), "fmt ");
    expect("data", std::string((const char*)h + 36, 4), "data");
    expect_int("riff size", h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24), 36 + data);
    expect_int("pcm", h[20] | (h[21] << 8), 1);
    expect_int("mono", h[22], 1);
    expect_int("16 kHz", h[24] | (h[25] << 8) | (h[26] << 16), 16000);
    expect_int("byte rate", h[28] | (h[29] << 8) | (h[30] << 16), 32000);
    expect_int("block align", h[32], 2);
    expect_int("bits", h[34], 16);

    WavInfo w;
    expect_int("reads back", wav_read_header(h, sizeof(h), w), 1);
    expect_int("rate", w.sample_rate, 16000);
    expect_int("channels", w.channels, 1);
    expect_int("bits back", w.bits, 16);
    expect_int("data bytes", w.data_bytes, data);
    expect_int("data offset", w.data_offset, 44);

    uint8_t bad[WAV_HEADER_BYTES];
    memcpy(bad, h, sizeof(bad));
    bad[0] = 'X';
    expect_int("not RIFF", wav_read_header(bad, sizeof(bad), w), 0);
    expect_int("too short", wav_read_header(h, 20, w), 0);
    memcpy(bad, h, sizeof(bad));
    bad[20] = 3;   // IEEE float
    expect_int("not PCM", wav_read_header(bad, sizeof(bad), w), 0);
}

static void test_clip()
{
    expect_int("32 bytes a ms", (long long)VOICE_BYTES_PER_MS, 32);
    expect_int("1 s of PCM", voice_pcm_ms(32000), 1000);
    expect_int("under the minimum", voice_pcm_ms(300 * 32 - 2) < VOICE_MIN_MS, 1);
    expect_int("30 s cap is 960000 bytes", (long long)VOICE_MAX_MS_DIRIGIBLE * VOICE_BYTES_PER_MS, 960000);

    std::vector<int16_t> quiet(1600, 0);
    for (size_t i = 0; i < quiet.size(); i++) quiet[i] = (int16_t)((i % 7) * 40 - 120);   // room hiss
    expect_int("hiss is silence", voice_is_silent(quiet.data(), quiet.size()), 1);
    std::vector<int16_t> speech = quiet;
    speech[800] = -9000;
    expect_int("a peak is speech", voice_is_silent(speech.data(), speech.size()), 0);
    expect_int("peak", voice_peak(speech.data(), speech.size()), 9000);
    const int16_t lowest[1] = { -32768 };
    expect_int("-32768 does not overflow", voice_peak(lowest, 1), 32768);
    expect_int("nothing is silence", voice_is_silent(nullptr, 0), 1);
}

// The same rules as appendTranscript in electron/src/shared/voice.ts.
static void test_append()
{
    expect("empty draft becomes the transcript", append_transcript("", "hello there"), "hello there");
    expect("whitespace draft becomes the transcript", append_transcript("  \n", " hello "), "hello");
    expect("a space goes between", append_transcript("Yes,", "go ahead"), "Yes, go ahead");
    expect("no double space", append_transcript("Yes, ", "go ahead"), "Yes, go ahead");
    expect("after a newline", append_transcript("Line\n", "next"), "Line\nnext");
    expect("transcript is trimmed", append_transcript("a", "  b  "), "a b");
    expect("blank transcript leaves the draft", append_transcript("keep me ", "   "), "keep me ");
}

static void test_capabilities()
{
    cJSON* root = cJSON_Parse(R"({"enabled":true,"available":true,"provider":"gemini","model":"gemini-2.5-flash",
      "location":"cloud","accepts":["audio/wav"],"sample_rate":16000,"channels":1,"max_seconds":60,"max_bytes":1920044})");
    VoiceCapabilities c;
    expect_int("capabilities parse", voice_capabilities_parse(root, c), 1);
    cJSON_Delete(root);
    expect_int("available", c.available, 1);
    expect("provider", c.provider, "gemini");
    expect_int("max bytes", c.max_bytes, 1920044);

    root = cJSON_Parse(R"({"enabled":false,"available":false,"reason":"disabled","provider":"gemini","model":"","sample_rate":16000})");
    expect_int("disabled parses", voice_capabilities_parse(root, c), 1);
    cJSON_Delete(root);
    expect_int("not available", c.available, 0);
    expect("reason", c.reason, "disabled");

    root = cJSON_Parse(R"({"enabled":true,"available":true,"sample_rate":44100})");
    expect_int("another rate parses", voice_capabilities_parse(root, c), 1);
    cJSON_Delete(root);
    expect_int("but hides the mic", c.available, 0);

    root = cJSON_Parse(R"({"detail":"Not Found"})");
    VoiceCapabilities none;
    expect_int("a 404 body is not capabilities", voice_capabilities_parse(root, none), 0);
    cJSON_Delete(root);
}

static void test_transcribe()
{
    cJSON* root = cJSON_Parse(R"({"text":"Yes, go ahead","provider":"gemini","model":"m","location":"cloud","audio_ms":1800,"latency_ms":900})");
    TranscribeResult r;
    transcribe_result_parse(200, root, r);
    cJSON_Delete(root);
    expect_int("ok", r.ok, 1);
    expect("text", r.text, "Yes, go ahead");
    expect_int("audio ms", r.audio_ms, 1800);

    root = cJSON_Parse(R"({"error":"too_short"})");
    transcribe_result_parse(422, root, r);
    cJSON_Delete(root);
    expect_int("422 fails", r.ok, 0);
    expect("code", r.error, "too_short");
    expect("line", voice_error_text(r), "Too short - hold on a little longer");

    root = cJSON_Parse(R"({"detail":"voice_unavailable:no_api_key"})");
    transcribe_result_parse(503, root, r);
    cJSON_Delete(root);
    expect("FastAPI detail", r.error, "voice_unavailable:no_api_key");
    expect("unavailable line", voice_error_text(r), "Voice is off in Hester");

    transcribe_result_parse(504, nullptr, r);
    expect("504 with no body", r.error, "timeout");
    transcribe_result_parse(0, nullptr, r);
    expect("no answer", r.error, "network");
    expect("no answer line", voice_error_text(r), "Hester did not answer");

    expect("purpose names", std::string(voice_purpose_name(VoicePurpose::Reply)) + "," +
           voice_purpose_name(VoicePurpose::Capture) + "," + voice_purpose_name(VoicePurpose::Ask) + "," +
           voice_purpose_name(VoicePurpose::Send), "reply,capture,ask,send");
}

// ---------------------------------------------------------------------------
// VoiceClient over a fake transport
// ---------------------------------------------------------------------------

struct FakeHttp : IHttpClient {
    std::string token, last_url, last_type;
    size_t last_bytes = 0;
    int gets = 0;
    int status = 200;
    const char* answer = "{}";
    void setAuthToken(const std::string& t) override { token = t; }
    void get(const std::string& url, std::function<void(int, cJSON*)> cb) override {
        gets++;
        last_url = url;
        cJSON* j = cJSON_Parse(answer);
        cb(status, j);
        cJSON_Delete(j);
    }
    void post(const std::string&, cJSON* body, std::function<void(int, cJSON*)> cb) override {
        cJSON_Delete(body);
        cb(0, nullptr);
    }
    void postBody(const std::string& url, const char* type, std::vector<uint8_t> bytes,
                  std::function<void(int, cJSON*)> cb) override {
        last_url = url;
        last_type = type;
        last_bytes = bytes.size();
        cJSON* j = cJSON_Parse(answer);
        cb(status, j);
        cJSON_Delete(j);
    }
    void postSSE(const std::string&, cJSON* body, SSEEventCallback, SSEDoneCallback done) override {
        cJSON_Delete(body);
        done(false);
    }
};

struct FakeFactory : ITransportFactory {
    FakeHttp* http = nullptr;
    IWebSocket* createWebSocket(uint32_t) override { return nullptr; }
    IHttpClient* createHttpClient(int) override { http = new FakeHttp(); return http; }
    IDiscovery* createDiscovery() override { return nullptr; }
};

static void test_client()
{
    FakeFactory f;
    VoiceClient v(&f, "mac.local", 9000);
    FakeHttp& h = *f.http;
    v.setToken("tok");
    expect("bearer", h.token, "tok");

    h.answer = R"({"enabled":true,"available":true,"provider":"gemini","model":"m","sample_rate":16000})";
    bool seen = false;
    v.refreshCapabilities(1000, [&](const VoiceCapabilities* c) { seen = c && c->available; });
    expect_int("capabilities fetched", seen, 1);
    expect("GET /voice", h.last_url, "http://mac.local:9000/voice");
    v.refreshCapabilities(2000);
    expect_int("cached for 5 minutes", h.gets, 1);
    expect_int("fresh", v.capabilities(2000) != nullptr, 1);
    expect_int("stale after 5 minutes", v.capabilities(1000 + VOICE_CAPABILITIES_TTL_MS + 1) == nullptr, 1);

    std::vector<uint8_t> wav(WAV_HEADER_BYTES + 32000, 0);
    wav_write_header(wav.data(), 32000);
    h.answer = R"({"text":"go ahead"})";
    std::string got;
    v.transcribe(std::move(wav), VoicePurpose::Reply, "att 1", "/ws/lee", [&](const TranscribeResult& r) { got = r.text; });
    expect("transcript", got, "go ahead");
    expect("URL", h.last_url, "http://mac.local:9000/voice/transcribe?purpose=reply&item_id=att%201&workspace=/ws/lee");
    expect("raw WAV body", h.last_type, "audio/wav");
    expect_int("whole clip sent", (long long)h.last_bytes, WAV_HEADER_BYTES + 32000);

    h.status = 503;
    h.answer = R"({"detail":"voice_disabled"})";
    v.transcribe(std::vector<uint8_t>(64, 0), VoicePurpose::Capture, "", "", [](const TranscribeResult&) {});
    expect_int("a 503 drops the cache", v.capabilities(2000) == nullptr, 1);
    expect("no item or workspace", h.last_url, "http://mac.local:9000/voice/transcribe?purpose=capture");
}

int main()
{
    test_header();
    test_clip();
    test_append();
    test_capabilities();
    test_transcribe();
    test_client();
    printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
    return fails ? 1 : 0;
}
