#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "dirigible/transport.hpp"

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// Voice input (docs/plans/2026-09-28-tether-review-voice.md §5; Lee's
// electron/src/shared/voice.ts, mirrored by hand).  Hester transcribes; the
// T-Deck only records.  A clip is 16 kHz mono 16-bit PCM WAV sent as the raw
// body of Hester's POST /voice/transcribe, and the transcript fills the text
// box it belongs to: nothing here ever sends a reply on its own.
//
// Everything in this header except VoiceClient is pure and host-tested
// (tools/wav-test).  The firmware builds the UI half only with
// CONFIG_DIRIGIBLE_VOICE; these pieces compile either way.
// ---------------------------------------------------------------------------

inline constexpr int VOICE_SAMPLE_RATE     = 16000;
inline constexpr int VOICE_CHANNELS        = 1;
inline constexpr int VOICE_BITS_PER_SAMPLE = 16;
inline constexpr int VOICE_MIN_MS          = 300;
/// The client cap on the T-Deck (Lee and Aeronaut stop at 60 s): 30 s is
/// ~960 KB of PSRAM and a 4-8 s upload over Wi-Fi.
inline constexpr int VOICE_MAX_MS_DIRIGIBLE = 30000;
inline constexpr uint32_t VOICE_CAPABILITIES_TTL_MS = 5 * 60 * 1000;
inline constexpr size_t WAV_HEADER_BYTES = 44;

/// Bytes of 16 kHz mono PCM16 per millisecond.
inline constexpr size_t VOICE_BYTES_PER_MS =
    (size_t)VOICE_SAMPLE_RATE * VOICE_CHANNELS * (VOICE_BITS_PER_SAMPLE / 8) / 1000;   // 32

/// The purpose a clip is transcribed for; Hester builds its vocabulary hint
/// from it.
enum class VoicePurpose : uint8_t { Reply, Capture, Ask, Send };
const char* voice_purpose_name(VoicePurpose p);

/// GET /voice on Hester.  Show the mic only when `available`.
struct VoiceCapabilities {
    bool        enabled   = false;
    bool        available = false;
    std::string reason;        // disabled | no_api_key | whisper_not_installed | ...
    std::string provider;
    std::string model;
    int         sample_rate = VOICE_SAMPLE_RATE;
    int         max_seconds = 60;
    int64_t     max_bytes   = 0;
};

/// False (leaving `out` untouched) when `json` is not a GET /voice body.
bool voice_capabilities_parse(cJSON* json, VoiceCapabilities& out);

/// The outcome of POST /voice/transcribe.  `error` holds Hester's code
/// (voice_disabled, voice_unavailable:<reason>, too_large, too_long,
/// too_short, ...) or a client one (network, silence, cancelled).
struct TranscribeResult {
    int         status = 0;    // HTTP status; 0 = no answer
    bool        ok = false;
    std::string text;
    std::string error;
    int64_t     audio_ms = 0;
    int64_t     latency_ms = 0;
};

void transcribe_result_parse(int status, cJSON* json, TranscribeResult& out);

/// A short line for the footer / status slot: "Hester can't hear yet",
/// "Too short", ...  Never the transcript.
std::string voice_error_text(const TranscribeResult& r);

/// Write the canonical 44-byte RIFF/WAVE header for `data_bytes` of PCM.
void wav_write_header(uint8_t* out, uint32_t data_bytes,
                      int sample_rate = VOICE_SAMPLE_RATE,
                      int channels = VOICE_CHANNELS,
                      int bits = VOICE_BITS_PER_SAMPLE);

/// Parse a header written by wav_write_header (or any plain PCM WAV with the
/// fmt chunk first).  False when it is not one.
struct WavInfo {
    int      sample_rate = 0;
    int      channels = 0;
    int      bits = 0;
    uint32_t data_bytes = 0;
    uint32_t data_offset = 0;
};
bool wav_read_header(const uint8_t* data, size_t len, WavInfo& out);

/// Milliseconds of audio in `pcm_bytes` of 16 kHz mono PCM16.
int64_t voice_pcm_ms(size_t pcm_bytes);

/// Peak absolute sample of `n` PCM16 samples.
int voice_peak(const int16_t* pcm, size_t n);

/// A clip too quiet to be speech: its peak stays under `threshold` (about
/// -36 dBFS by default).  Silent clips are never uploaded.
inline constexpr int VOICE_SILENCE_PEAK = 512;
bool voice_is_silent(const int16_t* pcm, size_t n, int threshold = VOICE_SILENCE_PEAK);

/// Lee's appendTranscript: the transcript is trimmed, a blank one leaves the
/// draft unchanged, an empty (or whitespace) draft becomes the transcript,
/// otherwise draft + a space if needed + transcript.  The caret goes to the
/// end, which is where lv_textarea_add_text leaves it.
std::string append_transcript(const std::string& draft, const std::string& transcript);

// ---------------------------------------------------------------------------
// VoiceClient — Hester's GET /voice and POST /voice/transcribe, with the
// same bearer as the Lee API.  Capabilities are cached for 5 minutes and
// dropped after a 503, so a Hester that turns voice on shows the mic soon.
// ---------------------------------------------------------------------------

class VoiceClient {
public:
    VoiceClient(ITransportFactory* factory, const std::string& host, int hester_port);
    ~VoiceClient();

    VoiceClient(const VoiceClient&) = delete;
    VoiceClient& operator=(const VoiceClient&) = delete;

    void setToken(const std::string& token);

    /// The last capabilities seen, or null.  `now_ms` is the caller's clock
    /// (lv_tick_get on the device); a stale answer counts as none.
    const VoiceCapabilities* capabilities(uint32_t now_ms) const;
    /// Fetch GET /voice unless a fresh answer is cached.
    void refreshCapabilities(uint32_t now_ms, std::function<void(const VoiceCapabilities*)> cb = nullptr);
    void forgetCapabilities() { have_caps_ = false; }

    /// POST /voice/transcribe?purpose=&item_id=&workspace= with `wav` (a
    /// whole WAV file, header included) as the raw body.
    void transcribe(std::vector<uint8_t> wav, VoicePurpose purpose,
                    const std::string& item_id, const std::string& workspace,
                    std::function<void(const TranscribeResult&)> cb);

private:
    std::string url(const char* path) const;

    IHttpClient* http_ = nullptr;
    std::string  host_;
    int          port_;

    VoiceCapabilities caps_;
    bool     have_caps_ = false;
    uint32_t caps_at_ = 0;
};

}  // namespace dirigible
