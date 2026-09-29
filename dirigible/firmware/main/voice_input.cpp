/*
 * voice_input.cpp — see voice_input.hpp.  Built only with
 * CONFIG_DIRIGIBLE_VOICE.
 *
 * States (Lee's VoiceState, less `arming`: the mic starts synchronously):
 *
 *   idle --start--> recording --stop / 30 s--> transcribing --> idle
 *                       |                           |
 *                       +--cancel / too short / silent / mic failed--> idle
 *
 * A worker task reads the mic into a buffer sized for the whole 30 s cap
 * (960 KB, PSRAM) with room for the WAV header in front, so the clip is never
 * copied or reallocated.  The LVGL task watches it on a 200 ms timer: that is
 * what reports the elapsed time, notices the cap, and hands the finished clip
 * to VoiceClient.  The audio lives only as long as the upload; nothing is
 * kept or logged.
 */

#include "voice_input.hpp"

#if CONFIG_DIRIGIBLE_VOICE

#include <atomic>
#include <cstring>
#include <cstdio>
#include <vector>

#include "app.hpp"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "tdeck_bsp.h"

static const char* TAG = "dirigible.voice";

namespace dirigible_app::voice {

namespace {

using dirigible::VoiceClient;
using dirigible::VoicePurpose;

enum class Phase : uint8_t { Idle, Recording, Transcribing };

constexpr size_t MAX_PCM = (size_t)dirigible::VOICE_MAX_MS_DIRIGIBLE * dirigible::VOICE_BYTES_PER_MS;
constexpr size_t CHUNK_SAMPLES = 512;   // 32 ms a read

struct State {
    Phase phase = Phase::Idle;
    VoiceClient* client = nullptr;
    std::string  client_for;       // machine the client was made for
    bool         mic_failed = false;

    // The clip in flight.
    std::vector<uint8_t> wav;      // header space + PCM, sized once
    std::atomic<size_t>  pcm_bytes{ 0 };
    std::atomic<bool>    stop_flag{ false };
    std::atomic<bool>    task_done{ true };
    std::atomic<bool>    task_failed{ false };
    bool                 discard = false;
    VoicePurpose purpose = VoicePurpose::Reply;
    std::string  item_id;
    Done         done;
    Tick         tick;
    lv_timer_t*  timer = nullptr;
    uint32_t     started = 0;
};

State& st()
{
    static State s;
    return s;
}

/// The VoiceClient for the active machine (Hester's port, the same bearer).
VoiceClient* client()
{
    auto& s = st();
    auto& a = app();
    auto* m = a.machines ? a.machines->activeMachine() : nullptr;
    if (!m || !a.factory) return nullptr;
    const std::string key = m->config.name + "@" + m->config.host;
    if (!s.client || s.client_for != key) {
        // Never deleted while a request may be in flight: an old client is
        // leaked on a machine switch, which happens a handful of times a year.
        s.client = new VoiceClient(a.factory, m->config.host, m->config.hester_port);
        s.client_for = key;
    }
    std::string token = m->token;
    if (token.empty() && a.config) token = a.config->getToken(m->config.name);
    s.client->setToken(token);
    return s.client;
}

void finish(bool ok, const std::string& text_or_error)
{
    auto& s = st();
    s.phase = Phase::Idle;
    std::vector<uint8_t>().swap(s.wav);
    Done done = std::move(s.done);
    s.done = nullptr;
    s.tick = nullptr;
    if (done) done(ok, text_or_error);
}

void record_task(void*)
{
    auto& s = st();
    int16_t chunk[CHUNK_SAMPLES];
    while (!s.stop_flag.load()) {
        const size_t n = tdeck_mic_read(chunk, CHUNK_SAMPLES, 200);
        if (n == 0) continue;
        size_t at = s.pcm_bytes.load();
        size_t bytes = n * sizeof(int16_t);
        if (at + bytes > MAX_PCM) bytes = MAX_PCM - at;
        memcpy(s.wav.data() + dirigible::WAV_HEADER_BYTES + at, chunk, bytes);
        s.pcm_bytes.store(at + bytes);
        if (at + bytes >= MAX_PCM) break;   // the cap: the timer stops and transcribes
    }
    tdeck_mic_stop();
    s.task_done.store(true);
    vTaskDelete(nullptr);
}

void upload()
{
    auto& s = st();
    const size_t pcm = s.pcm_bytes.load();
    const int64_t ms = dirigible::voice_pcm_ms(pcm);
    // Too short or too quiet never leaves the device (Hester would only
    // guess at it).
    if (ms < dirigible::VOICE_MIN_MS) { finish(false, "Too short - tap, speak, tap"); return; }
    const auto* samples = (const int16_t*)(s.wav.data() + dirigible::WAV_HEADER_BYTES);
    // The level, for checking the mic on a new board: speech should peak well above the silence gate.
    ESP_LOGI(TAG, "clip %d ms, peak %d of 32767 (gate %d)", (int)ms,
             dirigible::voice_peak(samples, pcm / sizeof(int16_t)), dirigible::VOICE_SILENCE_PEAK);
    if (dirigible::voice_is_silent(samples, pcm / sizeof(int16_t))) {
        finish(false, "Didn't hear anything");
        return;
    }
    VoiceClient* c = client();
    if (!c) { finish(false, "Not connected"); return; }

    dirigible::wav_write_header(s.wav.data(), (uint32_t)pcm);
    s.wav.resize(dirigible::WAV_HEADER_BYTES + pcm);
    s.phase = Phase::Transcribing;
    auto* conn = app().machines ? app().machines->activeConnection() : nullptr;
    const std::string ws = conn ? conn->followedWorkspace() : std::string();
    ESP_LOGI(TAG, "transcribing %d ms (%u bytes)", (int)ms, (unsigned)s.wav.size());
    c->transcribe(std::move(s.wav), s.purpose, s.item_id, ws,
                  [](const dirigible::TranscribeResult& r) {
        if (!r.ok) {
            ESP_LOGW(TAG, "transcribe: %d %s", r.status, r.error.c_str());
            finish(false, dirigible::voice_error_text(r));
            return;
        }
        if (r.text.empty()) { finish(false, "Didn't catch any words"); return; }
        finish(true, r.text);
    });
}

void timer_cb(lv_timer_t* t)
{
    auto& s = st();
    if (s.phase != Phase::Recording) return;
    const int ms = (int)dirigible::voice_pcm_ms(s.pcm_bytes.load());
    if (!s.task_done.load()) {
        if (s.tick) s.tick(ms);
        return;
    }
    // The worker has stopped: a tap, the cap, or cancel.
    lv_timer_del(t);
    s.timer = nullptr;
    if (s.discard) { finish(false, "Cancelled"); return; }
    upload();
}

}  // namespace

void refresh(std::function<void()> changed)
{
    VoiceClient* c = client();
    if (!c) return;
    c->refreshCapabilities(lv_tick_get(), [changed](const dirigible::VoiceCapabilities*) {
        if (changed) changed();
    });
}

bool available()
{
    auto& s = st();
    if (s.mic_failed || !s.client) return false;
    const auto* caps = s.client->capabilities(lv_tick_get());
    return caps && caps->available;
}

bool busy()      { return st().phase != Phase::Idle; }
// Stopping counts as done at the tap: the worker takes up to a read (32 ms)
// and the timer up to 200 ms to notice, and the button shouldn't wait for them.
bool recording() { return st().phase == Phase::Recording && !st().stop_flag.load(); }

const char* button_label()
{
    if (recording()) return LV_SYMBOL_STOP;
    return busy() ? "..." : MIC_LABEL;   // "...": stopped, Hester is transcribing
}

bool start(VoicePurpose purpose, const std::string& item_id, Done done, Tick tick)
{
    auto& s = st();
    if (s.phase != Phase::Idle || !available()) return false;

    // The whole cap up front, from PSRAM (SPIRAM_USE_MALLOC sends a block
    // this size there).  Checked first: a failed new aborts, with no
    // exceptions in this build.
    const size_t need = dirigible::WAV_HEADER_BYTES + MAX_PCM;
    if (heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) < need + 4096) {
        if (done) done(false, "Not enough memory to record");
        return false;
    }
    s.wav.assign(need, 0);
    if (tdeck_mic_start(dirigible::VOICE_SAMPLE_RATE) != ESP_OK) {
        // Hide the mic until reboot: a board whose mic won't start (or whose
        // pins are wrong) shouldn't keep offering it.
        s.mic_failed = true;
        std::vector<uint8_t>().swap(s.wav);
        if (done) done(false, "The mic didn't start");
        return false;
    }
    s.purpose = purpose;
    s.item_id = item_id;
    s.done = std::move(done);
    s.tick = std::move(tick);
    s.pcm_bytes.store(0);
    s.stop_flag.store(false);
    s.task_done.store(false);
    s.discard = false;
    s.phase = Phase::Recording;
    s.started = lv_tick_get();
    if (xTaskCreate(record_task, "dir_mic", 4096, nullptr, 5, nullptr) != pdPASS) {
        tdeck_mic_stop();
        s.task_done.store(true);
        finish(false, "The mic didn't start");
        return false;
    }
    s.timer = lv_timer_create(timer_cb, 200, nullptr);
    ESP_LOGI(TAG, "recording");
    return true;
}

void stop()
{
    auto& s = st();
    if (s.phase == Phase::Recording) s.stop_flag.store(true);
}

void cancel()
{
    auto& s = st();
    if (s.phase == Phase::Recording) {
        s.discard = true;
        s.stop_flag.store(true);
    }
    // A clip already uploading can't be recalled; its answer still lands in
    // the box, where it can be deleted.
}

void fill(lv_obj_t* ta, const std::string& transcript)
{
    if (!ta) return;
    const char* raw = lv_textarea_get_text(ta);
    const std::string draft = raw ? raw : "";
    const std::string next = dirigible::append_transcript(draft, transcript);
    if (next == draft) return;
    if (next.compare(0, draft.size(), draft) == 0) {
        lv_textarea_set_cursor_pos(ta, LV_TEXTAREA_CURSOR_LAST);
        lv_textarea_add_text(ta, next.c_str() + draft.size());
    } else {
        lv_textarea_set_text(ta, next.c_str());   // a blank draft became the transcript
    }
    lv_textarea_set_cursor_pos(ta, LV_TEXTAREA_CURSOR_LAST);
}

std::string elapsed_text(int ms)
{
    const int s = ms / 1000;
    const int cap = dirigible::VOICE_MAX_MS_DIRIGIBLE / 1000;
    char buf[32];
    snprintf(buf, sizeof(buf), "%d:%02d / %d:%02d  tap to stop", s / 60, s % 60, cap / 60, cap % 60);
    return buf;
}

}  // namespace dirigible_app::voice

#endif  // CONFIG_DIRIGIBLE_VOICE
