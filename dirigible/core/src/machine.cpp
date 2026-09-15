#include "dirigible/machine.hpp"
#include "dirigible/state.hpp"

namespace dirigible {

MachineManager::MachineManager(ITransportFactory* factory)
    : factory_(factory) {}

MachineManager::~MachineManager() {
    for (auto& m : machines_) {
        delete m.connection;
    }
}

void MachineManager::loadFromConfig(IConfig* config) {
    machines_.clear();
    for (int i = 0; i < config->machineCount(); i++) {
        Machine m;
        m.config = config->machineAt(i);
        machines_.push_back(std::move(m));
    }
}

void MachineManager::pingAll() {
    for (auto& m : machines_) {
        // Create a temporary HTTP client for health check
        auto* http = factory_->createHttpClient(3000);

        // If we have a token, set it (health check is optional auth)
        if (!m.token.empty()) {
            http->setAuthToken(m.token);
        }

        std::string url = "http://" + m.config.host + ":"
                        + std::to_string(m.config.lee_port) + "/health";

        std::string name = m.config.name;
        http->get(url, [this, name, http](int status, cJSON*) {
            Machine* mach = findByName(name);
            if (!mach) { delete http; return; }

            bool was_online = mach->online;
            mach->online = (status >= 200 && status < 300);

            if (mach->online != was_online) {
                Event evt = mach->online ? Event::MachineOnline
                                         : Event::MachineOffline;
                EventBus::instance().emit(evt);

                if (on_status_changed_) {
                    on_status_changed_(name.c_str(), mach->online);
                }
            }

            // If just came online and has no token, try to fetch one
            if (mach->online && mach->token.empty() && token_fetcher_) {
                token_fetcher_(mach->config, [this, name](const std::string& token) {
                    Machine* m2 = findByName(name);
                    if (m2 && !token.empty()) {
                        m2->token = token;
                        if (m2->connection) {
                            m2->connection->setToken(token);
                        }
                    }
                });
            }

            delete http;
        });
    }
}

void MachineManager::setActive(const std::string& name) {
    if (active_name_ == name) return;
    active_name_ = name;

    // Ensure connection exists for active machine
    Machine* m = findByName(name);
    if (m && !m->connection) {
        m->connection = new LeeConnection(factory_, m->config.host, m->config.lee_port);
        if (!m->token.empty()) {
            m->connection->setToken(m->token);
        }
    }

    EventBus::instance().emit(Event::MachineSwitched);
}

Machine* MachineManager::activeMachine() {
    return findByName(active_name_);
}

LeeConnection* MachineManager::activeConnection() {
    Machine* m = activeMachine();
    return m ? m->connection : nullptr;
}

Machine* MachineManager::machineAt(int index) {
    if (index < 0 || index >= static_cast<int>(machines_.size())) return nullptr;
    return &machines_[index];
}

Machine* MachineManager::findByName(const std::string& name) {
    for (auto& m : machines_) {
        if (m.config.name == name) return &m;
    }
    return nullptr;
}

void MachineManager::onStatusChanged(StatusCallback cb) {
    on_status_changed_ = std::move(cb);
}

void MachineManager::setTokenFetcher(TokenFetcher fetcher) {
    token_fetcher_ = std::move(fetcher);
}

void MachineManager::refreshToken(const std::string& machine_name,
                                   std::function<void(const std::string& token)> cb) {
    Machine* m = findByName(machine_name);
    if (!m) { if (cb) cb(""); return; }

    // Clear cached token
    m->token.clear();

    if (token_fetcher_) {
        token_fetcher_(m->config, [this, machine_name, cb](const std::string& token) {
            Machine* m2 = findByName(machine_name);
            if (m2) {
                m2->token = token;
                if (m2->connection) {
                    m2->connection->setToken(token);
                }
            }
            if (cb) cb(token);
        });
    } else {
        if (cb) cb("");
    }
}

}  // namespace dirigible
