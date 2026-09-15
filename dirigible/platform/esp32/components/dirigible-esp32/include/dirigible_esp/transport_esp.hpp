#pragma once

#include "dirigible/transport.hpp"
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// Forward declarations from ScreenSchema
class SSWebSocket;

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// WebSocketEsp — wraps ScreenSchema's SSWebSocket
//
// SSWebSocket lifetime is managed by ScreenSchema's named registry. We give
// each instance a unique name and reuse it across reconnects.
// ---------------------------------------------------------------------------

class WebSocketEsp : public dirigible::IWebSocket {
public:
    explicit WebSocketEsp(uint32_t reconnect_ms);
    ~WebSocketEsp() override;

    void connect(const std::string& url) override;
    void disconnect() override;
    bool isConnected() const override;

    void sendText(const std::string& text) override;
    void sendJson(cJSON* obj) override;
    void sendBinary(const uint8_t* data, size_t len) override;

    void onMessage(std::function<void(cJSON*)> cb) override;
    void onBinary(std::function<void(const uint8_t*, size_t)> cb) override;
    void onConnect(std::function<void()> cb) override;
    void onDisconnect(std::function<void()> cb) override;

private:
    void registerCallbacks();
    void pollConnectionState();

    std::string instance_name_;
    SSWebSocket* ws_ = nullptr;
    uint32_t reconnect_ms_;
    bool callbacks_registered_ = false;

    // Local callback storage (we forward SSWebSocket events through these)
    std::vector<std::function<void(cJSON*)>> message_cbs_;
    std::vector<std::function<void(const uint8_t*, size_t)>> binary_cbs_;
    std::vector<std::function<void()>> connect_cbs_;
    std::vector<std::function<void()>> disconnect_cbs_;

    // Connection state tracking — SSWebSocket doesn't expose connect/disconnect
    // events directly, so we poll isConnected() via an LVGL timer.
    bool last_connected_state_ = false;
    void* state_poll_timer_ = nullptr;  // lv_timer_t*
};

// ---------------------------------------------------------------------------
// HttpClientEsp — wraps ScreenSchema's SSHttpClient
//
// SSHttpClient uses named endpoints. Each HttpClientEsp instance registers
// its own endpoint name and parses incoming URLs to extract the path.
// ---------------------------------------------------------------------------

class HttpClientEsp : public dirigible::IHttpClient {
public:
    explicit HttpClientEsp(int timeout_ms);
    ~HttpClientEsp() override;

    void setAuthToken(const std::string& token) override;

    void get(const std::string& url,
             std::function<void(int status, cJSON* resp)> cb) override;

    void post(const std::string& url, cJSON* body,
              std::function<void(int status, cJSON* resp)> cb) override;

    void postSSE(const std::string& url, cJSON* body,
                  SSEEventCallback on_event,
                  SSEDoneCallback on_done) override;

private:
    // Ensures the SSHttpClient endpoint is registered with the current base URL
    void ensureEndpoint(const std::string& base_url);

    // Parses "http://host:port/path?query" → (base, path)
    static bool splitUrl(const std::string& url, std::string& base, std::string& path);

    std::string endpoint_name_;
    std::string current_base_url_;
    std::string token_;
    int timeout_ms_;
};

// ---------------------------------------------------------------------------
// DiscoveryEsp — wraps ScreenSchema's SSMdns::query()
// ---------------------------------------------------------------------------

class DiscoveryEsp : public dirigible::IDiscovery {
public:
    void query(const std::string& service_type,
               const std::string& proto,
               uint32_t timeout_ms,
               std::function<void(std::vector<dirigible::DiscoveryResult>)> cb) override;
};

// ---------------------------------------------------------------------------
// TransportFactoryEsp — produces WebSocketEsp / HttpClientEsp / DiscoveryEsp
// ---------------------------------------------------------------------------

class TransportFactoryEsp : public dirigible::ITransportFactory {
public:
    dirigible::IWebSocket* createWebSocket(uint32_t reconnect_ms = 5000) override;
    dirigible::IHttpClient* createHttpClient(int timeout_ms = 5000) override;
    dirigible::IDiscovery* createDiscovery() override;
};

}  // namespace dirigible_esp
