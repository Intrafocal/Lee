#pragma once

#include <functional>
#include <vector>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace dirigible_esp {

// ---------------------------------------------------------------------------
// LVGL-task dispatch.
//
// esp_websocket_client, esp_http_client and the WiFi/mDNS event loops all run
// on their own FreeRTOS tasks, while every Dirigible callback ends up touching
// LVGL widgets.  Anything crossing that boundary is posted to a Dispatcher and
// drained on the LVGL task, so callbacks always run where LVGL expects.
//
// This is the `post_fn` / `pump_pending` pattern from screenschema's
// SSWebSocket / SSHttpClient / SSWifiManager (Intrafocal/screenschema
// @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd), factored into one class.
//
// Each owner keeps its own Dispatcher so that drain() only discards that
// owner's pending work — a dead socket must not throw away another's queued
// callbacks.  A single LVGL timer pumps every live Dispatcher.
// ---------------------------------------------------------------------------

class Dispatcher {
public:
    Dispatcher();
    ~Dispatcher();

    Dispatcher(const Dispatcher&) = delete;
    Dispatcher& operator=(const Dispatcher&) = delete;

    /// Queue `fn` to run on the LVGL task.  Safe from any task.
    void post(std::function<void()> fn);

    /// Discard everything queued but not yet run, so a stale closure can't
    /// fire against state that has since been torn down.
    void drain();

    /// Run everything queued.  Called by the shared pump timer.
    void pump();

private:
    SemaphoreHandle_t                  mutex_ = nullptr;
    std::vector<std::function<void()>> queue_;
};

/// Create the shared 20 ms pump timer.  Call once from the LVGL task, after
/// tdeck_bsp_init() and before any transport is constructed.
void dispatch_start_pump();

}  // namespace dirigible_esp
