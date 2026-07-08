#pragma once

#include "dirigible/config.hpp"
#include <string>
#include <vector>

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// ConfigNvs — reads Dirigible config from NVS flash
//
// NVS layout (namespace "dirigible"):
//
//   Scalar keys:
//     active_machine  (str)  — name of currently active machine
//     mach_count      (u8)   — number of stored machines
//
//   Per-machine keys (i = 0..mach_count-1):
//     m{i}_name       (str)
//     m{i}_host       (str)
//     m{i}_user       (str)   — for SSH (unused on ESP32)
//     m{i}_lee_port   (u16)
//     m{i}_hester_port(u16)
//     m{i}_token      (str)   — cached bearer token
//
//   Free-form key/value:
//     k_<key>         (str/i32/bool)  — generic config keys
// ---------------------------------------------------------------------------

class ConfigNvs : public dirigible::IConfig {
public:
    ConfigNvs() = default;

    // Load all machines from NVS into memory.
    // Returns true on success (even if no machines stored).
    bool load();

    // Add or update a machine in NVS (also updates in-memory cache).
    bool addMachine(const dirigible::MachineConfig& m);

    // Remove a machine by name.
    bool removeMachine(const std::string& name);

    // Cached token accessor (NVS-backed)
    std::string getToken(const std::string& machine_name) const;
    bool setToken(const std::string& machine_name, const std::string& token);

    // IConfig interface
    int machineCount() const override { return static_cast<int>(machines_.size()); }
    dirigible::MachineConfig machineAt(int index) const override;

    std::string getString(const char* key, const char* def = "") const override;
    int getInt(const char* key, int def = 0) const override;
    bool getBool(const char* key, bool def = false) const override;

private:
    std::vector<dirigible::MachineConfig> machines_;
};

}  // namespace dirigible_esp
