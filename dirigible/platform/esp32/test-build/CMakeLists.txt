cmake_minimum_required(VERSION 3.16)

# Pull in component directories before project() so ESP-IDF sees them:
#
# - ../components/                  dirigible-core/ and dirigible-esp32/
# - ../../../third_party/screenschema/screenschema/runtime
#       The ScreenSchema 'runtime' component (vendored as a git submodule).
#       ESP-IDF treats the directory name ("runtime") as the component name.
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../components"
    "${CMAKE_CURRENT_LIST_DIR}/../../../third_party/screenschema/screenschema/runtime"
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(dirigible-esp32-test)
