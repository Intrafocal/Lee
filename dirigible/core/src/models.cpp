#include "dirigible/models.hpp"
#include "cJSON.h"
#include <cstdlib>
#include <cstring>

namespace dirigible {

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static char* dup_string(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item && cJSON_IsString(item) && item->valuestring) {
        return strdup(item->valuestring);
    }
    return nullptr;
}

static int get_int(cJSON* obj, const char* key, int def = 0) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item && cJSON_IsNumber(item)) {
        return item->valueint;
    }
    return def;
}

static double get_double(cJSON* obj, const char* key, double def = 0.0) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item && cJSON_IsNumber(item)) {
        return item->valuedouble;
    }
    return def;
}

static bool get_bool(cJSON* obj, const char* key, bool def = false) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (item) {
        if (cJSON_IsTrue(item)) return true;
        if (cJSON_IsFalse(item)) return false;
    }
    return def;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

static CursorPosition parse_cursor(cJSON* obj) {
    CursorPosition c;
    if (!obj) return c;
    c.line   = get_int(obj, "line", 1);
    c.column = get_int(obj, "column", 1);
    return c;
}

static EditorContext* parse_editor(cJSON* obj) {
    if (!obj || cJSON_IsNull(obj)) return nullptr;

    auto* e    = new EditorContext();
    e->file     = dup_string(obj, "file");
    e->language = dup_string(obj, "language");
    e->cursor   = parse_cursor(cJSON_GetObjectItemCaseSensitive(obj, "cursor"));
    e->modified = get_bool(obj, "modified");
    return e;
}

static ActivityContext* parse_activity(cJSON* obj) {
    if (!obj || cJSON_IsNull(obj)) return nullptr;

    auto* a = new ActivityContext();
    a->last_interaction = get_double(obj, "lastInteraction");
    a->idle_seconds     = get_double(obj, "idleSeconds");
    a->session_duration = get_double(obj, "sessionDuration");
    return a;
}

static TabContext parse_tab(cJSON* obj) {
    TabContext t;
    t.id     = get_int(obj, "id");
    t.type   = dup_string(obj, "type");
    t.label  = dup_string(obj, "label");
    t.pty_id = get_int(obj, "ptyId", -1);
    t.dock   = dup_string(obj, "dockPosition");
    t.state  = dup_string(obj, "state");
    return t;
}

LeeContext* context_parse(cJSON* json) {
    if (!json || !cJSON_IsObject(json)) return nullptr;

    auto* ctx = new LeeContext();

    ctx->workspace     = dup_string(json, "workspace");
    ctx->focused_panel = dup_string(json, "focusedPanel");
    ctx->timestamp     = get_double(json, "timestamp");

    // Tabs array
    cJSON* tabs_arr = cJSON_GetObjectItemCaseSensitive(json, "tabs");
    if (tabs_arr && cJSON_IsArray(tabs_arr)) {
        ctx->tab_count = cJSON_GetArraySize(tabs_arr);
        if (ctx->tab_count > 0) {
            ctx->tabs = new TabContext[ctx->tab_count];
            int i = 0;
            cJSON* tab_item = nullptr;
            cJSON_ArrayForEach(tab_item, tabs_arr) {
                ctx->tabs[i++] = parse_tab(tab_item);
            }
        }
    }

    // Editor (optional)
    ctx->editor = parse_editor(
        cJSON_GetObjectItemCaseSensitive(json, "editor"));

    // Per-tab editors: { "<tabId>": EditorContext, ... } (optional)
    cJSON* editors_obj = cJSON_GetObjectItemCaseSensitive(json, "editors");
    if (editors_obj && cJSON_IsObject(editors_obj)) {
        int n = cJSON_GetArraySize(editors_obj);
        if (n > 0) {
            ctx->editors = new EditorEntry[n];
            cJSON* item = nullptr;
            cJSON_ArrayForEach(item, editors_obj) {
                if (!item->string) continue;
                EditorContext* e = parse_editor(item);
                if (!e) continue;
                ctx->editors[ctx->editor_count].tab_id = atoi(item->string);
                ctx->editors[ctx->editor_count].editor = e;
                ctx->editor_count++;
            }
        }
    }

    // Activity (optional)
    ctx->activity = parse_activity(
        cJSON_GetObjectItemCaseSensitive(json, "activity"));

    return ctx;
}

// ---------------------------------------------------------------------------
// Free
// ---------------------------------------------------------------------------

static void free_tab(TabContext& t) {
    free(t.type);
    free(t.label);
    free(t.dock);
    free(t.state);
}

static void free_editor(EditorContext* e) {
    if (!e) return;
    free(e->file);
    free(e->language);
    delete e;
}

void context_free(LeeContext* ctx) {
    if (!ctx) return;

    free(ctx->workspace);
    free(ctx->focused_panel);

    if (ctx->tabs) {
        for (int i = 0; i < ctx->tab_count; i++) {
            free_tab(ctx->tabs[i]);
        }
        delete[] ctx->tabs;
    }

    free_editor(ctx->editor);
    for (int i = 0; i < ctx->editor_count; i++) free_editor(ctx->editors[i].editor);
    delete[] ctx->editors;
    delete ctx->activity;
    delete ctx;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

bool tab_is_editor_like(const char* type) {
    if (!type) return false;
    return strcmp(type, "editor") == 0 || strcmp(type, "editor-panel") == 0 ||
           strcmp(type, "file") == 0;
}

const EditorContext* context_editor_for(const LeeContext* ctx, const TabContext& tab) {
    if (!ctx) return nullptr;
    for (int i = 0; i < ctx->editor_count; i++) {
        if (ctx->editors[i].tab_id == tab.id) return ctx->editors[i].editor;
    }
    if (ctx->editor_count == 0 && tab_is_editor_like(tab.type)) return ctx->editor;
    return nullptr;
}

}  // namespace dirigible
