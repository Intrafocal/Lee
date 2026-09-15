// Internal wiring between the tdeck-bsp translation units.  Not installed.
#pragma once

#include "esp_err.h"
#include "lvgl.h"
#include "tdeck_bsp.h"

esp_err_t tdeck_display_init(void);
esp_err_t tdeck_touch_init(void);
esp_err_t tdeck_keyboard_init(void);
esp_err_t tdeck_trackball_init(void);
esp_err_t tdeck_battery_init(void);

/**
 * Install the legacy-driver I2C master on TDECK_I2C_PORT, once, for whichever
 * of touch/keyboard gets there first.
 *
 * B4/B5: do NOT call i2c_param_config() on a port that already has a driver.
 * param_config reconfigures live port state and stomps the existing driver's
 * pin/clock settings, putting the bus into a state where neither device
 * answers.  Install first; only configure when the install actually succeeded.
 */
esp_err_t tdeck_i2c_ensure(void);
