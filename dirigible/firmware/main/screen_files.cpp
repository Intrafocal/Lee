/*
 * screen_files.cpp — the workspace tree over GET /fs/list.
 *
 * Mirrors Aeronaut's FilesBrowserBody (aeronaut/lib/screens/files_screen.dart):
 * rooted at the active window's workspace, directories first, each directory
 * fetched lazily the first time it is expanded and cached after that, and
 * selecting a file opens the viewer (screen_viewer.cpp).  Reached the same
 * two ways, too: from a `files` tab in the tab list, and from the menu so it
 * works with no `files` tab open in Lee at all.
 *
 * Adapted for 320x204:
 *
 *   y   0..11   crumb: the selected row's directory, relative to the root
 *   y  12..198  11 rows x 17 px, a fixed pool re-labelled as the window moves
 *
 *   row:  [indent][+] name ............................ 12.3K
 *                  ^ + closed dir, - open dir, @ symlink, ~ loading, ! error
 *
 * The tree is flattened into `rows` and only the visible window is drawn, so
 * an expanded node_modules-sized directory costs a vector of strings, not a
 * few thousand LVGL objects.  The trackball is a d-pad here (as in the
 * terminal): roll up/down moves the selection, right expands, left collapses
 * or jumps to the parent, a click opens.  Touch taps a row; a vertical swipe
 * pages.
 */

#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "app.hpp"
#include "esp_log.h"
#include "theme.hpp"

static const char* TAG = "dirigible.files";

namespace dirigible_app {

namespace {

constexpr int CRUMB_H  = 12;
constexpr int ROW_H    = 17;
constexpr int ROWS     = (BODY_H - CRUMB_H) / ROW_H;   // 11
constexpr int INDENT_W = 8;                             // one mono column per level
constexpr int MAX_INDENT_LEVELS = 12;
/// Entries drawn per directory before a "... N more" row.  Lee already skips
/// .git / node_modules / build; this only bounds a pathological directory.
constexpr size_t MAX_ENTRIES = 500;

enum class RowKind { Dir, File, Link, Loading, Error, Empty, More };

struct Row {
    RowKind     kind;
    int         depth;
    std::string path;     // full path (Dir/File/Link); owning dir otherwise
    std::string name;     // label text
    int64_t     size = 0;
};

struct Slot {
    lv_obj_t* btn;
    lv_obj_t* mark;
    lv_obj_t* name;
    lv_obj_t* size;
};

struct State {
    lv_obj_t* crumb = nullptr;
    Slot      slots[ROWS] = {};

    std::string root;                                   // workspace path
    std::map<std::string, std::vector<dirigible::FsEntry>> cache;
    std::map<std::string, std::string> errors;          // dir -> message
    std::set<std::string> open;                         // expanded dirs
    std::set<std::string> loading;

    std::vector<Row> rows;
    int sel = 0;
    int top = 0;
    int gen = 0;   // bumped on refresh; stale /fs/list replies are dropped
};

State& st()
{
    static State s;
    return s;
}

std::string fmt_size(int64_t b)
{
    char buf[16];
    if (b < 1024)                 snprintf(buf, sizeof(buf), "%dB", (int)b);
    else if (b < 1024 * 1024)     snprintf(buf, sizeof(buf), "%.1fK", b / 1024.0);
    else                          snprintf(buf, sizeof(buf), "%.1fM", b / (1024.0 * 1024.0));
    return buf;
}

std::string relative(const std::string& path)
{
    const std::string& root = st().root;
    if (path == root) return "";
    if (path.size() > root.size() && path.compare(0, root.size(), root) == 0 &&
        path[root.size()] == '/') {
        return path.substr(root.size() + 1);
    }
    return path;
}

std::string parent_of(const std::string& path)
{
    size_t slash = path.find_last_of('/');
    return slash == std::string::npos || slash == 0 ? "/" : path.substr(0, slash);
}

// ---------------------------------------------------------------------------
// Tree -> rows
// ---------------------------------------------------------------------------

void flatten_dir(const std::string& dir, int depth)
{
    auto& s = st();

    if (s.loading.count(dir)) {
        s.rows.push_back({ RowKind::Loading, depth, dir, "loading..." });
        return;
    }
    auto err = s.errors.find(dir);
    if (err != s.errors.end()) {
        s.rows.push_back({ RowKind::Error, depth, dir, err->second });
        return;
    }
    auto it = s.cache.find(dir);
    if (it == s.cache.end()) return;
    if (it->second.empty()) {
        s.rows.push_back({ RowKind::Empty, depth, dir, "(empty directory)" });
        return;
    }

    size_t n = 0;
    for (const auto& e : it->second) {
        if (n++ == MAX_ENTRIES) {
            char buf[32];
            snprintf(buf, sizeof(buf), "... %d more",
                     (int)(it->second.size() - MAX_ENTRIES));
            s.rows.push_back({ RowKind::More, depth, dir, buf });
            break;
        }
        const std::string full = dir == "/" ? "/" + e.name : dir + "/" + e.name;
        if (e.isDir()) {
            s.rows.push_back({ RowKind::Dir, depth, full, e.name });
            if (s.open.count(full)) flatten_dir(full, depth + 1);
        } else {
            s.rows.push_back({ e.isSymlink() ? RowKind::Link : RowKind::File,
                               depth, full, e.name, e.size });
        }
    }
}

void render();

/// Rebuild `rows` from the cache, keeping the selection on the same path.
void reflow()
{
    auto& s = st();
    std::string keep;
    if (s.sel >= 0 && s.sel < (int)s.rows.size()) keep = s.rows[s.sel].path;

    s.rows.clear();
    if (!s.root.empty() || s.loading.count("") || s.errors.count("")) {
        flatten_dir(s.root, 0);
    }

    s.sel = 0;
    for (int i = 0; i < (int)s.rows.size(); i++) {
        if (s.rows[i].path == keep) { s.sel = i; break; }
    }
    render();
}

void fetch(const std::string& dir)
{
    auto& s = st();
    auto* conn = app().machines ? app().machines->activeConnection() : nullptr;
    if (!conn) {
        s.errors[dir] = "not connected";
        reflow();
        return;
    }

    s.loading.insert(dir);
    s.errors.erase(dir);
    const int gen = s.gen;
    conn->fsList(dir, [dir, gen](const dirigible::FsListResult& r) {
        auto& s = st();
        if (gen != s.gen) return;   // refreshed since; a newer fetch is in flight
        s.loading.erase(dir);
        if (r.error != dirigible::FsError::None) {
            ESP_LOGW(TAG, "list %s: %s", dir.c_str(), r.message.c_str());
            s.errors[dir] = r.message;
        } else if (dir.empty()) {
            // Root requested without a path: Lee answered for the focused
            // window's workspace and told us which one that is.
            s.root = r.path;
            s.cache[s.root] = r.entries;
        } else {
            s.cache[dir] = r.entries;
        }
        reflow();
    });
    reflow();
}

// ---------------------------------------------------------------------------
// Drawing — label the fixed row pool from rows[top .. top+ROWS)
// ---------------------------------------------------------------------------

void render()
{
    auto& s = st();
    const int n = (int)s.rows.size();
    if (s.sel >= n) s.sel = n ? n - 1 : 0;
    if (s.sel < 0) s.sel = 0;
    if (s.sel < s.top) s.top = s.sel;
    if (s.sel >= s.top + ROWS) s.top = s.sel - ROWS + 1;
    if (s.top > n - ROWS) s.top = n > ROWS ? n - ROWS : 0;

    for (int i = 0; i < ROWS; i++) {
        Slot& slot = s.slots[i];
        const int ri = s.top + i;
        if (ri >= n) {
            lv_obj_add_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        lv_obj_clear_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
        const Row& r = s.rows[ri];
        const bool selected = ri == s.sel;

        lv_obj_set_style_bg_color(slot.btn, selected ? dg::ground3() : dg::ground2(), 0);
        lv_obj_set_style_border_width(slot.btn, selected ? 1 : 0, 0);

        const char* mark = " ";
        lv_color_t mark_c = dg::text3();
        lv_color_t name_c = dg::text2();
        switch (r.kind) {
        case RowKind::Dir:
            mark = s.open.count(r.path) ? "-" : "+";
            mark_c = dg::phosphor();
            name_c = dg::text1();
            break;
        case RowKind::File:    break;
        case RowKind::Link:    mark = "@"; break;
        case RowKind::Loading: mark = "~"; mark_c = dg::ember(); name_c = dg::text3(); break;
        case RowKind::Error:   mark = "!"; mark_c = dg::error(); name_c = dg::error(); break;
        case RowKind::Empty:
        case RowKind::More:    name_c = dg::text3(); break;
        }

        const int depth = r.depth < MAX_INDENT_LEVELS ? r.depth : MAX_INDENT_LEVELS;
        const int x = 3 + depth * INDENT_W;
        lv_label_set_text(slot.mark, mark);
        lv_obj_set_style_text_color(slot.mark, mark_c, 0);
        lv_obj_align(slot.mark, LV_ALIGN_LEFT_MID, x, 0);

        const bool sized = r.kind == RowKind::File || r.kind == RowKind::Link;
        if (sized) {
            lv_label_set_text(slot.size, fmt_size(r.size).c_str());
            lv_obj_clear_flag(slot.size, LV_OBJ_FLAG_HIDDEN);
        } else {
            lv_obj_add_flag(slot.size, LV_OBJ_FLAG_HIDDEN);
        }
        // name from x+10; 6 mono columns (48 px) reserved for "999.9K" + margin
        lv_label_set_text(slot.name, r.name.c_str());
        lv_obj_set_style_text_color(slot.name, name_c, 0);
        lv_obj_set_width(slot.name, SCREEN_W - 4 - (x + 10) - (sized ? 52 : 4));
        lv_obj_align(slot.name, LV_ALIGN_LEFT_MID, x + 10, 0);
    }

    // Crumb: where the selection lives, since indentation alone runs out of
    // columns a few levels down.
    std::string crumb;
    if (n) {
        const Row& r = s.rows[s.sel];
        const bool is_entry = r.kind == RowKind::Dir || r.kind == RowKind::File ||
                              r.kind == RowKind::Link;
        crumb = relative(is_entry ? parent_of(r.path) : r.path);
    }
    crumb = "./" + crumb;
    if (crumb.size() > 2 && crumb.back() != '/') crumb += '/';
    // Keep the tail — the nearest directory is the useful end.
    constexpr size_t CRUMB_COLS = (SCREEN_W - 8) / 8;
    if (crumb.size() > CRUMB_COLS) crumb = ".." + crumb.substr(crumb.size() - CRUMB_COLS + 2);
    lv_label_set_text(s.crumb, crumb.c_str());

    if (app().view == View::Files && n) {
        char pos[24];
        snprintf(pos, sizeof(pos), "%d/%d", s.sel + 1, n);
        chrome_set_centre(pos);
    }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

void move(int delta)
{
    auto& s = st();
    s.sel += delta;
    render();
}

void set_open(const std::string& dir, bool want)
{
    auto& s = st();
    if (!want) {
        s.open.erase(dir);
    } else {
        s.open.insert(dir);
        if (!s.cache.count(dir) && !s.loading.count(dir)) { fetch(dir); return; }
    }
    reflow();
}

void activate()
{
    auto& s = st();
    if (s.rows.empty()) return;
    const Row r = s.rows[s.sel];   // copy: reflow() may reallocate rows
    switch (r.kind) {
    case RowKind::Dir:
        set_open(r.path, !s.open.count(r.path));
        break;
    case RowKind::File:
    case RowKind::Link:
        viewer_open_path(r.path, View::Files);
        break;
    case RowKind::Error:
        fetch(r.path);   // retry ("" = root before Lee named the workspace)
        break;
    default:
        break;
    }
}

/// Left: collapse an open dir, else hop to the parent directory's row.
void collapse()
{
    auto& s = st();
    if (s.rows.empty()) return;
    const Row& r = s.rows[s.sel];
    if (r.kind == RowKind::Dir && s.open.count(r.path)) {
        set_open(r.path, false);
        return;
    }
    const std::string parent = (r.kind == RowKind::Dir || r.kind == RowKind::File ||
                                r.kind == RowKind::Link) ? parent_of(r.path) : r.path;
    for (int i = s.sel - 1; i >= 0; i--) {
        if (s.rows[i].kind == RowKind::Dir && s.rows[i].path == parent) {
            s.sel = i;
            render();
            return;
        }
    }
}

void expand()
{
    auto& s = st();
    if (s.rows.empty()) return;
    const Row& r = s.rows[s.sel];
    if (r.kind == RowKind::Dir && !s.open.count(r.path)) set_open(r.path, true);
}

/// Drop every cached listing and refetch the root plus whatever is expanded,
/// Aeronaut's pull-to-refresh.
void refresh()
{
    auto& s = st();
    s.gen++;
    s.cache.clear();
    s.errors.clear();
    s.loading.clear();
    fetch(s.root);
    for (const auto& dir : s.open) fetch(dir);
}

void slot_clicked(lv_event_t* e)
{
    auto& s = st();
    const int i = (int)(intptr_t)lv_event_get_user_data(e);
    if (s.top + i >= (int)s.rows.size()) return;
    s.sel = s.top + i;
    render();
    activate();
}

void view_gesture(lv_event_t*)
{
    lv_indev_t* indev = lv_indev_get_act();
    if (!indev) return;
    switch (lv_indev_get_gesture_dir(indev)) {
    case LV_DIR_TOP:    move(ROWS - 1);    break;   // swipe up: page down
    case LV_DIR_BOTTOM: move(-(ROWS - 1)); break;
    case LV_DIR_RIGHT:  app_back();        break;
    default: break;
    }
}

void refresh_btn_cb(lv_event_t*) { refresh(); }

}  // namespace

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

void files_build(lv_obj_t* parent)
{
    auto& a = app();
    auto& s = st();

    a.view_files = lv_obj_create(parent);
    lv_obj_remove_style_all(a.view_files);
    lv_obj_set_pos(a.view_files, 0, 0);
    lv_obj_set_size(a.view_files, SCREEN_W, BODY_H);
    lv_obj_set_style_bg_color(a.view_files, dg::ground2(), 0);
    lv_obj_set_style_bg_opa(a.view_files, LV_OPA_COVER, 0);
    lv_obj_clear_flag(a.view_files, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_add_event_cb(a.view_files, view_gesture, LV_EVENT_GESTURE, nullptr);

    s.crumb = make_label(a.view_files, "./", dg::text3());
    lv_label_set_long_mode(s.crumb, LV_LABEL_LONG_CLIP);
    lv_obj_set_width(s.crumb, SCREEN_W - 8);
    lv_obj_set_pos(s.crumb, 4, 2);

    for (int i = 0; i < ROWS; i++) {
        Slot& slot = s.slots[i];
        slot.btn = lv_btn_create(a.view_files);
        lv_obj_remove_style_all(slot.btn);
        lv_obj_set_pos(slot.btn, 2, CRUMB_H + i * ROW_H);
        lv_obj_set_size(slot.btn, SCREEN_W - 4, ROW_H - 1);
        lv_obj_set_style_bg_opa(slot.btn, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(slot.btn, dg::ground2(), 0);
        lv_obj_set_style_radius(slot.btn, DG_RADIUS, 0);
        lv_obj_set_style_border_color(slot.btn, dg::lit(), 0);
        lv_obj_set_style_border_opa(slot.btn, LV_OPA_COVER, 0);
        lv_obj_clear_flag(slot.btn, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_add_event_cb(slot.btn, slot_clicked, LV_EVENT_CLICKED, (void*)(intptr_t)i);

        slot.mark = make_label(slot.btn, " ", dg::text3());
        slot.name = make_label(slot.btn, "", dg::text2());
        lv_label_set_long_mode(slot.name, LV_LABEL_LONG_DOT);
        slot.size = make_label(slot.btn, "", dg::text3());
        lv_obj_align(slot.size, LV_ALIGN_RIGHT_MID, -4, 0);
        lv_obj_add_flag(slot.btn, LV_OBJ_FLAG_HIDDEN);
    }

    lv_obj_add_flag(a.view_files, LV_OBJ_FLAG_HIDDEN);
}

void files_open()
{
    auto& s = st();
    auto* conn = app().machines ? app().machines->activeConnection() : nullptr;
    const dirigible::LeeContext* ctx = conn ? conn->currentContext() : nullptr;
    const std::string ws = ctx && ctx->workspace ? ctx->workspace : "";

    // A different workspace (another window focused, another machine) starts
    // a fresh tree; the same one keeps its cache and expansion, like
    // returning to Aeronaut's Files tab.
    if (ws.empty() || ws != s.root || s.rows.empty()) {
        s.gen++;
        s.root = ws;
        s.cache.clear();
        s.errors.clear();
        s.loading.clear();
        s.open.clear();
        s.sel = s.top = 0;
        fetch(ws);   // empty: Lee picks the focused window's workspace
    }

    app_show(View::Files);
    render();
    chrome_add_footer_button("Refresh", refresh_btn_cb, nullptr);
}

bool files_key(uint8_t ascii)
{
    switch (ascii) {
    case 0x1B:           app_back();    return true;
    case '\r': case '\n': activate();   return true;
    case 'j':            move(1);       return true;
    case 'k':            move(-1);      return true;
    case ' ':            move(ROWS - 1);    return true;
    case 'b':            move(-(ROWS - 1)); return true;
    case 'h': case 0x08: collapse();    return true;
    case 'l':            expand();      return true;
    case 'r':            refresh();     return true;
    default:             return false;
    }
}

void files_ball(int dx, int dy, bool click)
{
    if (dy) move(dy);
    if (dx > 0) expand();
    else if (dx < 0) collapse();
    if (click) activate();
}

}  // namespace dirigible_app
