#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace dirigible_app {

// ---------------------------------------------------------------------------
// VtScreen — a fixed character grid fed by a deliberately small VT parser.
//
// Scope (E3).  This is not a terminal emulator; it is enough of one that
// `ls`, `git status`, `lazygit`, `htop`, `claude` and a shell prompt are
// readable on a 320x240 panel:
//
//   handled : CR, LF, BS, TAB, FF, BEL(ignored), ESC M (reverse index),
//             ESC 7 / ESC 8 (save/restore cursor), charset selection
//             (ESC ( X, swallowed)
//   CSI     : CUU/CUD/CUF/CUB (A/B/C/D), CNL/CPL (E/F), CHA (G), VPA (d),
//             CUP/HVP (H/f), ED (J), EL (K), IL/DL (L/M), DCH (P), ICH (@),
//             SU/SD (S/T), DECSTBM (r), SCP/RCP (s/u), SGR (m — foreground
//             colour and reverse video are kept, see below), everything else
//             consumed and dropped; `?`/`>`/`<`/`=` private sequences are
//             dropped without being mistaken for their non-private finals
//   OSC     : consumed up to BEL or ST (window titles, colour queries)
//
// UTF-8 (E15).  The stream is decoded to codepoints and each codepoint folded
// to ONE cell of ASCII, because the lifted monospace font (lv_font_unscii_8)
// has no glyphs above 0x7F.  Doing this at the byte level — which is what the
// first cut did — spent one cell per *byte*, so every box-drawing rule, `·`
// and `…` in a modern TUI silently ate two or three columns and shoved the
// rest of the line sideways.  Box drawing folds to -|+, blocks to #, arrows to
// <^>v, and anything unrecognised to '?'.  Double-width codepoints (CJK,
// emoji) consume two cells so the remote program's column arithmetic still
// lines up.
//
// Colour (E15).  Each cell carries an attribute byte: a 16-colour foreground
// index plus a reverse-video bit.  256-colour and 24-bit SGR are folded to the
// nearest of the 16.  Backgrounds are parsed and dropped — an LVGL label can
// recolour a span of text but cannot fill behind it — so reverse video is
// rendered as a colour swap instead, which is enough to keep a selected row in
// lazygit or a highlighted menu item visible.
//
// Deliberately absent: bold/underline as distinct attributes (bold only
// brightens the colour), alternate screen buffer bookkeeping (the alt-screen
// switch is swallowed as an unknown private mode, which in practice just means
// a full-screen app redraws over whatever was there), scrollback, mouse
// reporting, character sets beyond ASCII.
// ---------------------------------------------------------------------------

inline constexpr int VT_MAX_COLS = 64;
inline constexpr int VT_MAX_ROWS = 32;

/// Attribute byte layout.
inline constexpr uint8_t VT_FG_MASK  = 0x0F;   // 16-colour foreground index
inline constexpr uint8_t VT_REVERSE  = 0x10;
inline constexpr uint8_t VT_DEFAULT_FG = 7;
inline constexpr uint8_t VT_ATTR_DEFAULT = VT_DEFAULT_FG;

/// The 16 ANSI colours as rendered on this panel.  Index 0 is lifted off pure
/// black on purpose: programs draw black-on-colour and the background is
/// dropped, so a literal 0x000000 would render as an invisible run of text.
uint32_t vt_palette(uint8_t index);

/// Longest markup a row can produce: every cell its own `#RRGGBB ` span plus a
/// closing `#`, with `#` in the payload escaped as `##`.
inline constexpr int VT_MARKUP_MAX = VT_MAX_COLS * 12 + 16;

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

    /// Row `r` as LVGL recolour markup (`#RRGGBB text#`), trailing blanks
    /// trimmed.  Valid until the next call; feed it to a label that has
    /// lv_label_set_recolor(l, true).
    const char* rowMarkup(int r) const;

    int cursorRow() const { return row_; }
    int cursorCol() const { return col_; }

    /// Cleared by the renderer once it has repainted.  Rows track their own
    /// dirty bit so a repaint only touches the labels that changed — at 24
    /// rows of recolour markup, repainting the lot every 60 ms was most of the
    /// LVGL budget.
    bool dirty() const          { return dirty_; }
    bool rowDirty(int r) const  { return r >= 0 && r < VT_MAX_ROWS && row_dirty_[r]; }
    void clearDirty();

private:
    void put(uint32_t cp);
    void putCell(char ch);
    void newline();
    void scrollUp(int n);
    void scrollDown(int n);
    void clearRow(int r, int from, int to);
    void execCsi(uint8_t final_byte);
    void execSgr();
    void touch(int r);
    void touchAll();
    int  param(int idx, int def) const;

    enum class State : uint8_t { Ground, Esc, Csi, Osc, OscEsc, Charset, Utf8 };

    char    cells_[VT_MAX_ROWS][VT_MAX_COLS + 1] = {};
    uint8_t attrs_[VT_MAX_ROWS][VT_MAX_COLS] = {};
    mutable char row_out_[VT_MAX_COLS + 1] = {};
    mutable char markup_out_[VT_MARKUP_MAX] = {};

    int cols_ = 40;
    int rows_ = 20;
    int row_  = 0;
    int col_  = 0;
    int saved_row_ = 0;
    int saved_col_ = 0;
    int scroll_top_ = 0;          // inclusive
    int scroll_bot_ = VT_MAX_ROWS;  // exclusive

    uint8_t attr_       = VT_ATTR_DEFAULT;   // current SGR state
    uint8_t saved_attr_ = VT_ATTR_DEFAULT;
    bool    bold_       = false;

    State    state_ = State::Ground;
    uint32_t utf8_cp_        = 0;   // codepoint under construction
    int      utf8_remaining_ = 0;   // continuation bytes still expected
    int      params_[8] = {};
    int      param_count_ = 0;
    bool     param_started_ = false;
    bool     private_ = false;      // CSI carried a ?/>/</= prefix
    bool     dirty_ = true;
    bool     row_dirty_[VT_MAX_ROWS] = {};
};

/// Fold one line of UTF-8 to the ASCII the unscii fonts can draw, using the
/// same one-cell-per-codepoint rules as VtScreen (box drawing to -|+, quotes
/// and dashes to their ASCII shapes, wide codepoints to two cells, anything
/// unknown to '?').  Tabs expand to `tab_width`-column stops; other control
/// bytes are dropped.  Used by the file viewer.
std::string fold_utf8_line(const char* s, size_t n, int tab_width = 4);

}  // namespace dirigible_app
