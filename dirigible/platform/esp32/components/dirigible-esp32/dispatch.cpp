#include "dirigible_esp/dispatch.hpp"

#include <algorithm>

#include "esp_log.h"
#include "lvgl.h"

static const char *TAG = "dirigible.disp";

namespace dirigible_esp {

namespace {

// Every live Dispatcher, guarded by its own mutex.  The registry is only
// touched from constructors/destructors (LVGL task) and the pump (LVGL task),
// but a mutex costs nothing here and keeps it honest.
SemaphoreHandle_t       g_reg_mutex = nullptr;
std::vector<Dispatcher*> g_registry;
lv_timer_t              *g_pump_timer = nullptr;

void ensure_registry()
{
    if (!g_reg_mutex) g_reg_mutex = xSemaphoreCreateMutex();
}

void pump_cb(lv_timer_t *)
{
    std::vector<Dispatcher*> snapshot;
    if (g_reg_mutex && xSemaphoreTake(g_reg_mutex, 0) == pdTRUE) {
        snapshot = g_registry;
        xSemaphoreGive(g_reg_mutex);
    }
    for (auto *d : snapshot) d->pump();
}

}  // namespace

Dispatcher::Dispatcher()
{
    mutex_ = xSemaphoreCreateMutex();
    ensure_registry();
    if (g_reg_mutex && xSemaphoreTake(g_reg_mutex, portMAX_DELAY) == pdTRUE) {
        g_registry.push_back(this);
        xSemaphoreGive(g_reg_mutex);
    }
}

Dispatcher::~Dispatcher()
{
    if (g_reg_mutex && xSemaphoreTake(g_reg_mutex, portMAX_DELAY) == pdTRUE) {
        g_registry.erase(std::remove(g_registry.begin(), g_registry.end(), this),
                         g_registry.end());
        xSemaphoreGive(g_reg_mutex);
    }
    drain();
    if (mutex_) vSemaphoreDelete(mutex_);
    mutex_ = nullptr;
}

void Dispatcher::post(std::function<void()> fn)
{
    if (!mutex_) return;
    if (xSemaphoreTake(mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
        queue_.push_back(std::move(fn));
        xSemaphoreGive(mutex_);
    } else {
        ESP_LOGW(TAG, "post: mutex timeout, callback dropped");
    }
}

void Dispatcher::drain()
{
    if (!mutex_) { queue_.clear(); return; }
    if (xSemaphoreTake(mutex_, pdMS_TO_TICKS(50)) == pdTRUE) {
        queue_.clear();
        xSemaphoreGive(mutex_);
    } else {
        ESP_LOGW(TAG, "drain: mutex timeout");
    }
}

void Dispatcher::pump()
{
    std::vector<std::function<void()>> to_run;
    if (mutex_ && xSemaphoreTake(mutex_, 0) == pdTRUE) {
        to_run = std::move(queue_);
        queue_.clear();
        xSemaphoreGive(mutex_);
    }
    for (auto &fn : to_run) fn();
}

void dispatch_start_pump()
{
    ensure_registry();
    if (!g_pump_timer) g_pump_timer = lv_timer_create(pump_cb, 20, nullptr);
}

}  // namespace dirigible_esp
