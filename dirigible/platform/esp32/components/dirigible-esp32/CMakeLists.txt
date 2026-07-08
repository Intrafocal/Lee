# dirigible-esp32 ESP-IDF component
#
# Wraps ScreenSchema's SSWebSocket / SSHttpClient as the dirigible-core
# transport interfaces, plus an NVS-backed config store.
#
# Depends on:
#   - dirigible-core (cross-platform protocol layer)
#   - runtime         (ScreenSchema runtime component, exports SSWebSocket/SSHttpClient)
#   - nvs_flash       (config storage)
#   - json            (cJSON)
#   - lvgl            (lv_timer for connection state polling)

idf_component_register(
    SRCS
        transport_esp.cpp
        config_nvs.cpp
    INCLUDE_DIRS
        include
    REQUIRES
        dirigible-core
        runtime
        nvs_flash
        json
        lvgl
)
