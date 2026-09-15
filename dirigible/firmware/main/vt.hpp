#pragma once

#include <cstddef>
#include <cstdint>

namespace dirigible_app {

// ---------------------------------------------------------------------------
// VtScreen — a fixed character grid fed by a deliberately small VT parser.
//
// Scope (E3).  This is not a terminal emulator; it is enough of one that
// `ls`, `git status`, `lazygit`, `htop` and a shell prompt are readable on a
// 320x240 panel:
//
//   handled : CR, LF, BS, TAB, FF, BEL(ignored), ESC M (reverse index),
//             ESC 7 / ESC 8 (save/restore cursor), charset selection
//             (ESC ( X, swallowed)
//   CSI     : CUU/CUD/CUF/CUB (A/B/C/D), CNL/CPL (E/F), CHA (G), VPA (d),
//             CUP/HVP (H/f), ED (J), EL (K), IL/DL (L/M), DCH (P), ICH (@),
//             SU/SD (S/T), DECSTBM (r), SCP/RCP (s/u), SGR (m — parsed and
//             discarded, the panel is monochrome-by-choice), everything else
//             consumed and dropped, private `?`-prefixed modes included
//   OSC     : consumed up to BEL or ST (window titles, colour queries)
//
// Deliberately absent: colour, bold/underline attributes, alternate screen
// buffer bookkeeping (the alt-screen switch is swallowed as an unknown private
// mode, which in practice just means a full-screen app redraws over whatever
// was there), scrollback, mouse reporting, character sets beyond ASCII.
// Bytes >= 0x80 are rendered as '?' because the lifted monospace font
// (lv_font_unscii_8) has no glyphs above ASCII and LVGL labels require valid
// UTF-8.
// ---------------------------------------------------------------------------

inline constexpr int VT_MAX_COLS = 64;
inline constexpr int VT_MAX_ROWS = 32;

class VtScreen {
public:
    void resize(int cols, int rows);
    void reset();

    /// Feed PTY output.  Returns true if anything on screen changed.
    bool feed(const uint8_t* data, size_t len);

    int cols() const { return cols_; }
    int rows() const { return rows_; }

    /// Row `r` as a NUL-terminated ASCII string, trailing blanks trimmed.
    const char* row(int r) const;

    int cursorRow() const { return row_; }
    int cursorCol() const { return col_; }

    /// Cleared by the renderer once it has repainted.
    bool dirty() const  { return dirty_; }
    void clearDirty()   { dirty_ = false; }

private:
    void put(uint8_t ch);
    void newline();
    void scrollUp(int n);
    void scrollDown(int n);
    void clearRow(int r, int from, int to);
    void execCsi(uint8_t final_byte);
    int  param(int idx, int def) const;

    enum class State : uint8_t { Ground, Esc, Csi, Osc, OscEsc, Charset };

    char  cells_[VT_MAX_ROWS][VT_MAX_COLS + 1] = {};
    mutable char row_out_[VT_MAX_COLS + 1] = {};

    int cols_ = 40;
    int rows_ = 20;
    int row_  = 0;
    int col_  = 0;
    int saved_row_ = 0;
    int saved_col_ = 0;
    int scroll_top_ = 0;          // inclusive
    int scroll_bot_ = VT_MAX_ROWS;  // exclusive

    State   state_ = State::Ground;
    int     params_[8] = {};
    int     param_count_ = 0;
    bool    param_started_ = false;
    bool    dirty_ = true;
};

}  // namespace dirigible_app
