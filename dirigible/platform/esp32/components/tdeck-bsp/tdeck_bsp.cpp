/*
 * tdeck_bsp.cpp — board bring-up order and the LVGL loop.
 *
 * The sequence below is the one screenschema's generated main.cpp used
 * (cli/templates/main_cpp.j2 @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd) with
 * the brookesia shell, the widget factory and the YAML-driven configuration
 * removed.  The ordering constraints it encodes are load-bearing:
 *
 *   1. the power gate (GPIO 10) must go HIGH before ANY peripheral answers,
 *      and the keypad MCU / GT911 need ~500 ms after it;
 *   2. lv_init() must run before any driver registers a display or indev;
 *   3. touch installs the I2C bus, and the keyboard must reuse it rather than
 *      reconfigure it (B4/B5) — here both go through tdeck_i2c_ensure();
 *   4. the trackball's cursor object needs a screen to live on, so it comes
 *      after the display.
 *
 * CONFIG_ESP_MAIN_TASK_STACK_SIZE is raised to 16384 in sdkconfig.defaults
 * (B7): the IDF default of 3840 overflows once the app builds non-trivial
 * state on the main task.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "tdeck.bsp";

static SemaphoreHandle_t s_lvgl_mux = nullptr;

bool tdeck_bsp_lvgl_lock(uint32_t timeout_ms)
{
    if (!s_lvgl_mux) return true;  // pre-init: single threaded
    TickType_t ticks = (timeout_ms == 0) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTakeRecursive(s_lvgl_mux, ticks) == pdTRUE;
}

void tdeck_bsp_lvgl_unlock(void)
{
    if (s_lvgl_mux) xSemaphoreGiveRecursive(s_lvgl_mux);
}

static void power_on(void)
{
    gpio_set_direction((gpio_num_t)TDECK_PIN_POWER_ON, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)TDECK_PIN_POWER_ON, 1);
    gpio_set_direction((gpio_num_t)TDECK_PIN_LORA_CS, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)TDECK_PIN_LORA_CS, 0);
    // Allow the power rails AND the gated I2C peripherals to come up.
    vTaskDelay(pdMS_TO_TICKS(TDECK_POWER_SETTLE_MS));
}

esp_err_t tdeck_bsp_init(void)
{
    ESP_LOGI(TAG, "T-Deck bring-up");

    power_on();

    s_lvgl_mux = xSemaphoreCreateRecursiveMutex();
    if (!s_lvgl_mux) return ESP_ERR_NO_MEM;

    lv_init();

    esp_err_t ret = tdeck_display_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "display init failed — nothing else is worth doing");
        return ret;
    }

    if (tdeck_touch_init() != ESP_OK) {
        ESP_LOGE(TAG, "touch init failed — continuing without touch");
    }
    if (tdeck_keyboard_init() != ESP_OK) {
        ESP_LOGE(TAG, "keyboard init failed — continuing without keyboard");
    }
    if (tdeck_trackball_init() != ESP_OK) {
        ESP_LOGE(TAG, "trackball init failed — continuing without trackball");
    }
    if (tdeck_battery_init() != ESP_OK) {
        ESP_LOGW(TAG, "battery init failed — percentage will read 0");
    }

    ESP_LOGI(TAG, "T-Deck ready");
    return ESP_OK;
}

void tdeck_bsp_lvgl_run(void)
{
    // Same shape as the firmware that booted in July 2026: a 10 ms tick loop
    // on the main task.  LV_TICK_CUSTOM stays off, so lv_tick_inc() is ours.
    while (true) {
        lv_tick_inc(10);
        if (tdeck_bsp_lvgl_lock(100)) {
            lv_timer_handler();
            tdeck_bsp_lvgl_unlock();
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
