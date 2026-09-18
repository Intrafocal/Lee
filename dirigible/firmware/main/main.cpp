/*
 * main.cpp — Dirigible firmware entry point (LilyGO T-Deck).
 *
 * Plain ESP-IDF + LVGL 8.  No code generation, no YAML, no brookesia: the
 * board comes up through tdeck-bsp, the protocol stack is dirigible-core over
 * dirigible-esp32, and the four screens live in screen_*.cpp.
 */

#include "app.hpp"

#include "dirigible_esp/dispatch.hpp"
#include "dirigible_esp/wifi_esp.hpp"
#include "esp_log.h"
#include "nvs_flash.h"
#include "tdeck_bsp.h"

static const char* TAG = "dirigible";

extern "C" void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    if (tdeck_bsp_init() != ESP_OK) {
        ESP_LOGE(TAG, "board init failed — halting");
        return;
    }

    // The LVGL-task dispatch pump must exist before any transport is built:
    // every network callback lands on it.
    dirigible_esp::dispatch_start_pump();

    // WiFi init — netif, the event loop and esp_wifi — must happen BEFORE the
    // UI exists, because it is what brings lwIP's TCP/IP stack up.  Anything
    // that opens a socket before this point asserts inside lwIP
    // ("tcpip_send_msg_wait_sem ... Invalid mbox") and panics the device into
    // a boot loop.  That is reachable from app_start(): a device with a
    // machine already in NVS dials it on the way up, so the loop only appeared
    // once pairing had succeeded once.  init() only starts the stack; it does
    // not associate, so nothing here waits on a network.
    dirigible_esp::WifiEsp::instance().init();

    dirigible_app::app_start();

    // Associating comes last, so the pairing screen is already on-screen if
    // there are no stored credentials.
    if (!dirigible_esp::WifiEsp::instance().autoConnect()) {
        ESP_LOGI(TAG, "no WiFi credentials — starting pairing");
        dirigible_app::pairing_begin();
    }

    tdeck_bsp_lvgl_run();   // never returns
}
