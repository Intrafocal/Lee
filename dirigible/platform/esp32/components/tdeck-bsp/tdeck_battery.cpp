/*
 * tdeck_battery.cpp — VBAT divider on ADC1, with curve-fitting calibration.
 *
 * Lifted from screenschema runtime/core/ss_battery.cpp
 *   (Intrafocal/screenschema @ 76b6ce9bb16521bd05d08f82b642014f390cf4cd),
 * with the SSBattery singleton and its LVGL sample timer removed — Dirigible
 * polls from its own status-bar timer instead.
 */

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"

static const char *TAG = "tdeck.bat";

static adc_oneshot_unit_handle_t s_adc  = nullptr;
static adc_cali_handle_t         s_cali = nullptr;
static adc_channel_t             s_chan = ADC_CHANNEL_0;
static bool                      s_ready = false;
static tdeck_battery_t           s_last  = {};

// On the ESP32-S3, ADC1 covers GPIO 1-10 as ADC1_CH0-9.
static bool gpio_to_adc(int gpio, adc_unit_t *unit, adc_channel_t *chan)
{
    if (gpio < 1 || gpio > 10) return false;
    *unit = ADC_UNIT_1;
    *chan = (adc_channel_t)(gpio - 1);
    return true;
}

esp_err_t tdeck_battery_init(void)
{
    if (s_ready) return ESP_OK;

    adc_unit_t unit;
    if (!gpio_to_adc(TDECK_BAT_ADC_GPIO, &unit, &s_chan)) {
        ESP_LOGE(TAG, "GPIO %d is not an ADC1 pin", TDECK_BAT_ADC_GPIO);
        return ESP_ERR_INVALID_ARG;
    }

    adc_oneshot_unit_init_cfg_t init_cfg = {};
    init_cfg.unit_id  = unit;
    init_cfg.ulp_mode = ADC_ULP_MODE_DISABLE;
    esp_err_t err = adc_oneshot_new_unit(&init_cfg, &s_adc);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "adc_oneshot_new_unit failed: %s", esp_err_to_name(err));
        return err;
    }

    adc_oneshot_chan_cfg_t chan_cfg = {};
    chan_cfg.atten    = ADC_ATTEN_DB_12;   // ~0-3.3 V range
    chan_cfg.bitwidth = ADC_BITWIDTH_DEFAULT;
    err = adc_oneshot_config_channel(s_adc, s_chan, &chan_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "adc_oneshot_config_channel failed: %s", esp_err_to_name(err));
        return err;
    }

    adc_cali_curve_fitting_config_t cali_cfg = {};
    cali_cfg.unit_id  = unit;
    cali_cfg.chan     = s_chan;
    cali_cfg.atten    = ADC_ATTEN_DB_12;
    cali_cfg.bitwidth = ADC_BITWIDTH_DEFAULT;
    if (adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_cali) != ESP_OK) {
        ESP_LOGW(TAG, "ADC calibration unavailable — readings will be raw");
        s_cali = nullptr;
    }

    s_ready = true;
    s_last  = tdeck_bsp_battery_read();
    ESP_LOGI(TAG, "Battery ready (GPIO %d, divider %.1f, %d-%d mV)",
             TDECK_BAT_ADC_GPIO, (double)TDECK_BAT_DIVIDER,
             TDECK_BAT_EMPTY_MV, TDECK_BAT_FULL_MV);
    return ESP_OK;
}

tdeck_battery_t tdeck_bsp_battery_read(void)
{
    tdeck_battery_t r = {};
    if (!s_ready) return r;

    int raw = 0;
    if (adc_oneshot_read(s_adc, s_chan, &raw) != ESP_OK) return s_last;

    int adc_mv = 0;
    if (s_cali) {
        adc_cali_raw_to_voltage(s_cali, raw, &adc_mv);
    } else {
        // Rough fallback: 12-bit, ADC_ATTEN_DB_12 → ~3100 mV full scale.
        adc_mv = (raw * 3100) / 4095;
    }

    r.voltage_mv = (int)(adc_mv * TDECK_BAT_DIVIDER);

    const int range = TDECK_BAT_FULL_MV - TDECK_BAT_EMPTY_MV;
    if (r.voltage_mv >= TDECK_BAT_FULL_MV)       r.percent = 100;
    else if (r.voltage_mv <= TDECK_BAT_EMPTY_MV) r.percent = 0;
    else r.percent = (uint8_t)(((r.voltage_mv - TDECK_BAT_EMPTY_MV) * 100) / range);

    s_last = r;
    return r;
}
