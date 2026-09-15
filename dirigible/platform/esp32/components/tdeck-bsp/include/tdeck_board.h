/*
 * tdeck_board.h — LilyGO T-Deck (ESP32-S3) board profile.
 *
 * Lifted from screenschema's `boards/lilygo-t-deck.yaml`
 *   source: dirigible/third_party/screenschema/screenschema/boards/lilygo-t-deck.yaml
 *   commit: 76b6ce9bb16521bd05d08f82b642014f390cf4cd (Intrafocal/screenschema)
 *
 * The YAML board profile is gone with the submodule; these constants are the
 * whole of it that Dirigible needs.  The comments that justify the empirically
 * derived values (rotation, touch transform, settle delay) are preserved
 * verbatim, because they are the expensive part.
 */
#pragma once

// ---------------------------------------------------------------------------
// Early init — power gate.  GPIO 10 must be HIGH before any peripheral
// responds; the keyboard MCU (an ESP32-C3) and the GT911 need ~500 ms after
// the gate opens before they answer on I2C.  GPIO 9 is the (unpopulated) LoRa
// chip select, deasserted for good practice.
// ---------------------------------------------------------------------------
#define TDECK_PIN_POWER_ON       10
#define TDECK_PIN_LORA_CS         9
#define TDECK_POWER_SETTLE_MS   500

// ---------------------------------------------------------------------------
// Display — ST7789 over SPI, 320x240 landscape
// ---------------------------------------------------------------------------
#define TDECK_LCD_WIDTH         320
#define TDECK_LCD_HEIGHT        240
#define TDECK_LCD_SPI_HOST      SPI2_HOST
#define TDECK_LCD_PIN_CS         12
#define TDECK_LCD_PIN_DC         11
#define TDECK_LCD_PIN_RST        (-1)
#define TDECK_LCD_PIN_SCLK       40
#define TDECK_LCD_PIN_MOSI       41
#define TDECK_LCD_PIN_MISO       (-1)
#define TDECK_LCD_PIN_BL         42
#define TDECK_LCD_PCLK_HZ       (40 * 1000 * 1000)

// Native panel is 240x320 portrait, mounted in landscape with the keyboard at
// the bottom.  rotation 3 sets swap_xy + mirror_x, which is right-side-up
// landscape when held with the keyboard down.  (Don't be misled by LILYGO
// TFT_eSPI's setRotation(1) — TFT_eSPI's rotation reference frame doesn't
// match esp_lcd_panel_st7789's, so the empirical value from visual testing
// is rotation = 3.)
#define TDECK_LCD_ROTATION        3
#define TDECK_LCD_SWAP_XY         false   // XOR override on the rotation default
#define TDECK_LCD_MIRROR_X        false
#define TDECK_LCD_MIRROR_Y        false

// ---------------------------------------------------------------------------
// Touch — GT911 on the shared I2C bus
// ---------------------------------------------------------------------------
#define TDECK_I2C_PORT          I2C_NUM_0
#define TDECK_I2C_PIN_SDA        18
#define TDECK_I2C_PIN_SCL         8
#define TDECK_I2C_FREQ_HZ    400000

#define TDECK_TOUCH_PIN_RST      (-1)
#define TDECK_TOUCH_PIN_INT       16
// The GT911 reports in the panel's native portrait frame (240x320);
// esp_lcd_touch applies mirrors pre-swap, same convention as the display's
// MADCTL, so these match the display's rotation 3 (swap_xy + mirror_x).
#define TDECK_TOUCH_SWAP_XY     true
#define TDECK_TOUCH_MIRROR_X    true
#define TDECK_TOUCH_MIRROR_Y    false

// ---------------------------------------------------------------------------
// BlackBerry keyboard — an ESP32-C3 running LILYGO's keypad firmware,
// polled over the shared I2C bus.  Reads return one ASCII byte (0 = no key).
// ---------------------------------------------------------------------------
#define TDECK_KBD_I2C_ADDR     0x55
#define TDECK_KBD_PIN_INT        46
#define TDECK_KBD_HAS_BACKLIGHT   1

// ---------------------------------------------------------------------------
// Trackball — five GPIOs, polled (no ISR).  Click shares the BOOT pin.
// ---------------------------------------------------------------------------
#define TDECK_TB_PIN_UP           3
#define TDECK_TB_PIN_DOWN        15
#define TDECK_TB_PIN_LEFT         1
#define TDECK_TB_PIN_RIGHT        2
#define TDECK_TB_PIN_CLICK        0
#define TDECK_TB_STEP_PX         10
#define TDECK_TB_LONG_PRESS_MS  800

// ---------------------------------------------------------------------------
// Battery — ADC1 with a 2x divider on VBAT
// ---------------------------------------------------------------------------
#define TDECK_BAT_ADC_GPIO        4
#define TDECK_BAT_DIVIDER      2.0f
#define TDECK_BAT_FULL_MV      4200
#define TDECK_BAT_EMPTY_MV     3300
#define TDECK_BAT_SAMPLE_MS   30000

// ---------------------------------------------------------------------------
// Memory — 16 MB flash, 8 MB octal PSRAM.  LVGL draw buffer is 40 lines
// double-buffered in DMA-capable internal RAM (see display_st7789.cpp).
// ---------------------------------------------------------------------------
#define TDECK_LVGL_BUF_LINES     40
