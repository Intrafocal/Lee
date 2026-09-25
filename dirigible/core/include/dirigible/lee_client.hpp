#pragma once

#include "dirigible/attention.hpp"
#include "dirigible/fs.hpp"
#include "dirigible/models.hpp"
#include "dirigible/transport.hpp"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// LeeWindow — one entry of Lee's `GET /windows` (Aeronaut's WindowInfo).
// Every Lee window on a host shares the one API port; the window id is how a
// client tells their contexts apart and targets commands at one of them.
// ---------------------------------------------------------------------------

struct LeeWindow {
    int         id = 0;
    std::string workspace;   // absolute path, "" for an untitled window
    bool        focused = false;

    /// Last path segment of the workspace, or "Untitled".
    std::string name() const;
};

// ---------------------------------------------------------------------------
// LeeConnection — WebSocket context stream + HTTP command client
//
// One instance per machine. Handles:
//   - WS to /context/stream?token= (real-time LeeContext updates)
//   - HTTP POST to /command with Bearer token
//   - Exponential backoff reconnect (5s → 60s)
//   - Window selection: every open Lee window broadcasts on the same stream,
//     tagged with `window_id`.  One window is "active"; context from the
//     others is dropped and commands carry its id, as in Aeronaut.
//
// Auth protocol (from api-server.ts):
//   - WebSocket: token as ?token= query parameter
//   - HTTP: Authorization: Bearer {token} header
// ---------------------------------------------------------------------------

class LeeConnection {
public:
    using ContextCallback = std::function<void(const LeeContext*)>;

    LeeConnection(ITransportFactory* factory,
                  const std::string& host, int port);
    ~LeeConnection();

    // Non-copyable
    LeeConnection(const LeeConnection&) = delete;
    LeeConnection& operator=(const LeeConnection&) = delete;

    // Connection lifecycle
    void connect();
    void disconnect();
    bool isConnected() const;

    // Auth
    void setToken(const std::string& token);
    const std::string& token() const { return token_; }

    // Context stream
    void onContextUpdate(ContextCallback cb);
    const LeeContext* currentContext() const { return context_; }

    // Windows (GET /windows).  The active window defaults to the one focused
    // on the host when the list first arrives, and stays put after that until
    // it closes — the same rule as Aeronaut's WindowsNotifier.  Refreshed on
    // every WS connect; call refreshWindows() periodically to track windows
    // opening and closing.  Emits Event::WindowsChanged.
    void refreshWindows();
    const std::vector<LeeWindow>& windows() const { return windows_; }
    const LeeWindow* activeWindow() const;
    int activeWindowId() const { return active_window_; }   // -1: none yet
    /// Switch to `id` and pull its context over GET /context?window_id=, so the
    /// view changes now rather than on that window's next broadcast.
    void setActiveWindow(int id);
    /// Step to the next (+1) or previous (-1) window, wrapping.
    void cycleWindow(int step);

    // Commands — domain/action/params matching Lee's POST /command.  The
    // active window's id is added as params.window_id unless already set.
    void sendCommand(const char* domain, const char* action,
                     cJSON* params = nullptr,
                     std::function<void(bool success)> cb = nullptr);

    // Convenience commands
    void focusTab(int tab_id);
    void closeTab(int tab_id);
    void openFile(const char* path);
    void saveFile();
    void spawnTui(const char* type, const char* cwd = nullptr);

    // Read-only filesystem (GET /fs/list, GET /fs/read).  Results are
    // non-owning, valid only for the callback, which fires on the UI thread.
    // An empty `path` lists the active window's workspace.
    void fsList(const std::string& path,
                std::function<void(const FsListResult&)> cb);
    void fsRead(const std::string& path, bool stat_only,
                std::function<void(const FsReadResult&)> cb);

    // Copilot attention queue (contracts §5.6, §9.3).  The snapshot follows
    // `attention_snapshot` messages on the context stream and is fetched over
    // GET /attention?compact=1 on every WS connect.  Emits
    // Event::AttentionChanged on each new snapshot and Event::AttentionAlert
    // when an item's notify flips to true.  The snapshot survives a
    // disconnect, so a reconnect compares against what was last seen.
    const AttentionSnapshot& attention() const { return attention_; }
    /// False until a snapshot has arrived; stays false against a Lee that
    /// answers 404 (no queue yet).
    bool attentionAvailable() const { return attention_ok_; }
    bool attentionUnsupported() const { return attention_404_; }
    void fetchAttention(std::function<void(bool ok)> cb = nullptr);

    /// Every stream message whose type is not `context_update` (after the
    /// connection has consumed `attention_snapshot` itself).  `msg` is the
    /// whole message, non-owning, valid only for the call.
    void onCopilotMessage(std::function<void(cJSON* msg)> cb);

    /// POST /attention/:id/reply.  `action` is "approve", "deny" or "text";
    /// `text` is sent only for "text".  `version` must echo the item's.
    void attentionReply(const std::string& id, const char* action,
                        const std::string& text, int version,
                        std::function<void(const ReplyResult&)> cb);

    /// POST /attention/:id/dismiss.  Human-only like reply (§4.4).
    void attentionDismiss(const std::string& id,
                          std::function<void(const ReplyResult&)> cb);

    /// POST /attention/:id/snooze with {"minutes": n}.
    void attentionSnooze(const std::string& id, int minutes,
                         std::function<void(const ReplyResult&)> cb);

    /// POST /focus/start (no item: Lee picks the focused window's workspace)
    /// or POST /focus/stop.  The new state arrives in the next snapshot.
    void focusSet(bool on, std::function<void(const ReplyResult&)> cb);

    /// POST /capture into Hester's Someday list, for the followed window's
    /// workspace.
    void capture(const std::string& text,
                 std::function<void(const CaptureOutcome&)> cb);

    // Health check
    void healthCheck(std::function<void(bool online)> cb);

    // Reconnect control
    void scheduleReconnect();

private:
    void onWsMessage(cJSON* msg);
    void onWsConnected();
    void onWsDisconnected();

    void fetchContext(int window_id);
    void setContext(LeeContext* ctx, int window_id);
    void setAttention(AttentionSnapshot&& snap);
    /// POST `body` (owned; freed here or by the transport) to `path` and
    /// report it as a ReplyResult.
    void postAction(const std::string& path, cJSON* body,
                    std::function<void(const ReplyResult&)> cb);

    std::string buildWsUrl() const;
    std::string buildHttpUrl(const char* path) const;

    ITransportFactory* factory_;
    IWebSocket* ws_         = nullptr;
    IHttpClient* http_      = nullptr;

    std::string host_;
    int port_;
    std::string token_;

    LeeContext* context_    = nullptr;  // owned, freed on update
    bool connected_         = false;

    ContextCallback on_context_update_;
    std::function<void(cJSON*)> on_copilot_message_;

    // Attention queue
    AttentionSnapshot attention_;
    bool attention_ok_  = false;
    bool attention_404_ = false;

    // Windows
    std::vector<LeeWindow> windows_;
    int active_window_  = -1;   // selected window, -1 until /windows answers
    int context_window_ = -1;   // window context_ came from, -1 if untagged

    // HTTP callbacks land later on the UI task; they hold a weak_ptr to this
    // and bail if the connection has been destroyed in the meantime.
    std::shared_ptr<int> alive_ = std::make_shared<int>(0);

    // Reconnect state
    static constexpr double RECONNECT_DELAY_INIT = 5.0;
    static constexpr double RECONNECT_DELAY_MAX  = 60.0;
    double reconnect_delay_ = RECONNECT_DELAY_INIT;
};

}  // namespace dirigible
