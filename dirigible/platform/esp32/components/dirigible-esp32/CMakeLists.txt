# dirigible-esp32 — the ESP-IDF half of Dirigible: dirigible-core's transport
# interfaces on esp_websocket_client / esp_http_client / mdns, station-mode
# WiFi, and the NVS-backed config store.
#
# Previously this component wrapped screenschema's SSWebSocket / SSHttpClient /
# SSMdns / SSWifiManager.  The screenschema dependency is gone; the behaviour
# those classes had earned lives on in transport_esp.cpp and wifi_esp.cpp.

idf_component_register(
    SRCS
        "dispatch.cpp"
        "transport_esp.cpp"
        "wifi_esp.cpp"
        "config_nvs.cpp"
    INCLUDE_DIRS
        "include"
    REQUIRES
        dirigible-core
        json
        lvgl
    PRIV_REQUIRES
        nvs_flash
        esp_wifi
        esp_netif
        esp_event
        esp_http_client
        esp_websocket_client
        mdns
        lwip
)
