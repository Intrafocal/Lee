/*
 * tdeck_display.cpp — ST7789 panel + LVGL display driver for the T-Deck.
 *
 * Lifted from screenschema runtime/hal/drivers/display/st7789.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * with the SSDisplayST7789 class and the ISSDisplay interface removed and the
 * board profile inlined from tdeck_board.h.
 *
 * Preserves B8/B9/B10 (garbled display) and B11 (rotation):
 *   - the LILYGO-specific positive/negative gamma tables, sent after the
 *     standard ST7789 init (from TFT_eSPI's Setup210_LilyGo_T_Deck.h)
 *   - colour inversion on
 *   - full_refresh = 1, which avoids stale display memory on partial flushes
 *   - the rotation-3 swap/mirror derivation
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"

static const char *TAG = "tdeck.lcd";

static esp_lcd_panel_handle_t    s_panel = nullptr;
static esp_lcd_panel_io_handle_t s_io    = nullptr;
static lv_disp_drv_t             s_disp_drv;
static lv_disp_t                *s_disp  = nullptr;

static void flush_cb(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *px_map)
{
    esp_lcd_panel_draw_bitmap(s_panel, area->x1, area->y1,
                              area->x2 + 1, area->y2 + 1, px_map);
    lv_disp_flush_ready(drv);
}

void tdeck_bsp_set_backlight(float level)
{
    static bool configured = false;
    if (!configured) {
        gpio_config_t io_cfg = {};
        io_cfg.pin_bit_mask = 1ULL << TDECK_LCD_PIN_BL;
        io_cfg.mode         = GPIO_MODE_OUTPUT;
        io_cfg.pull_up_en   = GPIO_PULLUP_DISABLE;
        io_cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
        io_cfg.intr_type    = GPIO_INTR_DISABLE;
        gpio_config(&io_cfg);
        configured = true;
    }
    gpio_set_level((gpio_num_t)TDECK_LCD_PIN_BL, level >= 0.5f ? 1 : 0);
}

esp_err_t tdeck_display_init(void)
{
    esp_err_t ret;

    // SPI bus — tolerate "already initialised" in case something else (SD
    // card, LoRa) claimed the shared bus first.
    spi_bus_config_t bus_cfg = {};
    bus_cfg.mosi_io_num     = TDECK_LCD_PIN_MOSI;
    bus_cfg.miso_io_num     = TDECK_LCD_PIN_MISO;
    bus_cfg.sclk_io_num     = TDECK_LCD_PIN_SCLK;
    bus_cfg.quadwp_io_num   = -1;
    bus_cfg.quadhd_io_num   = -1;
    bus_cfg.max_transfer_sz = TDECK_LCD_WIDTH * TDECK_LCD_HEIGHT * (int)sizeof(uint16_t);

    ret = spi_bus_initialize(TDECK_LCD_SPI_HOST, &bus_cfg, SPI_DMA_CH_AUTO);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "SPI bus init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    esp_lcd_panel_io_spi_config_t io_cfg = {};
    io_cfg.cs_gpio_num       = TDECK_LCD_PIN_CS;
    io_cfg.dc_gpio_num       = TDECK_LCD_PIN_DC;
    io_cfg.pclk_hz           = TDECK_LCD_PCLK_HZ;
    io_cfg.trans_queue_depth = 10;
    io_cfg.lcd_cmd_bits      = 8;
    io_cfg.lcd_param_bits    = 8;

    ret = esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)TDECK_LCD_SPI_HOST,
                                   &io_cfg, &s_io);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "SPI panel IO failed: %s", esp_err_to_name(ret));
        return ret;
    }

    esp_lcd_panel_dev_config_t panel_cfg = {};
    panel_cfg.reset_gpio_num = TDECK_LCD_PIN_RST;
    panel_cfg.rgb_ele_order  = LCD_RGB_ELEMENT_ORDER_RGB;
    panel_cfg.bits_per_pixel = 16;

    ret = esp_lcd_new_panel_st7789(s_io, &panel_cfg, &s_panel);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "ST7789 panel create failed: %s", esp_err_to_name(ret));
        return ret;
    }

    esp_lcd_panel_reset(s_panel);
    esp_lcd_panel_init(s_panel);

    // ST7789 needs inversion enabled for correct colours.
    esp_lcd_panel_invert_color(s_panel, true);

    // T-Deck custom init (B8/B9/B10): LILYGO's ST7789V uses a non-standard
    // gamma and voltage sequence.  Send the LILYGO-specific register values
    // after the standard init.  These come from the LILYGO TFT_eSPI fork
    // (Setup210_LilyGo_T_Deck.h).
    const uint8_t pgamma[] = {
        0xD0, 0x08, 0x0E, 0x09, 0x09, 0x05, 0x31, 0x33,
        0x48, 0x17, 0x14, 0x15, 0x31, 0x34
    };
    esp_lcd_panel_io_tx_param(s_io, 0xE0, pgamma, sizeof(pgamma));
    const uint8_t ngamma[] = {
        0xD0, 0x08, 0x0E, 0x09, 0x09, 0x15, 0x31, 0x33,
        0x48, 0x17, 0x14, 0x15, 0x31, 0x34
    };
    esp_lcd_panel_io_tx_param(s_io, 0xE1, ngamma, sizeof(ngamma));

    esp_lcd_panel_disp_on_off(s_panel, true);

    // Rotation + per-axis overrides (B11).  All three overrides XOR on top of
    // the rotation-derived defaults.
    const bool swap_xy  = ((TDECK_LCD_ROTATION == 1) || (TDECK_LCD_ROTATION == 3)) ^ TDECK_LCD_SWAP_XY;
    const bool mirror_x = ((TDECK_LCD_ROTATION == 2) || (TDECK_LCD_ROTATION == 3)) ^ TDECK_LCD_MIRROR_X;
    const bool mirror_y = ((TDECK_LCD_ROTATION == 1) || (TDECK_LCD_ROTATION == 2)) ^ TDECK_LCD_MIRROR_Y;
    esp_lcd_panel_swap_xy(s_panel, swap_xy);
    esp_lcd_panel_mirror(s_panel, mirror_x, mirror_y);

    tdeck_bsp_set_backlight(1.0f);

    // LVGL draw buffers — double-buffered, 40 lines, DMA-capable internal RAM.
    // (PSRAM is not DMA-capable for SPI master on the S3, so these stay
    // internal even though the board has 8 MB of it.)
    const size_t buf_pixels = (size_t)TDECK_LCD_WIDTH * TDECK_LVGL_BUF_LINES;
    auto *buf1 = (lv_color_t *)heap_caps_malloc(buf_pixels * sizeof(lv_color_t),
                                                MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    auto *buf2 = (lv_color_t *)heap_caps_malloc(buf_pixels * sizeof(lv_color_t),
                                                MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!buf1 || !buf2) {
        ESP_LOGE(TAG, "Draw buffer alloc failed (%u px each)", (unsigned)buf_pixels);
        if (buf1) heap_caps_free(buf1);
        if (buf2) heap_caps_free(buf2);
        return ESP_ERR_NO_MEM;
    }

    static lv_disp_draw_buf_t draw_buf;
    lv_disp_draw_buf_init(&draw_buf, buf1, buf2, buf_pixels);

    lv_disp_drv_init(&s_disp_drv);
    s_disp_drv.hor_res      = (lv_coord_t)TDECK_LCD_WIDTH;
    s_disp_drv.ver_res      = (lv_coord_t)TDECK_LCD_HEIGHT;
    s_disp_drv.flush_cb     = flush_cb;
    s_disp_drv.draw_buf     = &draw_buf;
    s_disp_drv.full_refresh = 1;  // always redraw the whole screen — avoids
                                  // stale display memory (B9)
    s_disp = lv_disp_drv_register(&s_disp_drv);
    if (!s_disp) {
        ESP_LOGE(TAG, "lv_disp_drv_register returned NULL");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "ST7789 ready (%dx%d, rotation=%d, swap=%d mx=%d my=%d)",
             TDECK_LCD_WIDTH, TDECK_LCD_HEIGHT, TDECK_LCD_ROTATION,
             swap_xy, mirror_x, mirror_y);
    return ESP_OK;
}

lv_disp_t *tdeck_bsp_display(void) { return s_disp; }
uint16_t   tdeck_bsp_width(void)   { return TDECK_LCD_WIDTH; }
uint16_t   tdeck_bsp_height(void)  { return TDECK_LCD_HEIGHT; }
