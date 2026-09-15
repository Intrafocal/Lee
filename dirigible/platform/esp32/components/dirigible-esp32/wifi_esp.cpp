/*
 * wifi_esp.cpp — station-mode WiFi.
 *
 * Lifted from screenschema runtime/core/ss_wifi_manager.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd).
 * The ISSWifiTransport indirection is gone (native only) and the pending-queue
 * plumbing now uses the shared Dispatcher.
 */

#include "dirigible_esp/wifi_esp.hpp"

#include <cstring>

#include "dirigible_esp/dispatch.hpp"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "dirigible.wifi";

namespace dirigible_esp {

namespace {
Dispatcher& wifi_dispatch()
{
    static Dispatcher d;
    return d;
}
}  // namespace

WifiEsp& WifiEsp::instance()
{
    static WifiEsp inst;
    return inst;
}

esp_err_t WifiEsp::init()
{
    if (initialized_) return ESP_OK;

    ESP_ERROR_CHECK(esp_netif_init());

    // Returns ESP_ERR_INVALID_STATE if the default loop already exists — fine.
    esp_err_t loop_err = esp_event_loop_create_default();
    if (loop_err != ESP_OK && loop_err != ESP_ERR_INVALID_STATE) {
        ESP_ERROR_CHECK(loop_err);
    }

    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &WifiEsp::event_handler, this, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &WifiEsp::event_handler, this, nullptr));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());

    initialized_ = true;
    ESP_LOGI(TAG, "WiFi ready (STA)");
    return ESP_OK;
}

void WifiEsp::scan(std::function<void(std::vector<AP>)> on_done)
{
    if (!initialized_) { if (on_done) on_done({}); return; }
    scan_cb_ = std::move(on_done);

    wifi_scan_config_t scan_cfg = {};
    scan_cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, false);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_scan_start failed: %s", esp_err_to_name(err));
        auto cb = std::move(scan_cb_);
        scan_cb_ = nullptr;
        if (cb) cb({});
        return;
    }
    ESP_LOGI(TAG, "scan started");
}

void WifiEsp::connect(const std::string& ssid, const std::string& password,
                      std::function<void(bool)> on_done)
{
    if (!initialized_) { if (on_done) on_done(false); return; }
    connect_cb_ = std::move(on_done);

    wifi_config_t cfg = {};
    strncpy((char*)cfg.sta.ssid,     ssid.c_str(),     sizeof(cfg.sta.ssid)     - 1);
    strncpy((char*)cfg.sta.password, password.c_str(), sizeof(cfg.sta.password) - 1);
    cfg.sta.threshold.authmode = password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;

    esp_wifi_disconnect();
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
    esp_err_t err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_connect failed: %s", esp_err_to_name(err));
        auto cb = std::move(connect_cb_);
        connect_cb_ = nullptr;
        if (cb) cb(false);
        return;
    }
    ESP_LOGI(TAG, "connecting to %s", ssid.c_str());
}

void WifiEsp::disconnect()
{
    if (initialized_) esp_wifi_disconnect();
}

void WifiEsp::onStateChanged(std::function<void(bool, int8_t)> cb)
{
    state_cb_ = std::move(cb);
}

// ---------------------------------------------------------------------------
// NVS credentials — namespace "ss_wifi" (kept for provisioning compatibility)
// ---------------------------------------------------------------------------

void WifiEsp::saveCredentials(const std::string& ssid, const std::string& password)
{
    nvs_handle_t h;
    if (nvs_open("ss_wifi", NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(ss_wifi) failed");
        return;
    }
    nvs_set_str(h, "ssid", ssid.c_str());
    nvs_set_str(h, "password", password.c_str());
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "credentials saved (ssid=%s)", ssid.c_str());
}

std::pair<std::string, std::string> WifiEsp::loadCredentials()
{
    nvs_handle_t h;
    if (nvs_open("ss_wifi", NVS_READONLY, &h) != ESP_OK) return { "", "" };

    char ssid_buf[64] = {};
    char pw_buf[80]   = {};
    size_t ssid_len = sizeof(ssid_buf);
    size_t pw_len   = sizeof(pw_buf);
    nvs_get_str(h, "ssid",     ssid_buf, &ssid_len);
    nvs_get_str(h, "password", pw_buf,   &pw_len);
    nvs_close(h);
    return { std::string(ssid_buf), std::string(pw_buf) };
}

bool WifiEsp::autoConnect()
{
    auto creds = loadCredentials();
    if (creds.first.empty()) {
        ESP_LOGI(TAG, "no saved credentials");
        return false;
    }
    ESP_LOGI(TAG, "auto-connecting to %s", creds.first.c_str());
    connect(creds.first, creds.second, nullptr);
    return true;
}

// ---------------------------------------------------------------------------
// Event handler — runs on the event-loop task; everything user-visible is
// posted to the LVGL task.
// ---------------------------------------------------------------------------

void WifiEsp::event_handler(void* arg, const char* base, int32_t id, void* data)
{
    auto* self = static_cast<WifiEsp*>(arg);

    if (base == WIFI_EVENT && id == WIFI_EVENT_SCAN_DONE) {
        uint16_t count = 0;
        esp_wifi_scan_get_ap_num(&count);
        std::vector<wifi_ap_record_t> records(count);
        if (count) esp_wifi_scan_get_ap_records(&count, records.data());

        std::vector<AP> aps;
        aps.reserve(count);
        for (uint16_t i = 0; i < count; i++) {
            std::string ssid((const char*)records[i].ssid);
            if (ssid.empty()) continue;
            bool dup = false;
            for (auto& a : aps) if (a.ssid == ssid) { dup = true; break; }
            if (dup) continue;   // the same AP shows up once per band/BSSID
            aps.push_back({ ssid, records[i].rssi,
                            records[i].authmode != WIFI_AUTH_OPEN });
        }
        ESP_LOGI(TAG, "scan done: %u APs", (unsigned)aps.size());

        if (self->scan_cb_) {
            auto cb = std::move(self->scan_cb_);
            self->scan_cb_ = nullptr;
            wifi_dispatch().post([cb = std::move(cb), aps = std::move(aps)]() mutable {
                cb(std::move(aps));
            });
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto* event = static_cast<ip_event_got_ip_t*>(data);
        char buf[16];
        esp_ip4addr_ntoa(&event->ip_info.ip, buf, sizeof(buf));
        self->connected_  = true;
        self->ip_address_ = buf;

        int8_t rssi = 0;
        wifi_ap_record_t ap = {};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            self->connected_ssid_ = (const char*)ap.ssid;
            rssi = ap.rssi;
        }
        ESP_LOGI(TAG, "connected: %s  ip=%s", self->connected_ssid_.c_str(), buf);

        if (self->connect_cb_) {
            auto cb = std::move(self->connect_cb_);
            self->connect_cb_ = nullptr;
            wifi_dispatch().post([cb = std::move(cb)]() { cb(true); });
        }
        if (self->state_cb_) {
            auto cb = self->state_cb_;
            wifi_dispatch().post([cb, rssi]() { cb(true, rssi); });
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        auto* event = static_cast<wifi_event_sta_disconnected_t*>(data);
        bool was_connected = self->connected_;
        self->connected_  = false;
        self->ip_address_.clear();
        ESP_LOGW(TAG, "disconnected (reason %d)", event->reason);

        if (!was_connected && self->connect_cb_) {
            // Failed to associate at all — report the failure to the pairing UI.
            auto cb = std::move(self->connect_cb_);
            self->connect_cb_ = nullptr;
            wifi_dispatch().post([cb = std::move(cb)]() { cb(false); });
        } else {
            // Lost an established link: keep retrying in the background.
            esp_wifi_connect();
        }
        if (self->state_cb_) {
            auto cb = self->state_cb_;
            wifi_dispatch().post([cb]() { cb(false, 0); });
        }
    }
}

}  // namespace dirigible_esp
