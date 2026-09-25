/*
 * tdeck_bsp.h — board support package for the LilyGO T-Deck.
 *
 * Lifted from the ScreenSchema runtime HAL and stripped of the SS* class
 * hierarchy and YAML-driven configuration:
 *   source: dirigible/third_party/screenschema/screenschema/runtime/hal/
 *           dirigible/third_party/screenschema/screenschema/runtime/core/ss_battery.*
 *           dirigible/third_party/screenschema/screenschema/cli/templates/main_cpp.j2
 *   commit: 76b6ce9bb16521bd05d08f82b642014f390cf4cd (Intrafocal/screenschema)
 *
 * The hardware fixes that took real T-Deck debugging to find are preserved
 * verbatim and marked with their screenschema issue ids (B4-B18).
 *
 * Threading model (unchanged from the firmware that booted in July 2026):
 * LVGL runs on the main task.  tdeck_bsp_lvgl_run() owns the loop.  Anything
 * touching LVGL from another task must hold tdeck_bsp_lvgl_lock().
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Bring up the whole board, in the order the hardware requires:
 *   power gate → settle → LVGL → SPI display → I2C + GT911 touch →
 *   keyboard → trackball → battery ADC.
 *
 * Individual input devices that fail to appear log an error and are skipped;
 * only a display failure is fatal (returns non-ESP_OK).
 */
esp_err_t tdeck_bsp_init(void);

/** Run the LVGL tick + timer loop forever.  Call last from app_main. */
void tdeck_bsp_lvgl_run(void) __attribute__((noreturn));

/** Recursive LVGL lock.  Held by tdeck_bsp_lvgl_run around lv_timer_handler. */
bool tdeck_bsp_lvgl_lock(uint32_t timeout_ms);
void tdeck_bsp_lvgl_unlock(void);

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

lv_disp_t *tdeck_bsp_display(void);
uint16_t   tdeck_bsp_width(void);
uint16_t   tdeck_bsp_height(void);

/** Panel backlight.  The T-Deck's is a bare GPIO, so this is on/off at 0.5. */
void tdeck_bsp_set_backlight(float level);

/** Keyboard backlight brightness 0-255 (the keypad MCU handles the PWM). */
esp_err_t tdeck_bsp_set_keyboard_backlight(uint8_t brightness);

// ---------------------------------------------------------------------------
// Input devices
// ---------------------------------------------------------------------------

lv_indev_t *tdeck_bsp_touch_indev(void);      // pointer, may be NULL
lv_indev_t *tdeck_bsp_keyboard_indev(void);   // keypad,  may be NULL
lv_indev_t *tdeck_bsp_trackball_indev(void);  // pointer, may be NULL

/**
 * Raw keyboard interception.  Returning true consumes the byte so LVGL never
 * sees it — this is how terminal mode gets every keystroke.
 * (screenschema called this SSInput; one handler is enough for Dirigible.)
 */
typedef bool (*tdeck_key_hook_t)(uint8_t ascii, void *user);
void tdeck_bsp_set_key_hook(tdeck_key_hook_t hook, void *user);

/**
 * Raw trackball interception.  While a delta hook is installed the trackball
 * stops driving the LVGL cursor and reports quantised steps instead
 * (dx/dy in units of one detent), which is what terminal mode maps to arrow
 * keys.  `click` is true once, on release of a plain press — never for a hold
 * that fired the long-press callback or rolled while held.  Pass NULL to
 * return to pointer mode.
 */
typedef void (*tdeck_ball_hook_t)(int dx, int dy, bool click, void *user);
void tdeck_bsp_set_ball_hook(tdeck_ball_hook_t hook, void *user);

/** Fired once per hold when the ball is pressed without rolling (B-series). */
typedef void (*tdeck_long_press_cb_t)(void *user);
void tdeck_bsp_set_long_press_cb(tdeck_long_press_cb_t cb, void *user);

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

typedef struct {
    int     voltage_mv;
    uint8_t percent;  // 0-100
} tdeck_battery_t;

tdeck_battery_t tdeck_bsp_battery_read(void);

#ifdef __cplusplus
}  // extern "C"
#endif
