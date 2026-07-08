// Minimal smoke test for dirigible-core + dirigible-esp32 components.
//
// This is NOT a real Dirigible firmware build — it just verifies that the
// components compile and link as ESP-IDF components, with all headers
// resolvable and all interfaces wired correctly.
//
// A real Dirigible firmware will be generated from screenschema.yaml and
// will use these components via the ScreenSchema-generated project.

#include "dirigible/lee_client.hpp"
#include "dirigible/hester_client.hpp"
#include "dirigible/machine.hpp"
#include "dirigible/state.hpp"
#include "dirigible_esp/transport_esp.hpp"
#include "dirigible_esp/config_nvs.hpp"

#include "esp_log.h"
#include "nvs_flash.h"

extern "C" void app_main(void) {
    // Init NVS (required by config_nvs and ScreenSchema's WiFi)
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    ESP_LOGI("test", "dirigible-core + dirigible-esp32 link test");

    // Construct the platform transport factory
    auto* factory = new dirigible_esp::TransportFactoryEsp();

    // Load machines from NVS
    auto* config = new dirigible_esp::ConfigNvs();
    config->load();
    ESP_LOGI("test", "loaded %d machines from NVS", config->machineCount());

    // Build a MachineManager
    auto* mgr = new dirigible::MachineManager(factory);
    mgr->loadFromConfig(config);

    // Subscribe to events (just to verify EventBus links)
    dirigible::EventBus::instance().on(dirigible::Event::ContextUpdated, []() {
        ESP_LOGI("test", "context updated");
    });

    // If we have at least one machine, set it active and try to connect
    if (mgr->machineCount() > 0) {
        auto* m = mgr->machineAt(0);
        mgr->setActive(m->config.name);
        auto* conn = mgr->activeConnection();
        if (conn) {
            conn->onContextUpdate([](const dirigible::LeeContext* ctx) {
                if (ctx && ctx->workspace) {
                    ESP_LOGI("test", "workspace: %s, %d tabs",
                             ctx->workspace, ctx->tab_count);
                }
            });
            conn->connect();
        }
    }

    // Smoke test the HesterClient construction
    auto* hester = new dirigible::HesterClient(factory, "127.0.0.1", 9000);
    hester->onPhase([](dirigible::HesterPhase phase, const std::string& detail) {
        ESP_LOGI("test", "hester phase: %d (%s)", static_cast<int>(phase), detail.c_str());
    });

    ESP_LOGI("test", "all subsystems wired — entering idle loop");
}
