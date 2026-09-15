#include "vt.hpp"

#include <cstring>

namespace dirigible_app {

namespace {
inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }
}  // namespace

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
    }
    row_ = col_ = saved_row_ = saved_col_ = 0;
    scroll_top_ = 0;
    scroll_bot_ = rows_;
    state_ = State::Ground;
    param_count_ = 0;
    param_started_ = false;
    dirty_ = true;
}

const char* VtScreen::row(int r) const
{
    if (r < 0 || r >= rows_) { row_out_[0] = '\0'; return row_out_; }
    int last = -1;
    for (int c = 0; c < cols_; c++) {
        char ch = cells_[r][c];
        // LVGL labels need valid UTF-8 and the font is ASCII-only.
        row_out_[c] = (ch >= 0x20 && ch < 0x7F) ? ch : ' ';
        if (row_out_[c] != ' ') last = c;
    }
    row_out_[last + 1] = '\0';
    return row_out_;
}

void VtScreen::clearRow(int r, int from, int to)
{
    if (r < 0 || r >= rows_) return;
    from = clampi(from, 0, cols_);
    to   = clampi(to, 0, cols_);
    for (int c = from; c < to; c++) cells_[r][c] = ' ';
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
    }
    for (int r = bot - n; r < bot; r++) clearRow(r, 0, cols_);
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
    }
    for (int r = top; r < top + n; r++) clearRow(r, 0, cols_);
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

void VtScreen::put(uint8_t ch)
{
    if (col_ >= cols_) {   // deferred wrap
        col_ = 0;
        newline();
    }
    cells_[row_][col_] = (char)ch;
    col_++;
}

int VtScreen::param(int idx, int def) const
{
    if (idx >= param_count_) return def;
    return params_[idx] == 0 && def != 0 ? def : params_[idx];
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
        clearRow(row_, cols_ - n, cols_);
        break;
    }
    case '@': {   // insert blanks
        int n = clampi(param(0, 1), 0, cols_ - col_);
        memmove(&cells_[row_][col_ + n], &cells_[row_][col_], cols_ - col_ - n);
        clearRow(row_, col_, col_ + n);
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

    case 's': saved_row_ = row_; saved_col_ = col_; break;
    case 'u': row_ = saved_row_; col_ = saved_col_; break;

    case 'm':   // SGR — parsed, discarded
    default:
        break;
    }
}

bool VtScreen::feed(const uint8_t* data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        uint8_t ch = data[i];

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
                if (ch >= 0x20) put(ch);
                break;
            }
            break;

        case State::Esc:
            switch (ch) {
            case '[':
                state_ = State::Csi;
                param_count_ = 0;
                param_started_ = false;
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
            case '7': saved_row_ = row_; saved_col_ = col_; state_ = State::Ground; break;
            case '8': row_ = saved_row_; col_ = saved_col_; state_ = State::Ground; break;
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
            } else if (ch == ';') {
                if (!param_started_ && param_count_ < 8) params_[param_count_++] = 0;
                param_started_ = false;
            } else if (ch >= 0x3C && ch <= 0x3F) {
                // Private parameter prefix (?, >, <, =) — remembered only in
                // that we drop the whole sequence below for unknown finals.
            } else if (ch >= 0x20 && ch <= 0x2F) {
                // Intermediate bytes — ignored.
            } else if (ch >= 0x40 && ch <= 0x7E) {
                execCsi(ch);
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

    if (len > 0) dirty_ = true;
    return dirty_;
}

}  // namespace dirigible_app
