#include "dirigible_esp/transport_esp.hpp"

// ScreenSchema runtime headers
#include "ss_websocket.hpp"
#include "ss_http_client.hpp"
#include "ss_mdns.hpp"

#include "cJSON.h"
#include "esp_log.h"
#include "lvgl.h"

#include <atomic>
#include <cstdio>
#include <cstring>

static const char* TAG = "dirigible-esp";

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// Unique instance counter (each WS/HTTP client gets a unique name)
// ---------------------------------------------------------------------------

static std::atomic<uint32_t> g_instance_counter{0};

static std::string makeUniqueName(const char* prefix) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%s_%lu", prefix,
             static_cast<unsigned long>(g_instance_counter.fetch_add(1)));
    return std::string(buf);
}

// ===========================================================================
// WebSocketEsp
// ===========================================================================

WebSocketEsp::WebSocketEsp(uint32_t reconnect_ms)
    : reconnect_ms_(reconnect_ms) {
    instance_name_ = makeUniqueName("dir_ws");
}

WebSocketEsp::~WebSocketEsp() {
    if (state_poll_timer_) {
        lv_timer_del(static_cast<lv_timer_t*>(state_poll_timer_));
        state_poll_timer_ = nullptr;
    }
    if (ws_) {
        ws_->stop();
        // SSWebSocket instances are owned by the named registry — don't delete
    }
}

void WebSocketEsp::connect(const std::string& url) {
    ESP_LOGI(TAG, "WebSocketEsp::connect %s", url.c_str());

    if (!ws_) {
        // First connect — create the named SSWebSocket instance
        ws_ = &SSWebSocket::create(instance_name_, url, reconnect_ms_);
        registerCallbacks();
    } else {
        // Reconnect with potentially new URL
        ws_->stop();
        ws_->init(url, reconnect_ms_);
    }
}

void WebSocketEsp::disconnect() {
    if (ws_) {
        ws_->stop();
    }
    if (last_connected_state_) {
        last_connected_state_ = false;
        for (auto& cb : disconnect_cbs_) cb();
    }
}

bool WebSocketEsp::isConnected() const {
    return ws_ && ws_->isConnected();
}

void WebSocketEsp::sendText(const std::string& text) {
    if (ws_) ws_->sendRaw(text);
}

void WebSocketEsp::sendJson(cJSON* obj) {
    if (ws_) {
        ws_->send(obj);  // takes ownership
    } else {
        cJSON_Delete(obj);
    }
}

void WebSocketEsp::sendBinary(const uint8_t* data, size_t len) {
    if (ws_) ws_->sendBinary(data, len);
}

void WebSocketEsp::onMessage(std::function<void(cJSON*)> cb) {
    message_cbs_.push_back(std::move(cb));
}

void WebSocketEsp::onBinary(std::function<void(const uint8_t*, size_t)> cb) {
    binary_cbs_.push_back(std::move(cb));
}

void WebSocketEsp::onConnect(std::function<void()> cb) {
    connect_cbs_.push_back(std::move(cb));
}

void WebSocketEsp::onDisconnect(std::function<void()> cb) {
    disconnect_cbs_.push_back(std::move(cb));
}

void WebSocketEsp::registerCallbacks() {
    if (callbacks_registered_ || !ws_) return;
    callbacks_registered_ = true;

    // Forward incoming JSON messages to all registered callbacks.
    // SSWebSocket dispatches to LVGL task, so callbacks run on UI thread.
    ws_->onMessage([this](cJSON* msg) {
        for (auto& cb : message_cbs_) {
            cb(msg);
        }
    });

    ws_->onBinary([this](const uint8_t* data, size_t len) {
        for (auto& cb : binary_cbs_) {
            cb(data, len);
        }
    });

    // Connection state polling — SSWebSocket doesn't expose connect/disconnect
    // events, so we poll isConnected() every 200ms via an LVGL timer.
    // LVGL 8.x exposes the user pointer via the lv_timer_t::user_data field.
    state_poll_timer_ = lv_timer_create(
        [](lv_timer_t* t) {
            auto* self = static_cast<WebSocketEsp*>(t->user_data);
            self->pollConnectionState();
        },
        200, this);
}

void WebSocketEsp::pollConnectionState() {
    bool now_connected = isConnected();
    if (now_connected != last_connected_state_) {
        last_connected_state_ = now_connected;
        if (now_connected) {
            for (auto& cb : connect_cbs_) cb();
        } else {
            for (auto& cb : disconnect_cbs_) cb();
        }
    }
}

// ===========================================================================
// HttpClientEsp
// ===========================================================================

HttpClientEsp::HttpClientEsp(int timeout_ms)
    : timeout_ms_(timeout_ms) {
    endpoint_name_ = makeUniqueName("dir_http");
}

HttpClientEsp::~HttpClientEsp() {
    // SSHttpClient endpoints persist in the singleton — no per-instance cleanup
}

void HttpClientEsp::setAuthToken(const std::string& token) {
    token_ = token;
    // Re-register endpoint with new auth header
    if (!current_base_url_.empty()) {
        std::string base = current_base_url_;
        current_base_url_.clear();  // force re-register
        ensureEndpoint(base);
    }
}

bool HttpClientEsp::splitUrl(const std::string& url,
                              std::string& base, std::string& path) {
    // Find scheme separator
    size_t scheme_end = url.find("://");
    if (scheme_end == std::string::npos) return false;

    // Find first '/' after scheme://host:port
    size_t path_start = url.find('/', scheme_end + 3);
    if (path_start == std::string::npos) {
        base = url;
        path = "/";
    } else {
        base = url.substr(0, path_start);
        path = url.substr(path_start);
    }
    return true;
}

void HttpClientEsp::ensureEndpoint(const std::string& base_url) {
    if (current_base_url_ == base_url) return;
    current_base_url_ = base_url;

    SSEndpointConfig cfg;
    cfg.base_url = base_url;
    cfg.timeout_ms = timeout_ms_;
    cfg.retry = 1;
    if (!token_.empty()) {
        cfg.headers["Authorization"] = "Bearer " + token_;
    }

    SSHttpClient::instance().registerEndpoint(endpoint_name_, cfg);
    ESP_LOGI(TAG, "Registered endpoint %s -> %s",
             endpoint_name_.c_str(), base_url.c_str());
}

void HttpClientEsp::get(const std::string& url,
                         std::function<void(int status, cJSON* resp)> cb) {
    std::string base, path;
    if (!splitUrl(url, base, path)) {
        if (cb) cb(0, nullptr);
        return;
    }
    ensureEndpoint(base);

    SSHttpClient::instance().get(endpoint_name_, path,
        [cb](bool ok, cJSON* resp) {
            // SSHttpClient gives us ok bool, not status code — synthesize one
            int status = ok ? 200 : 0;
            if (cb) cb(status, resp);
            // Caller (cb) does NOT take ownership of resp; SSHttpClient manages it
        });
}

void HttpClientEsp::post(const std::string& url, cJSON* body,
                          std::function<void(int status, cJSON* resp)> cb) {
    std::string base, path;
    if (!splitUrl(url, base, path)) {
        cJSON_Delete(body);
        if (cb) cb(0, nullptr);
        return;
    }
    ensureEndpoint(base);

    SSHttpClient::instance().post(endpoint_name_, path, body,
        [cb](bool ok, cJSON* resp) {
            int status = ok ? 200 : 0;
            if (cb) cb(status, resp);
        });
}

void HttpClientEsp::postSSE(const std::string& url, cJSON* body,
                             SSEEventCallback on_event,
                             SSEDoneCallback on_done) {
    std::string base, path;
    if (!splitUrl(url, base, path)) {
        cJSON_Delete(body);
        if (on_done) on_done(false);
        return;
    }
    ensureEndpoint(base);

    // SSHttpClient::postSSE callback signatures match ours exactly
    SSHttpClient::instance().postSSE(endpoint_name_, path, body,
        std::move(on_event),
        std::move(on_done));
}

// ===========================================================================
// DiscoveryEsp
// ===========================================================================

void DiscoveryEsp::query(const std::string& service_type,
                          const std::string& proto,
                          uint32_t timeout_ms,
                          std::function<void(std::vector<dirigible::DiscoveryResult>)> cb) {
    SSMdns::query(service_type.c_str(), proto.c_str(), timeout_ms,
        [cb](std::vector<SSMdnsResult> results) {
            // Translate SSMdnsResult → dirigible::DiscoveryResult
            std::vector<dirigible::DiscoveryResult> out;
            out.reserve(results.size());
            for (auto& r : results) {
                dirigible::DiscoveryResult d;
                d.hostname = r.hostname;
                d.ipv4     = r.ip;
                d.port     = static_cast<int>(r.port);
                for (auto& kv : r.txt) {
                    d.txt[kv.first] = kv.second;
                }
                out.push_back(std::move(d));
            }
            if (cb) cb(std::move(out));
        });
}

// ===========================================================================
// TransportFactoryEsp
// ===========================================================================

dirigible::IWebSocket* TransportFactoryEsp::createWebSocket(uint32_t reconnect_ms) {
    return new WebSocketEsp(reconnect_ms);
}

dirigible::IHttpClient* TransportFactoryEsp::createHttpClient(int timeout_ms) {
    return new HttpClientEsp(timeout_ms);
}

dirigible::IDiscovery* TransportFactoryEsp::createDiscovery() {
    return new DiscoveryEsp();
}

}  // namespace dirigible_esp
