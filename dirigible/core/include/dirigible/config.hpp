#pragma once

#include <string>

namespace dirigible {

// Machine definition — loaded from platform config (NVS or YAML)
struct MachineConfig {
    std::string name;
    std::string host;
    std::string user;        // for SSH token fetch (Linux only)
    int ssh_port    = 22;
    int lee_port    = 9001;
    int hester_port = 9000;
};

// Abstract config interface — platform provides implementation
class IConfig {
public:
    virtual ~IConfig() = default;

    virtual int machineCount() const = 0;
    virtual MachineConfig machineAt(int index) const = 0;

    virtual std::string getString(const char* key, const char* def = "") const = 0;
    virtual int getInt(const char* key, int def = 0) const = 0;
    virtual bool getBool(const char* key, bool def = false) const = 0;
};

}  // namespace dirigible
