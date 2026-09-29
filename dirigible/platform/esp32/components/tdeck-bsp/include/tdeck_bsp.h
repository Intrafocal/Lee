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
#include <stddef.h>
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
// The trackball is deliberately NOT an LVGL indev: see tdeck_bsp_set_ball_hook.

/**
 * Raw keyboard interception.  Returning true consumes the byte so LVGL never
 * sees it — this is how terminal mode gets every keystroke.
 * (screenschema called this SSInput; one handler is enough for Dirigible.)
 */
typedef bool (*tdeck_key_hook_t)(uint8_t ascii, void *user);
void tdeck_bsp_set_key_hook(tdeck_key_hook_t hook, void *user);

/**
 * The trackball.  It is not an LVGL pointer or keypad: a timer polls it and
 * reports quantised detents (dx/dy in units of one detent; +x right, +y down)
 * to this hook, on the LVGL task, and the firmware decides what a roll means
 * on each screen (scroll, move a list highlight, arrow keys).  `click` is
 * true once, on release of a plain press — never for a hold that fired the
 * long-press callback or rolled while held.  With no hook the ball is inert.
 */
typedef void (*tdeck_ball_hook_t)(int dx, int dy, bool click, void *user);
void tdeck_bsp_set_ball_hook(tdeck_ball_hook_t hook, void *user);

/** Fired once per hold when the ball is pressed without rolling (B-series). */
typedef void (*tdeck_long_press_cb_t)(void *user);
void tdeck_bsp_set_long_press_cb(tdeck_long_press_cb_t cb, void *user);

// ---------------------------------------------------------------------------
// Microphone (built only with CONFIG_DIRIGIBLE_VOICE; tdeck_audio.cpp)
// ---------------------------------------------------------------------------

/**
 * Power the ES7210 mic ADC and start I2S RX at `sample_rate` Hz, 16-bit.
 * Idempotent while running.  Fails (and leaves everything off) when the codec
 * does not answer on I2C.
 */
esp_err_t tdeck_mic_start(uint32_t sample_rate);

/**
 * Read up to `max_samples` mono 16-bit samples into `dst`, blocking at most
 * `timeout_ms`.  Returns the number read (0 on timeout or when stopped).
 * Call from one task at a time; not from the LVGL task.
 */
size_t tdeck_mic_read(int16_t *dst, size_t max_samples, uint32_t timeout_ms);

/** Stop I2S RX and close the codec.  Safe to call when not started. */
void tdeck_mic_stop(void);

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
