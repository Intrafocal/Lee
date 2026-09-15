/*
 * tdeck_keyboard.cpp — BlackBerry keyboard (I2C keypad MCU) as an LVGL keypad.
 *
 * Lifted from screenschema runtime/hal/drivers/input/ss_keyboard_i2c.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * with the SSKeyboardI2C class dropped, the bus install delegated to
 * tdeck_i2c.cpp (B4/B5), and SSInput replaced by a single C hook.
 *
 * Modifier state: the stock LILYGO keypad firmware returns one already-
 * resolved ASCII byte per key event.  Sym/Alt/Shift are applied inside the
 * keypad MCU and are NOT reported separately, so Sym+key chords cannot be
 * distinguished here — Sym+X simply arrives as the symbol X produces.  Any
 * Sym-based shortcut layer would need custom keypad firmware.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/i2c.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "tdeck.kbd";

static lv_indev_drv_t s_indev_drv;
static lv_indev_t    *s_indev = nullptr;

static uint8_t s_last_key     = 0;
static bool    s_key_pressed  = false;
static bool    s_first_logged = false;

static tdeck_key_hook_t s_hook      = nullptr;
static void            *s_hook_user = nullptr;

void tdeck_bsp_set_key_hook(tdeck_key_hook_t hook, void *user)
{
    s_hook      = hook;
    s_hook_user = user;
}

static uint32_t map_to_lv_key(uint8_t ascii)
{
    switch (ascii) {
        case 0x08: return LV_KEY_BACKSPACE;
        case 0x7F: return LV_KEY_BACKSPACE;  // DEL
        case 0x0D: return LV_KEY_ENTER;
        case 0x0A: return LV_KEY_ENTER;
        case 0x1B: return LV_KEY_ESC;
        case 0x09: return LV_KEY_NEXT;       // Tab
        default:   return ascii;             // printable characters pass through
    }
}

static uint8_t read_key(void)
{
    uint8_t key = 0;
    esp_err_t ret = i2c_master_read_from_device(TDECK_I2C_PORT, TDECK_KBD_I2C_ADDR,
                                                &key, 1, pdMS_TO_TICKS(10));
    return (ret == ESP_OK) ? key : 0;
}

static void read_cb(lv_indev_drv_t *, lv_indev_data_t *data)
{
    uint8_t raw = read_key();

    // One-shot log on the first detected key — confirms I2C reads work and
    // the keyboard is wired/responsive, without spamming normal use.
    if (!s_first_logged && raw != 0) {
        ESP_LOGI(TAG, "First keyboard event: 0x%02X", raw);
        s_first_logged = true;
    }

    if (raw != 0) {
        if (s_hook && s_hook(raw, s_hook_user)) {
            // Consumed by the application (terminal mode) — LVGL sees nothing.
            data->state = LV_INDEV_STATE_REL;
            return;
        }
        s_last_key    = raw;
        s_key_pressed = true;
        data->key     = map_to_lv_key(raw);
        data->state   = LV_INDEV_STATE_PR;
    } else if (s_key_pressed) {
        data->key     = map_to_lv_key(s_last_key);
        data->state   = LV_INDEV_STATE_REL;
        s_key_pressed = false;
    } else {
        data->state = LV_INDEV_STATE_REL;
    }
}

esp_err_t tdeck_keyboard_init(void)
{
    esp_err_t ret = tdeck_i2c_ensure();
    if (ret != ESP_OK) return ret;

    // E13: the ESP32-C3 keypad MCU is still coming up when the S3 reaches this
    // point, so a single probe reliably times out on a cold boot even though
    // the keyboard works seconds later.  Retry across ~500 ms before saying
    // anything alarming, and report a late success as INFO rather than a
    // warning nobody can act on.
    const int kProbeAttempts = 5;
    const int kProbeDelayMs  = 100;
    uint8_t probe = 0;
    int attempt = 0;
    for (; attempt < kProbeAttempts; attempt++) {
        if (attempt) vTaskDelay(pdMS_TO_TICKS(kProbeDelayMs));
        ret = i2c_master_read_from_device(TDECK_I2C_PORT, TDECK_KBD_I2C_ADDR,
                                          &probe, 1, pdMS_TO_TICKS(100));
        if (ret == ESP_OK) break;
    }
    if (ret == ESP_OK && attempt > 0) {
        ESP_LOGI(TAG, "Keyboard answered at 0x%02X on attempt %d (%d ms) — "
                      "keypad MCU was still booting",
                 TDECK_KBD_I2C_ADDR, attempt + 1, attempt * kProbeDelayMs);
    } else if (ret != ESP_OK) {
        ESP_LOGW(TAG, "Keyboard not responding at 0x%02X after %d attempts: %s "
                      "— registering anyway",
                 TDECK_KBD_I2C_ADDR, kProbeAttempts, esp_err_to_name(ret));
    }

    lv_indev_drv_init(&s_indev_drv);
    s_indev_drv.type    = LV_INDEV_TYPE_KEYPAD;
    s_indev_drv.read_cb = read_cb;
    s_indev = lv_indev_drv_register(&s_indev_drv);
    if (!s_indev) {
        ESP_LOGE(TAG, "lv_indev_drv_register returned NULL");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Keyboard ready (addr=0x%02X, INT=%d)",
             TDECK_KBD_I2C_ADDR, TDECK_KBD_PIN_INT);
    return ESP_OK;
}

esp_err_t tdeck_bsp_set_keyboard_backlight(uint8_t brightness)
{
#if TDECK_KBD_HAS_BACKLIGHT
    uint8_t cmd[] = { 0x01, brightness };
    return i2c_master_write_to_device(TDECK_I2C_PORT, TDECK_KBD_I2C_ADDR,
                                      cmd, sizeof(cmd), pdMS_TO_TICKS(10));
#else
    (void)brightness;
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

lv_indev_t *tdeck_bsp_keyboard_indev(void) { return s_indev; }
