/*
 * screen_viewer.cpp — read-only file viewer over GET /fs/read.
 *
 * Mirrors Aeronaut's FileViewerScreen (aeronaut/lib/screens/file_viewer_screen.dart)
 * and EditorScreen: files are classified by extension (dirigible/fs.hpp, the
 * same sets Aeronaut uses), code gets a line-number gutter, markdown is
 * rendered and plain text wraps, and every failure Lee can report — outside
 * the workspace, not found, too large, binary, token rejected — gets its own
 * message rather than a blank screen.  Opened two ways:
 *
 *   - from the Files tree, where back returns to the tree;
 *   - from an editor-like tab in the tab list, where it follows the tab:
 *     `editors[tab].file` is re-read when the tab switches file, and the
 *     modified flag and cursor line track Lee live (Aeronaut's EditorScreen).
 *
 * Adapted for 320x204:
 *
 *   y   0..15   meta: size, mtime, kind  ............  Ln 42 *   (Montserrat 12)
 *   y  17..203  the document, scrolled by the pixel inside a clipping box
 *
 * Every mode lays the file out once into display rows (Disp) with a y and a
 * height, and draws only the rows in view from fixed pools of labels — so a
 * 256 KB file costs one flat text buffer, a row index and ~200 LVGL objects,
 * whatever its length.  Kinds of row:
 *
 *   code      unscii_8, 9 px, with a gutter; pans (h/l, sideways ball) or
 *             wraps on click / w
 *   plain     Montserrat 14 wrapped by measured width, 17 px
 *   markdown  parsed by dirigible/markdown.hpp (host-tested in tools/md-test)
 *             into headings (16 / 14 px, phosphor), paragraphs with inline
 *             colour for **strong**, *em*, `code`, links and ~~strike~~
 *             (LVGL recolour; the fonts have no bold), bullets, numbers and
 *             checkboxes with hanging indents, nested lists, quotes with a
 *             bar per depth, rules, fenced code in unscii, and tables
 *
 * Tables are laid out in one of three ways, whichever reads best:
 *
 *   fit    every column at its natural Montserrat width fits the row: cells
 *          are separate labels at measured column positions, aligned as the
 *          :---: row says, the header in phosphor over a hairline;
 *   wrap   it does not fit but has at most 4 columns and each column that
 *          must shrink keeps >= 60 px and its longest word: widths are
 *          water-filled (narrow columns keep their natural width, the wide
 *          ones share the rest by size) and cells wrap inside their column;
 *   mono   anything wider: a monospace grid (padded columns, " | "
 *          separators, a "-+-" rule under the header) that h/l and the
 *          sideways ball pan, like code.  Narrow proportional columns of
 *          five or more cells read worse than a grid you can slide.
 *
 * Before downloading anything it asks for `?stat=1`: images and PDFs stop at
 * metadata (there is no decoder on the device), and text over VIEW_CAP is
 * refused up front instead of being pulled into PSRAM.  What does load is
 * folded to ASCII once (neither font has anything above 0x7F worth drawing
 * here); large buffers land in PSRAM, and nothing is allocated per character.
 *
 * Keys: j/k line, space/b page, g/G ends, h/l pan, w wrap (code), r reload,
 * o open in Lee.  The trackball scrolls by the pixel with acceleration; a
 * deliberate sideways roll pans code and wide tables; a click toggles wrap on
 * code.  Swipe up/down pages, swipe right goes back.
 */

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

#include "app.hpp"
#include "dirigible/markdown.hpp"
#include "esp_log.h"
#include "theme.hpp"
#include "ui_text.hpp"

static const char* TAG = "dirigible.viewer";

#ifndef DIRIGIBLE_UI_DEMO
#define DIRIGIBLE_UI_DEMO 0
#endif

namespace dirigible_app {

namespace {

namespace md = dirigible::md;

constexpr int META_H   = 17;                     // 16 px strip: a Montserrat 12 line + hairline
constexpr int VIEW_H   = BODY_H - META_H;        // 187: the scrolling box
constexpr int CHAR_W   = 8;                      // unscii_8 advance
constexpr int CODE_H   = 9;                      // unscii_8 line
constexpr int TEXT_H   = 17;                     // Montserrat 14's 16 px line + 1
constexpr int H1_H     = 23;                     // Montserrat 16 (18) with air above
constexpr int H3_H     = 20;                     // Montserrat 14 heading
constexpr int FENCE_H  = 10;                     // unscii_8 in prose, 1 px apart
constexpr int RULE_H   = 9;
constexpr int SPACER_H = 6;
constexpr int CRULE_H  = 5;                      // hairline under a table header
constexpr int MONO_H   = 10;
constexpr int TEXT_X   = 3;
constexpr int RIGHT    = SCREEN_W - 3;           // right edge of text
constexpr int INDENT_W = 14;                     // per list level
constexpr int QUOTE_W  = 10;                     // per quote level
constexpr int CELL_GAP = 10;
constexpr int WRAP_MIN_W = 60;                   // narrowest column worth wrapping into
constexpr int WRAP_MAX_COLS = 4;

constexpr int POOL      = 24;   // text rows: 187 / 9 rounds up to 22 in view
constexpr int CELL_POOL = 96;   // table cells in view
constexpr int DECO_POOL = 32;   // quote bars and rules in view

/// Largest file the device will download.  Lee's own cap is 2 MB; a 2 MB
/// JSON body plus its parse and a folded copy is more PSRAM churn and WiFi
/// time than a 40-column screen is worth.
constexpr int64_t VIEW_CAP = 256 * 1024;
constexpr int PAN_STEP = 8;

enum class RK : uint8_t { Code, Plain, Text, Heading, Fence, Rule, Spacer, Cells, CellRule, Mono };

struct Disp {
    uint32_t off;        // into State::buf
    uint16_t len;
    uint8_t  style0;     // md inline style in effect at `off`
    RK       kind;
    int32_t  y;          // px from the top of the document
    int32_t  src;        // 0-based source line
    uint16_t h;
    int16_t  x;
    uint8_t  level;      // Heading: 1..6; Cells / Mono: 1 on the header row
    uint8_t  quote;
    uint16_t table;      // Cells: index into State::tables
    bool     first;      // first display row of its source line (code gutter)
};

enum class TMode : uint8_t { Fit, Wrap, Mono };

struct TableLay {
    TMode     mode = TMode::Fit;
    uint8_t   ncols = 0;
    int16_t   x[md::MAX_COLS] = {};
    int16_t   w[md::MAX_COLS] = {};
    md::Align align[md::MAX_COLS] = {};
};

struct State {
    // widgets
    lv_obj_t* meta    = nullptr;
    lv_obj_t* flag    = nullptr;   // "Ln 42 *" at the right of the meta strip
    lv_obj_t* box     = nullptr;   // clipping container for the document
    lv_obj_t* gutter[POOL]   = {};
    lv_obj_t* text[POOL]     = {};
    lv_obj_t* cell[CELL_POOL] = {};
    lv_obj_t* deco[DECO_POOL] = {};
    lv_obj_t* msg       = nullptr;
    lv_obj_t* msg_title = nullptr;
    lv_obj_t* msg_body  = nullptr;

    // what is open
    std::string path;
    View        from   = View::Tabs;
    int         tab_id = -1;       // >= 0: following an editor-like tab
    bool        modified = false;
    int         cursor_line = 0;   // 1-based, 0 = unknown
    dirigible::FileViewKind kind = dirigible::FileViewKind::Text;
    int         gen = 0;

    // metadata
    bool        have_meta = false;
    int64_t     size = 0;
    double      mtime_ms = 0;

    // content
    bool                  loaded = false;
    std::string           buf;         // folded lines (code / plain) or md text + mono rows
    std::vector<uint32_t> line_off;    // code / plain: start of each source line in buf
    std::vector<uint16_t> line_len;
    md::Doc               doc;         // markdown: lines and tables (text moved to buf)
    std::vector<TableLay> tables;
    std::vector<Disp>     disp;
    int  src_lines = 0;
    bool wrap = false;                 // code: wrap instead of pan
    bool pans = false;                 // something on the page pans (code unwrapped, mono tables)
    int  sy   = 0;                     // scroll, px
    int  content_h = 0;
    int  hoff = 0;                     // pan, columns
    int  max_cols = 0;                 // widest pannable row, columns
    int  gutter_cols = 0;
    int  text_cols   = 0;
    bool cells_short = false;          // logged once when CELL_POOL ran out

    // What each pooled label shows (display row, pan), so a pixel scroll
    // that keeps the same rows in view only moves labels instead of
    // re-setting their text.  Cleared whenever the rows are rebuilt.
    int32_t slot_key[POOL] = {};
    int32_t cell_key[CELL_POOL] = {};
};


State& st()
{
    static State s;
    return s;
}

void forget_slots()
{
    auto& s = st();
    for (auto& k : s.slot_key) k = -1;
    for (auto& k : s.cell_key) k = -1;
}

bool is_md() { return st().kind == dirigible::FileViewKind::Markdown; }
bool is_code() { return st().kind == dirigible::FileViewKind::Code; }

/// One line's scroll step in the current mode.
int line_step() { return is_code() ? CODE_H : TEXT_H; }

dirigible::LeeConnection* conn()
{
    return app().machines ? app().machines->activeConnection() : nullptr;
}

std::string base_name(const std::string& p)
{
    size_t slash = p.find_last_of('/');
    return slash == std::string::npos ? p : p.substr(slash + 1);
}

std::string fmt_bytes(int64_t b)
{
    char buf[24];
    if (b < 1024)             snprintf(buf, sizeof(buf), "%d B", (int)b);
    else if (b < 1024 * 1024) snprintf(buf, sizeof(buf), "%.1f KB", b / 1024.0);
    else                      snprintf(buf, sizeof(buf), "%.2f MB", b / (1024.0 * 1024.0));
    return buf;
}

std::string fmt_mtime(double ms)
{
    // Device clock has no timezone configured; Lee's mtime is UTC epoch ms,
    // so this is UTC.  Enough to tell "just now" from "last month".
    time_t t = (time_t)(ms / 1000.0);
    struct tm tmv;
    gmtime_r(&t, &tmv);
    char buf[20];
    strftime(buf, sizeof(buf), "%m-%d %H:%M", &tmv);
    return buf;
}

const char* kind_name(dirigible::FileViewKind k)
{
    switch (k) {
    case dirigible::FileViewKind::Markdown: return "md";
    case dirigible::FileViewKind::Code:     return "code";
    case dirigible::FileViewKind::Image:    return "image";
    case dirigible::FileViewKind::Pdf:      return "pdf";
    case dirigible::FileViewKind::Binary:   return "binary";
    default:                                return "text";
    }
}

// ---------------------------------------------------------------------------
// Measuring and converting marked-up text
// ---------------------------------------------------------------------------

const char* glyph_text(uint8_t g)
{
    switch (g) {
    case md::GLYPH_BULLET:    return LV_SYMBOL_BULLET;
    case md::GLYPH_TASK_OPEN: return "[  ]";
    case md::GLYPH_TASK_DONE: return LV_SYMBOL_OK;
    default:                  return "?";
    }
}

uint32_t glyph_hex(uint8_t g)
{
    switch (g) {
    case md::GLYPH_TASK_OPEN: return DG_TEXT_3;
    case md::GLYPH_TASK_DONE: return DG_PHOSPHOR;
    default:                  return DG_PHOSPHOR;
    }
}

int glyph_w(const lv_font_t* font, uint8_t g)
{
    struct Entry { const lv_font_t* font; uint8_t g; int16_t w; };
    static Entry cache[12];
    static int used = 0;
    for (int i = 0; i < used; i++) {
        if (cache[i].font == font && cache[i].g == g) return cache[i].w;
    }
    const char* t = glyph_text(g);
    const int w = lv_txt_get_width(t, strlen(t), font, 0, LV_TEXT_FLAG_NONE);
    if (used < 12) cache[used++] = { font, g, (int16_t)w };
    return w;
}

/// Advance of one byte of marked-up text: markers are free, glyph tokens
/// measure as what they draw.
int byte_w(const lv_font_t* font, unsigned char c)
{
    if (md::is_style(c)) return 0;
    if (md::is_glyph(c)) return glyph_w(font, c);
    return ui_char_w(font, c);
}

int text_w(const lv_font_t* font, const char* p, size_t n)
{
    int w = 0;
    for (size_t i = 0; i < n; i++) w += byte_w(font, (unsigned char)p[i]);
    return w;
}

/// Visible characters (monospace columns) in marked-up text.
int text_cols(const char* p, size_t n)
{
    int c = 0;
    for (size_t i = 0; i < n; i++) if (!md::is_style((unsigned char)p[i])) c++;
    return c;
}

/// Colour for an inline style; 0 = the row's own colour.
uint32_t span_hex(uint8_t style)
{
    if (style & md::CODE)   return DG_INFO;
    if (style & md::LINK)   return DG_LIT;
    if (style & md::DIM)    return DG_TEXT_3;
    if (style & md::STRONG) return DG_PHOSPHOR_HI;
    if (style & md::EM)     return DG_TEXT_2;
    return 0;
}

/// Label text for [p, p+n) starting in `style`.  With `recolor` the style
/// markers become LVGL colour commands (and a literal '#' is escaped);
/// without, they are dropped.  `skip` / `max` window the visible characters
/// for panned monospace rows (max < 0: no limit).  `out` is reused.
void to_label(std::string& out, const char* p, size_t n, uint8_t style, bool recolor,
              int skip = 0, int max = -1)
{
    uint32_t open = 0;
    auto colour = [&](uint32_t hex) {
        if (hex == open) return;
        if (open) out += '#';
        if (hex) {
            char t[12];
            snprintf(t, sizeof(t), "#%06X ", (unsigned)(hex & 0xFFFFFF));
            out += t;
        }
        open = hex;
    };
    if (recolor) colour(span_hex(style));
    int col = 0;
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)p[i];
        if (md::is_style(c)) {
            if (recolor) colour(span_hex(md::style_of(c)));
            continue;
        }
        if (md::is_glyph(c)) {
            const uint32_t was = open;
            if (recolor) colour(glyph_hex(c));
            out += glyph_text(c);
            if (recolor) colour(was);
            col++;
            continue;
        }
        if (col++ < skip) continue;
        if (max >= 0 && col - skip > max) break;
        if (c == '#' && recolor) {
            // Inside a span a '#' would end it: close, write the escaped
            // "##", reopen.
            const uint32_t was = open;
            colour(0);
            out += "##";
            colour(was);
            continue;
        }
        out += (char)c;
    }
    if (recolor) colour(0);
}

/// Break [off, off+len) of State::buf into rows no wider than `first_w`
/// (then `rest_w`) in `font`: fill a row, then break after the last space in
/// its second half, else where it overflowed.  `emit(off, len, style0, first)`
/// gets each row.  Markers ride along and cost no width.
template <typename F>
void wrap_run(const lv_font_t* font, uint32_t off, uint32_t len, int first_w, int rest_w, F&& emit)
{
    const std::string& b = st().buf;
    if (len == 0) { emit(off, 0u, (uint8_t)0, true); return; }
    uint32_t p = 0;
    uint8_t style = 0;
    bool first = true;
    while (p < len) {
        const int max_w = (first ? first_w : rest_w) - 2;   // rounding slack
        int w = 0;
        uint32_t k = p, after_space = 0;
        uint8_t st_now = style, st_space = style;
        while (k < len) {
            const unsigned char c = (unsigned char)b[off + k];
            if (md::is_style(c)) { st_now = md::style_of(c); k++; continue; }
            const int cw = byte_w(font, c);
            if (w + cw > max_w && k > p) break;
            w += cw;
            k++;
            if (c == ' ') { after_space = k; st_space = st_now; }
        }
        uint32_t end = k;
        uint8_t st_end = st_now;
        if (k < len && after_space > p + (k - p) / 2) { end = after_space; st_end = st_space; }
        const uint32_t take = end - p > 0xFFFF ? 0xFFFF : end - p;
        emit(off + p, take, style, first);
        style = st_end;
        p += take;
        first = false;
    }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

void render_meta()
{
    auto& s = st();
    std::string m;
    if (s.have_meta) {
        m = fmt_bytes(s.size) + "  " + (s.mtime_ms > 0 ? fmt_mtime(s.mtime_ms) + "  " : "");
    }
    m += kind_name(s.kind);
    if (is_code() && s.loaded) m += s.wrap ? " wrap" : "";
    lv_label_set_text(s.meta, m.c_str());

    char flag[24] = "";
    if (s.cursor_line > 0) snprintf(flag, sizeof(flag), "Ln %d", s.cursor_line);
    if (s.modified) strncat(flag, s.cursor_line > 0 ? " *" : "*", sizeof(flag) - strlen(flag) - 1);
    lv_label_set_text(s.flag, flag);
}

/// Index of the first row still in view at scroll `sy`.
int first_visible(int sy)
{
    const auto& d = st().disp;
    auto it = std::upper_bound(d.begin(), d.end(), sy,
        [](int y, const Disp& r) { return y < r.y + (int)r.h; });
    return (int)(it - d.begin());
}

void render_position()
{
    auto& s = st();
    if (app().view != View::Viewer || !s.loaded || s.disp.empty()) return;
    const int i = first_visible(s.sy);
    const int line = (i < (int)s.disp.size() ? s.disp[i].src : s.disp.back().src) + 1;
    char pos[48];
    if (s.hoff > 0) snprintf(pos, sizeof(pos), "L%d/%d c%d", line, s.src_lines, s.hoff + 1);
    else            snprintf(pos, sizeof(pos), "L%d/%d", line, s.src_lines);
    chrome_set_centre(pos);
}

void hide_pools()
{
    auto& s = st();
    forget_slots();
    for (int i = 0; i < POOL; i++) {
        lv_obj_add_flag(s.gutter[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s.text[i], LV_OBJ_FLAG_HIDDEN);
    }
    for (auto* c : s.cell) lv_obj_add_flag(c, LV_OBJ_FLAG_HIDDEN);
    for (auto* d : s.deco) lv_obj_add_flag(d, LV_OBJ_FLAG_HIDDEN);
}

void show_message(const char* title, const std::string& body)
{
    auto& s = st();
    hide_pools();
    ui_set_text(s.msg_title, title);
    ui_set_text(s.msg_body, body);
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_HIDDEN);
    render_meta();
}

// ---------------------------------------------------------------------------
// Content: fold, parse, lay out
// ---------------------------------------------------------------------------

void clear_content()
{
    auto& s = st();
    s.loaded = false;
    std::string().swap(s.buf);
    std::vector<uint32_t>().swap(s.line_off);
    std::vector<uint16_t>().swap(s.line_len);
    s.doc.clear();
    std::vector<TableLay>().swap(s.tables);
    std::vector<Disp>().swap(s.disp);
    s.sy = s.hoff = s.max_cols = s.content_h = s.src_lines = 0;
    s.pans = false;
    forget_slots();
}

/// Code and plain text: each source line folded into `buf` with an index.
/// Markdown: folded into one scratch copy, parsed, and only the parse kept.
void ingest(const std::string& content)
{
    auto& s = st();
    clear_content();

    std::string scratch;
    std::string& out = is_md() ? scratch : s.buf;
    out.reserve(content.size() + 64);

    size_t pos = 0;
    int lines = 0;
    while (pos <= content.size()) {
        size_t nl = content.find('\n', pos);
        if (nl == std::string::npos) nl = content.size();
        size_t end = nl;
        if (end > pos && content[end - 1] == '\r') end--;

        std::string folded = fold_utf8_line(content.data() + pos, end - pos);
        if (folded.size() > 0xFFFF) folded.resize(0xFFFF);
        if (is_md()) {
            out += folded;
            out += '\n';
        } else {
            s.line_off.push_back((uint32_t)out.size());
            s.line_len.push_back((uint16_t)folded.size());
            out += folded;
        }
        lines++;

        if (nl == content.size()) break;
        pos = nl + 1;
    }
    // A trailing newline is not an extra line (matches Aeronaut's gutter).
    if (lines > 1 && !content.empty() && content.back() == '\n') {
        lines--;
        if (!is_md()) { s.line_off.pop_back(); s.line_len.pop_back(); }
    }
    s.src_lines = lines;

    if (is_md()) {
        md::parse(scratch.data(), scratch.size(), s.doc);
        std::string().swap(scratch);
        s.buf.swap(s.doc.text);
    }
    s.loaded = true;
}

void push(RK kind, uint32_t off, uint32_t len, uint8_t style0, int32_t src, int h, int x,
          uint8_t quote = 0, uint8_t level = 0, uint16_t table = 0, bool first = true)
{
    auto& s = st();
    Disp d;
    d.off = off;
    d.len = (uint16_t)(len > 0xFFFF ? 0xFFFF : len);
    d.style0 = style0;
    d.kind = kind;
    d.y = s.content_h;
    d.src = src;
    d.h = (uint16_t)h;
    d.x = (int16_t)x;
    d.level = level;
    d.quote = quote;
    d.table = table;
    d.first = first;
    s.disp.push_back(d);
    s.content_h += h;
}

void layout_code()
{
    auto& s = st();
    // Gutter only for code (as in Aeronaut): digits of the line count, min 2.
    int digits = 1;
    for (size_t n = s.line_off.size(); n >= 10; n /= 10) digits++;
    s.gutter_cols = digits < 2 ? 2 : digits;
    const int text_x = s.gutter_cols * CHAR_W + 6;
    s.text_cols = (SCREEN_W - text_x - 2) / CHAR_W;
    s.pans = !s.wrap;
    s.max_cols = 0;

    for (size_t i = 0; i < s.line_off.size(); i++) {
        const uint32_t off = s.line_off[i];
        const uint16_t len = s.line_len[i];
        if (len > s.max_cols) s.max_cols = len;
        if (!s.wrap || len <= s.text_cols) {
            push(RK::Code, off, len, 0, (int32_t)i, CODE_H, text_x);
            continue;
        }
        bool first = true;
        for (uint32_t p = 0; p < len; p += s.text_cols) {
            const uint32_t take = std::min<uint32_t>(s.text_cols, len - p);
            push(RK::Code, off + p, take, 0, (int32_t)i, CODE_H, text_x, 0, 0, 0, first);
            first = false;
        }
    }
}

void layout_plain()
{
    auto& s = st();
    s.gutter_cols = 0;
    for (size_t i = 0; i < s.line_off.size(); i++) {
        wrap_run(dg::ui_font(), s.line_off[i], s.line_len[i], RIGHT - TEXT_X, RIGHT - TEXT_X,
                 [&](uint32_t off, uint32_t len, uint8_t, bool first) {
                     push(RK::Plain, off, len, 0, (int32_t)i, TEXT_H, TEXT_X, 0, 0, 0, first);
                 });
    }
}

/// Split a TableRow's text into its cells (offsets into buf).
int split_row(uint32_t off, uint32_t len, uint32_t* c_off, uint32_t* c_len, int max)
{
    const std::string& b = st().buf;
    int n = 0;
    uint32_t start = 0;
    for (uint32_t i = 0; i <= len && n < max; i++) {
        if (i == len || b[off + i] == md::CELL_SEP) {
            c_off[n] = off + start;
            c_len[n] = i - start;
            n++;
            start = i + 1;
        }
    }
    return n;
}

/// Widest word of a cell, so a wrapped column is never narrower than one.
int longest_word(const lv_font_t* font, const char* p, size_t n)
{
    int best = 0, w = 0;
    for (size_t i = 0; i < n; i++) {
        if (p[i] == ' ') { best = std::max(best, w); w = 0; continue; }
        w += byte_w(font, (unsigned char)p[i]);
    }
    return std::max(best, w);
}

/// Decide how table `ti` (whose rows start at doc line `first`) is drawn.
void plan_table(size_t first, uint16_t ti, int x0)
{
    auto& s = st();
    const md::Table& t = s.doc.tables[ti];
    TableLay& lay = s.tables[ti];
    const int n = t.ncols;
    lay.ncols = (uint8_t)n;
    for (int c = 0; c < n; c++) lay.align[c] = t.align[c];

    const lv_font_t* f = dg::ui_font();
    int nat[md::MAX_COLS] = {}, word[md::MAX_COLS] = {};
    uint32_t co[md::MAX_COLS], cl[md::MAX_COLS];
    for (uint32_t r = 0; r < t.rows && first + r < s.doc.lines.size(); r++) {
        const md::Line& l = s.doc.lines[first + r];
        const int k = split_row(l.off, l.len, co, cl, n);
        for (int c = 0; c < k; c++) {
            nat[c]  = std::max(nat[c], text_w(f, s.buf.data() + co[c], cl[c]));
            word[c] = std::max(word[c], longest_word(f, s.buf.data() + co[c], cl[c]));
        }
    }

    const int avail = RIGHT - x0;
    int sum = CELL_GAP * (n - 1);
    for (int c = 0; c < n; c++) sum += std::max(nat[c], 8);
    if (sum <= avail) {
        lay.mode = TMode::Fit;
        int x = x0;
        for (int c = 0; c < n; c++) {
            lay.x[c] = (int16_t)x;
            lay.w[c] = (int16_t)std::max(nat[c], 8);
            x += lay.w[c] + CELL_GAP;
        }
        return;
    }

    // Water-fill: columns narrower than an even share keep their width, the
    // rest split what is left in proportion to their natural widths.
    bool fixed[md::MAX_COLS] = {};
    int space = avail - CELL_GAP * (n - 1);
    int wide = n;
    for (bool changed = true; changed && wide > 0;) {
        changed = false;
        const int share = space / wide;
        for (int c = 0; c < n; c++) {
            if (fixed[c] || nat[c] > share) continue;
            fixed[c] = true;
            lay.w[c] = (int16_t)std::max(nat[c], 8);
            space -= lay.w[c];
            wide--;
            changed = true;
        }
    }
    int wide_nat = 0;
    for (int c = 0; c < n; c++) if (!fixed[c]) wide_nat += nat[c];
    bool ok = n <= WRAP_MAX_COLS && wide > 0 && space > 0;
    for (int c = 0; ok && c < n; c++) {
        if (fixed[c]) continue;
        lay.w[c] = (int16_t)((int64_t)space * nat[c] / (wide_nat ? wide_nat : 1));
        if (lay.w[c] < WRAP_MIN_W || lay.w[c] < word[c]) ok = false;
    }
    if (ok) {
        lay.mode = TMode::Wrap;
        int x = x0;
        for (int c = 0; c < n; c++) {
            lay.x[c] = (int16_t)x;
            x += lay.w[c] + CELL_GAP;
        }
        return;
    }
    // Mono: column widths in characters.
    lay.mode = TMode::Mono;
    for (int c = 0; c < n; c++) lay.w[c] = 1;
    for (uint32_t r = 0; r < t.rows && first + r < s.doc.lines.size(); r++) {
        const md::Line& l = s.doc.lines[first + r];
        const int k = split_row(l.off, l.len, co, cl, n);
        for (int c = 0; c < k; c++) {
            lay.w[c] = (int16_t)std::max<int>(lay.w[c], text_cols(s.buf.data() + co[c], cl[c]));
        }
    }
}

/// Mono tables: append one padded grid row to buf and return its span.
void mono_row(const TableLay& lay, uint32_t off, uint32_t len, bool rule,
              uint32_t& out_off, uint32_t& out_len)
{
    auto& s = st();
    uint32_t co[md::MAX_COLS] = {}, cl[md::MAX_COLS] = {};
    const int k = rule ? 0 : split_row(off, len, co, cl, lay.ncols);
    // Copy the cells out first: appending to buf may move its storage.
    std::string row;
    for (int c = 0; c < lay.ncols; c++) {
        if (c) row += rule ? "-+-" : " | ";
        const int w = lay.w[c];
        if (rule) { row.append(w, '-'); continue; }
        const char* p = c < k ? s.buf.data() + co[c] : "";
        const uint32_t n = c < k ? cl[c] : 0;
        const int pad = std::max(0, w - text_cols(p, n));
        const int left = lay.align[c] == md::Align::Right ? pad
                       : lay.align[c] == md::Align::Center ? pad / 2 : 0;
        row.append(left, ' ');
        row.append(p, n);
        row += (char)md::STYLE_MARK;   // no style bleeds into the padding
        row.append(pad - left, ' ');
    }
    out_off = (uint32_t)s.buf.size();
    s.buf += row;
    out_len = (uint32_t)row.size();
    s.max_cols = std::max(s.max_cols, text_cols(row.data(), row.size()));
}

/// Lines of `cell` wrapped at `w` in Montserrat 14 (at least 1).
int cell_lines(uint32_t off, uint32_t len, int w)
{
    int n = 0;
    wrap_run(dg::ui_font(), off, len, w + 2, w + 2,
             [&](uint32_t, uint32_t, uint8_t, bool) { n++; });
    return std::max(n, 1);
}

void layout_md()
{
    auto& s = st();
    s.gutter_cols = 0;
    s.tables.assign(s.doc.tables.size(), TableLay());
    const int bullet_w = glyph_w(dg::ui_font(), md::GLYPH_BULLET) + ui_char_w(dg::ui_font(), ' ');

    for (size_t li = 0; li < s.doc.lines.size(); li++) {
        const md::Line& l = s.doc.lines[li];
        const int qx = l.quote * QUOTE_W;
        const int x = TEXT_X + qx + (l.indent > 0 ? (l.indent - 1) * INDENT_W : 0);
        switch (l.kind) {
        case md::Kind::Spacer:
            push(RK::Spacer, l.off, 0, 0, l.src, SPACER_H, x, l.quote);
            break;
        case md::Kind::Rule:
            push(RK::Rule, l.off, 0, 0, l.src, RULE_H, x, l.quote);
            break;
        case md::Kind::Heading: {
            const bool big = l.level <= 2;
            const lv_font_t* f = big ? dg::ui_font_title() : dg::ui_font();
            bool first = true;
            wrap_run(f, l.off, l.len, RIGHT - x, RIGHT - x,
                     [&](uint32_t off, uint32_t len, uint8_t st0, bool) {
                         // Air above the first row only.
                         const int h = first ? (big ? H1_H : H3_H) : lv_font_get_line_height(f) + 1;
                         push(RK::Heading, off, len, st0, l.src, h, x, l.quote, l.level);
                         first = false;
                     });
            break;
        }
        case md::Kind::Code: {
            const int cols = std::max(1, (RIGHT - x - 4) / CHAR_W);
            if (l.len == 0) { push(RK::Fence, l.off, 0, 0, l.src, FENCE_H, x + 4, l.quote); break; }
            for (uint32_t p = 0; p < l.len; p += cols) {
                push(RK::Fence, l.off + p, std::min<uint32_t>(cols, l.len - p), 0, l.src,
                     FENCE_H, x + 4, l.quote);
            }
            break;
        }
        case md::Kind::Text: {
            // A list item's wrapped rows line up after its marker; a later
            // paragraph in the same item lines up with the item's text.
            const lv_font_t* f = dg::ui_font();
            const int hang = l.hang ? text_w(f, s.buf.data() + l.off, l.hang)
                           : (l.indent > 0 ? bullet_w : 0);
            const int x0 = l.hang ? x : x + hang;
            wrap_run(f, l.off, l.len, RIGHT - x0, RIGHT - x - hang,
                     [&](uint32_t off, uint32_t len, uint8_t st0, bool first) {
                         push(RK::Text, off, len, st0, l.src, TEXT_H,
                              first ? x0 : x + hang, l.quote, 0, 0, first);
                     });
            break;
        }
        case md::Kind::TableRow: {
            if (l.row == 0) plan_table(li, l.table, x);
            const TableLay& lay = s.tables[l.table];
            const bool header = l.row == 0;
            if (lay.mode == TMode::Mono) {
                uint32_t off, len;
                mono_row(lay, l.off, l.len, false, off, len);
                push(RK::Mono, off, len, 0, l.src, MONO_H, x, l.quote, header ? 1 : 0, l.table);
                if (header) {
                    mono_row(lay, 0, 0, true, off, len);
                    push(RK::Mono, off, len, 0, l.src, MONO_H, x, l.quote, 0, l.table);
                }
                s.pans = true;
                break;
            }
            int lines = 1;
            if (lay.mode == TMode::Wrap) {
                uint32_t co[md::MAX_COLS], cl[md::MAX_COLS];
                const int k = split_row(l.off, l.len, co, cl, lay.ncols);
                for (int c = 0; c < k; c++) lines = std::max(lines, cell_lines(co[c], cl[c], lay.w[c]));
            }
            push(RK::Cells, l.off, l.len, 0, l.src, lines * TEXT_H + 2, x, l.quote,
                 header ? 1 : 0, l.table);
            if (header) push(RK::CellRule, l.off, 0, 0, l.src, CRULE_H, x, l.quote, 0, l.table);
            break;
        }
        }
    }
    // The parse is spent once its rows exist; the tables' plans stay.
    std::vector<md::Line>().swap(s.doc.lines);
}

/// Build display rows for the file's kind (and, for code, the wrap mode).
void layout()
{
    auto& s = st();
    std::vector<Disp>().swap(s.disp);
    s.content_h = 0;
    s.hoff = 0;
    if (is_code())     layout_code();
    else if (is_md())  layout_md();
    else               layout_plain();
    s.disp.shrink_to_fit();
    forget_slots();
}

// ---------------------------------------------------------------------------
// Drawing: only the rows in view, from the pools
// ---------------------------------------------------------------------------

lv_color_t row_colour(const Disp& d)
{
    switch (d.kind) {
    case RK::Heading: return dg::phosphor();
    case RK::Fence:   return dg::text2();
    case RK::Mono:    return d.level ? dg::phosphor_hi() : dg::text1();
    default:          return d.quote ? dg::text2() : dg::text1();
    }
}

const lv_font_t* row_font(const Disp& d)
{
    switch (d.kind) {
    case RK::Code: case RK::Fence: case RK::Mono: return dg::mono_font();
    case RK::Heading: return d.level <= 2 ? dg::ui_font_title() : dg::ui_font();
    default: return dg::ui_font();
    }
}

void render()
{
    auto& s = st();
    if (!s.loaded) return;
    lv_obj_add_flag(s.msg, LV_OBJ_FLAG_HIDDEN);

    const int max_sy = std::max(0, s.content_h - VIEW_H);
    s.sy = std::max(0, std::min(s.sy, max_sy));
    if (s.pans) s.hoff = std::max(0, std::min(s.hoff, std::max(0, s.max_cols - 8)));

    static std::string row;   // label text, reused
    static int slot_hoff = 0;  // the pan the slots were last drawn at
    // Rows keep the label they had (row index mod pool) so scrolling a line
    // re-sets only the rows that came into view; a clash takes a free one.
    bool used_slot[POOL] = {};
    bool used_cell[CELL_POOL] = {};
    auto take = [](bool* used, int pool, int want) {
        for (int k = 0; k < pool; k++) {
            const int j = (want + k) % pool;
            if (!used[j]) { used[j] = true; return j; }
        }
        return -1;
    };
    int deco = 0;
    auto hline = [&](int x, int y, int w) {
        if (deco >= DECO_POOL) return;
        lv_obj_t* o = s.deco[deco++];
        lv_obj_set_pos(o, x, y);
        lv_obj_set_size(o, w, 1);
        lv_obj_set_style_bg_color(o, dg::ground5(), 0);
        lv_obj_clear_flag(o, LV_OBJ_FLAG_HIDDEN);
    };

    const int n = (int)s.disp.size();
    int last_bar_end[8] = {};   // merge quote bars row to row
    lv_obj_t* bars[8] = {};
    for (int i = first_visible(s.sy); i < n && s.disp[i].y < s.sy + VIEW_H; i++) {
        const Disp& d = s.disp[i];
        const int ry = d.y - s.sy;

        // Quote bars: one per depth, extended across consecutive rows.
        for (int q = 0; q < d.quote && q < 8; q++) {
            if (bars[q] && last_bar_end[q] == ry) {
                lv_obj_set_height(bars[q], ry + d.h - lv_obj_get_y(bars[q]));
            } else if (deco < DECO_POOL) {
                lv_obj_t* o = s.deco[deco++];
                lv_obj_set_pos(o, TEXT_X + q * QUOTE_W, ry);
                lv_obj_set_size(o, 2, d.h);
                lv_obj_set_style_bg_color(o, dg::phosphor_deep(), 0);
                lv_obj_clear_flag(o, LV_OBJ_FLAG_HIDDEN);
                bars[q] = o;
            }
            last_bar_end[q] = ry + d.h;
        }

        switch (d.kind) {
        case RK::Spacer:
            continue;
        case RK::Rule:
            hline(d.x, ry + d.h / 2, RIGHT - d.x);
            continue;
        case RK::CellRule: {
            const TableLay& lay = s.tables[d.table];
            const int w = lay.x[lay.ncols - 1] + lay.w[lay.ncols - 1] - d.x;
            hline(d.x, ry + 2, std::min(w, RIGHT - d.x));
            continue;
        }
        case RK::Cells: {
            const TableLay& lay = s.tables[d.table];
            uint32_t co[md::MAX_COLS], cl[md::MAX_COLS];
            const int k = split_row(d.off, d.len, co, cl, lay.ncols);
            for (int c = 0; c < k; c++) {
                const int32_t key = i * md::MAX_COLS + c;
                const int cell = take(used_cell, CELL_POOL, key % CELL_POOL);
                if (cell < 0) {
                    if (!s.cells_short) ESP_LOGW(TAG, "cell pool exhausted");
                    s.cells_short = true;
                    break;
                }
                lv_obj_t* l = s.cell[cell];
                if (s.cell_key[cell] == key) {
                    lv_obj_set_y(l, ry + 1);   // same cell: just move it
                    continue;
                }
                s.cell_key[cell] = key;
                row.clear();
                bool first = true;
                wrap_run(dg::ui_font(), co[c], cl[c], lay.w[c] + 2, lay.w[c] + 2,
                         [&](uint32_t off, uint32_t len, uint8_t st0, bool) {
                             if (!first) row += '\n';
                             first = false;
                             to_label(row, s.buf.data() + off, len, st0, true);
                         });
                lv_label_set_text(l, row.c_str());
                lv_obj_set_pos(l, lay.x[c], ry + 1);
                lv_obj_set_width(l, lay.w[c] + (lay.mode == TMode::Fit ? 2 : 0));
                lv_obj_set_style_text_align(l,
                    lay.align[c] == md::Align::Right  ? LV_TEXT_ALIGN_RIGHT :
                    lay.align[c] == md::Align::Center ? LV_TEXT_ALIGN_CENTER : LV_TEXT_ALIGN_LEFT, 0);
                lv_obj_set_style_text_color(l, d.level ? dg::phosphor_hi() : dg::text1(), 0);
                lv_obj_clear_flag(l, LV_OBJ_FLAG_HIDDEN);
            }
            continue;
        }
        default:
            break;
        }

        const int slot = take(used_slot, POOL, i % POOL);
        if (slot < 0) break;
        lv_obj_t* g = s.gutter[slot];
        lv_obj_t* t = s.text[slot];
        const lv_font_t* font = row_font(d);
        const bool mono = font == dg::mono_font();
        const int lh = lv_font_get_line_height(font);
        const int y = d.kind == RK::Heading ? ry + d.h - lh - 1
                    : mono ? ry : ry + (d.h - lh) / 2;
        const bool panned = d.kind == RK::Mono || (d.kind == RK::Code && !s.wrap);
        const int32_t key = i * 2 + (panned ? 0 : 1);
        if (s.slot_key[slot] == key && (!panned || s.hoff == slot_hoff)) {
            // Same row, same pan: only the scroll moved.
            lv_obj_set_y(t, y);
            if (d.kind == RK::Code) lv_obj_set_y(g, ry);
            continue;
        }
        s.slot_key[slot] = key;

        const bool marked = d.kind == RK::Text || d.kind == RK::Heading || d.kind == RK::Mono;

        if (d.kind == RK::Code) {
            char num[12];
            if (d.first) snprintf(num, sizeof(num), "%d", (int)d.src + 1);
            else         num[0] = 0;
            lv_label_set_text(g, num);
            lv_obj_set_width(g, s.gutter_cols * CHAR_W);
            lv_obj_set_y(g, ry);
            lv_obj_set_style_text_color(g,
                d.src + 1 == s.cursor_line ? dg::phosphor() : dg::text3(), 0);
            lv_obj_clear_flag(g, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(g, LV_OBJ_FLAG_HIDDEN);
        }

        row.clear();
        const int window = panned ? (RIGHT - d.x) / CHAR_W + 1 : -1;
        to_label(row, s.buf.data() + d.off, d.len, d.style0, marked,
                 panned ? s.hoff : 0, window);
        lv_label_set_recolor(t, marked);
        lv_obj_set_style_text_font(t, font, 0);
        lv_label_set_text(t, row.c_str());
        lv_obj_set_pos(t, d.x, y);
        lv_obj_set_width(t, SCREEN_W - d.x - 1);
        lv_obj_set_style_text_color(t, row_colour(d), 0);
        lv_obj_clear_flag(t, LV_OBJ_FLAG_HIDDEN);
    }

    for (int i = 0; i < POOL; i++) {
        if (used_slot[i]) continue;
        lv_obj_add_flag(s.gutter[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s.text[i], LV_OBJ_FLAG_HIDDEN);
        s.slot_key[i] = -1;
    }
    for (int i = 0; i < CELL_POOL; i++) {
        if (used_cell[i]) continue;
        lv_obj_add_flag(s.cell[i], LV_OBJ_FLAG_HIDDEN);
        s.cell_key[i] = -1;
    }
    slot_hoff = s.hoff;
    for (int i = deco; i < DECO_POOL; i++) lv_obj_add_flag(s.deco[i], LV_OBJ_FLAG_HIDDEN);
    render_meta();
    render_position();
}

/// Put 0-based source line `line` about a third of the way down.
void scroll_to_source(int line)
{
    auto& s = st();
    for (const Disp& d : s.disp) {
        if (d.src >= line) { s.sy = d.y - VIEW_H / 3; break; }
    }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

void show_error(const dirigible::FsReadResult& r)
{
    using dirigible::FsError;
    switch (r.error) {
    case FsError::TooLarge:
        show_message("File too large to view",
                     r.has_meta ? fmt_bytes(r.size) + " is over Lee's 2 MB viewer cap."
                                : r.message);
        break;
    case FsError::Unviewable:
        show_message("Binary file",
                     (r.has_meta ? fmt_bytes(r.size) + " - " : std::string()) +
                     "no preview for this file type.");
        break;
    case FsError::Forbidden:
        show_message("Outside workspace",
                     "This path is outside every open Lee workspace.");
        break;
    case FsError::NotFound:
        show_message("Not found", "The file may have been moved or deleted.");
        break;
    case FsError::Unauthorized:
        show_message("Token rejected", "Re-pair this machine from the menu.");
        break;
    default:
        show_message("Couldn't load file", r.message);
        break;
    }
}

void fetch_content()
{
    auto& s = st();
    auto* c = conn();
    if (!c) { show_message("Not connected", "Reconnect from the menu."); return; }

    const int gen = s.gen;
    c->fsRead(s.path, false, [gen](const dirigible::FsReadResult& r) {
        auto& s = st();
        if (gen != s.gen) return;
        if (r.error != dirigible::FsError::None) { show_error(r); return; }
        if (!r.isUtf8()) {
            show_message("Binary file", fmt_bytes(r.size) + " - no preview available.");
            return;
        }
        const uint32_t t0 = lv_tick_get();
        ingest(r.content);
        layout();
        if (s.cursor_line > 0) scroll_to_source(s.cursor_line - 1);
        ESP_LOGI(TAG, "%s: %d lines, %d rows, %d px, %d tables, %u ms", s.path.c_str(),
                 s.src_lines, (int)s.disp.size(), s.content_h, (int)s.tables.size(),
                 (unsigned)lv_tick_elaps(t0));
        render();
    });
}

/// Stat first, then decide whether the content is worth downloading.
void load()
{
    using dirigible::FileViewKind;
    auto& s = st();
    s.gen++;
    clear_content();
    s.have_meta = false;
    s.kind = dirigible::classify_file(s.path);
    s.wrap = false;   // code pans until asked to wrap; prose always wraps
    show_message("Loading", s.path);

    auto* c = conn();
    if (!c) { show_message("Not connected", "Reconnect from the menu."); return; }

    const int gen = s.gen;
    c->fsRead(s.path, true, [gen](const dirigible::FsReadResult& r) {
        auto& s = st();
        if (gen != s.gen) return;
        if (r.error != dirigible::FsError::None) { show_error(r); return; }
        s.have_meta = true;
        s.size      = r.size;
        s.mtime_ms  = r.mtime_ms;

        if (s.kind == FileViewKind::Image) {
            show_message("Image", fmt_bytes(r.size) + "  " + r.mime +
                         "\n\nNo image preview on Dirigible.\nOpen shows it in Lee.");
            return;
        }
        if (s.kind == FileViewKind::Pdf) {
            show_message("PDF preview not available",
                         fmt_bytes(r.size) + "\n\nOpen shows it in Lee.");
            return;
        }
        if (r.size > VIEW_CAP) {
            show_message("Too large for Dirigible",
                         fmt_bytes(r.size) + " is over the " + fmt_bytes(VIEW_CAP) +
                         " device cap.\nOpen shows it in Lee.");
            return;
        }
        fetch_content();
    });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Scroll by `px` (negative: up).
void scroll_px(int px)
{
    auto& s = st();
    if (!s.loaded) return;
    s.sy += px;
    render();
}

void scroll_lines(int n) { scroll_px(n * line_step()); }
void scroll_pages(int n) { scroll_px(n * (VIEW_H - line_step())); }

void pan(int delta)
{
    auto& s = st();
    if (!s.loaded || !s.pans) return;
    s.hoff += delta;
    if (s.hoff < 0) s.hoff = 0;
    render();
}

void toggle_wrap()
{
    auto& s = st();
    if (!s.loaded || !is_code()) return;
    const int i = first_visible(s.sy);
    const int src = i < (int)s.disp.size() ? s.disp[i].src : 0;
    s.wrap = !s.wrap;
    layout();
    for (const Disp& d : s.disp) {
        if (d.src == src) { s.sy = d.y; break; }
    }
    render();
}

void open_in_lee()
{
    auto& s = st();
    auto* c = conn();
    if (!c || s.path.empty()) return;
    if (s.tab_id >= 0) c->focusTab(s.tab_id);
    else               c->openFile(s.path.c_str());
    chrome_set_centre("opened in Lee");
}

void open_btn_cb(lv_event_t*)   { open_in_lee(); }
void reload_btn_cb(lv_event_t*) { load(); }

void view_gesture(lv_event_t*)
{
    lv_indev_t* indev = lv_indev_get_act();
    if (!indev) return;
    switch (lv_indev_get_gesture_dir(indev)) {
    case LV_DIR_TOP:    scroll_pages(1);  break;
    case LV_DIR_BOTTOM: scroll_pages(-1); break;
    case LV_DIR_RIGHT:  app_back();          break;
    default: break;
    }
}

/// Show the view with its chrome.  Separate from load() so a context update
/// that only moves the cursor does not refetch.
void enter()
{
    auto& s = st();
    app_show(View::Viewer);
    chrome_set_title(base_name(s.path).c_str());
    chrome_add_footer_button(s.tab_id >= 0 ? "Focus (O)" : "Open (O)", open_btn_cb, nullptr);
    chrome_add_footer_button("Reload (R)", reload_btn_cb, nullptr);
}

void editor_state(const dirigible::LeeContext* ctx, std::string& file,
                  bool& modified, int& line)
{
    file.clear();
    modified = false;
    line = 0;
    if (!ctx) return;
    for (int i = 0; i < ctx->tab_count; i++) {
        if (ctx->tabs[i].id != st().tab_id) continue;
        const dirigible::EditorContext* e = dirigible::context_editor_for(ctx, ctx->tabs[i]);
        if (e && e->file) {
            file     = e->file;
            modified = e->modified;
            line     = e->cursor.line;
        }
        return;
    }
}

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void viewer_build(lv_obj_t* parent)
{
    auto& a = app();
    auto& s = st();

    a.view_viewer = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_viewer);
    lv_obj_set_pos(a.view_viewer, 0, 0);
    lv_obj_set_size(a.view_viewer, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_viewer, dg::ground0(), 0);
    lv_obj_set_style_bg_opa(a.view_viewer, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_viewer, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(a.view_viewer, view_gesture, LV_EVENT_GESTURE, nullptr);

    // meta strip on ground-1 with a hairline under it
    lv_obj_t* strip = lv_obj_create(a.view_viewer);
    lv_obj_remove_style_all(strip);
    lv_obj_set_pos(strip, 0, 0);
    lv_obj_set_size(strip, SCREEN_W, META_H - 1);
    lv_obj_set_style_bg_color(strip, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(strip, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(strip, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_border_width(strip, 1, 0);
    lv_obj_set_style_border_color(strip, dg::ground4(), 0);
    lv_obj_set_style_border_opa(strip, LV_OPA_COVER, 0);
    lv_obj_clear_flag(strip, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(strip, LV_OBJ_FLAG_CLICKABLE);

    // Montserrat 12 fills the strip's 15 rows above its hairline.  LVGL
    // offsets children by the border width (it counts both sides even with
    // only the bottom drawn), hence y -1.
    s.meta = make_label(strip, "", dg::text3(), dg::ui_font_small());
    lv_label_set_long_mode(s.meta, LV_LABEL_LONG_DOT);
    lv_obj_set_width(s.meta, 240);
    lv_obj_align(s.meta, LV_ALIGN_TOP_LEFT, 2, -1);

    s.flag = make_label(strip, "", dg::ember(), dg::ui_font_small());
    lv_obj_align(s.flag, LV_ALIGN_TOP_RIGHT, -2, -1);

    // The document scrolls inside this box, which clips the rows that are
    // half out of view.  Not scrollable itself (the view pages on swipes and
    // the ball scrolls by the pixel), and gestures bubble to the view.
    s.box = lv_obj_create(a.view_viewer);
    lv_obj_remove_style_all(s.box);
    lv_obj_set_pos(s.box, 0, META_H);
    lv_obj_set_size(s.box, SCREEN_W, VIEW_H);
    lv_obj_clear_flag(s.box, LV_OBJ_FLAG_SCROLLABLE);

    for (int i = 0; i < DECO_POOL; i++) {
        lv_obj_t* o = lv_obj_create(s.box);
        lv_obj_remove_style_all(o);
        lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
        lv_obj_clear_flag(o, LV_OBJ_FLAG_CLICKABLE);
        lv_obj_clear_flag(o, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
        s.deco[i] = o;
    }
    for (int r = 0; r < POOL; r++) {
        s.gutter[r] = make_label(s.box, "", dg::text3(), dg::mono_font());
        lv_label_set_long_mode(s.gutter[r], LV_LABEL_LONG_CLIP);
        lv_obj_set_style_text_align(s.gutter[r], LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_set_x(s.gutter[r], 2);
        lv_obj_add_flag(s.gutter[r], LV_OBJ_FLAG_HIDDEN);

        s.text[r] = make_label(s.box, "", dg::text1(), dg::mono_font());
        lv_label_set_long_mode(s.text[r], LV_LABEL_LONG_CLIP);
        lv_obj_add_flag(s.text[r], LV_OBJ_FLAG_HIDDEN);
    }
    for (int i = 0; i < CELL_POOL; i++) {
        lv_obj_t* l = make_label(s.box, "", dg::text1());
        lv_label_set_long_mode(l, LV_LABEL_LONG_CLIP);
        lv_label_set_recolor(l, true);
        lv_obj_set_style_text_line_space(l, TEXT_H - 16, 0);
        lv_obj_add_flag(l, LV_OBJ_FLAG_HIDDEN);
        s.cell[i] = l;
    }
    forget_slots();

    // Message panel for loading / errors / metadata-only kinds: a column, so
    // a title that wraps pushes the body down instead of overlapping it.
    s.msg = lv_obj_create(a.view_viewer);
    lv_obj_remove_style_all(s.msg);
    lv_obj_set_pos(s.msg, 0, META_H);
    lv_obj_set_size(s.msg, SCREEN_W, BODY_H - META_H);
    lv_obj_set_style_pad_hor(s.msg, 8, 0);
    lv_obj_set_style_pad_top(s.msg, 14, 0);
    lv_obj_set_style_pad_row(s.msg, 6, 0);
    lv_obj_set_flex_flow(s.msg, LV_FLEX_FLOW_COLUMN);
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_CLICKABLE);

    s.msg_title = make_label(s.msg, "", dg::text1(), dg::ui_font_title());
    lv_label_set_long_mode(s.msg_title, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.msg_title, SCREEN_W - 16);

    s.msg_body = make_label(s.msg, "", dg::text2());
    lv_label_set_long_mode(s.msg_body, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.msg_body, SCREEN_W - 16);

    lv_obj_add_flag(a.view_viewer, LV_OBJ_FLAG_HIDDEN);
}

void viewer_open_path(const std::string& path, View from)
{
    auto& s = st();
    s.path        = path;
    s.from        = from;
    s.tab_id      = -1;
    s.modified    = false;
    s.cursor_line = 0;
    enter();
    load();
}

void viewer_open_tab(int tab_id)
{
    auto& s = st();
    s.tab_id = tab_id;
    s.from   = View::Tabs;

    auto* c = conn();
    std::string file;
    editor_state(c ? c->currentContext() : nullptr, file, s.modified, s.cursor_line);
    s.path = file;
    enter();
    if (file.empty()) {
        s.gen++;
        clear_content();
        s.have_meta = false;
        show_message("No file open", "This tab has no file Lee reports.");
        return;
    }
    load();
}

void viewer_on_context(const dirigible::LeeContext* ctx)
{
    auto& s = st();
    if (app().view != View::Viewer || s.tab_id < 0) return;

    std::string file;
    bool modified;
    int line;
    editor_state(ctx, file, modified, line);

    if (!file.empty() && file != s.path) {
        // The tab now shows a different file: follow it.
        s.path = file;
        s.modified = modified;
        s.cursor_line = line;
        chrome_set_title(base_name(file).c_str());
        load();
        return;
    }
    if (modified == s.modified && line == s.cursor_line) return;
    const bool saved = s.modified && !modified;
    s.modified = modified;
    s.cursor_line = line;
    if (saved) { load(); return; }   // just saved: what's on disk changed
    forget_slots();                  // the gutter's cursor colour moved
    if (s.loaded) render(); else render_meta();
}

void viewer_close()
{
    auto& s = st();
    s.gen++;
    s.tab_id = -1;
    clear_content();
}

View viewer_return_view() { return st().from; }

#if DIRIGIBLE_UI_DEMO
// A markdown page covering what the renderer handles, so the layout can be
// eyeballed with no Lee: Menu > MD sample in the demo build.
void viewer_open_demo()
{
    static const char* const SAMPLE =
        "# Markdown sample\n"
        "\n"
        "A paragraph with **strong**, *emphasis*, `inline code`, a [link](docs/13-Copilot.md) "
        "and ~~struck~~ text. Soft line breaks\n"
        "join into one paragraph; a hard break  \n"
        "starts a new line.\n"
        "\n"
        "## Lists\n"
        "\n"
        "- Trackball scrolls everything\n"
        "- Touch taps rows and buttons\n"
        "  - nested items indent\n"
        "    - and again, with a long line that wraps under its own text rather than the bullet\n"
        "- [x] task done\n"
        "- [ ] task open\n"
        "\n"
        "1. first\n"
        "2. second\n"
        "10. tenth, wider number\n"
        "\n"
        "> A block quote with **inline** style.\n"
        ">\n"
        "> > Nested quote.\n"
        "\n"
        "---\n"
        "\n"
        "### Tables that fit\n"
        "\n"
        "| Key | Action | Count |\n"
        "|:----|:------:|------:|\n"
        "| `j` | down | 1 |\n"
        "| `k` | up | 12 |\n"
        "| `a \\| b` | escaped pipe | 300 |\n"
        "\n"
        "### Tables that wrap\n"
        "\n"
        "| Screen | What it does |\n"
        "|--------|--------------|\n"
        "| Waiting | The attention queue as a pager, one item per page with big bordered buttons. |\n"
        "| Viewer | Read-only file view: code pans, markdown renders, tables fit, wrap or pan. |\n"
        "\n"
        "### Tables that pan\n"
        "\n"
        "| Property | Type | Default | Scope | Since | Description |\n"
        "|----------|------|---------|-------|-------|-------------|\n"
        "| `command` | string | - | tui | E1 | The CLI command to execute |\n"
        "| `cwd_aware` | boolean | false | tui | E3 | Uses the workspace directory as cwd |\n"
        "\n"
        "```cpp\n"
        "// fenced code keeps unscii and wraps in prose\n"
        "int main() { return 0; }\n"
        "```\n"
        "\n"
        "Setext heading\n"
        "--------------\n"
        "\n"
        "The end.\n";

    auto& s = st();
    s.gen++;
    s.path = "demo/markdown-sample.md";
    s.from = View::Waiting;
    s.tab_id = -1;
    s.modified = false;
    s.cursor_line = 0;
    s.kind = dirigible::FileViewKind::Markdown;
    s.wrap = false;
    s.have_meta = true;
    s.size = (int64_t)strlen(SAMPLE);
    s.mtime_ms = 0;
    enter();
    ingest(SAMPLE);
    layout();
    render();
}
#endif

bool viewer_key(uint8_t ascii)
{
    switch (ascii) {
    case 0x1B:           app_back();          return true;   // no Esc key on the T-Deck; alias only
    case 'j': case '\r': case '\n': scroll_lines(1); return true;
    case 'k':            scroll_lines(-1);    return true;
    case ' ': case 'f':  scroll_pages(1);     return true;
    case 'b':            scroll_pages(-1);    return true;
    case 'g':            scroll_px(-(1 << 28)); return true;
    case 'G':            scroll_px(1 << 28);  return true;
    case 'h':            pan(-PAN_STEP);      return true;
    case 'l':            pan(PAN_STEP);       return true;
    case 'w':            toggle_wrap();       return true;
    case 'r':            load();              return true;
    case 'o':            open_in_lee();       return true;
    default:             return false;
    }
}

void viewer_ball(int dx, int dy, bool click)
{
    static BallAcc side;
    if (dy) scroll_px(ball_scroll_px(dy));
    // Sideways pans code and wide tables, a few columns per firm roll; the
    // app's hook has already dropped sideways leak from vertical rolls.
    if (const int n = ball_steps(side, dx)) pan(n * 4);
    if (click) toggle_wrap();
}

}  // namespace dirigible_app
