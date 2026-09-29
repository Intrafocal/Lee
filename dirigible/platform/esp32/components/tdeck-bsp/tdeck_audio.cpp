/*
 * tdeck_audio.cpp — the T-Deck's microphone for voice input (plan 2026-09-28
 * §5.6).  Built only with CONFIG_DIRIGIBLE_VOICE; see tdeck_board.h for the
 * pins and what about them is still unverified.
 *
 * The ES7210 is driven through espressif/esp_codec_dev's es7210 codec.  Its
 * register access is a small control interface of our own over the legacy
 * I2C master tdeck_i2c.cpp already installed for touch and the keyboard:
 * esp_codec_dev's own I2C control uses IDF's new i2c_master driver, and IDF
 * aborts at boot when the new and the legacy driver are both linked (its
 * CODEC_I2C_BACKWARD_COMPATIBLE switch doesn't build on IDF 5.4: the component
 * no longer requires `driver`).  The data is an I2S RX channel in standard
 * (Philips) mode, stereo 16-bit: MIC1 left, MIC2 right, which tdeck_mic_read
 * averages to mono.
 *
 * Everything is brought up on start and torn down on stop, so an idle device
 * spends nothing on the mic and a failed start leaves no half-open channel.
 *
 * The keypad reports no key-up (tdeck_keyboard.cpp), so recording is
 * tap-to-toggle only; there is no push-to-talk hold.
 */

#include <algorithm>

#include "tdeck_internal.hpp"
#include "tdeck_board.h"

#include "driver/i2c.h"
#include "driver/i2s_tdm.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "es7210_adc.h"
#include "esp_log.h"

static const char *TAG = "tdeck.mic";

namespace {

i2s_chan_handle_t              s_rx    = nullptr;
const audio_codec_data_if_t   *s_data  = nullptr;
const audio_codec_ctrl_if_t   *s_ctrl  = nullptr;
const audio_codec_if_t        *s_codec = nullptr;
esp_codec_dev_handle_t         s_dev   = nullptr;

// TDM with the ES7210's four inputs, as LilyGO's own examples run it: with two
// mics in plain I2S the T-Deck read nothing but zeros. Checked on a device
// (2026-09-28): the two mics are slots 0 and 1 (speech peaked at 28k / 19k),
// slots 2 and 3 only carry noise (~1-2k), so the mono mix is the average of
// 0 and 1; summing all four clipped. The per-slot peaks are logged at stop.
constexpr int CHANNELS = 4;              // MIC1..MIC4, one TDM slot each
constexpr size_t STEREO_CHUNK = 256;     // frames per read
int s_slot_peak[CHANNELS] = {};
constexpr TickType_t I2C_WAIT = pdMS_TO_TICKS(50);

// ---------------------------------------------------------------------------
// The codec's register access over the shared legacy I2C bus.  Static, never
// freed: audio_codec_delete_ctrl_if would free() it, so it is simply dropped.
// ES7210 registers are one address byte and one data byte.
// ---------------------------------------------------------------------------

int ctrl_open(const audio_codec_ctrl_if_t*, void*, int) { return ESP_CODEC_DEV_OK; }
bool ctrl_is_open(const audio_codec_ctrl_if_t*) { return true; }

int ctrl_read(const audio_codec_ctrl_if_t*, int reg, int reg_len, void* data, int data_len)
{
    if (!data || reg_len != 1 || data_len < 1) return ESP_CODEC_DEV_INVALID_ARG;
    const uint8_t r = (uint8_t)reg;
    const esp_err_t err = i2c_master_write_read_device(TDECK_I2C_PORT, TDECK_MIC_I2C_ADDR, &r, 1,
                                                       (uint8_t*)data, (size_t)data_len, I2C_WAIT);
    return err == ESP_OK ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_READ_FAIL;
}

int ctrl_write(const audio_codec_ctrl_if_t*, int reg, int reg_len, void* data, int data_len)
{
    if (!data || reg_len != 1 || data_len != 1) return ESP_CODEC_DEV_INVALID_ARG;
    const uint8_t buf[2] = { (uint8_t)reg, *(const uint8_t*)data };
    const esp_err_t err = i2c_master_write_to_device(TDECK_I2C_PORT, TDECK_MIC_I2C_ADDR, buf, 2, I2C_WAIT);
    if (err != ESP_OK) ESP_LOGW(TAG, "ES7210 write 0x%02x: %s", reg, esp_err_to_name(err));
    return err == ESP_OK ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_WRITE_FAIL;
}

int ctrl_info(const audio_codec_ctrl_if_t*, audio_codec_ctrl_info_t* info)
{
    if (!info) return ESP_CODEC_DEV_INVALID_ARG;
    info->type = AUDIO_CODEC_CTRL_I2C;
    info->i2c.addr = TDECK_MIC_I2C_ADDR << 1;
    info->i2c.port = TDECK_I2C_PORT;
    return ESP_CODEC_DEV_OK;
}

int ctrl_close(const audio_codec_ctrl_if_t*) { return ESP_CODEC_DEV_OK; }

const audio_codec_ctrl_if_t s_i2c_ctrl = {
    ctrl_open, ctrl_is_open, ctrl_read, ctrl_write, ctrl_info, ctrl_close,
};

void teardown()
{
    if (s_dev)   { esp_codec_dev_close(s_dev); esp_codec_dev_delete(s_dev); s_dev = nullptr; }
    if (s_codec) { audio_codec_delete_codec_if(s_codec); s_codec = nullptr; }
    s_ctrl = nullptr;   // static: see s_i2c_ctrl
    if (s_data)  { audio_codec_delete_data_if(s_data); s_data = nullptr; }
    if (s_rx) {
        i2s_channel_disable(s_rx);   // may already be, by the close above
        i2s_del_channel(s_rx);
        s_rx = nullptr;
    }
}

}  // namespace

esp_err_t tdeck_mic_start(uint32_t sample_rate)
{
    if (s_dev) return ESP_OK;

    esp_err_t err = tdeck_i2c_ensure();
    if (err != ESP_OK) return err;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG((i2s_port_t)TDECK_MIC_I2S_PORT, I2S_ROLE_MASTER);
    err = i2s_new_channel(&chan_cfg, nullptr, &s_rx);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s_new_channel: %s", esp_err_to_name(err));
        s_rx = nullptr;
        return err;
    }
    i2s_tdm_config_t tdm_cfg = {};
    tdm_cfg.clk_cfg.sample_rate_hz = sample_rate;
    tdm_cfg.clk_cfg.clk_src        = I2S_CLK_SRC_DEFAULT;
    tdm_cfg.clk_cfg.mclk_multiple  = I2S_MCLK_MULTIPLE_256;
    tdm_cfg.slot_cfg = I2S_TDM_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO,
        (i2s_tdm_slot_mask_t)(I2S_TDM_SLOT0 | I2S_TDM_SLOT1 | I2S_TDM_SLOT2 | I2S_TDM_SLOT3));
    tdm_cfg.gpio_cfg.mclk = (gpio_num_t)TDECK_MIC_PIN_MCLK;
    tdm_cfg.gpio_cfg.bclk = (gpio_num_t)TDECK_MIC_PIN_BCLK;
    tdm_cfg.gpio_cfg.ws   = (gpio_num_t)TDECK_MIC_PIN_WS;
    tdm_cfg.gpio_cfg.dout = I2S_GPIO_UNUSED;
    tdm_cfg.gpio_cfg.din  = (gpio_num_t)TDECK_MIC_PIN_DIN;
    err = i2s_channel_init_tdm_mode(s_rx, &tdm_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2s tdm mode: %s", esp_err_to_name(err));
        teardown();
        return err;
    }

    audio_codec_i2s_cfg_t i2s_cfg = {};
    i2s_cfg.port = TDECK_MIC_I2S_PORT;
    i2s_cfg.rx_handle = s_rx;
    s_data = audio_codec_new_i2s_data(&i2s_cfg);

    // Is the ES7210 there at all?  Asking before the codec's own init turns
    // wrong pins or a wrong address into one clear line in the log.
    int probe = 0;
    if (ctrl_read(&s_i2c_ctrl, 0x3D, 1, &probe, 1) != ESP_CODEC_DEV_OK) {   // chip id register
        ESP_LOGE(TAG, "no ES7210 at 0x%02x on I2C%d", TDECK_MIC_I2C_ADDR, (int)TDECK_I2C_PORT);
        teardown();
        return ESP_ERR_NOT_FOUND;
    }
    s_ctrl = &s_i2c_ctrl;

    if (s_ctrl) {
        es7210_codec_cfg_t es_cfg = {};
        es_cfg.ctrl_if = s_ctrl;
        es_cfg.mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2 | ES7210_SEL_MIC3 | ES7210_SEL_MIC4;  // 3+ turns on TDM
        s_codec = es7210_codec_new(&es_cfg);
    }
    if (!s_data || !s_ctrl || !s_codec) {
        ESP_LOGE(TAG, "ES7210 did not come up (data %p ctrl %p codec %p)", s_data, s_ctrl, s_codec);
        teardown();
        return ESP_FAIL;
    }

    esp_codec_dev_cfg_t dev_cfg = {};
    dev_cfg.dev_type = ESP_CODEC_DEV_TYPE_IN;
    dev_cfg.codec_if = s_codec;
    dev_cfg.data_if  = s_data;
    s_dev = esp_codec_dev_new(&dev_cfg);
    if (!s_dev) {
        teardown();
        return ESP_FAIL;
    }

    esp_codec_dev_sample_info_t fs = {};
    fs.bits_per_sample = 16;
    fs.channel = CHANNELS;
    fs.sample_rate = sample_rate;
    if (esp_codec_dev_open(s_dev, &fs) != ESP_CODEC_DEV_OK) {
        ESP_LOGE(TAG, "codec open failed");
        esp_codec_dev_delete(s_dev);
        s_dev = nullptr;
        teardown();
        return ESP_FAIL;
    }
    esp_codec_dev_set_in_gain(s_dev, TDECK_MIC_GAIN_DB);
    for (int& p : s_slot_peak) p = 0;
    ESP_LOGI(TAG, "mic on: %u Hz, TDM, mics on slots 0 and 1", (unsigned)sample_rate);
    return ESP_OK;
}

size_t tdeck_mic_read(int16_t *dst, size_t max_samples, uint32_t timeout_ms)
{
    (void)timeout_ms;   // esp_codec_dev reads with its own I2S wait
    if (!s_dev || !dst || !max_samples) return 0;
    int16_t frames[STEREO_CHUNK * CHANNELS];
    size_t done = 0;
    while (done < max_samples) {
        const size_t want = std::min(STEREO_CHUNK, max_samples - done);
        if (esp_codec_dev_read(s_dev, frames, (int)(want * CHANNELS * sizeof(int16_t))) != ESP_CODEC_DEV_OK) {
            break;
        }
        for (size_t i = 0; i < want; i++) {
            for (int c = 0; c < CHANNELS; c++) {
                const int v = frames[CHANNELS * i + c];
                s_slot_peak[c] = std::max(s_slot_peak[c], v < 0 ? -v : v);
            }
            // The two mics (slots 0 and 1), averaged; slots 2 and 3 are noise.
            dst[done + i] = (int16_t)(((int)frames[CHANNELS * i] + (int)frames[CHANNELS * i + 1]) / 2);
        }
        done += want;
    }
    return done;
}

void tdeck_mic_stop(void)
{
    if (!s_dev && !s_rx) return;
    teardown();
    ESP_LOGI(TAG, "mic off; slot peaks %d %d %d %d", s_slot_peak[0], s_slot_peak[1], s_slot_peak[2], s_slot_peak[3]);
}
