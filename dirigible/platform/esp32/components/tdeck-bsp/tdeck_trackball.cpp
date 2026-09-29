/*
 * tdeck_trackball.cpp — optical trackball as a scroll wheel, not a pointer.
 *
 * Lifted from screenschema runtime/hal/drivers/input/ss_trackball_gpio.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd).
 *
 * Until September 2026 the ball was an LVGL POINTER (B12) with a visible
 * cursor (B13) and edge-scroll (87a87be), because that is what LILYGO's
 * factory firmware does.  On the device it was the wrong tool: the ball is
 * great at fast scrolling and poor at landing a cursor on a 17 px row
 * (docs/13-Copilot.md §5.2), and touch already does every tap.  So there is
 * no pointer indev and no cursor any more: an LVGL timer polls the five pins
 * and hands quantised detents to the one hook the firmware installs, which
 * turns them into scrolling, list highlight moves, or (in the terminal)
 * arrow keys.
 *
 * Kept from the B series:
 *   detents are one per level transition on a direction pin; how far a
 *        detent moves anything is the consumer's business (B18's step
 *        tunable went with the cursor).
 *   long-press  hold-without-roll fires a deferred callback (via lv_async_call,
 *        so the handler may safely tear down the widget tree) and suppresses
 *        the click that would otherwise follow on release.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "tdeck.ball";

/// Poll cadence.  The optical sensor toggles a pin per detent; 10 ms catches
/// a fast flick without dropping transitions and matches the LVGL loop tick.
static constexpr uint32_t POLL_MS = 10;

static lv_timer_t *s_timer = nullptr;

// Pull-ups → idle high.  Index order matches dir_pins below.
static bool s_last_level[5] = { true, true, true, true, true };

static bool     s_was_pressed  = false;
static bool     s_press_moved  = false;  // rolled while held: not a click, not a long-press
static bool     s_long_fired   = false;
static uint32_t s_press_start  = 0;
static bool     s_first_logged = false;

static tdeck_long_press_cb_t s_long_cb    = nullptr;
static void                 *s_long_user  = nullptr;
static tdeck_ball_hook_t     s_hook       = nullptr;
static void                 *s_hook_user  = nullptr;

void tdeck_bsp_set_long_press_cb(tdeck_long_press_cb_t cb, void *user)
{
    s_long_cb   = cb;
    s_long_user = user;
}

void tdeck_bsp_set_ball_hook(tdeck_ball_hook_t hook, void *user)
{
    s_hook      = hook;
    s_hook_user = user;
}

static void long_press_async(void *)
{
    if (s_long_cb) s_long_cb(s_long_user);
}

/// Press bookkeeping and the hold-without-roll detector.  `moved` is true when
/// the ball turned during this poll, which downgrades the hold to a roll.
static void track_press(bool pressed, bool moved)
{
    if (pressed && !s_was_pressed) {
        s_press_start = lv_tick_get();
        s_press_moved = false;
        s_long_fired  = false;
    }
    if (pressed && moved) s_press_moved = true;
    if (pressed && !s_long_fired && !s_press_moved && s_long_cb &&
        lv_tick_elaps(s_press_start) >= (uint32_t)TDECK_TB_LONG_PRESS_MS) {
        s_long_fired = true;
        // Deferred: the action may delete the widget tree we are called from.
        lv_async_call(long_press_async, nullptr);
    }
}

static void poll_cb(lv_timer_t *)
{
    // Pin order matches LILYGO's reference: right, up, left, down.  Each
    // transition (rising or falling) on a direction pin is one detent; the
    // level itself carries no meaning.
    const int dir_pins[4] = {
        TDECK_TB_PIN_RIGHT, TDECK_TB_PIN_UP, TDECK_TB_PIN_LEFT, TDECK_TB_PIN_DOWN,
    };

    bool moved = false;
    int  det_x = 0;
    int  det_y = 0;
    for (int i = 0; i < 4; i++) {
        bool level = gpio_get_level((gpio_num_t)dir_pins[i]) != 0;
        if (level == s_last_level[i]) continue;
        s_last_level[i] = level;
        moved = true;
        switch (i) {
            case 0: det_x++; break;  // right
            case 1: det_y--; break;  // up
            case 2: det_x--; break;  // left
            case 3: det_y++; break;  // down
        }
    }

    // Click is level-based (active low, pull-up).
    const bool pressed = gpio_get_level((gpio_num_t)TDECK_TB_PIN_CLICK) == 0;

    if (!s_first_logged && (moved || pressed != s_was_pressed)) {
        ESP_LOGI(TAG, "First trackball event — driver alive (d=%d,%d click=%d)",
                 det_x, det_y, pressed);
        s_first_logged = true;
    }

    track_press(pressed, moved);
    // Click on *release*, and only for a plain press: a hold that became the
    // long-press (back) or a roll-while-held must not also activate anything.
    const bool click = !pressed && s_was_pressed && !s_long_fired && !s_press_moved;
    s_was_pressed = pressed;

    if (s_hook && (det_x || det_y || click)) s_hook(det_x, det_y, click, s_hook_user);
}

esp_err_t tdeck_trackball_init(void)
{
    // All five pins are polled inputs with internal pull-ups.  No ISR — this
    // matches LILYGO's UnitTest reference firmware and is robust against the
    // GPIO 0 / BOOT pin sharing.
    const int pins[5] = {
        TDECK_TB_PIN_RIGHT, TDECK_TB_PIN_UP, TDECK_TB_PIN_LEFT,
        TDECK_TB_PIN_DOWN,  TDECK_TB_PIN_CLICK,
    };

    for (int i = 0; i < 5; i++) {
        if (pins[i] < 0) continue;
        gpio_config_t io_cfg = {};
        io_cfg.pin_bit_mask = 1ULL << pins[i];
        io_cfg.mode         = GPIO_MODE_INPUT;
        io_cfg.pull_up_en   = GPIO_PULLUP_ENABLE;
        io_cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
        io_cfg.intr_type    = GPIO_INTR_DISABLE;
        esp_err_t ret = gpio_config(&io_cfg);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "gpio_config failed for pin %d: %s",
                     pins[i], esp_err_to_name(ret));
            return ret;
        }
        // Seed from the real idle level so the first poll doesn't fire a
        // spurious edge.
        s_last_level[i] = gpio_get_level((gpio_num_t)pins[i]) != 0;
    }

    // A plain LVGL timer rather than an indev: the hook runs on the LVGL task
    // (so it may touch widgets) and nothing in LVGL treats the ball as a
    // pointer or a keypad.
    s_timer = lv_timer_create(poll_cb, POLL_MS, nullptr);
    if (!s_timer) {
        ESP_LOGE(TAG, "lv_timer_create returned NULL");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Trackball ready as scroll wheel (U=%d D=%d L=%d R=%d C=%d)",
             TDECK_TB_PIN_UP, TDECK_TB_PIN_DOWN, TDECK_TB_PIN_LEFT,
             TDECK_TB_PIN_RIGHT, TDECK_TB_PIN_CLICK);
    return ESP_OK;
}
