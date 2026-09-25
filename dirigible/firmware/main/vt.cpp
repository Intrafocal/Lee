#include "vt.hpp"

#include <cstdio>
#include <cstring>

#include "theme_tokens.h"

namespace dirigible_app {

namespace {

inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---------------------------------------------------------------------------
// Codepoint folding
//
// One cell per codepoint, always.  The font is ASCII-only, so the job is to
// pick the ASCII character that preserves the *shape* of the line: a box rule
// must stay a rule, a bullet must stay a mark, and nothing may change width.
// ---------------------------------------------------------------------------

// U+2500..U+257F, in order.  Horizontals '-', verticals '|', every corner,
// tee and cross '+', diagonals as drawn.
const char kBoxDrawing[129] =
    // One row per 16 codepoints from U+2500.  Horizontal rules '-', vertical
    // rules '|', every corner/tee/cross '+', diagonals as drawn.
    "--||--||--||++++"   // 2500 lines and light corners
    "++++++++++++++++"   // 2510 corners
    "++++++++++++++++"   // 2520 tees
    "++++++++++++++++"   // 2530 tees
    "++++++++++++--||"   // 2540 crosses, then 254C-254F dashes
    "-|++++++++++++++"   // 2550 double rules, then corners
    "++++++++++++++++"   // 2560 tees, crosses, rounded corners
    "+/\\X-|-|-|-|-|-|";  // 2570 rounded, diagonals, half-rules
               // 2570-257F

/// Half-width geometric / symbol folds.  Returns 0 when not handled.
char fold_symbol(uint32_t cp)
{
    switch (cp) {
    case 0x00A0: return ' ';                       // NBSP
    case 0x00AB: case 0x2039: return '<';
    case 0x00BB: case 0x203A: return '>';
    case 0x00B0: return 'o';                       // degree
    case 0x00B1: return '+';
    case 0x00B7: case 0x2027: return '.';          // middle dot
    case 0x2022: case 0x25CF: case 0x25CB:
    case 0x25AA: case 0x25A0: case 0x25E6: return '*';
    case 0x2026: return '.';                       // ellipsis, one cell
    case 0x2018: case 0x2019: case 0x02BC: return '\'';
    case 0x201C: case 0x201D: return '"';
    case 0x2190: return '<';
    case 0x2191: return '^';
    case 0x2192: case 0x279C: case 0x27A4: return '>';
    case 0x2193: return 'v';
    case 0x2713: case 0x2714: return 'v';          // check
    case 0x2717: case 0x2718: case 0x2715: return 'x';
    case 0x26A0: return '!';                       // warning
    case 0x2588: return '#';
    case 0x00D7: return 'x';
    default: break;
    }
    if (cp >= 0x2010 && cp <= 0x2015) return '-';  // hyphens / dashes
    if (cp >= 0x2580 && cp <= 0x2590) return '#';  // block elements
    if (cp >= 0x2591 && cp <= 0x2593) return ':';  // shade blocks
    if (cp >= 0x2594 && cp <= 0x259F) return '#';
    if (cp >= 0x25A1 && cp <= 0x25FF) return '*';  // geometric shapes
    if (cp >= 0x2500 && cp <= 0x257F) return kBoxDrawing[cp - 0x2500];
    return 0;
}

/// Zero-width: combining marks and formatting characters take no cell.
bool is_zero_width(uint32_t cp)
{
    return (cp >= 0x0300 && cp <= 0x036F) ||    // combining diacriticals
           (cp >= 0x200B && cp <= 0x200F) ||    // ZWSP..RLM
           (cp >= 0xFE00 && cp <= 0xFE0F) ||    // variation selectors
           cp == 0xFEFF ||                      // BOM / ZWNBSP
           (cp >= 0x1F3FB && cp <= 0x1F3FF);    // skin-tone modifiers
}

/// Double-width, per the East Asian Wide/Fullwidth ranges a terminal cares
/// about.  Consuming two cells keeps the remote program's columns aligned.
bool is_wide(uint32_t cp)
{
    return (cp >= 0x1100 && cp <= 0x115F) ||
           (cp >= 0x2E80 && cp <= 0x303E) ||
           (cp >= 0x3041 && cp <= 0x33FF) ||
           (cp >= 0x3400 && cp <= 0x4DBF) ||
           (cp >= 0x4E00 && cp <= 0x9FFF) ||
           (cp >= 0xA000 && cp <= 0xA4CF) ||
           (cp >= 0xAC00 && cp <= 0xD7A3) ||
           (cp >= 0xF900 && cp <= 0xFAFF) ||
           (cp >= 0xFE30 && cp <= 0xFE6F) ||
           (cp >= 0xFF00 && cp <= 0xFF60) ||
           (cp >= 0xFFE0 && cp <= 0xFFE6) ||
           (cp >= 0x1F300 && cp <= 0x1FAFF) ||
           (cp >= 0x20000 && cp <= 0x3FFFD);
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------


/// Nearest of the 16 for a 24-bit colour: pick the hue by which channels are
/// dominant, then the brightness tier.  A full CIE match is not worth the
/// cycles when the output is eight-bit-per-channel text on a 2.8" panel.
uint8_t nearest_ansi(int r, int g, int b)
{
    const int max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const int min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    if (max - min < 32) {                       // greyscale
        if (max < 64)  return 0;
        if (max < 128) return 8;
        if (max < 200) return 7;
        return 15;
    }
    const int thr = min + (max - min) / 2;
    const int idx = (r > thr ? 1 : 0) | (g > thr ? 2 : 0) | (b > thr ? 4 : 0);
    // idx bits are r/g/b; the ANSI order is black,red,green,yellow,blue,...
    static const uint8_t kMap[8] = { 0, 1, 2, 3, 4, 5, 6, 7 };
    const uint8_t base = kMap[idx];
    return max >= 170 ? (uint8_t)(base + 8) : base;
}

/// xterm 256-colour index -> nearest of the 16.
uint8_t from_256(int n)
{
    if (n < 0) return VT_DEFAULT_FG;
    if (n < 16) return (uint8_t)n;
    if (n < 232) {
        const int c = n - 16;
        static const int kLevel[6] = { 0, 95, 135, 175, 215, 255 };
        return nearest_ansi(kLevel[(c / 36) % 6], kLevel[(c / 6) % 6], kLevel[c % 6]);
    }
    const int grey = 8 + (n - 232) * 10;
    return nearest_ansi(grey, grey, grey);
}

}  // namespace

uint32_t vt_palette(uint8_t index)
{
    index &= 0x0F;
    // Index 0 (ANSI black) is lifted to DG_TEXT_3 rather than the palette's
    // own DG_GROUND_4: backgrounds are parsed and dropped (see the VtScreen
    // class comment above), so black-on-colour text would otherwise render
    // as black-on-nothing and vanish against this screen's dark backgrounds
    // — the same workaround the old hand-picked table's 0x707070 did.
    if (index == 0) return DG_TEXT_3;
    static const uint32_t kPalette[16] = DG_ANSI_PALETTE;
    return kPalette[index];
}

// ---------------------------------------------------------------------------

void VtScreen::touch(int r)
{
    if (r >= 0 && r < VT_MAX_ROWS) row_dirty_[r] = true;
    dirty_ = true;
}

void VtScreen::touchAll()
{
    for (int r = 0; r < VT_MAX_ROWS; r++) row_dirty_[r] = true;
    dirty_ = true;
}

void VtScreen::clearDirty()
{
    for (int r = 0; r < VT_MAX_ROWS; r++) row_dirty_[r] = false;
    dirty_ = false;
}

void VtScreen::resize(int cols, int rows)
{
    cols_ = clampi(cols, 8, VT_MAX_COLS);
    rows_ = clampi(rows, 2, VT_MAX_ROWS);
    scroll_top_ = 0;
    scroll_bot_ = rows_;
    reset();
}

void VtScreen::reset()
{
    for (int r = 0; r < VT_MAX_ROWS; r++) {
        memset(cells_[r], ' ', VT_MAX_COLS);
        cells_[r][VT_MAX_COLS] = '\0';
        memset(attrs_[r], VT_ATTR_DEFAULT, VT_MAX_COLS);
    }
    row_ = col_ = saved_row_ = saved_col_ = 0;
    scroll_top_ = 0;
    scroll_bot_ = rows_;
    state_ = State::Ground;
    utf8_cp_ = 0;
    utf8_remaining_ = 0;
    param_count_ = 0;
    param_started_ = false;
    private_ = false;
    attr_ = saved_attr_ = VT_ATTR_DEFAULT;
    bold_ = false;
    touchAll();
}

const char* VtScreen::row(int r) const
{
    if (r < 0 || r >= rows_) { row_out_[0] = '\0'; return row_out_; }
    int last = -1;
    for (int c = 0; c < cols_; c++) {
        char ch = cells_[r][c];
        row_out_[c] = (ch >= 0x20 && ch < 0x7F) ? ch : ' ';
        if (row_out_[c] != ' ') last = c;
    }
    row_out_[last + 1] = '\0';
    return row_out_;
}

const char* VtScreen::rowMarkup(int r) const
{
    char* out = markup_out_;
    const char* const end = markup_out_ + VT_MARKUP_MAX - 16;
    *out = '\0';
    if (r < 0 || r >= rows_) return markup_out_;

    // Trailing blanks are dropped, but only when they carry no reverse-video
    // highlight — a selected row in a TUI is a run of reversed *spaces*, and
    // trimming it would erase the selection bar.
    int last = -1;
    for (int c = 0; c < cols_; c++) {
        const char ch = cells_[r][c];
        const bool blank = !(ch > 0x20 && ch < 0x7F);
        if (!blank || (attrs_[r][c] & VT_REVERSE)) last = c;
    }
    if (last < 0) return markup_out_;

    bool span_open = false;
    uint8_t span_attr = 0;
    for (int c = 0; c <= last; c++) {
        char ch = cells_[r][c];
        if (ch < 0x20 || ch >= 0x7F) ch = ' ';
        const uint8_t attr = attrs_[r][c];

        if (!span_open || attr != span_attr) {
            if (span_open) *out++ = '#';
            // Reverse video without a background: swap to bright white, which
            // is the one colour that reads as "picked out" on this panel.
            const uint8_t fg = (attr & VT_REVERSE) ? 15 : (attr & VT_FG_MASK);
            out += snprintf(out, 12, "#%06lX ", (unsigned long)vt_palette(fg));
            span_open = true;
            span_attr = attr;
        }
        if (out >= end) break;
        if (ch == '#') *out++ = '#';   // LVGL recolour escape: ## -> one #
        *out++ = ch;
    }
    if (span_open) *out++ = '#';
    *out = '\0';
    return markup_out_;
}

void VtScreen::clearRow(int r, int from, int to)
{
    if (r < 0 || r >= rows_) return;
    from = clampi(from, 0, cols_);
    to   = clampi(to, 0, cols_);
    for (int c = from; c < to; c++) {
        cells_[r][c] = ' ';
        // Erases paint with the *current* attribute, which is how a program
        // fills a coloured bar with ESC[7m ESC[K.
        attrs_[r][c] = attr_;
    }
    if (to > from) touch(r);
}

void VtScreen::scrollUp(int n)
{
    const int top = scroll_top_, bot = scroll_bot_;
    if (n <= 0 || bot - top <= 0) return;
    if (n >= bot - top) {
        for (int r = top; r < bot; r++) clearRow(r, 0, cols_);
        return;
    }
    for (int r = top; r < bot - n; r++) {
        memcpy(cells_[r], cells_[r + n], VT_MAX_COLS);
        memcpy(attrs_[r], attrs_[r + n], VT_MAX_COLS);
    }
    for (int r = bot - n; r < bot; r++) clearRow(r, 0, cols_);
    for (int r = top; r < bot; r++) touch(r);
}

void VtScreen::scrollDown(int n)
{
    const int top = scroll_top_, bot = scroll_bot_;
    if (n <= 0 || bot - top <= 0) return;
    if (n >= bot - top) {
        for (int r = top; r < bot; r++) clearRow(r, 0, cols_);
        return;
    }
    for (int r = bot - 1; r >= top + n; r--) {
        memcpy(cells_[r], cells_[r - n], VT_MAX_COLS);
        memcpy(attrs_[r], attrs_[r - n], VT_MAX_COLS);
    }
    for (int r = top; r < top + n; r++) clearRow(r, 0, cols_);
    for (int r = top; r < bot; r++) touch(r);
}

void VtScreen::newline()
{
    if (row_ + 1 >= scroll_bot_) {
        scrollUp(1);
        row_ = scroll_bot_ - 1;
    } else {
        row_++;
    }
}

void VtScreen::putCell(char ch)
{
    if (col_ >= cols_) {   // deferred wrap
        col_ = 0;
        newline();
    }
    cells_[row_][col_] = ch;
    attrs_[row_][col_] = attr_;
    touch(row_);
    col_++;
}

void VtScreen::put(uint32_t cp)
{
    if (is_zero_width(cp)) return;

    if (cp < 0x80) {
        putCell((char)cp);
        return;
    }

    char folded = fold_symbol(cp);
    const bool wide = is_wide(cp);
    if (!folded) folded = '?';

    putCell(folded);
    // A double-width codepoint occupied two columns on the host; consume the
    // second one here or every later character on the line lands one cell off.
    if (wide) putCell(' ');
}

int VtScreen::param(int idx, int def) const
{
    if (idx >= param_count_) return def;
    return params_[idx] == 0 && def != 0 ? def : params_[idx];
}

// ---------------------------------------------------------------------------
// SGR — foreground colour and reverse video are kept; the rest is parsed so it
// cannot be mistaken for a colour, then dropped.
// ---------------------------------------------------------------------------
void VtScreen::execSgr()
{
    if (param_count_ == 0) {                 // bare ESC[m == ESC[0m
        attr_ = VT_ATTR_DEFAULT;
        bold_ = false;
        return;
    }

    for (int i = 0; i < param_count_; i++) {
        const int p = params_[i];
        if (p == 0) {
            attr_ = VT_ATTR_DEFAULT;
            bold_ = false;
        } else if (p == 1) {
            bold_ = true;
            attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | ((attr_ & VT_FG_MASK) | 8));
        } else if (p == 22) {
            bold_ = false;
            attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | ((attr_ & VT_FG_MASK) & 7));
        } else if (p == 7) {
            attr_ |= VT_REVERSE;
        } else if (p == 27) {
            attr_ = (uint8_t)(attr_ & ~VT_REVERSE);
        } else if (p >= 30 && p <= 37) {
            uint8_t fg = (uint8_t)(p - 30);
            if (bold_) fg |= 8;
            attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | fg);
        } else if (p == 39) {
            attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | VT_DEFAULT_FG);
        } else if (p >= 90 && p <= 97) {
            attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | (uint8_t)(p - 90 + 8));
        } else if (p == 38 || p == 48) {
            // Extended colour: 38;5;n or 38;2;r;g;b.  Both forms are consumed
            // here so their sub-parameters are never read as further SGRs.
            const int mode = (i + 1 < param_count_) ? params_[i + 1] : -1;
            uint8_t fg = VT_DEFAULT_FG;
            if (mode == 5 && i + 2 < param_count_) {
                fg = from_256(params_[i + 2]);
                i += 2;
            } else if (mode == 2 && i + 4 < param_count_) {
                fg = nearest_ansi(params_[i + 2], params_[i + 3], params_[i + 4]);
                i += 4;
            } else {
                i = param_count_;   // malformed — drop the rest
            }
            if (p == 38) attr_ = (uint8_t)((attr_ & ~VT_FG_MASK) | fg);
            // p == 48 is a background: parsed, dropped.
        }
        // Everything else (underline, blink, backgrounds 40-49, ...) is ignored.
    }
}

void VtScreen::execCsi(uint8_t f)
{
    switch (f) {
    case 'A': row_ = clampi(row_ - param(0, 1), 0, rows_ - 1); break;
    case 'B': row_ = clampi(row_ + param(0, 1), 0, rows_ - 1); break;
    case 'C': col_ = clampi(col_ + param(0, 1), 0, cols_ - 1); break;
    case 'D': col_ = clampi(col_ - param(0, 1), 0, cols_ - 1); break;
    case 'E': row_ = clampi(row_ + param(0, 1), 0, rows_ - 1); col_ = 0; break;
    case 'F': row_ = clampi(row_ - param(0, 1), 0, rows_ - 1); col_ = 0; break;
    case 'G': col_ = clampi(param(0, 1) - 1, 0, cols_ - 1); break;
    case 'd': row_ = clampi(param(0, 1) - 1, 0, rows_ - 1); break;

    case 'H':
    case 'f':
        row_ = clampi(param(0, 1) - 1, 0, rows_ - 1);
        col_ = clampi(param(1, 1) - 1, 0, cols_ - 1);
        break;

    case 'J': {   // erase in display
        int mode = param(0, 0);
        if (mode == 0) {
            clearRow(row_, col_, cols_);
            for (int r = row_ + 1; r < rows_; r++) clearRow(r, 0, cols_);
        } else if (mode == 1) {
            for (int r = 0; r < row_; r++) clearRow(r, 0, cols_);
            clearRow(row_, 0, col_ + 1);
        } else {
            for (int r = 0; r < rows_; r++) clearRow(r, 0, cols_);
            // Many programs clear the screen then assume home position;
            // xterm does not move the cursor, and neither do we.
        }
        break;
    }

    case 'K': {   // erase in line
        int mode = param(0, 0);
        if (mode == 0)      clearRow(row_, col_, cols_);
        else if (mode == 1) clearRow(row_, 0, col_ + 1);
        else                clearRow(row_, 0, cols_);
        break;
    }

    case 'L': {   // insert lines at cursor
        int n = param(0, 1);
        int save_top = scroll_top_;
        scroll_top_ = row_;
        scrollDown(n);
        scroll_top_ = save_top;
        break;
    }
    case 'M': {   // delete lines at cursor
        int n = param(0, 1);
        int save_top = scroll_top_;
        scroll_top_ = row_;
        scrollUp(n);
        scroll_top_ = save_top;
        break;
    }

    case 'P': {   // delete characters
        int n = clampi(param(0, 1), 0, cols_ - col_);
        memmove(&cells_[row_][col_], &cells_[row_][col_ + n], cols_ - col_ - n);
        memmove(&attrs_[row_][col_], &attrs_[row_][col_ + n], cols_ - col_ - n);
        clearRow(row_, cols_ - n, cols_);
        touch(row_);
        break;
    }
    case '@': {   // insert blanks
        int n = clampi(param(0, 1), 0, cols_ - col_);
        memmove(&cells_[row_][col_ + n], &cells_[row_][col_], cols_ - col_ - n);
        memmove(&attrs_[row_][col_ + n], &attrs_[row_][col_], cols_ - col_ - n);
        clearRow(row_, col_, col_ + n);
        touch(row_);
        break;
    }

    case 'S': scrollUp(param(0, 1));   break;
    case 'T': scrollDown(param(0, 1)); break;

    case 'r':   // DECSTBM
        scroll_top_ = clampi(param(0, 1) - 1, 0, rows_ - 1);
        scroll_bot_ = clampi(param(1, rows_), 1, rows_);
        if (scroll_bot_ <= scroll_top_) { scroll_top_ = 0; scroll_bot_ = rows_; }
        row_ = scroll_top_;
        col_ = 0;
        break;

    case 's': saved_row_ = row_; saved_col_ = col_; saved_attr_ = attr_; break;
    case 'u': row_ = saved_row_; col_ = saved_col_; attr_ = saved_attr_; break;

    case 'm': execSgr(); break;
    default:  break;
    }
}

bool VtScreen::feed(const uint8_t* data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t ch = data[i];

        // A control byte inside a UTF-8 sequence means the sequence was
        // truncated; abandon it rather than swallowing the control.
        if (state_ == State::Utf8 && (ch & 0xC0) != 0x80) {
            put('?');
            state_ = State::Ground;
            utf8_remaining_ = 0;
        }

        switch (state_) {
        case State::Ground:
            switch (ch) {
            case 0x07: break;                         // BEL
            case 0x08: if (col_ > 0) col_--; break;   // BS
            case 0x09:                                // TAB
                col_ = clampi((col_ / 8 + 1) * 8, 0, cols_ - 1);
                break;
            case 0x0A:                                // LF
            case 0x0B:
            case 0x0C: newline(); break;
            case 0x0D: col_ = 0; break;               // CR
            case 0x1B: state_ = State::Esc; break;
            default:
                if (ch < 0x20) break;                 // other C0: dropped
                if (ch < 0x80) {
                    put(ch);
                } else if ((ch & 0xE0) == 0xC0) {
                    utf8_cp_ = ch & 0x1Fu;
                    utf8_remaining_ = 1;
                    state_ = State::Utf8;
                } else if ((ch & 0xF0) == 0xE0) {
                    utf8_cp_ = ch & 0x0Fu;
                    utf8_remaining_ = 2;
                    state_ = State::Utf8;
                } else if ((ch & 0xF8) == 0xF0) {
                    utf8_cp_ = ch & 0x07u;
                    utf8_remaining_ = 3;
                    state_ = State::Utf8;
                } else {
                    put('?');                         // stray continuation
                }
                break;
            }
            break;

        case State::Utf8:
            utf8_cp_ = (utf8_cp_ << 6) | (uint32_t)(ch & 0x3F);
            if (--utf8_remaining_ == 0) {
                put(utf8_cp_);
                state_ = State::Ground;
            }
            break;

        case State::Esc:
            switch (ch) {
            case '[':
                state_ = State::Csi;
                param_count_ = 0;
                param_started_ = false;
                private_ = false;
                memset(params_, 0, sizeof(params_));
                break;
            case ']': state_ = State::Osc; break;
            case '(': case ')': case '*': case '+':
                state_ = State::Charset;
                break;
            case 'M':   // reverse index
                if (row_ <= scroll_top_) scrollDown(1); else row_--;
                state_ = State::Ground;
                break;
            case '7': saved_row_ = row_; saved_col_ = col_; saved_attr_ = attr_;
                      state_ = State::Ground; break;
            case '8': row_ = saved_row_; col_ = saved_col_; attr_ = saved_attr_;
                      state_ = State::Ground; break;
            case 'c': reset(); state_ = State::Ground; break;
            default:  state_ = State::Ground; break;
            }
            break;

        case State::Charset:
            state_ = State::Ground;   // swallow the designator
            break;

        case State::Csi:
            if (ch >= '0' && ch <= '9') {
                if (!param_started_) {
                    param_started_ = true;
                    if (param_count_ < 8) params_[param_count_++] = 0;
                }
                if (param_count_ > 0 && param_count_ <= 8) {
                    int& p = params_[param_count_ - 1];
                    if (p < 10000) p = p * 10 + (ch - '0');
                }
            } else if (ch == ';' || ch == ':') {
                // ':' is the sub-parameter separator of ESC[38:2:r:g:b; treat
                // it as ';' so truecolour in that dialect still lands.
                if (!param_started_ && param_count_ < 8) params_[param_count_++] = 0;
                param_started_ = false;
            } else if (ch >= 0x3C && ch <= 0x3F) {
                private_ = true;   // ?, >, <, = — dropped whole, see below
            } else if (ch >= 0x20 && ch <= 0x2F) {
                // Intermediate bytes — ignored.
            } else if (ch >= 0x40 && ch <= 0x7E) {
                // A private sequence must never reach execCsi: ESC[>4;2m is
                // xterm's modifyOtherKeys, not an SGR, and ESC[?25l is not a
                // DCH.
                if (!private_) execCsi(ch);
                state_ = State::Ground;
            } else {
                state_ = State::Ground;
            }
            break;

        case State::Osc:
            if (ch == 0x07)      state_ = State::Ground;   // BEL terminator
            else if (ch == 0x1B) state_ = State::OscEsc;   // maybe ST
            break;

        case State::OscEsc:
            state_ = (ch == '\\') ? State::Ground : State::Osc;
            break;
        }
    }

    return dirty_;
}

}  // namespace dirigible_app
