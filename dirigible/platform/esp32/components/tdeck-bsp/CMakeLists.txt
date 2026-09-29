# tdeck-bsp — LilyGO T-Deck board support (display, touch, keyboard,
# trackball, battery, and the mic with CONFIG_DIRIGIBLE_VOICE) on plain
# ESP-IDF + LVGL 8.
#
# Lifted from the ScreenSchema runtime HAL, Intrafocal/screenschema
# @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd.  See the file headers.

set(srcs
    "tdeck_bsp.cpp"
    "tdeck_i2c.cpp"
    "tdeck_display.cpp"
    "tdeck_touch.cpp"
    "tdeck_keyboard.cpp"
    "tdeck_trackball.cpp"
    "tdeck_battery.cpp"
)
set(priv_reqs esp_lcd_touch esp_lcd_touch_gt911)

# Voice input (plan 2026-09-28 §5.6): the ES7210 through esp_codec_dev, only
# when the firmware is built with it, so the default build neither fetches
# nor links the codec component.
if(CONFIG_DIRIGIBLE_VOICE)
    list(APPEND srcs "tdeck_audio.cpp")
    list(APPEND priv_reqs esp_codec_dev)
endif()

idf_component_register(
    SRCS
        ${srcs}
    INCLUDE_DIRS
        "include"
    PRIV_INCLUDE_DIRS
        "."
    REQUIRES
        esp_lcd
        driver
        esp_adc
        esp_timer
        lvgl
    PRIV_REQUIRES
        ${priv_reqs}
)
