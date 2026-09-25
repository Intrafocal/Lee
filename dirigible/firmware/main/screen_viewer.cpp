/*
 * screen_viewer.cpp — read-only file viewer over GET /fs/read.
 *
 * Mirrors Aeronaut's FileViewerScreen (aeronaut/lib/screens/file_viewer_screen.dart)
 * and EditorScreen: files are classified by extension (dirigible/fs.hpp, the
 * same sets Aeronaut uses), code gets a line-number gutter, markdown and plain
 * text wrap, and every failure Lee can report — outside the workspace, not
 * found, too large, binary, token rejected — gets its own message rather than
 * a blank screen.  Opened two ways:
 *
 *   - from the Files tree, where back returns to the tree;
 *   - from an editor-like tab in the tab list, where it follows the tab:
 *     `editors[tab].file` is re-read when the tab switches file, and the
 *     modified flag and cursor line track Lee live (Aeronaut's EditorScreen).
 *
 * Adapted for 320x204:
 *
 *   y   0..10   meta: size, mtime, kind  ............  Ln 42 *
 *   y  13..201  21 rows of unscii_8, a fixed pool of labels
 *
 * Before downloading anything it asks for `?stat=1`: images and PDFs stop at
 * metadata (there is no decoder on the device), and text over VIEW_CAP is
 * refused up front instead of being pulled into PSRAM.  What does load is
 * folded to ASCII once (the font has nothing above 0x7F) into one flat buffer
 * with a line index — no per-line heap allocations, which on this chip would
 * land in internal RAM.
 *
 * Keys: j/k line, space/b page, g/G ends, h/l pan code, w wrap, r reload,
 * o open in Lee.  The trackball is a d-pad: roll scrolls/pans, click toggles
 * wrap on code.  Swipe up/down pages, swipe right goes back.
 */

#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"

static const char* TAG = "dirigible.viewer";

namespace dirigible_app {

namespace {

constexpr int META_H  = 13;
constexpr int LINE_H  = 9;                         // unscii_8 line height
constexpr int ROWS    = (BODY_H - META_H) / LINE_H;   // 21
constexpr int CHAR_W  = 8;
/// Largest file the device will download.  Lee's own cap is 2 MB; a 2 MB
/// JSON body plus its parse and a folded copy is more PSRAM churn and WiFi
/// time than a 40-column screen is worth.
constexpr int64_t VIEW_CAP = 256 * 1024;
constexpr int PAN_STEP = 8;

enum class LineStyle : uint8_t { Normal, Heading, Code, Quote };

struct Disp {
    uint32_t  off;     // into State::buf
    uint16_t  len;
    int32_t   src;     // 0-based source line
    bool      first;   // first display row of its source line
    LineStyle style;
};

struct State {
    // widgets
    lv_obj_t* meta    = nullptr;
    lv_obj_t* flag    = nullptr;   // "Ln 42 *" at the right of the meta strip
    lv_obj_t* gutter[ROWS] = {};
    lv_obj_t* text[ROWS]   = {};
    lv_obj_t* msg     = nullptr;
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
    std::string           buf;         // folded lines, back to back
    std::vector<uint32_t> line_off;    // start of each source line in buf
    std::vector<uint16_t> line_len;
    std::vector<LineStyle> line_style;
    std::vector<Disp>     disp;
    bool wrap = false;
    int  top  = 0;
    int  hoff = 0;
    int  gutter_cols = 0;
    int  text_cols   = 0;
};

State& st()
{
    static State s;
    return s;
}

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
    if (s.kind == dirigible::FileViewKind::Code && s.loaded) m += s.wrap ? " wrap" : "";
    lv_label_set_text(s.meta, m.c_str());

    char flag[24] = "";
    if (s.cursor_line > 0) snprintf(flag, sizeof(flag), "Ln %d", s.cursor_line);
    if (s.modified) strncat(flag, s.cursor_line > 0 ? " *" : "*", sizeof(flag) - strlen(flag) - 1);
    lv_label_set_text(s.flag, flag);
}

void render_position()
{
    auto& s = st();
    if (app().view != View::Viewer || !s.loaded || s.disp.empty()) return;
    char pos[48];
    const int line = s.disp[s.top].src + 1;
    if (s.hoff > 0) snprintf(pos, sizeof(pos), "L%d/%d c%d", line, (int)s.line_off.size(), s.hoff + 1);
    else            snprintf(pos, sizeof(pos), "L%d/%d", line, (int)s.line_off.size());
    chrome_set_centre(pos);
}

void show_message(const char* title, const std::string& body)
{
    auto& s = st();
    for (int i = 0; i < ROWS; i++) {
        lv_obj_add_flag(s.gutter[i], LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(s.text[i], LV_OBJ_FLAG_HIDDEN);
    }
    lv_label_set_text(s.msg_title, title);
    lv_label_set_text(s.msg_body, body.c_str());
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_HIDDEN);
    render_meta();
}

// ---------------------------------------------------------------------------
// Content: fold, index, lay out
// ---------------------------------------------------------------------------

void clear_content()
{
    auto& s = st();
    s.loaded = false;
    std::string().swap(s.buf);
    std::vector<uint32_t>().swap(s.line_off);
    std::vector<uint16_t>().swap(s.line_len);
    std::vector<LineStyle>().swap(s.line_style);
    std::vector<Disp>().swap(s.disp);
    s.top = s.hoff = 0;
}

void ingest(const std::string& content)
{
    auto& s = st();
    clear_content();
    s.buf.reserve(content.size());

    const bool md = s.kind == dirigible::FileViewKind::Markdown;
    bool in_fence = false;
    size_t pos = 0;
    while (pos <= content.size()) {
        size_t nl = content.find('\n', pos);
        if (nl == std::string::npos) nl = content.size();
        size_t end = nl;
        if (end > pos && content[end - 1] == '\r') end--;

        const char* line = content.data() + pos;
        size_t n = end - pos;

        LineStyle style = LineStyle::Normal;
        if (md) {
            if (n >= 3 && line[0] == '`' && line[1] == '`' && line[2] == '`') {
                in_fence = !in_fence;
                style = LineStyle::Code;
            } else if (in_fence) {
                style = LineStyle::Code;
            } else if (n && line[0] == '#') {
                // Render the heading, not its markup: drop the #s and a space.
                style = LineStyle::Heading;
                while (n && *line == '#') { line++; n--; }
                if (n && *line == ' ') { line++; n--; }
            } else if (n && line[0] == '>') {
                style = LineStyle::Quote;
            }
        }

        std::string folded = fold_utf8_line(line, n);
        if (folded.size() > 0xFFFF) folded.resize(0xFFFF);
        s.line_off.push_back((uint32_t)s.buf.size());
        s.line_len.push_back((uint16_t)folded.size());
        s.line_style.push_back(style);
        s.buf += folded;

        if (nl == content.size()) break;
        pos = nl + 1;
    }
    // A trailing newline is not an extra line (matches Aeronaut's gutter).
    if (s.line_off.size() > 1 && s.line_len.back() == 0 &&
        !content.empty() && content.back() == '\n') {
        s.line_off.pop_back();
        s.line_len.pop_back();
        s.line_style.pop_back();
    }
    s.loaded = true;
}

/// Build display rows for the current wrap mode and gutter width.
void layout()
{
    auto& s = st();
    const bool code = s.kind == dirigible::FileViewKind::Code;

    // Gutter only for code (as in Aeronaut): digits of the line count, min 2.
    s.gutter_cols = 0;
    if (code) {
        int digits = 1;
        for (size_t n = s.line_off.size(); n >= 10; n /= 10) digits++;
        s.gutter_cols = digits < 2 ? 2 : digits;
    }
    const int text_x = s.gutter_cols ? s.gutter_cols * CHAR_W + 6 : 3;
    s.text_cols = (SCREEN_W - text_x - 2) / CHAR_W;

    std::vector<Disp>().swap(s.disp);
    s.disp.reserve(s.line_off.size());
    const int cols = s.text_cols;

    for (size_t i = 0; i < s.line_off.size(); i++) {
        const uint32_t off = s.line_off[i];
        const uint16_t len = s.line_len[i];
        const LineStyle style = s.line_style[i];
        if (!s.wrap || len <= cols) {
            s.disp.push_back({ off, len, (int32_t)i, true, style });
            continue;
        }
        // Soft wrap: break at the last space in the second half of the row,
        // else hard-break at the column.
        uint32_t p = 0;
        bool first = true;
        while (p < len) {
            uint32_t take = len - p;
            if ((int)take > cols) {
                take = cols;
                for (uint32_t k = cols; k > (uint32_t)cols / 2; k--) {
                    if (s.buf[off + p + k - 1] == ' ') { take = k; break; }
                }
            }
            s.disp.push_back({ off + p, (uint16_t)take, (int32_t)i, first, style });
            first = false;
            p += take;
        }
    }

    for (int r = 0; r < ROWS; r++) {
        lv_obj_set_width(s.gutter[r], s.gutter_cols * CHAR_W);
        lv_obj_set_x(s.text[r], text_x);
        lv_obj_set_width(s.text[r], SCREEN_W - text_x - 2);
    }
    s.hoff = 0;
}

void render()
{
    auto& s = st();
    if (!s.loaded) return;
    lv_obj_add_flag(s.msg, LV_OBJ_FLAG_HIDDEN);

    const int n = (int)s.disp.size();
    if (s.top > n - ROWS) s.top = n - ROWS;
    if (s.top < 0) s.top = 0;

    std::string row;
    char num[12];
    for (int r = 0; r < ROWS; r++) {
        const int di = s.top + r;
        if (di >= n) {
            lv_obj_add_flag(s.gutter[r], LV_OBJ_FLAG_HIDDEN);
            lv_obj_add_flag(s.text[r], LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        const Disp& d = s.disp[di];

        if (s.gutter_cols) {
            if (d.first) snprintf(num, sizeof(num), "%d", (int)d.src + 1);
            else         num[0] = 0;
            lv_label_set_text(s.gutter[r], num);
            lv_obj_set_style_text_color(s.gutter[r],
                d.src + 1 == s.cursor_line ? dg::phosphor() : dg::text3(), 0);
            lv_obj_clear_flag(s.gutter[r], LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(s.gutter[r], LV_OBJ_FLAG_HIDDEN);
        }

        const int skip = s.wrap ? 0 : s.hoff;
        if (skip < d.len) {
            const int take = d.len - skip < s.text_cols ? d.len - skip : s.text_cols;
            row.assign(s.buf, d.off + skip, take);
        } else {
            row.clear();
        }
        lv_label_set_text(s.text[r], row.c_str());

        lv_color_t c = dg::text1();
        switch (d.style) {
        case LineStyle::Heading: c = dg::phosphor(); break;
        case LineStyle::Code:    c = dg::text2();    break;
        case LineStyle::Quote:   c = dg::text3();    break;
        default: break;
        }
        lv_obj_set_style_text_color(s.text[r], c, 0);
        lv_obj_clear_flag(s.text[r], LV_OBJ_FLAG_HIDDEN);
    }
    render_meta();
    render_position();
}

/// Put 0-based source line `line` about a third of the way down.
void scroll_to_source(int line)
{
    auto& s = st();
    for (int i = 0; i < (int)s.disp.size(); i++) {
        if (s.disp[i].src >= line) { s.top = i - ROWS / 3; break; }
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
        ingest(r.content);
        layout();
        if (s.cursor_line > 0) scroll_to_source(s.cursor_line - 1);
        ESP_LOGI(TAG, "%s: %d lines, %d rows", s.path.c_str(),
                 (int)s.line_off.size(), (int)s.disp.size());
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
    s.wrap = s.kind != FileViewKind::Code;   // prose wraps; code pans
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

void scroll(int delta)
{
    auto& s = st();
    if (!s.loaded) return;
    s.top += delta;
    render();
}

void pan(int delta)
{
    auto& s = st();
    if (!s.loaded || s.wrap) return;
    s.hoff += delta;
    if (s.hoff < 0) s.hoff = 0;
    render();
}

void toggle_wrap()
{
    auto& s = st();
    if (!s.loaded || s.kind != dirigible::FileViewKind::Code) return;
    const int src = s.disp.empty() ? 0 : s.disp[s.top].src;
    s.wrap = !s.wrap;
    layout();
    for (int i = 0; i < (int)s.disp.size(); i++) {
        if (s.disp[i].src == src) { s.top = i; break; }
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
    case LV_DIR_TOP:    scroll(ROWS - 1);    break;
    case LV_DIR_BOTTOM: scroll(-(ROWS - 1)); break;
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
    chrome_add_footer_button(s.tab_id >= 0 ? "Focus" : "Open", open_btn_cb, nullptr);
    chrome_add_footer_button("Reload", reload_btn_cb, nullptr);
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
    lv_obj_set_size(strip, SCREEN_W, META_H - 2);
    lv_obj_set_style_bg_color(strip, dg::ground1(), 0);
    lv_obj_set_style_bg_opa(strip, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(strip, LV_BORDER_SIDE_BOTTOM, 0);
    lv_obj_set_style_border_width(strip, 1, 0);
    lv_obj_set_style_border_color(strip, dg::ground4(), 0);
    lv_obj_set_style_border_opa(strip, LV_OPA_COVER, 0);
    lv_obj_clear_flag(strip, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(strip, LV_OBJ_FLAG_CLICKABLE);

    s.meta = make_label(strip, "", dg::text3());
    lv_label_set_long_mode(s.meta, LV_LABEL_LONG_CLIP);
    lv_obj_set_width(s.meta, 232);
    lv_obj_align(s.meta, LV_ALIGN_LEFT_MID, 3, 0);

    s.flag = make_label(strip, "", dg::ember());
    lv_obj_align(s.flag, LV_ALIGN_RIGHT_MID, -3, 0);

    for (int r = 0; r < ROWS; r++) {
        s.gutter[r] = make_label(a.view_viewer, "", dg::text3());
        lv_label_set_long_mode(s.gutter[r], LV_LABEL_LONG_CLIP);
        lv_obj_set_style_text_align(s.gutter[r], LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_set_pos(s.gutter[r], 2, META_H + r * LINE_H);
        lv_obj_add_flag(s.gutter[r], LV_OBJ_FLAG_HIDDEN);

        s.text[r] = make_label(a.view_viewer, "", dg::text1());
        lv_label_set_long_mode(s.text[r], LV_LABEL_LONG_CLIP);
        lv_obj_set_pos(s.text[r], 3, META_H + r * LINE_H);
        lv_obj_add_flag(s.text[r], LV_OBJ_FLAG_HIDDEN);
    }

    // Message panel for loading / errors / metadata-only kinds.
    s.msg = lv_obj_create(a.view_viewer);
    lv_obj_remove_style_all(s.msg);
    lv_obj_set_pos(s.msg, 0, META_H);
    lv_obj_set_size(s.msg, SCREEN_W, BODY_H - META_H);
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_clear_flag(s.msg, LV_OBJ_FLAG_CLICKABLE);

    s.msg_title = make_label(s.msg, "", dg::text1());
    lv_label_set_long_mode(s.msg_title, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.msg_title, SCREEN_W - 16);
    lv_obj_set_pos(s.msg_title, 8, 16);

    s.msg_body = make_label(s.msg, "", dg::text2());
    lv_label_set_long_mode(s.msg_body, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(s.msg_body, SCREEN_W - 16);
    lv_obj_set_pos(s.msg_body, 8, 34);

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

bool viewer_key(uint8_t ascii)
{
    switch (ascii) {
    case 0x1B:           app_back();          return true;
    case 'j': case '\r': case '\n': scroll(1); return true;
    case 'k':            scroll(-1);          return true;
    case ' ': case 'f':  scroll(ROWS - 1);    return true;
    case 'b':            scroll(-(ROWS - 1)); return true;
    case 'g':            scroll(-(1 << 30));  return true;
    case 'G':            scroll(1 << 30);     return true;
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
    if (dy) scroll(dy);
    if (dx) pan(dx * 4);
    if (click) toggle_wrap();
}

}  // namespace dirigible_app
