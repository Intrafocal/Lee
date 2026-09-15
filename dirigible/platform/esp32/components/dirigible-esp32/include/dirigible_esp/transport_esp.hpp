#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "dirigible/transport.hpp"
#include "dirigible_esp/dispatch.hpp"

struct esp_websocket_client;
typedef struct esp_websocket_client *esp_websocket_client_handle_t;

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// WebSocketEsp — dirigible::IWebSocket on esp_websocket_client.
//
// Each instance owns its client handle outright (screenschema's SSWebSocket
// kept them in a named global registry that outlived the wrapper, which is
// what made its teardown path so delicate).  Events arrive on the websocket
// task and are posted to the instance's Dispatcher, so every callback the core
// sees runs on the LVGL task.
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
    static void event_handler(void* arg, const char* base, int32_t id, void* data);
    void teardown();

    esp_websocket_client_handle_t client_ = nullptr;
    std::string url_;
    uint32_t    reconnect_ms_;
    volatile bool connected_ = false;

    std::string frame_buf_;   // reassembles fragmented frames (ws task only)
    Dispatcher  dispatch_;

    std::vector<std::function<void(cJSON*)>>                message_cbs_;
    std::vector<std::function<void(const uint8_t*, size_t)>> binary_cbs_;
    std::vector<std::function<void()>>                      connect_cbs_;
    std::vector<std::function<void()>>                      disconnect_cbs_;
};

// ---------------------------------------------------------------------------
// HttpClientEsp — dirigible::IHttpClient on esp_http_client.
//
// One short-lived FreeRTOS task per request (plain GET/POST), one long-lived
// task per SSE stream.  Response JSON handed to the callback is owned by this
// class and freed as soon as the callback returns, matching the IHttpClient
// contract ("resp is non-owning").
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
    struct Request;
    struct SSERequest;

    static void request_task(void* arg);
    static void sse_task(void* arg);

    std::string token_;
    int         timeout_ms_;
    Dispatcher  dispatch_;
};

// ---------------------------------------------------------------------------
// DiscoveryEsp — dirigible::IDiscovery on the ESP-IDF mdns component.
// ---------------------------------------------------------------------------

class DiscoveryEsp : public dirigible::IDiscovery {
public:
    void query(const std::string& service_type,
               const std::string& proto,
               uint32_t timeout_ms,
               std::function<void(std::vector<dirigible::DiscoveryResult>)> cb) override;
};

// ---------------------------------------------------------------------------
// TransportFactoryEsp
// ---------------------------------------------------------------------------

class TransportFactoryEsp : public dirigible::ITransportFactory {
public:
    dirigible::IWebSocket*  createWebSocket(uint32_t reconnect_ms = 5000) override;
    dirigible::IHttpClient* createHttpClient(int timeout_ms = 5000) override;
    dirigible::IDiscovery*  createDiscovery() override;
};

}  // namespace dirigible_esp
