#include "dirigible/lee_client.hpp"
#include "dirigible/state.hpp"
#include "cJSON.h"
#include <cstdio>
#include <cstring>

namespace dirigible {

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
    // Expect: { "type": "context_update", "data": { ... } }
    cJSON* type_item = cJSON_GetObjectItemCaseSensitive(msg, "type");
    if (!type_item || !cJSON_IsString(type_item)) return;

    if (strcmp(type_item->valuestring, "context_update") != 0) return;

    cJSON* data = cJSON_GetObjectItemCaseSensitive(msg, "data");
    if (!data) return;

    LeeContext* new_ctx = context_parse(data);
    if (!new_ctx) return;

    // Swap cached context
    context_free(context_);
    context_ = new_ctx;

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
}

void LeeConnection::onWsDisconnected() {
    connected_ = false;
    EventBus::instance().emit(Event::ConnectionChanged);
    // Platform is responsible for reconnect (WS transport may auto-reconnect)
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
    if (params) {
        // Detach params so body takes ownership
        cJSON_AddItemToObject(body, "params", params);
    } else {
        cJSON_AddObjectToObject(body, "params");
    }

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
