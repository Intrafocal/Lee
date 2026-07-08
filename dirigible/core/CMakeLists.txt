cmake_minimum_required(VERSION 3.16)
project(dirigible-core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(dirigible-core STATIC
    src/models.cpp
    src/lee_client.cpp
    src/pty_client.cpp
    src/hester_client.cpp
    src/machine.cpp
    src/state.cpp
)

target_include_directories(dirigible-core
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# cJSON — found differently on ESP-IDF vs Linux
if(NOT ESP_PLATFORM)
    # Linux: find system cJSON or use bundled
    find_package(PkgConfig QUIET)
    if(PkgConfig_FOUND)
        pkg_check_modules(CJSON QUIET libcjson)
    endif()

    if(CJSON_FOUND)
        target_include_directories(dirigible-core PUBLIC ${CJSON_INCLUDE_DIRS})
        target_link_libraries(dirigible-core PUBLIC ${CJSON_LIBRARIES})
    else()
        # Fallback: expect cJSON headers in a vendored location or system path
        message(STATUS "cJSON not found via pkg-config, assuming system headers available")
        target_link_libraries(dirigible-core PUBLIC cjson)
    endif()
else()
    # ESP-IDF: cJSON is provided as a component, linked via idf_component_register
    message(STATUS "ESP-IDF build: cJSON provided by ESP-IDF json component")
endif()
