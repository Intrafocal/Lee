/*
 * tdeck_i2c.cpp — one shared legacy-driver I2C master for touch + keyboard.
 *
 * Distilled from screenschema's gt911.cpp / ss_keyboard_i2c.cpp bus handling
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * which discovered the hard way (B4/B5) that calling i2c_param_config() on a
 * port that already has a driver installed stomps the live configuration.
 * Centralising the bus here makes that mistake impossible to repeat.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/i2c.h"
#include "esp_log.h"

static const char *TAG = "tdeck.i2c";
static bool s_ready = false;

esp_err_t tdeck_i2c_ensure(void)
{
    if (s_ready) return ESP_OK;

    // Install first.  ESP_FAIL / ESP_ERR_INVALID_STATE means somebody else
    // already owns the port, in which case we must NOT reconfigure it.
    esp_err_t err = i2c_driver_install(TDECK_I2C_PORT, I2C_MODE_MASTER, 0, 0, 0);
    if (err == ESP_OK) {
        i2c_config_t cfg = {};
        cfg.mode                = I2C_MODE_MASTER;
        cfg.sda_io_num          = TDECK_I2C_PIN_SDA;
        cfg.scl_io_num          = TDECK_I2C_PIN_SCL;
        cfg.sda_pullup_en       = GPIO_PULLUP_ENABLE;
        cfg.scl_pullup_en       = GPIO_PULLUP_ENABLE;
        cfg.master.clk_speed    = TDECK_I2C_FREQ_HZ;
        cfg.clk_flags           = 0;
        esp_err_t cfg_err = i2c_param_config(TDECK_I2C_PORT, &cfg);
        if (cfg_err != ESP_OK) {
            ESP_LOGE(TAG, "i2c_param_config failed: %s", esp_err_to_name(cfg_err));
            return cfg_err;
        }
        ESP_LOGI(TAG, "I2C%d up (SDA=%d SCL=%d @%d Hz)",
                 (int)TDECK_I2C_PORT, TDECK_I2C_PIN_SDA, TDECK_I2C_PIN_SCL,
                 TDECK_I2C_FREQ_HZ);
    } else if (err == ESP_FAIL || err == ESP_ERR_INVALID_STATE) {
        ESP_LOGI(TAG, "I2C%d already installed — reusing existing bus",
                 (int)TDECK_I2C_PORT);
    } else {
        ESP_LOGE(TAG, "i2c_driver_install failed: %s", esp_err_to_name(err));
        return err;
    }

    s_ready = true;
    return ESP_OK;
}
