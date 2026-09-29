/*
 * ui_text.hpp — text helpers for the proportional (Montserrat) UI font.
 *
 * Montserrat as built into LVGL draws ASCII, the degree sign and the
 * LV_SYMBOL_* FontAwesome subset, nothing else.  Text from the wire (agent
 * output, tab labels, file names, SSIDs, window names) is folded first so a
 * curly quote or an em dash reads as its ASCII shape instead of vanishing.
 *
 * The monospace viewer/terminal paths have their own cell-accurate folding in
 * vt.hpp (fold_utf8_line / VtScreen); this is the proportional-text one.
 */
#pragma once

#include <string>

#include "lvgl.h"

namespace dirigible_app {

/// Fold UTF-8 to what Montserrat can draw: ASCII, the punctuation agents
/// actually use mapped to ASCII (quotes, dashes, ellipsis, arrow, nbsp), middle
/// dot and bullet to LV_SYMBOL_BULLET, LV_SYMBOL_* codepoints (U+F000-U+F8FF)
/// passed through, anything else one '?' per codepoint.  Tabs and CR become
/// spaces; newlines survive only with `keep_newlines`.
std::string ui_fold(const std::string& in, bool keep_newlines = false);
std::string ui_fold(const char* in, bool keep_newlines = false);

/// lv_label_set_text() through ui_fold(); newlines kept.
void ui_set_text(lv_obj_t* label, const char* text);
inline void ui_set_text(lv_obj_t* label, const std::string& text) { ui_set_text(label, text.c_str()); }

/// Keep the tail of `text` that fits `max_w` px in `font`, prefixed with "..",
/// for paths where the nearest directory is the useful end.  Returns `text`
/// unchanged when it already fits.
std::string ui_fit_tail(const std::string& text, const lv_font_t* font, int max_w);

/// Advance width of one ASCII byte in `font` (no kerning, so a run of these
/// never under-estimates Montserrat's mostly-negative kerning pairs).
/// Cached per font; non-ASCII bytes measure as '?'.
int ui_char_w(const lv_font_t* font, unsigned char c);

}  // namespace dirigible_app
