#pragma once

#include <cstdint>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// LeeContext model — C structs matching Lee's TypeScript LeeContext.
//
// JSON keys are camelCase (e.g., "focusedPanel", "idleSeconds").
// Reference: hester/daemon/models.py lines 593-700
// Reference: electron/src/shared/context.ts
// ---------------------------------------------------------------------------

struct CursorPosition {
    int line   = 1;
    int column = 1;
};

struct EditorContext {
    char* file     = nullptr;   // currently open file path
    char* language = nullptr;   // detected language
    CursorPosition cursor;
    bool modified  = false;     // unsaved changes
};

struct TabContext {
    int   id       = 0;
    char* type     = nullptr;   // "editor", "terminal", "git", "docker", etc.
    char* label    = nullptr;   // display label
    int   pty_id   = -1;        // PTY process ID, -1 if none
    char* dock     = nullptr;   // dock position: "center", "left", "right", "bottom"
    char* state    = nullptr;   // "active", "background", "idle"
};

struct ActivityContext {
    double last_interaction = 0;  // unix timestamp
    double idle_seconds     = 0;
    double session_duration = 0;
};

struct LeeContext {
    char* workspace      = nullptr;
    char* focused_panel  = nullptr;   // "center", "left", "right", "bottom"
    double timestamp     = 0;

    // Tabs
    TabContext* tabs      = nullptr;
    int tab_count        = 0;

    // Optional sections (nullptr if absent)
    EditorContext*   editor   = nullptr;
    ActivityContext* activity = nullptr;
};

// ---------------------------------------------------------------------------
// Parse / Free
// ---------------------------------------------------------------------------

// Parse a LeeContext from the "data" field of a context_update message.
// Returns nullptr on parse failure. Caller must free with context_free().
LeeContext* context_parse(cJSON* json);

// Deep-free a LeeContext and all its owned strings/arrays.
void context_free(LeeContext* ctx);

}  // namespace dirigible
