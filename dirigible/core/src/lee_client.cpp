#include "dirigible/lee_client.hpp"
#include "dirigible/state.hpp"
#include "cJSON.h"
#include <cstdio>
#include <cstring>

namespace dirigible {

std::string LeeWindow::name() const {
    if (workspace.empty()) return "Untitled";
    const size_t slash = workspace.find_last_of('/');
    return slash == std::string::npos ? workspace : workspace.substr(slash + 1);
}

LeeConnection::LeeConnection(ITransportFactory* factory,
                               const std::string& host, int port)
    : factory_(factory), host_(host), port_(port) {}

LeeConnection::~LeeConnection() {
    disconnect();
    context_free(context_);
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

std::string LeeConnection::buildWsUrl() const {
    std::string url = "ws://" + host_ + ":" + std::to_string(port_)
                    + "/context/stream";
    if (!token_.empty()) {
        url += "?token=" + token_;
    }
    return url;
}

std::string LeeConnection::buildHttpUrl(const char* path) const {
    return "http://" + host_ + ":" + std::to_string(port_) + path;
}

void LeeConnection::connect() {
    if (!ws_) {
        ws_ = factory_->createWebSocket(5000);
        ws_->onMessage([this](cJSON* msg) { onWsMessage(msg); });
        ws_->onConnect([this]() { onWsConnected(); });
        ws_->onDisconnect([this]() { onWsDisconnected(); });
    }
    if (!http_) {
        http_ = factory_->createHttpClient(5000);
        if (!token_.empty()) {
            http_->setAuthToken(token_);
        }
    }

    ws_->connect(buildWsUrl());
}

void LeeConnection::disconnect() {
    if (ws_) {
        ws_->disconnect();
        delete ws_;
        ws_ = nullptr;
    }
    if (http_) {
        delete http_;
        http_ = nullptr;
    }
    connected_ = false;
}

bool LeeConnection::isConnected() const {
    return connected_ && ws_ && ws_->isConnected();
}

void LeeConnection::setToken(const std::string& token) {
    token_ = token;
    if (http_) {
        http_->setAuthToken(token);
    }
    // If already connected, reconnect with new token
    if (ws_ && ws_->isConnected()) {
        ws_->disconnect();
        ws_->connect(buildWsUrl());
    }
}

// ---------------------------------------------------------------------------
// Context stream
// ---------------------------------------------------------------------------

void LeeConnection::onContextUpdate(ContextCallback cb) {
    on_context_update_ = std::move(cb);
}

void LeeConnection::onWsMessage(cJSON* msg) {
    // Expect: { "type": "context_update", "window_id": N, "data": { ... } }
    cJSON* type_item = cJSON_GetObjectItemCaseSensitive(msg, "type");
    if (!type_item || !cJSON_IsString(type_item)) return;

    if (strcmp(type_item->valuestring, "context_update") != 0) {
        // Copilot types share the socket (contracts §12 #2).
        if (strcmp(type_item->valuestring, "attention_snapshot") == 0) {
            AttentionSnapshot snap;
            if (attention_snapshot_parse(
                    cJSON_GetObjectItemCaseSensitive(msg, "data"), snap)) {
                setAttention(std::move(snap));
            }
        }
        if (on_copilot_message_) on_copilot_message_(msg);
        return;
    }

    // Every Lee window broadcasts here.  Drop the ones we aren't showing; an
    // untagged update (older Lee) is taken as-is, as Aeronaut does.
    int window_id = -1;
    cJSON* wid = cJSON_GetObjectItemCaseSensitive(msg, "window_id");
    if (wid && cJSON_IsNumber(wid)) window_id = wid->valueint;
    if (active_window_ >= 0 && window_id >= 0 && window_id != active_window_) {
        return;
    }

    cJSON* data = cJSON_GetObjectItemCaseSensitive(msg, "data");
    if (!data) return;

    LeeContext* new_ctx = context_parse(data);
    if (!new_ctx) return;

    setContext(new_ctx, window_id);
}

void LeeConnection::setContext(LeeContext* ctx, int window_id) {
    // Swap cached context
    context_free(context_);
    context_ = ctx;
    context_window_ = window_id;

    // Notify
    if (on_context_update_) {
        on_context_update_(context_);
    }
    EventBus::instance().emit(Event::ContextUpdated);
}

void LeeConnection::onWsConnected() {
    connected_ = true;
    reconnect_delay_ = RECONNECT_DELAY_INIT;
    EventBus::instance().emit(Event::ConnectionChanged);
    // Windows may have opened or closed while we were away.
    refreshWindows();
    fetchAttention();
}

void LeeConnection::onWsDisconnected() {
    connected_ = false;
    EventBus::instance().emit(Event::ConnectionChanged);
    // Platform is responsible for reconnect (WS transport may auto-reconnect)
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const LeeWindow* LeeConnection::activeWindow() const {
    for (const auto& w : windows_) {
        if (w.id == active_window_) return &w;
    }
    return nullptr;
}

void LeeConnection::refreshWindows() {
    if (!http_) return;
    std::weak_ptr<int> alive = alive_;
    http_->get(buildHttpUrl("/windows"), [this, alive](int status, cJSON* resp) {
        if (alive.expired()) return;
        if (status < 200 || status >= 300 || !resp) return;   // keep what we had

        // Lee wraps payloads as { success, data: [...] }.
        cJSON* data = cJSON_GetObjectItemCaseSensitive(resp, "data");
        if (!data) data = resp;
        if (!cJSON_IsArray(data)) return;

        std::vector<LeeWindow> list;
        cJSON* item = nullptr;
        cJSON_ArrayForEach(item, data) {
            cJSON* id = cJSON_GetObjectItemCaseSensitive(item, "id");
            if (!id || !cJSON_IsNumber(id)) continue;
            LeeWindow w;
            w.id = id->valueint;
            cJSON* ws = cJSON_GetObjectItemCaseSensitive(item, "workspace");
            if (ws && cJSON_IsString(ws)) w.workspace = ws->valuestring;
            w.focused = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(item, "focused"));
            list.push_back(std::move(w));
        }

        // Keep the selection while its window exists; otherwise fall back to
        // the focused window, then the first.
        int active = active_window_;
        bool still_open = false;
        for (const auto& w : list) still_open |= (w.id == active);
        if (!still_open) {
            active = list.empty() ? -1 : list.front().id;
            for (const auto& w : list) {
                if (w.focused) { active = w.id; break; }
            }
        }

        bool changed = active != active_window_ || list.size() != windows_.size();
        for (size_t i = 0; !changed && i < list.size(); i++) {
            changed = list[i].id != windows_[i].id ||
                      list[i].workspace != windows_[i].workspace ||
                      list[i].focused != windows_[i].focused;
        }
        windows_ = std::move(list);
        active_window_ = active;

        // The cached context may belong to another window: the untagged
        // snapshot sent on connect, or the one that just closed.
        if (active_window_ >= 0 && context_window_ != active_window_) {
            fetchContext(active_window_);
        }
        if (changed) EventBus::instance().emit(Event::WindowsChanged);
    });
}

void LeeConnection::setActiveWindow(int id) {
    if (id == active_window_) return;
    active_window_ = id;
    EventBus::instance().emit(Event::WindowsChanged);
    fetchContext(id);
}

void LeeConnection::cycleWindow(int step) {
    const int n = (int)windows_.size();
    if (n < 2) return;
    int i = 0;
    for (int k = 0; k < n; k++) {
        if (windows_[k].id == active_window_) { i = k; break; }
    }
    setActiveWindow(windows_[((i + step) % n + n) % n].id);
}

void LeeConnection::fetchContext(int window_id) {
    if (!http_) return;
    std::weak_ptr<int> alive = alive_;
    http_->get(buildHttpUrl("/context") + "?window_id=" + std::to_string(window_id),
               [this, alive, window_id](int status, cJSON* resp) {
        if (alive.expired()) return;
        // Switched again while this was in flight: the newer fetch wins.
        if (window_id != active_window_) return;
        if (status < 200 || status >= 300 || !resp) return;
        cJSON* data = cJSON_GetObjectItemCaseSensitive(resp, "data");
        LeeContext* ctx = context_parse(data ? data : resp);
        if (ctx) setContext(ctx, window_id);
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

void LeeConnection::sendCommand(const char* domain, const char* action,
                                 cJSON* params,
                                 std::function<void(bool success)> cb) {
    if (!http_) {
        if (cb) cb(false);
        return;
    }

    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "domain", domain);
    cJSON_AddStringToObject(body, "action", action);
    if (!params) params = cJSON_CreateObject();
    // Target the window we are showing, not whichever one has focus on the
    // host (Lee's default when window_id is absent).
    if (active_window_ >= 0 &&
        !cJSON_GetObjectItemCaseSensitive(params, "window_id")) {
        cJSON_AddNumberToObject(params, "window_id", active_window_);
    }
    // body takes ownership of params
    cJSON_AddItemToObject(body, "params", params);

    http_->post(buildHttpUrl("/command"), body,
                [cb](int status, cJSON* resp) {
        if (cb) {
            bool success = (status >= 200 && status < 300);
            if (resp) {
                cJSON* s = cJSON_GetObjectItemCaseSensitive(resp, "success");
                if (s && cJSON_IsBool(s)) {
                    success = cJSON_IsTrue(s);
                }
            }
            cb(success);
        }
    });
}

// ---------------------------------------------------------------------------
// Convenience commands
// ---------------------------------------------------------------------------

void LeeConnection::focusTab(int tab_id) {
    cJSON* p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "tab_id", std::to_string(tab_id).c_str());
    sendCommand("system", "focus_tab", p);
}

void LeeConnection::closeTab(int tab_id) {
    cJSON* p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "tab_id", std::to_string(tab_id).c_str());
    sendCommand("system", "close_tab", p);
}

void LeeConnection::openFile(const char* path) {
    cJSON* p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "file", path);
    sendCommand("editor", "open", p);
}

void LeeConnection::saveFile() {
    sendCommand("editor", "save");
}

void LeeConnection::spawnTui(const char* type, const char* cwd) {
    cJSON* p = nullptr;
    if (cwd) {
        p = cJSON_CreateObject();
        cJSON_AddStringToObject(p, "cwd", cwd);
    }
    sendCommand("tui", type, p);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

void LeeConnection::fsList(const std::string& path,
                           std::function<void(const FsListResult&)> cb) {
    if (!http_) {
        FsListResult r;
        fs_list_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    // Lee's own default is the *focused* window; ask for ours instead.
    std::string dir = path;
    if (dir.empty()) {
        if (const LeeWindow* w = activeWindow()) dir = w->workspace;
    }
    std::string url = buildHttpUrl("/fs/list");
    if (!dir.empty()) url += "?path=" + url_encode(dir);
    http_->get(url, [cb](int status, cJSON* resp) {
        FsListResult r;
        fs_list_parse(status, resp, r);
        if (cb) cb(r);
    });
}

void LeeConnection::fsRead(const std::string& path, bool stat_only,
                           std::function<void(const FsReadResult&)> cb) {
    if (!http_) {
        FsReadResult r;
        fs_read_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    std::string url = buildHttpUrl("/fs/read") + "?path=" + url_encode(path);
    if (stat_only) url += "&stat=1";
    http_->get(url, [cb](int status, cJSON* resp) {
        FsReadResult r;
        fs_read_parse(status, resp, r);
        if (cb) cb(r);
    });
}

// ---------------------------------------------------------------------------
// Copilot: attention queue, reply, capture
// ---------------------------------------------------------------------------

void LeeConnection::onCopilotMessage(std::function<void(cJSON*)> cb) {
    on_copilot_message_ = std::move(cb);
}

void LeeConnection::setAttention(AttentionSnapshot&& snap) {
    const bool rose = attention_ok_ && attention_notify_rose(attention_, snap);
    attention_ = std::move(snap);
    attention_ok_ = true;
    attention_404_ = false;
    EventBus::instance().emit(Event::AttentionChanged);
    if (rose) EventBus::instance().emit(Event::AttentionAlert);
}

void LeeConnection::fetchAttention(std::function<void(bool ok)> cb) {
    if (!http_) {
        if (cb) cb(false);
        return;
    }
    std::weak_ptr<int> alive = alive_;
    http_->get(buildHttpUrl("/attention?compact=1"),
               [this, alive, cb](int status, cJSON* resp) {
        if (alive.expired()) return;
        AttentionSnapshot snap;
        const bool ok = status >= 200 && status < 300 &&
                        attention_snapshot_parse(resp, snap);
        if (ok) {
            setAttention(std::move(snap));
        } else if (status == 404 && !attention_ok_) {
            attention_404_ = true;
            EventBus::instance().emit(Event::AttentionChanged);
        }
        if (cb) cb(ok);
    });
}

void LeeConnection::attentionReply(const std::string& id, const char* action,
                                   const std::string& text, int version,
                                   std::function<void(const ReplyResult&)> cb) {
    if (!http_) {
        ReplyResult r;
        reply_result_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "action", action);
    if (strcmp(action, "text") == 0) cJSON_AddStringToObject(body, "text", text.c_str());
    cJSON_AddNumberToObject(body, "version", version);

    const std::string url = buildHttpUrl("/attention/") + url_encode(id) + "/reply";
    http_->post(url, body, [cb](int status, cJSON* resp) {
        ReplyResult r;
        reply_result_parse(status, resp, r);
        if (cb) cb(r);
    });
}

void LeeConnection::postAction(const std::string& path, cJSON* body,
                               std::function<void(const ReplyResult&)> cb) {
    if (!http_) {
        cJSON_Delete(body);
        ReplyResult r;
        reply_result_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    http_->post(buildHttpUrl(path.c_str()), body, [cb](int status, cJSON* resp) {
        ReplyResult r;
        reply_result_parse(status, resp, r);
        if (cb) cb(r);
    });
}

void LeeConnection::attentionChoose(const std::string& id, int choice, int version,
                                    std::function<void(const ReplyResult&)> cb) {
    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "action", "choose");
    cJSON_AddNumberToObject(body, "choice", choice);
    cJSON_AddNumberToObject(body, "version", version);
    postAction("/attention/" + url_encode(id) + "/reply", body, std::move(cb));
}

void LeeConnection::attentionOpen(const std::string& id,
                                  std::function<void(const ReplyResult&)> cb) {
    postAction("/attention/" + url_encode(id) + "/open", cJSON_CreateObject(), std::move(cb));
}

void LeeConnection::fetchAttentionItem(const std::string& id,
                                       std::function<void(int, const AttentionItem*)> cb) {
    if (!http_) {
        if (cb) cb(0, nullptr);
        return;
    }
    std::weak_ptr<int> alive = alive_;
    // The transport owns and frees `resp` after the callback; only the parsed
    // copy leaves it.
    http_->get(buildHttpUrl("/attention/") + url_encode(id),
               [alive, cb](int status, cJSON* resp) {
        if (alive.expired() || !cb) return;
        AttentionItem item;
        const bool ok = status >= 200 && status < 300 && attention_item_parse(resp, item);
        cb(status, ok ? &item : nullptr);
    });
}

void LeeConnection::attentionDismiss(const std::string& id,
                                     std::function<void(const ReplyResult&)> cb) {
    postAction("/attention/" + url_encode(id) + "/dismiss", cJSON_CreateObject(), std::move(cb));
}

void LeeConnection::attentionSnooze(const std::string& id, int minutes,
                                    std::function<void(const ReplyResult&)> cb) {
    cJSON* body = cJSON_CreateObject();
    cJSON_AddNumberToObject(body, "minutes", minutes);
    postAction("/attention/" + url_encode(id) + "/snooze", body, std::move(cb));
}

void LeeConnection::focusSet(bool on, std::function<void(const ReplyResult&)> cb) {
    postAction(on ? "/focus/start" : "/focus/stop", cJSON_CreateObject(), std::move(cb));
}

void LeeConnection::capture(const std::string& text,
                            std::function<void(const CaptureOutcome&)> cb) {
    if (!http_) {
        CaptureOutcome r;
        capture_outcome_parse(0, nullptr, r);
        if (cb) cb(r);
        return;
    }
    cJSON* body = cJSON_CreateObject();
    cJSON_AddStringToObject(body, "text", text.c_str());
    // Lee's default is the focused window; capture belongs to the one we follow.
    if (const LeeWindow* w = activeWindow(); w && !w->workspace.empty()) {
        cJSON_AddStringToObject(body, "workspace", w->workspace.c_str());
    }
    http_->post(buildHttpUrl("/capture"), body, [cb](int status, cJSON* resp) {
        CaptureOutcome r;
        capture_outcome_parse(status, resp, r);
        if (cb) cb(r);
    });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

void LeeConnection::healthCheck(std::function<void(bool online)> cb) {
    if (!http_) {
        if (cb) cb(false);
        return;
    }

    http_->get(buildHttpUrl("/health"),
               [cb](int status, cJSON* /*resp*/) {
        if (cb) cb(status >= 200 && status < 300);
    });
}

}  // namespace dirigible
