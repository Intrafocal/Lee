// handlers.cpp — Dirigible app handlers
//
// Package source — consumed in place by screenschema codegen (copied into
// build/generated/main/handlers_dirigible.cpp with a #line prologue on every
// build; edit THIS file, never the copy).
// Bridges ScreenSchema widget events into the dirigible-core API.

#include "handlers.hpp"
#include "ss_context.hpp"
#include "ss_input.hpp"
#include "ss_battery.hpp"
#include "ss_fonts.hpp"
#include "esp_log.h"

#include "dirigible/lee_client.hpp"
#include "dirigible/pty_client.hpp"
#include "dirigible/machine.hpp"
#include "dirigible/state.hpp"
#include "dirigible_esp/transport_esp.hpp"
#include "dirigible_esp/config_nvs.hpp"

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

static const char* TAG = "DIR";

// ---------------------------------------------------------------------------
// T-Deck terminal viewport (320x240, monospace_8 font ≈ 6x8 px)
// minus header (22px) + status bar (16px) → ~202 px usable height
// ---------------------------------------------------------------------------
static constexpr int TERM_COLS = 53;
static constexpr int TERM_ROWS = 25;

// ---------------------------------------------------------------------------
// App state — owned by the handlers translation unit, lives for the lifetime
// of the firmware.
// ---------------------------------------------------------------------------
struct DirigibleAppState {
    dirigible_esp::TransportFactoryEsp* factory = nullptr;
    dirigible_esp::ConfigNvs*           config  = nullptr;
    dirigible::MachineManager*          machines = nullptr;

    // Active PTY subscription (when a terminal-style tab is focused)
    dirigible::PTYClient* pty = nullptr;
    int active_pty_id = -1;

    // Cached display rows for the last LeeContext (used by tab list rendering)
    std::vector<int> tab_ids;

    enum class Mode { TabList, Terminal };
    Mode mode = Mode::TabList;

    bool initialized = false;
    bool ui_attached = false;  // flipped to true once buildUI has run
    bool foreground = false;   // true while Dirigible is the visible app
};

static DirigibleAppState g_app;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

static const char* tab_icon(const char* type) {
    if (!type) return "";
    if (strcmp(type, "editor")   == 0) return LV_SYMBOL_EDIT;
    if (strcmp(type, "terminal") == 0) return LV_SYMBOL_LIST;
    if (strcmp(type, "git")      == 0) return LV_SYMBOL_REFRESH;
    if (strcmp(type, "docker")   == 0) return LV_SYMBOL_DRIVE;
    if (strcmp(type, "browser")  == 0) return LV_SYMBOL_HOME;
    if (strcmp(type, "hester")   == 0) return LV_SYMBOL_BELL;
    if (strcmp(type, "claude")   == 0) return LV_SYMBOL_BELL;
    if (strcmp(type, "files")    == 0) return LV_SYMBOL_DIRECTORY;
    return LV_SYMBOL_FILE;
}

// Tab type → does it have a PTY worth streaming?
static bool tab_has_pty(const char* type) {
    if (!type) return false;
    return strcmp(type, "terminal") == 0 ||
           strcmp(type, "git")      == 0 ||
           strcmp(type, "docker")   == 0 ||
           strcmp(type, "k8s")      == 0 ||
           strcmp(type, "hester")   == 0 ||
           strcmp(type, "claude")   == 0;
}

static dirigible::LeeConnection* activeConn() {
    return g_app.machines ? g_app.machines->activeConnection() : nullptr;
}

// ---------------------------------------------------------------------------
// View mode switching
// ---------------------------------------------------------------------------

// Tear down the active PTY stream — shared by ESC, pause, and close.
static void teardownPty() {
    if (g_app.pty) {
        g_app.pty->disconnect();
        delete g_app.pty;
        g_app.pty = nullptr;
    }
    g_app.active_pty_id = -1;
}

static void enterTabListMode() {
    g_app.mode = DirigibleAppState::Mode::TabList;
    if (!g_app.ui_attached) return;  // widgets not built yet
    SSContext::instance().show("dir_tab_list");
    SSContext::instance().hide("dir_term_output");
}

static void enterTerminalMode() {
    g_app.mode = DirigibleAppState::Mode::Terminal;
    if (!g_app.ui_attached) return;
    SSContext::instance().hide("dir_tab_list");
    SSContext::instance().show("dir_term_output");

    // Apply monospace font to the terminal output label (D7)
    if (auto* obj = SSContext::instance().raw("dir_term_output")) {
        lv_obj_set_style_text_font(obj, SSFonts::monospace_8(), 0);
    }
}

// ---------------------------------------------------------------------------
// Render LeeContext into widgets
// ---------------------------------------------------------------------------

static void renderContext(const dirigible::LeeContext* ctx) {
    if (!g_app.ui_attached) return;  // widgets not built yet
    auto& ss = SSContext::instance();

    // Header — machine name comes from the active machine config
    if (auto* m = g_app.machines->activeMachine()) {
        ss.set("dir_machine_label", m->config.name);
        ss.set("dir_conn_dot", std::string(activeConn() && activeConn()->isConnected() ? "●" : "○"));
    }

    if (!ctx) return;

    // Status bar — idle time + workspace
    if (ctx->activity) {
        char buf[40];
        snprintf(buf, sizeof(buf), "idle %ds", static_cast<int>(ctx->activity->idle_seconds));
        ss.set("dir_status_left", std::string(buf));
    } else {
        ss.set("dir_status_left", std::string(""));
    }

    // Tab list — rebuild when in tab list mode
    if (g_app.mode == DirigibleAppState::Mode::TabList) {
        std::vector<std::string> items;
        items.reserve(ctx->tab_count);
        g_app.tab_ids.clear();
        g_app.tab_ids.reserve(ctx->tab_count);

        for (int i = 0; i < ctx->tab_count; i++) {
            const auto& t = ctx->tabs[i];
            std::string row = std::string(tab_icon(t.type)) + " "
                            + (t.label ? t.label : "(unnamed)");
            items.push_back(row);
            g_app.tab_ids.push_back(t.id);
        }
        ss.list_set_items("dir_tab_list", items);
    }
}

// ---------------------------------------------------------------------------
// Battery callback (D9)
// ---------------------------------------------------------------------------

static void onBatteryChange(SSBatteryReading reading) {
    if (!g_app.ui_attached) return;  // widgets not built yet
    char buf[16];
    snprintf(buf, sizeof(buf), "%d%%", static_cast<int>(reading.percent));
    SSContext::instance().set("dir_battery_label", std::string(buf));
}

// ---------------------------------------------------------------------------
// Keyboard shortcut interceptor (D5)
//
// Returns true to consume the keypress so it doesn't reach focused widgets.
// ---------------------------------------------------------------------------

static bool onKeyIntercept(uint8_t key, SSKeySource source) {
    if (!g_app.foreground) return false;  // backgrounded — never consume keys

    // In terminal mode, all keystrokes are forwarded to the PTY (no local
    // shortcut handling — typing in the terminal must work).
    if (g_app.mode == DirigibleAppState::Mode::Terminal) {
        // Esc returns to tab list
        if (key == 0x1B /* ESC */) {
            teardownPty();
            enterTabListMode();
            return true;
        }
        if (g_app.pty && g_app.pty->isConnected()) {
            char ch = static_cast<char>(key);
            g_app.pty->sendInput(&ch, 1);
            return true;
        }
        return false;
    }

    // Tab list mode — Sym+key shortcuts
    // (For now, return false and let the default LVGL group navigation handle
    //  arrow keys / Enter for list selection. Real shortcut routing comes when
    //  Sym key combinations are exposed by the keyboard driver.)
    return false;
}

// ---------------------------------------------------------------------------
// PTY data → terminal output widget
// ---------------------------------------------------------------------------

static std::string g_term_buf;

static void onPtyData(const uint8_t* data, size_t len) {
    if (g_app.mode != DirigibleAppState::Mode::Terminal) return;

    // Naive append — strip ANSI escapes for now (full ANSI rendering is a
    // later phase). Just keep the last ~2KB of output.
    static constexpr size_t MAX_BUF = 2048;
    g_term_buf.append(reinterpret_cast<const char*>(data), len);
    if (g_term_buf.size() > MAX_BUF) {
        g_term_buf.erase(0, g_term_buf.size() - MAX_BUF);
    }

    // Strip ESC sequences (ESC '[' ... letter)
    std::string clean;
    clean.reserve(g_term_buf.size());
    for (size_t i = 0; i < g_term_buf.size(); ) {
        if (g_term_buf[i] == 0x1B && i + 1 < g_term_buf.size() && g_term_buf[i+1] == '[') {
            i += 2;
            while (i < g_term_buf.size() && !((g_term_buf[i] >= '@' && g_term_buf[i] <= '~'))) i++;
            if (i < g_term_buf.size()) i++;
        } else {
            clean += g_term_buf[i++];
        }
    }
    SSContext::instance().set("dir_term_output", clean);
}

// ===========================================================================
// Public handlers — referenced by screenschema.yaml
// ===========================================================================

void handler_dir_init(const SSEvent& /*event*/) {
    // Brookesia/SSAppBase calls onInit() at least twice (once on installApp,
    // once on app launch). Idempotency: only do the heavy work once.
    if (g_app.initialized) {
        ESP_LOGI(TAG, "Dirigible init (already done — skipping)");
        return;
    }
    g_app.initialized = true;
    ESP_LOGI(TAG, "Dirigible init");

    // NOTE: handler_dir_init runs BEFORE buildUI() in the SSAppBase lifecycle,
    // so widgets do not exist yet. Don't touch SSContext widgets here — defer
    // any widget mutation to handler_dir_resume (called after buildUI).

    // ---- Construct dirigible-core stack ---------------------------------
    g_app.factory  = new dirigible_esp::TransportFactoryEsp();
    g_app.config   = new dirigible_esp::ConfigNvs();
    g_app.config->load();
    ESP_LOGI(TAG, "loaded %d machines from NVS", g_app.config->machineCount());

    g_app.machines = new dirigible::MachineManager(g_app.factory);
    g_app.machines->loadFromConfig(g_app.config);

    g_app.machines->onStatusChanged([](const char* name, bool online) {
        ESP_LOGI(TAG, "machine %s: %s", name, online ? "online" : "offline");
    });

    // ---- Subscribe to context updates -----------------------------------
    dirigible::EventBus::instance().on(dirigible::Event::ContextUpdated, []() {
        if (auto* conn = activeConn()) {
            renderContext(conn->currentContext());
        }
    });
    dirigible::EventBus::instance().on(dirigible::Event::ConnectionChanged, []() {
        renderContext(activeConn() ? activeConn()->currentContext() : nullptr);
    });

    // ---- Battery (D9) ---------------------------------------------------
    SSBattery::instance().onChange(onBatteryChange);

    // ---- Keyboard interceptor (D5) --------------------------------------
    SSInput::instance().onKey(onKeyIntercept);

    // ---- Connect to first machine if any --------------------------------
    if (g_app.machines->machineCount() > 0) {
        auto* m = g_app.machines->machineAt(0);
        // Pull cached token from NVS
        std::string token = g_app.config->getToken(m->config.name);
        if (!token.empty()) m->token = token;

        g_app.machines->setActive(m->config.name);
        if (auto* conn = g_app.machines->activeConnection()) {
            if (!token.empty()) conn->setToken(token);
            conn->connect();
            ESP_LOGI(TAG, "connecting to %s (%s:%d)",
                     m->config.name.c_str(), m->config.host.c_str(), m->config.lee_port);
        }
    }
    // Widget state setup happens in handler_dir_resume.
}

void handler_dir_resume(const SSEvent& /*event*/) {
    ESP_LOGI(TAG, "Dirigible resume");
    g_app.foreground = true;
    g_app.ui_attached = true;  // buildUI has now run

    // Initial UI sync — show the right mode and render any cached context
    enterTabListMode();
    if (auto* conn = activeConn()) {
        // Re-fires on every resume-from-background (S3 resume() semantics).
        // Safe: SSWebSocket::stop() drains its pending queue and init() is
        // idempotent for the pump timer/mutex, so repeated connect() while
        // the host is unreachable doesn't leak resources.
        if (!conn->isConnected()) conn->connect();
        renderContext(conn->currentContext());
    } else {
        SSContext::instance().set("dir_status_left",
            std::string("No machines configured. Use system menu."));
    }
}

void handler_dir_pause(const SSEvent& /*event*/) {
    ESP_LOGI(TAG, "Dirigible pause");
    g_app.foreground = false;
    // Drop out of terminal key-capture: tear down the PTY stream and return
    // to the tab list so a backgrounded Dirigible never owns the keyboard.
    if (g_app.mode == DirigibleAppState::Mode::Terminal) {
        teardownPty();
        enterTabListMode();   // widgets still exist during pause (screen preserved)
    }
    // LeeConnection WS stays alive so context keeps caching in background.
}

void handler_dir_close(const SSEvent& /*event*/) {
    ESP_LOGI(TAG, "Dirigible close");
    g_app.foreground = false;
    g_app.ui_attached = false;          // widgets are about to be destroyed
    g_app.mode = DirigibleAppState::Mode::TabList;
    teardownPty();
    g_term_buf.clear();
    if (auto* conn = activeConn()) conn->disconnect();
}

// ---- Tab list selection -----------------------------------------------
//
// Fired when the user clicks (touch / trackball / Enter) a row in the LVGL
// list. We resolve the row index → tab id → send focus_tab to Lee, then
// (if it's a PTY-bearing tab) open a PTY stream and switch to terminal mode.

void handler_dir_tab_select(const SSEvent& event) {
    int row = event.int_value;  // list widget puts the selected index here
    if (row < 0 || row >= static_cast<int>(g_app.tab_ids.size())) return;

    int tab_id = g_app.tab_ids[row];
    auto* conn = activeConn();
    if (!conn) return;

    ESP_LOGI(TAG, "selecting tab id=%d (row %d)", tab_id, row);

    // 1. Tell Lee to focus this tab on the host
    conn->focusTab(tab_id);

    // 2. Look up the tab in the cached context to find its type / pty_id
    const dirigible::LeeContext* ctx = conn->currentContext();
    if (!ctx) return;

    const dirigible::TabContext* tab = nullptr;
    for (int i = 0; i < ctx->tab_count; i++) {
        if (ctx->tabs[i].id == tab_id) { tab = &ctx->tabs[i]; break; }
    }
    if (!tab) return;

    // 3. If the tab has a PTY, subscribe to it and switch to terminal mode
    if (tab_has_pty(tab->type) && tab->pty_id >= 0) {
        // Tear down any existing subscription
        if (g_app.pty) {
            g_app.pty->disconnect();
            delete g_app.pty;
            g_app.pty = nullptr;
        }

        auto* m = g_app.machines->activeMachine();
        if (!m) return;

        g_app.pty = new dirigible::PTYClient(
            g_app.factory, m->config.host, m->config.lee_port,
            tab->pty_id, m->token);
        g_app.active_pty_id = tab->pty_id;
        g_term_buf.clear();
        SSContext::instance().set("dir_term_output", std::string(""));

        g_app.pty->onData(onPtyData);
        g_app.pty->connect();

        // Tell the host to resize this PTY to fit the T-Deck viewport.
        // (PTYClient records the size and re-sends from onConnect once the
        //  WS opens (and after every reconnect).)
        g_app.pty->sendResize(TERM_COLS, TERM_ROWS);

        enterTerminalMode();
    }
    // For non-PTY tabs (editor, browser, files, etc.) we just switch focus
    // on the host and stay in the tab list — Dirigible doesn't try to render
    // those in v1.
}
