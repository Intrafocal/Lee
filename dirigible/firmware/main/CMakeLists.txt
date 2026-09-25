idf_component_register(
    SRCS
        "main.cpp"
        "app.cpp"
        "vt.cpp"
        "screen_tabs.cpp"
        "screen_terminal.cpp"
        "screen_hester.cpp"
        "screen_pairing.cpp"
        "screen_files.cpp"
        "screen_viewer.cpp"
        "brand_images.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        tdeck-bsp
        dirigible-core
        dirigible-esp32
        lvgl
        nvs_flash
)

# UI demo mode: cycle the pairing steps with canned data every 3 s so the
# layout can be eyeballed without a network.  Off by default; enable with
#     idf.py -DDIRIGIBLE_UI_DEMO=1 build
if(DIRIGIBLE_UI_DEMO)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE DIRIGIBLE_UI_DEMO=1)
    message(STATUS "Dirigible: UI demo mode ENABLED - do not ship this build")
endif()
