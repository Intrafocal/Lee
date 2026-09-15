#pragma once

#include "dirigible/config.hpp"
#include "dirigible/lee_client.hpp"
#include "dirigible/transport.hpp"
#include <functional>
#include <string>
#include <vector>

namespace dirigible {

// ---------------------------------------------------------------------------
// Machine — runtime state for a configured Lee instance
// ---------------------------------------------------------------------------

struct Machine {
    MachineConfig config;
    bool online         = false;
    std::string token;             // cached bearer token
    LeeConnection* connection = nullptr;  // created on demand
};

// ---------------------------------------------------------------------------
// MachineManager — multi-machine lifecycle
//
// Loads machines from IConfig, pings health every 15s, tracks online/offline,
// manages the active machine and its LeeConnection.
// ---------------------------------------------------------------------------

class MachineManager {
public:
    using StatusCallback = std::function<void(const char* name, bool online)>;
    using TokenFetcher = std::function<void(const MachineConfig& m,
                                            std::function<void(const std::string& token)> cb)>;

    explicit MachineManager(ITransportFactory* factory);
    ~MachineManager();

    // Load machines from config
    void loadFromConfig(IConfig* config);

    // Health pinging — call from a periodic timer
    void pingAll();

    // Active machine
    void setActive(const std::string& name);
    Machine* activeMachine();
    LeeConnection* activeConnection();

    // Lookup
    int machineCount() const { return static_cast<int>(machines_.size()); }
    Machine* machineAt(int index);
    Machine* findByName(const std::string& name);

    // Callbacks
    void onStatusChanged(StatusCallback cb);

    // Token fetcher — platform provides (SSH on Linux, manual on ESP32)
    void setTokenFetcher(TokenFetcher fetcher);

    // Called by LeeConnection on 401 — clears cached token, re-fetches
    void refreshToken(const std::string& machine_name,
                      std::function<void(const std::string& token)> cb);

private:
    ITransportFactory* factory_;
    std::vector<Machine> machines_;
    std::string active_name_;
    StatusCallback on_status_changed_;
    TokenFetcher token_fetcher_;
};

}  // namespace dirigible
