#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// IWebSocket — platform-provided WebSocket client
// ---------------------------------------------------------------------------

class IWebSocket {
public:
    virtual ~IWebSocket() = default;

    virtual void connect(const std::string& url) = 0;
    virtual void disconnect() = 0;
    virtual bool isConnected() const = 0;

    // Send (thread-safe on both ESP32 and Linux)
    virtual void sendText(const std::string& text) = 0;
    virtual void sendJson(cJSON* obj) = 0;  // takes ownership, frees after send
    virtual void sendBinary(const uint8_t* data, size_t len) = 0;

    // Callbacks — fired on the platform's main/UI thread
    virtual void onMessage(std::function<void(cJSON*)> cb) = 0;
    virtual void onBinary(std::function<void(const uint8_t*, size_t)> cb) = 0;
    virtual void onConnect(std::function<void()> cb) = 0;
    virtual void onDisconnect(std::function<void()> cb) = 0;
};

// ---------------------------------------------------------------------------
// IHttpClient — platform-provided async HTTP client
// ---------------------------------------------------------------------------

class IHttpClient {
public:
    virtual ~IHttpClient() = default;

    // Bearer token added to all requests as "Authorization: Bearer <token>"
    virtual void setAuthToken(const std::string& token) = 0;

    // Async GET/POST — callback fires on the platform's main/UI thread
    // resp is non-owning: valid only for the duration of the callback
    virtual void get(const std::string& url,
                     std::function<void(int status, cJSON* resp)> cb) = 0;

    virtual void post(const std::string& url, cJSON* body,
                      std::function<void(int status, cJSON* resp)> cb) = 0;

    // SSE streaming POST — used for Hester ReAct phase events
    //
    // event_cb fires once per SSE event (event name + data string).
    // done_cb fires exactly once when the stream ends (ok=true on clean close).
    // Both callbacks dispatch on the platform's main/UI thread.
    using SSEEventCallback = std::function<void(const std::string& event,
                                                 const std::string& data)>;
    using SSEDoneCallback  = std::function<void(bool ok)>;

    virtual void postSSE(const std::string& url, cJSON* body,
                          SSEEventCallback on_event,
                          SSEDoneCallback on_done) = 0;
};

// ---------------------------------------------------------------------------
// IDiscovery — mDNS service discovery
// ---------------------------------------------------------------------------

struct DiscoveryResult {
    std::string hostname;
    std::string ipv4;
    int port = 0;
    std::map<std::string, std::string> txt;
};

class IDiscovery {
public:
    virtual ~IDiscovery() = default;

    // Async PTR query for a service type. Results delivered on main/UI thread.
    // Example: query("_lee", "_tcp", 3000, cb) finds all Lee instances.
    virtual void query(const std::string& service_type,
                       const std::string& proto,
                       uint32_t timeout_ms,
                       std::function<void(std::vector<DiscoveryResult>)> cb) = 0;
};

// ---------------------------------------------------------------------------
// ITransportFactory — platform provides this to the core
// ---------------------------------------------------------------------------

class ITransportFactory {
public:
    virtual ~ITransportFactory() = default;

    // Caller owns the returned pointer
    virtual IWebSocket* createWebSocket(uint32_t reconnect_ms = 5000) = 0;
    virtual IHttpClient* createHttpClient(int timeout_ms = 5000) = 0;
    virtual IDiscovery* createDiscovery() = 0;
};

// ---------------------------------------------------------------------------
// ITimer — platform-provided periodic timer
// ---------------------------------------------------------------------------

class ITimer {
public:
    virtual ~ITimer() = default;
    virtual void start(uint32_t interval_ms, std::function<void()> cb) = 0;
    virtual void stop() = 0;
};

}  // namespace dirigible
