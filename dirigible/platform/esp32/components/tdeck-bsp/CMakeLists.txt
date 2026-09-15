# tdeck-bsp — LilyGO T-Deck board support (display, touch, keyboard,
# trackball, battery) on plain ESP-IDF + LVGL 8.
#
# Lifted from the ScreenSchema runtime HAL, Intrafocal/screenschema
# @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd.  See the file headers.

idf_component_register(
    SRCS
        "tdeck_bsp.cpp"
        "tdeck_i2c.cpp"
        "tdeck_display.cpp"
        "tdeck_touch.cpp"
        "tdeck_keyboard.cpp"
        "tdeck_trackball.cpp"
        "tdeck_battery.cpp"
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
        esp_lcd_touch
        esp_lcd_touch_gt911
)
