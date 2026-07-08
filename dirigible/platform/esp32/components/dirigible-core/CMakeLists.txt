# dirigible-core ESP-IDF component
#
# Wraps the cross-platform core library at ../../../../core/ as an ESP-IDF
# component. Source files live in dirigible/core/src/, headers in
# dirigible/core/include/. cJSON is provided by ESP-IDF's `json` component.

set(CORE_DIR ${CMAKE_CURRENT_LIST_DIR}/../../../../core)

idf_component_register(
    SRCS
        ${CORE_DIR}/src/models.cpp
        ${CORE_DIR}/src/lee_client.cpp
        ${CORE_DIR}/src/pty_client.cpp
        ${CORE_DIR}/src/hester_client.cpp
        ${CORE_DIR}/src/machine.cpp
        ${CORE_DIR}/src/state.cpp
    INCLUDE_DIRS
        ${CORE_DIR}/include
    REQUIRES
        json
)
