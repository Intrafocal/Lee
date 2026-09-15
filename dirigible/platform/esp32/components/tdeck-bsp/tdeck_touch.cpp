/*
 * tdeck_touch.cpp — GT911 capacitive touch as an LVGL pointer device.
 *
 * Lifted from screenschema runtime/hal/drivers/touch/gt911.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * with the SSTouchGT911 class removed and the bus install moved to
 * tdeck_i2c.cpp.
 *
 * The two fixes that made touch work on this board are kept verbatim:
 *   B-series "GT911 panel-IO framing": disable_control_phase = 1 in the
 *     esp_lcd_panel_io_i2c config.  With the control phase enabled the
 *     component's register reads are mis-framed and silently return zeros,
 *     i.e. touch looks dead rather than broken.
 *   B-series "touch calibration": x_max/y_max are in the RAW (pre-transform)
 *     frame because esp_lcd_touch applies mirrors before swap, so with
 *     swap_xy set the raw frame is (height, width) of the final orientation.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/i2c.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_gt911.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "tdeck.touch";

static esp_lcd_touch_handle_t s_touch = nullptr;
static lv_indev_drv_t         s_indev_drv;
static lv_indev_t            *s_indev = nullptr;

// The GT911 straps to I2C address 0x5D or 0x14 depending on the INT level at
// power-up; boards without a wired reset line (the T-Deck is one) can't force
// it.  A chip that isn't ready yet ACKs but reads the product-ID register
// (0x8140, expected "911") as all zeros — so validate the ID, not just the ACK.
static bool gt911_probe(uint8_t addr)
{
    const uint8_t reg[2] = { 0x81, 0x40 };
    uint8_t id[4] = { 0 };
    esp_err_t err = i2c_master_write_read_device(TDECK_I2C_PORT, addr,
                                                 reg, sizeof(reg),
                                                 id, sizeof(id),
                                                 pdMS_TO_TICKS(50));
    if (err != ESP_OK) return false;
    if (id[0] == 0) return false;
    ESP_LOGI(TAG, "GT911 found at 0x%02X (ID: %c%c%c)", addr, id[0], id[1], id[2]);
    return true;
}

static void read_cb(lv_indev_drv_t *, lv_indev_data_t *data)
{
    data->state = LV_INDEV_STATE_REL;
    if (!s_touch) return;

    esp_lcd_touch_read_data(s_touch);

    // esp_lcd_touch_get_coordinates() is deprecated in the 1.x component;
    // get_data() is the same transform pipeline behind a struct.
    esp_lcd_touch_point_data_t pt = {};
    uint8_t count = 0;
    if (esp_lcd_touch_get_data(s_touch, &pt, &count, 1) != ESP_OK) return;
    if (count == 0) return;

    // Throttled coordinate log — tap the display corners to verify the
    // swap/mirror transform from the serial console.
    static uint32_t last_log_ms = 0;
    uint32_t now_ms = xTaskGetTickCount() * portTICK_PERIOD_MS;
    if (now_ms - last_log_ms > 300) {
        last_log_ms = now_ms;
        ESP_LOGD(TAG, "touch (%u, %u) n=%u", pt.x, pt.y, count);
    }

    data->point.x = pt.x;
    data->point.y = pt.y;
    data->state   = LV_INDEV_STATE_PR;
}

esp_err_t tdeck_touch_init(void)
{
    esp_err_t ret = tdeck_i2c_ensure();
    if (ret != ESP_OK) return ret;

    // Probe primary then alternate address, with retries in case the power
    // gate only just came up.
    uint8_t dev_addr = 0;
    for (int attempt = 0; attempt < 3 && dev_addr == 0; attempt++) {
        if (attempt > 0) vTaskDelay(pdMS_TO_TICKS(100));
        if (gt911_probe(ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS)) {
            dev_addr = ESP_LCD_TOUCH_IO_I2C_GT911_ADDRESS;
        } else if (gt911_probe(0x14)) {
            dev_addr = 0x14;
        }
    }
    if (dev_addr == 0) {
        ESP_LOGE(TAG, "GT911 not responding at 0x5D or 0x14 — touch disabled");
        return ESP_FAIL;
    }

    // Field values must match ESP_LCD_TOUCH_IO_I2C_GT911_CONFIG() — in
    // particular disable_control_phase = 1.  See the file header.
    esp_lcd_panel_io_i2c_config_t io_config = {};
    io_config.dev_addr                   = dev_addr;
    io_config.control_phase_bytes        = 1;
    io_config.dc_bit_offset              = 0;
    io_config.lcd_cmd_bits               = 16;
    io_config.lcd_param_bits             = 0;
    io_config.flags.dc_low_on_data       = 0;
    io_config.flags.disable_control_phase = 1;

    esp_lcd_panel_io_handle_t io = nullptr;
    ret = esp_lcd_new_panel_io_i2c((esp_lcd_i2c_bus_handle_t)TDECK_I2C_PORT,
                                   &io_config, &io);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_lcd_new_panel_io_i2c failed: %s", esp_err_to_name(ret));
        return ret;
    }

    esp_lcd_touch_config_t touch_cfg = {};
    touch_cfg.x_max            = TDECK_TOUCH_SWAP_XY ? TDECK_LCD_HEIGHT : TDECK_LCD_WIDTH;
    touch_cfg.y_max            = TDECK_TOUCH_SWAP_XY ? TDECK_LCD_WIDTH  : TDECK_LCD_HEIGHT;
    touch_cfg.rst_gpio_num     = (gpio_num_t)TDECK_TOUCH_PIN_RST;
    touch_cfg.int_gpio_num     = (gpio_num_t)TDECK_TOUCH_PIN_INT;
    touch_cfg.levels.reset     = 0;
    touch_cfg.levels.interrupt = 0;
    touch_cfg.flags.swap_xy    = TDECK_TOUCH_SWAP_XY;
    touch_cfg.flags.mirror_x   = TDECK_TOUCH_MIRROR_X;
    touch_cfg.flags.mirror_y   = TDECK_TOUCH_MIRROR_Y;

    ret = esp_lcd_touch_new_i2c_gt911(io, &touch_cfg, &s_touch);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "esp_lcd_touch_new_i2c_gt911 failed: %s", esp_err_to_name(ret));
        return ret;
    }

    lv_indev_drv_init(&s_indev_drv);
    s_indev_drv.type    = LV_INDEV_TYPE_POINTER;
    s_indev_drv.read_cb = read_cb;
    s_indev = lv_indev_drv_register(&s_indev_drv);
    if (!s_indev) {
        ESP_LOGE(TAG, "lv_indev_drv_register returned NULL");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "GT911 ready (%dx%d, swap=%d mx=%d my=%d)",
             TDECK_LCD_WIDTH, TDECK_LCD_HEIGHT,
             TDECK_TOUCH_SWAP_XY, TDECK_TOUCH_MIRROR_X, TDECK_TOUCH_MIRROR_Y);
    return ESP_OK;
}

lv_indev_t *tdeck_bsp_touch_indev(void) { return s_indev; }
