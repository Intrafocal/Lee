#pragma once

/*
 * voice_input.hpp — voice input on the T-Deck (plan 2026-09-28 §5.6), built
 * only with CONFIG_DIRIGIBLE_VOICE (Kconfig, default off until it has been
 * checked on a device).  One recording at a time, tap to start and tap to
 * stop (the keypad reports no key-up, so there is no hold), a 30 s cap that
 * stops and still transcribes.  A clip too short or too quiet never leaves
 * the device.  The transcript goes into the text box it belongs to, through
 * lv_textarea_add_text; nothing is ever sent by voice.
 *
 * Recording is tdeck-bsp's tdeck_mic_* (ES7210 over I2S) into PSRAM on a
 * worker task; transcription is Hester's POST /voice/transcribe via
 * dirigible::VoiceClient.  Every callback runs on the LVGL task.
 */

#include "sdkconfig.h"

#if CONFIG_DIRIGIBLE_VOICE

#include <functional>
#include <string>

#include "dirigible/voice.hpp"
#include "lvgl.h"

namespace dirigible_app::voice {

/// The mic button's label: LVGL's symbol font has no microphone (its "audio"
/// glyph is a music note), so a word, like the tab view's Keys and Type.
inline constexpr const char* MIC_LABEL = "Mic";

/// What the mic button shows: stop while recording, "..." from the tap until
/// the transcript lands, else Mic.
const char* button_label();

/// Ask Hester whether voice is on (GET /voice, cached 5 minutes).  Cheap:
/// call it whenever a screen with a mic opens.  `changed` runs when the
/// answer lands, so the screen can show or hide its mic.
void refresh(std::function<void()> changed = nullptr);

/// Show the mic: Hester has voice available and the mic has not failed.
bool available();
bool busy();          // recording or transcribing
bool recording();

using Done = std::function<void(bool ok, const std::string& text_or_error)>;
using Tick = std::function<void(int elapsed_ms)>;

/// Start a clip.  `done` gets the transcript, or a short line saying why
/// not; `tick` runs about five times a second while recording.  False (and
/// nothing started) when voice is unavailable or a clip is already going.
bool start(dirigible::VoicePurpose purpose, const std::string& item_id, Done done,
           Tick tick = nullptr);
void stop();          // stop and transcribe (the second tap)
void cancel();        // stop and discard

/// Put a transcript into a text box by Lee's appendTranscript rules: the
/// box's text becomes it when empty, else it is added at the end (after a
/// space if one is needed), and the caret goes to the end.
void fill(lv_obj_t* ta, const std::string& transcript);

/// "0:07 / 0:30" for a footer or status line.
std::string elapsed_text(int ms);

}  // namespace dirigible_app::voice

#endif  // CONFIG_DIRIGIBLE_VOICE
