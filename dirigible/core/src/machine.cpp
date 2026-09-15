#include "dirigible/machine.hpp"
#include "dirigible/state.hpp"

namespace dirigible {

MachineManager::MachineManager(ITransportFactory* factory)
    : factory_(factory) {}

MachineManager::~MachineManager() {
    for (auto& m : machines_) {
        delete m.connection;
        delete m.health_http;
    }
}

void MachineManager::loadFromConfig(IConfig* config) {
    for (auto& m : machines_) {
        delete m.connection;
        delete m.health_http;
    }
    machines_.clear();
    active_name_.clear();   // the old pointer set is gone
    for (int i = 0; i < config->machineCount(); i++) {
        Machine m;
        m.config = config->machineAt(i);
        machines_.push_back(std::move(m));
    }
}

void MachineManager::pingAll() {
    for (auto& m : machines_) {
        if (m.health_in_flight) continue;   // don't stack pings on a dead host

        if (!m.health_http) {
            m.health_http = factory_->createHttpClient(3000);
        }
        if (!m.token.empty()) {
            m.health_http->setAuthToken(m.token);
        }

        std::string url = "http://" + m.config.host + ":"
                        + std::to_string(m.config.lee_port) + "/health";

        std::string name = m.config.name;
        m.health_in_flight = true;
        m.health_http->get(url, [this, name](int status, cJSON*) {
            Machine* mach = findByName(name);
            if (!mach) return;
            mach->health_in_flight = false;

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

            // If it just came online with no token, try to fetch one.
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
        });
    }
}

void MachineManager::setActive(const std::string& name) {
    // Idempotent, not early-returning on an unchanged name: after
    // loadFromConfig() the machine list is rebuilt, so "same name" can still
    // mean "no connection yet".
    const bool changed = (active_name_ != name);
    active_name_ = name;

    Machine* m = findByName(name);
    if (m && !m->connection) {
        m->connection = new LeeConnection(factory_, m->config.host, m->config.lee_port);
        if (!m->token.empty()) {
            m->connection->setToken(m->token);
        }
    }

    if (changed) EventBus::instance().emit(Event::MachineSwitched);
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
