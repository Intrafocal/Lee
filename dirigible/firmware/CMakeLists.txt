cmake_minimum_required(VERSION 3.16)

# Dirigible firmware for the LilyGO T-Deck.
#
#   ../core                          portable protocol layer (dirigible-core)
#   ../platform/esp32/components     tdeck-bsp, dirigible-core, dirigible-esp32
#
# Build:  source $IDF_PATH/export.sh && idf.py set-target esp32s3 && idf.py build

set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../platform/esp32/components"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
set(PROJECT_VER "0.2.0")
project(dirigible)
