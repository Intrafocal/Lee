#pragma once

#include "dirigible/models.hpp"
#include "dirigible/transport.hpp"
#include <cstdint>
#include <functional>
#include <string>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// LeeConnection — WebSocket context stream + HTTP command client
//
// One instance per machine. Handles:
//   - WS to /context/stream?token= (real-time LeeContext updates)
//   - HTTP POST to /command with Bearer token
//   - Exponential backoff reconnect (5s → 60s)
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

    // Commands — domain/action/params matching Lee's POST /command
    void sendCommand(const char* domain, const char* action,
                     cJSON* params = nullptr,
                     std::function<void(bool success)> cb = nullptr);

    // Convenience commands
    void focusTab(int tab_id);
    void closeTab(int tab_id);
    void openFile(const char* path);
    void saveFile();
    void spawnTui(const char* type, const char* cwd = nullptr);

    // Health check
    void healthCheck(std::function<void(bool online)> cb);

    // Reconnect control
    void scheduleReconnect();

private:
    void onWsMessage(cJSON* msg);
    void onWsConnected();
    void onWsDisconnected();

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

    // Reconnect state
    static constexpr double RECONNECT_DELAY_INIT = 5.0;
    static constexpr double RECONNECT_DELAY_MAX  = 60.0;
    double reconnect_delay_ = RECONNECT_DELAY_INIT;
};

}  // namespace dirigible
