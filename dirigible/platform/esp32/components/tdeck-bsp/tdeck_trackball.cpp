/*
 * tdeck_trackball.cpp — optical trackball as an LVGL pointer device.
 *
 * Lifted from screenschema runtime/hal/drivers/input/ss_trackball_gpio.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * with the SSTrackballGPIO class removed and a raw-delta hook added for
 * Dirigible's terminal mode.
 *
 * Fixes preserved from the B series:
 *   B12  the ball is an LVGL POINTER, not a keypad.  Each level transition on
 *        a direction pin advances a virtual cursor by step_px.  This is the
 *        input model LILYGO's factory firmware uses, and it means every LVGL
 *        touch UI handles the ball identically to touch, with no group
 *        binding.
 *   B13  a visible cursor object on the top layer, so the pointer is findable.
 *   B18  the step is a tunable (TDECK_TB_STEP_PX).
 *   87a87be  rolling against a screen edge scrolls the scrollable under the
 *        cursor, probing progressively inward past non-scrollable overlays.
 *   long-press  hold-without-roll fires a deferred callback (via lv_async_call,
 *        so the handler may safely tear down the widget tree) and cancels the
 *        in-flight press so no CLICKED event follows on release.
 *
 * Dirigible addition: while a delta hook is installed (terminal mode) the ball
 * stops moving the cursor and reports quantised detents to the hook instead.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/gpio.h"
#include "esp_log.h"

static const char *TAG = "tdeck.ball";

static lv_indev_drv_t s_indev_drv;
static lv_indev_t    *s_indev  = nullptr;
static lv_obj_t      *s_cursor = nullptr;

static int16_t s_cursor_x = TDECK_LCD_WIDTH / 2;
static int16_t s_cursor_y = TDECK_LCD_HEIGHT / 2;

// Pull-ups → idle high.  Index order matches dir_pins below.
static bool s_last_level[5] = { true, true, true, true, true };

static bool     s_was_pressed  = false;
static bool     s_press_moved  = false;  // rolled while held → drag, not long-press
static bool     s_long_fired   = false;
static uint32_t s_press_start  = 0;
static bool     s_first_logged = false;

static tdeck_long_press_cb_t s_long_cb        = nullptr;
static void                 *s_long_user      = nullptr;
static tdeck_ball_hook_t     s_delta_hook     = nullptr;
static void                 *s_delta_user     = nullptr;

void tdeck_bsp_set_long_press_cb(tdeck_long_press_cb_t cb, void *user)
{
    s_long_cb   = cb;
    s_long_user = user;
}

void tdeck_bsp_set_ball_hook(tdeck_ball_hook_t hook, void *user)
{
    s_delta_hook = hook;
    s_delta_user = user;
    if (s_cursor) {
        // Hide the pointer while the ball is being read as a d-pad.
        if (hook) lv_obj_add_flag(s_cursor, LV_OBJ_FLAG_HIDDEN);
        else      lv_obj_clear_flag(s_cursor, LV_OBJ_FLAG_HIDDEN);
    }
}

static void long_press_async(void *)
{
    if (s_long_cb) s_long_cb(s_long_user);
}

static void read_cb(lv_indev_drv_t *, lv_indev_data_t *data)
{
    // Pin order matches LILYGO's reference: right, up, left, down.  Each
    // transition (rising or falling) on a direction pin is one detent; the
    // level itself carries no meaning.
    const int dir_pins[4] = {
        TDECK_TB_PIN_RIGHT, TDECK_TB_PIN_UP, TDECK_TB_PIN_LEFT, TDECK_TB_PIN_DOWN,
    };

    bool moved  = false;
    int  step   = TDECK_TB_STEP_PX;
    int  over_x = 0;   // movement swallowed by the screen-edge clamp this poll
    int  over_y = 0;
    int  det_x  = 0;   // raw detents, for the delta hook
    int  det_y  = 0;

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

    // Click is level-based (active low, pull-up): holding the ball down keeps
    // the pressed state asserted, so hold+roll works as an LVGL drag.
    bool pressed = gpio_get_level((gpio_num_t)TDECK_TB_PIN_CLICK) == 0;

    if (!s_first_logged && (moved || pressed != s_was_pressed)) {
        ESP_LOGI(TAG, "First trackball event — driver alive (d=%d,%d click=%d)",
                 det_x, det_y, pressed);
        s_first_logged = true;
    }

    // ---- d-pad mode -------------------------------------------------------
    if (s_delta_hook) {
        if (det_x || det_y || (pressed && !s_was_pressed)) {
            s_delta_hook(det_x, det_y, pressed && !s_was_pressed, s_delta_user);
        }
        s_was_pressed = pressed;
        data->point.x = s_cursor_x;
        data->point.y = s_cursor_y;
        data->state   = LV_INDEV_STATE_RELEASED;
        return;
    }

    // ---- pointer mode -----------------------------------------------------
    if (det_x > 0) {
        s_cursor_x += step * det_x;
        if (s_cursor_x >= TDECK_LCD_WIDTH) {
            over_x += s_cursor_x - (TDECK_LCD_WIDTH - 1);
            s_cursor_x = TDECK_LCD_WIDTH - 1;
        }
    } else if (det_x < 0) {
        s_cursor_x += step * det_x;
        if (s_cursor_x < 0) { over_x += s_cursor_x; s_cursor_x = 0; }
    }
    if (det_y > 0) {
        s_cursor_y += step * det_y;
        if (s_cursor_y >= TDECK_LCD_HEIGHT) {
            over_y += s_cursor_y - (TDECK_LCD_HEIGHT - 1);
            s_cursor_y = TDECK_LCD_HEIGHT - 1;
        }
    } else if (det_y < 0) {
        s_cursor_y += step * det_y;
        if (s_cursor_y < 0) { over_y += s_cursor_y; s_cursor_y = 0; }
    }

    if (pressed && !s_was_pressed) {
        s_press_start = lv_tick_get();
        s_press_moved = false;
        s_long_fired  = false;
    }
    if (pressed && moved) s_press_moved = true;  // drag intent, not long-press
    if (pressed && !s_long_fired && !s_press_moved && s_long_cb &&
        lv_tick_elaps(s_press_start) >= (uint32_t)TDECK_TB_LONG_PRESS_MS) {
        s_long_fired = true;
        // Cancel the in-flight press so the widget under the cursor doesn't
        // also get CLICKED on release, and defer the action out of the indev
        // read — it may delete the widget tree under us.
        lv_indev_reset(s_indev, nullptr);
        lv_async_call(long_press_async, nullptr);
    }

    // Edge-scroll: rolling against a screen edge scrolls the scrollable under
    // the cursor (only while not pressed — a held click is LVGL's own drag).
    // The object pinned under the cursor may be a non-scrollable overlay
    // (a header bar at the top edge), so probe progressively inward until
    // something scrollable is hit.
    if (!pressed && (over_x != 0 || over_y != 0)) {
        // The SCROLLABLE flag alone isn't enough — LVGL screens carry it by
        // default with no overflow — so require actual room in the direction
        // being scrolled.
        auto can_scroll = [&](lv_obj_t *o) {
            if (!lv_obj_has_flag(o, LV_OBJ_FLAG_SCROLLABLE)) return false;
            return (over_y > 0 && lv_obj_get_scroll_bottom(o) > 0) ||
                   (over_y < 0 && lv_obj_get_scroll_top(o)    > 0) ||
                   (over_x > 0 && lv_obj_get_scroll_right(o)  > 0) ||
                   (over_x < 0 && lv_obj_get_scroll_left(o)   > 0);
        };
        lv_obj_t *target = nullptr;
        for (int inset = 0; inset <= 60 && !target; inset += 20) {
            lv_point_t p = { s_cursor_x, s_cursor_y };
            if (over_x > 0) p.x -= inset; else if (over_x < 0) p.x += inset;
            if (over_y > 0) p.y -= inset; else if (over_y < 0) p.y += inset;
            lv_obj_t *hit = lv_indev_search_obj(lv_scr_act(), &p);
            while (hit && !can_scroll(hit)) hit = lv_obj_get_parent(hit);
            target = hit;
        }
        if (target) {
            // Rolling down at the bottom edge reveals content below → content
            // moves up → negative delta (same convention as a touch drag).
            lv_obj_scroll_by_bounded(target, -over_x, -over_y, LV_ANIM_OFF);
        }
    }

    s_was_pressed = pressed;
    data->point.x = s_cursor_x;
    data->point.y = s_cursor_y;
    // After a long-press fires, suppress the press until physical release so
    // LVGL sees the hold as cancelled rather than a fresh press.
    data->state = (pressed && !s_long_fired) ? LV_INDEV_STATE_PRESSED
                                             : LV_INDEV_STATE_RELEASED;
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

    lv_indev_drv_init(&s_indev_drv);
    s_indev_drv.type    = LV_INDEV_TYPE_POINTER;
    s_indev_drv.read_cb = read_cb;
    s_indev = lv_indev_drv_register(&s_indev_drv);
    if (!s_indev) {
        ESP_LOGE(TAG, "lv_indev_drv_register returned NULL");
        return ESP_FAIL;
    }

    // Visible cursor on the top layer, so it floats above every screen.  LVGL
    // repositions it automatically on each pointer event from this indev.
    s_cursor = lv_obj_create(lv_layer_top());
    lv_obj_remove_style_all(s_cursor);
    lv_obj_set_size(s_cursor, 14, 14);
    lv_obj_set_style_radius(s_cursor, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(s_cursor, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(s_cursor, LV_OPA_70, 0);
    lv_obj_set_style_border_color(s_cursor, lv_color_black(), 0);
    lv_obj_set_style_border_width(s_cursor, 2, 0);
    lv_obj_set_style_border_opa(s_cursor, LV_OPA_COVER, 0);
    lv_obj_clear_flag(s_cursor, LV_OBJ_FLAG_CLICKABLE);  // don't eat its own clicks
    lv_indev_set_cursor(s_indev, s_cursor);

    ESP_LOGI(TAG, "Trackball ready as pointer (U=%d D=%d L=%d R=%d C=%d, step=%dpx)",
             TDECK_TB_PIN_UP, TDECK_TB_PIN_DOWN, TDECK_TB_PIN_LEFT,
             TDECK_TB_PIN_RIGHT, TDECK_TB_PIN_CLICK, TDECK_TB_STEP_PX);
    return ESP_OK;
}

lv_indev_t *tdeck_bsp_trackball_indev(void) { return s_indev; }
