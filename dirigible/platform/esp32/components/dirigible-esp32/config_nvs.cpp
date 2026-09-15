#include "dirigible_esp/config_nvs.hpp"

#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"

#include <cstdio>
#include <cstring>

static const char* TAG = "dirigible-nvs";
static const char* NS  = "dirigible";

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// NVS helpers
// ---------------------------------------------------------------------------

static esp_err_t openHandle(nvs_open_mode_t mode, nvs_handle_t* out) {
    return nvs_open(NS, mode, out);
}

// Read a string key into std::string. Returns empty if not found.
static std::string readString(nvs_handle_t h, const char* key) {
    size_t required = 0;
    if (nvs_get_str(h, key, nullptr, &required) != ESP_OK || required == 0) {
        return "";
    }
    std::string out(required, '\0');
    if (nvs_get_str(h, key, out.data(), &required) != ESP_OK) {
        return "";
    }
    if (!out.empty() && out.back() == '\0') {
        out.pop_back();  // strip trailing null
    }
    return out;
}

static uint16_t readU16(nvs_handle_t h, const char* key, uint16_t def) {
    uint16_t v = def;
    nvs_get_u16(h, key, &v);
    return v;
}

static uint8_t readU8(nvs_handle_t h, const char* key, uint8_t def) {
    uint8_t v = def;
    nvs_get_u8(h, key, &v);
    return v;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

bool ConfigNvs::load() {
    machines_.clear();

    nvs_handle_t h;
    esp_err_t err = openHandle(NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "No dirigible namespace yet — empty config");
        return true;
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "nvs_open failed: %s", esp_err_to_name(err));
        return false;
    }

    uint8_t count = readU8(h, "mach_count", 0);
    ESP_LOGI(TAG, "Loading %u machines from NVS", count);

    char key[24];
    for (uint8_t i = 0; i < count; i++) {
        dirigible::MachineConfig m;

        snprintf(key, sizeof(key), "m%u_name", i);
        m.name = readString(h, key);
        if (m.name.empty()) continue;  // skip invalid entries

        snprintf(key, sizeof(key), "m%u_host", i);
        m.host = readString(h, key);

        snprintf(key, sizeof(key), "m%u_user", i);
        m.user = readString(h, key);

        snprintf(key, sizeof(key), "m%u_lee_port", i);
        m.lee_port = readU16(h, key, 9001);

        snprintf(key, sizeof(key), "m%u_hester_port", i);
        m.hester_port = readU16(h, key, 9000);

        m.ssh_port = 22;  // unused on ESP32

        machines_.push_back(std::move(m));
    }

    nvs_close(h);
    return true;
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

bool ConfigNvs::addMachine(const dirigible::MachineConfig& m) {
    nvs_handle_t h;
    if (openHandle(NVS_READWRITE, &h) != ESP_OK) return false;

    // Find existing slot by name, or append
    int idx = -1;
    for (size_t i = 0; i < machines_.size(); i++) {
        if (machines_[i].name == m.name) { idx = static_cast<int>(i); break; }
    }
    if (idx < 0) {
        idx = static_cast<int>(machines_.size());
        machines_.push_back(m);
    } else {
        machines_[idx] = m;
    }

    char key[24];
    snprintf(key, sizeof(key), "m%d_name", idx);
    nvs_set_str(h, key, m.name.c_str());
    snprintf(key, sizeof(key), "m%d_host", idx);
    nvs_set_str(h, key, m.host.c_str());
    snprintf(key, sizeof(key), "m%d_user", idx);
    nvs_set_str(h, key, m.user.c_str());
    snprintf(key, sizeof(key), "m%d_lee_port", idx);
    nvs_set_u16(h, key, static_cast<uint16_t>(m.lee_port));
    snprintf(key, sizeof(key), "m%d_hester_port", idx);
    nvs_set_u16(h, key, static_cast<uint16_t>(m.hester_port));

    nvs_set_u8(h, "mach_count", static_cast<uint8_t>(machines_.size()));
    nvs_commit(h);
    nvs_close(h);
    return true;
}

bool ConfigNvs::removeMachine(const std::string& name) {
    int idx = -1;
    for (size_t i = 0; i < machines_.size(); i++) {
        if (machines_[i].name == name) { idx = static_cast<int>(i); break; }
    }
    if (idx < 0) return false;

    machines_.erase(machines_.begin() + idx);

    // Rewrite the entire machine list (simpler than gap management)
    nvs_handle_t h;
    if (openHandle(NVS_READWRITE, &h) != ESP_OK) return false;

    nvs_set_u8(h, "mach_count", static_cast<uint8_t>(machines_.size()));
    char key[24];
    for (size_t i = 0; i < machines_.size(); i++) {
        const auto& m = machines_[i];
        snprintf(key, sizeof(key), "m%zu_name", i);          nvs_set_str(h, key, m.name.c_str());
        snprintf(key, sizeof(key), "m%zu_host", i);          nvs_set_str(h, key, m.host.c_str());
        snprintf(key, sizeof(key), "m%zu_user", i);          nvs_set_str(h, key, m.user.c_str());
        snprintf(key, sizeof(key), "m%zu_lee_port", i);      nvs_set_u16(h, key, static_cast<uint16_t>(m.lee_port));
        snprintf(key, sizeof(key), "m%zu_hester_port", i);   nvs_set_u16(h, key, static_cast<uint16_t>(m.hester_port));
    }

    nvs_commit(h);
    nvs_close(h);
    return true;
}

// ---------------------------------------------------------------------------
// Token storage (separate keys, not bound to machine index)
// ---------------------------------------------------------------------------

std::string ConfigNvs::getToken(const std::string& machine_name) const {
    nvs_handle_t h;
    if (openHandle(NVS_READONLY, &h) != ESP_OK) return "";
    std::string key = "tok_" + machine_name;
    if (key.size() > 15) key = key.substr(0, 15);  // NVS key limit
    std::string token = readString(h, key.c_str());
    nvs_close(h);
    return token;
}

bool ConfigNvs::setToken(const std::string& machine_name, const std::string& token) {
    nvs_handle_t h;
    if (openHandle(NVS_READWRITE, &h) != ESP_OK) return false;
    std::string key = "tok_" + machine_name;
    if (key.size() > 15) key = key.substr(0, 15);
    esp_err_t err = nvs_set_str(h, key.c_str(), token.c_str());
    if (err == ESP_OK) nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK;
}

// ---------------------------------------------------------------------------
// IConfig interface
// ---------------------------------------------------------------------------

dirigible::MachineConfig ConfigNvs::machineAt(int index) const {
    if (index < 0 || index >= static_cast<int>(machines_.size())) {
        return dirigible::MachineConfig{};
    }
    return machines_[index];
}

std::string ConfigNvs::getString(const char* key, const char* def) const {
    nvs_handle_t h;
    if (openHandle(NVS_READONLY, &h) != ESP_OK) return def;

    char nvs_key[16];
    snprintf(nvs_key, sizeof(nvs_key), "k_%s", key);
    std::string value = readString(h, nvs_key);
    nvs_close(h);
    return value.empty() ? std::string(def) : value;
}

int ConfigNvs::getInt(const char* key, int def) const {
    nvs_handle_t h;
    if (openHandle(NVS_READONLY, &h) != ESP_OK) return def;

    char nvs_key[16];
    snprintf(nvs_key, sizeof(nvs_key), "k_%s", key);
    int32_t v = def;
    nvs_get_i32(h, nvs_key, &v);
    nvs_close(h);
    return v;
}

bool ConfigNvs::getBool(const char* key, bool def) const {
    nvs_handle_t h;
    if (openHandle(NVS_READONLY, &h) != ESP_OK) return def;

    char nvs_key[16];
    snprintf(nvs_key, sizeof(nvs_key), "k_%s", key);
    uint8_t v = def ? 1 : 0;
    nvs_get_u8(h, nvs_key, &v);
    nvs_close(h);
    return v != 0;
}

}  // namespace dirigible_esp
