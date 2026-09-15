#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

#include "esp_err.h"

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// WifiEsp — station-mode WiFi with NVS-cached credentials.
//
// Lifted from screenschema's SSWifiManager (Intrafocal/screenschema
// @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd) minus the transport abstraction
// (the T-Deck's S3 has native WiFi; there is no SPI coprocessor to support)
// and minus the brookesia status-bar coupling.
//
// Credentials live in NVS namespace "ss_wifi", keys "ssid"/"password" — the
// same layout dirigible-provision writes, so already-provisioned devices keep
// working.
//
// All callbacks fire on the LVGL task.
// ---------------------------------------------------------------------------

class WifiEsp {
public:
    struct AP {
        std::string ssid;
        int8_t      rssi    = 0;
        bool        secured = false;
    };

    static WifiEsp& instance();

    /// netif + event loop + esp_wifi in STA mode.  Idempotent.
    esp_err_t init();

    void scan(std::function<void(std::vector<AP>)> on_done);
    void connect(const std::string& ssid, const std::string& password,
                 std::function<void(bool)> on_done);
    void disconnect();

    void saveCredentials(const std::string& ssid, const std::string& password);
    std::pair<std::string, std::string> loadCredentials();

    /// Connect using saved credentials, if there are any.  Returns false when
    /// nothing is stored (the caller should then show the pairing screen).
    bool autoConnect();

    bool        isConnected()   const { return connected_; }
    std::string connectedSSID() const { return connected_ssid_; }
    std::string ipAddress()     const { return ip_address_; }

    void onStateChanged(std::function<void(bool connected, int8_t rssi)> cb);

private:
    WifiEsp() = default;
    static void event_handler(void* arg, const char* base, int32_t id, void* data);

    bool        initialized_ = false;
    bool        connected_   = false;
    std::string connected_ssid_;
    std::string ip_address_;

    std::function<void(bool)>            connect_cb_;
    std::function<void(std::vector<AP>)> scan_cb_;
    std::function<void(bool, int8_t)>    state_cb_;
};

}  // namespace dirigible_esp
