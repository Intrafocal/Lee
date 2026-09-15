# Dirigible - Dedicated Hardware Controller for Lee

> A physical device on your desk that connects to Lee. Not a phone app, not a remote desktop — a purpose-built control surface for your IDE.

## Overview

**Dirigible** is a dedicated hardware device that connects to one or more Lee instances over the local network, providing always-on monitoring and physical input for driving the editor. It connects via the same HTTP/WebSocket APIs as Aeronaut (port 9001) and Spyglass, or via SSH like Bridge, depending on device capabilities.

Where Aeronaut puts Lee in your pocket, Dirigible puts Lee on your desk — a persistent, glanceable, tactile interface that doesn't compete with your phone's attention or battery.

**Design philosophy:** A dedicated device can do things a phone can't — always-on display, physical buttons/knobs, zero-distraction single-purpose UI, instant wake, and the ability to sit next to your monitor showing status without you ever picking it up.

### Naming

**Dirigible** — a steerable airship. Lee Scoresby's balloon was a dirigible, not a passive hot-air balloon — it had propulsion and control surfaces. Dirigible is the physical control surface for Lee's balloon.

The quartet:
- **Lee** — the editor (the balloon, the vehicle)
- **Hester** — the daemon (the intelligence, the awareness)
- **Aeronaut** — the mobile companion (the vantage point from afar)
- **Dirigible** — the control surface (the physical interface, the helm)

## Hardware Tiers

Dirigible targets two distinct hardware classes, each with different capabilities and constraints.

### Tier 1: Microcontroller (MCU)

Bare-metal or RTOS firmware. Constrained resources, but instant boot, zero OS overhead, and excellent power efficiency.

#### LilyGO T-Deck (Primary — ESP32-S3)

The T-Deck (non-LoRa variant) is the primary MCU target. It's a complete handheld unit with everything Dirigible needs built in — no external wiring, no BOM assembly, no 3D-printed case. Pick one up, flash it, connect to WiFi, and you have a Dirigible.

| Component | Spec |
|-----------|------|
| **MCU** | ESP32-S3 (QFN56, rev v0.2), dual-core Xtensa LX7 + LP Core, 240MHz |
| **Radio** | WiFi 802.11 b/g/n + Bluetooth 5.0 LE |
| **RAM** | 512KB SRAM + 8MB PSRAM (OPI / Octal) |
| **Flash** | 16MB GigaDevice (QIO, 80MHz) |
| **Display** | 2.8" 320x240 ST7789V IPS (SPI: MOSI=41, CLK=40, CS=12, DC=11, BL=42) |
| **Touch** | GT911 capacitive, 5-point (I2C 0x5D, INT=16) |
| **Keyboard** | BB-style QWERTY, ESP32-C3 as I2C slave (addr 0x55, INT=46, backlight controllable) |
| **Trackball** | 4-direction + click (GPIO: UP=3, DOWN=15, LEFT=1, RIGHT=2, CLICK=0/BOOT) |
| **Microphone** | ES7210 4-ch ADC (I2C 0x40 + I2S: MCLK=48, LRCK=21, SCK=47, DIN=14) |
| **Speaker** | Built-in, I2S Class-D amp (BCK=7, WS=5, DOUT=6) |
| **Storage** | MicroSD slot (SPI CS=39, shared bus with display) |
| **Power** | USB-C + LiPo connector, onboard charging, BAT_ADC on GPIO 4 |
| **Power Gate** | GPIO 10 (BOARD_POWERON) must be driven HIGH before any peripheral works |
| **I2C Bus** | SDA=18, SCL=8 (shared: keyboard, touch, mic codec) |

**Verified pin map:** See `/home/ben/Development/hardware/microcontrollers/lilygo-t-deck/BOARD.md` for full pinout and hardware notes.

The BlackBerry keyboard changes the equation for the MCU tier entirely. With a physical QWERTY keyboard, Dirigible on T-Deck can:
- **Type terminal commands** — full text input sent to PTY via WebSocket
- **Chat with Hester** — type queries, read streamed responses on the 320x240 display
- **Navigate with the trackball** — scroll through tabs, terminal output, Hester responses
- **Voice input** (later priority) — built-in mic enables speech-to-text for Hester queries

This makes the T-Deck a fully interactive Lee controller, not just a status display. It's closer to a pocket terminal than a desk widget. Keyboard input is the primary interaction model; voice is a future enhancement.

#### ESP32-P4 + C6 Combo (Future — Premium Tier)

| Component | Spec |
|-----------|------|
| **MCU** | P4: RISC-V dual-core 400MHz; C6: RISC-V single-core (radio coprocessor) |
| **Radio** | C6: WiFi 6 + BLE 5 + 802.15.4 |
| **RAM** | P4: 768KB SRAM + up to 32MB PSRAM |
| **Flash** | Up to 64MB |
| **Display** | MIPI-DSI, parallel RGB (up to 1024x600) |

The P4+C6 is the future premium tier — relevant when larger/higher-res displays are needed (e.g., a 4-5" MIPI panel for a desk-mounted dashboard). The P4's extra compute headroom enables smoother terminal rendering and richer UI. Not needed for Phase 1 given what the T-Deck already provides.

### Tier 2: Linux SBC

Full Linux userspace. Can run the same Python/Node tooling as the host, SSH natively, and leverage existing libraries.

#### Luckfox Pico Ultra (Primary Linux Target)

The Luckfox Pico Ultra paired with a 4" 720x720 MIPI DSI touch display and M5Stack CardKB creates a desk-mounted Linux Dirigible with a rich GUI, touch input, and physical keyboard.

| Component | Spec |
|-----------|------|
| **SoC** | Rockchip RV1106G (ARM Cortex-A7 @ 1.2GHz + RISC-V MCU) |
| **RAM** | 256MB DDR3L (integrated in SoC package) |
| **Storage** | 256MB SPI NAND flash + MicroSD slot |
| **WiFi** | Onboard (Ultra variant) |
| **Ethernet** | 100Mbps (RJ45 on Ultra W sub-variant, pin header otherwise) |
| **USB** | USB 2.0 OTG via USB-C |
| **NPU** | 0.5 TOPS INT8 (RKNN framework — future: wake word detection, voice intent) |
| **Camera** | MIPI CSI, hardware ISP (up to 5MP) |
| **Video** | H.264/H.265 hardware encode up to 2560x1440@30fps |
| **GPIO** | Up to 26 pins (SPI, I2C, UART, PWM, ADC) |
| **Power** | 5V via USB-C, ~1W typical |
| **Dimensions** | ~65mm x 25mm (Pico form factor) |

**Paired peripherals:**

| Peripheral | Spec | Interface |
|-----------|------|-----------|
| **Display** | 4" 720x720 IPS touch panel (ST7703/JD9365 driver) | MIPI DSI (2/4-lane) |
| **Touch** | Capacitive multi-touch (GT911 Goodix controller) | I2C (addr 0x5D or 0x14) |
| **Keyboard** | M5Stack CardKB — 56-key mini QWERTY | I2C (addr 0x5F, ATmega328P controller) |

This combination creates a Linux Dirigible with: a high-res square display for rich dashboard UI, capacitive touch for direct interaction, a physical keyboard for terminal input and Hester chat, and enough compute for comfortable Python execution, SSH, and on-device NPU inference.

**Why the Pico Ultra over the Lyra:** The Pico Ultra's 256MB RAM, onboard WiFi, MIPI DSI output, and NPU make it the strongest Linux SBC for Dirigible. The Pico form factor also makes it easy to mount behind a display panel.

#### Raspberry Pi Pico 2 W (Future — Ultra-Low-Cost)

| Component | Spec |
|-----------|------|
| **SoC** | RP2350 dual-core ARM Cortex-M33 / RISC-V Hazard3, 150MHz |
| **RAM** | 520KB SRAM (no external DRAM without add-on) |
| **Connectivity** | WiFi 4 + BLE 5.2 |
| **Display** | External SPI TFT only (no MIPI DSI) |

The Pico 2 W is a future option for a sub-$10 Dirigible running minimal Linux (Buildroot) or MicroPython. Its constrained RAM limits it to basic status display with text input — no rich GUI or terminal rendering. Included in the spec for completeness but not a Phase 1 target.

## Connection Model

Dirigible reuses the exact same APIs that Aeronaut and Spyglass use. No new server-side code is needed for basic functionality.

### MCU Tier: WebSocket + HTTP (Aeronaut Model)

```
┌─────────────────────────┐         ┌─────────────────────────────┐
│  Dirigible (ESP32)      │  WiFi   │  Dev Machine                │
│                         │◄───────►│                             │
│  WebSocket Client       │         │  Lee API Server :9001       │
│  HTTP Client            │         │  Hester Daemon  :9000       │
│  mDNS Listener          │         │  mDNS Advertiser            │
└─────────────────────────┘         └─────────────────────────────┘
```

**Protocols:**
- `ws://host:9001/context/stream` — live LeeContext updates (primary data source)
- `ws://host:9001/pty/:id/stream` — PTY output for terminal display
- `POST http://host:9001/command` — send commands (tab switch, TUI spawn, etc.)
- `POST http://host:9000/context/stream` — Hester queries (keyboard input; voice-to-text in later phases)

**Authentication:** Bearer token, same as Aeronaut. Token provisioned via:
1. QR code scan (if device has camera) — same QR as Aeronaut
2. BLE pairing — device advertises, Lee desktop pairs and pushes token
3. USB serial provisioning — connect via USB, push config from host
4. Web captive portal — ESP32 hosts a config AP on first boot, user enters WiFi creds + Lee host + token

### Linux Tier: WebSocket + HTTP + SSH (Spyglass/Bridge Model)

```
┌─────────────────────────┐         ┌─────────────────────────────┐
│  Dirigible (Luckfox)    │ WiFi/   │  Dev Machine                │
│                         │ Eth     │                             │
│  WebSocket Client       │◄───────►│  Lee API Server :9001       │
│  HTTP Client            │         │  Hester Daemon  :9000       │
│  SSH Client             │         │  SSH Server     :22         │
│  mDNS Listener          │         │  mDNS Advertiser            │
└─────────────────────────┘         └─────────────────────────────┘
```

**Additional capabilities over MCU tier:**
- SSH key-based auth (like Bridge) — can fetch `~/.lee/api-token` automatically
- SSH tunnel for PTY access (alternative to WebSocket, more reliable for poor networks)
- Can run Bridge-style TUI execution if attached to a capable display
- Can run a local Hester client process for richer AI interaction

**Authentication:** Same as Spyglass — SSH key exchange for token retrieval, then Bearer token for API calls. The Linux tier can manage SSH keys natively, making setup frictionless if the device's public key is in the host's `authorized_keys`.

## Device Capabilities by Tier

### What Each Tier Can Do

| Capability | T-Deck (ESP32-S3) | ESP32-P4+C6 | Luckfox Pico Ultra | Pico 2 W |
|------------|-------------------|-------------|---------------------|----------|
| **Context display** (tabs, file, status) | Yes (320x240 TFT) | Yes | Yes (720x720 touch) | Yes (small SPI TFT) |
| **Tab switching** | Trackball + keyboard | Touch | Touch + CardKB | Buttons |
| **Terminal output display** | Yes (320x240, ANSI color) | Yes (high-res) | Yes (720x720, full ANSI) | Limited |
| **Terminal input** (keyboard) | Yes (BB QWERTY) | Touch keyboard | Yes (CardKB) | No |
| **Hester chat** (text) | Yes (type + read) | Yes | Yes (type + read) | Request only |
| **Hester chat** (voice, later) | Possible (built-in mic + speaker) | With I2S mic + speaker | With I2S/USB audio + NPU | No |
| **Browser cast viewing** | Limited (JPEG decode is tight on S3) | Yes (JPEG decode) | Yes (hardware decode) | No |
| **File tree browsing** | Yes (trackball navigation) | Touch-based | Yes (touch + keyboard) | No |
| **Multi-machine** | Yes (keyboard shortcut) | Yes (touch selector) | Yes | Yes (button cycle) |
| **SSH/Bridge** | No | No | Yes | Yes (minimal) |
| **Local AI** (wake word, intent) | No | No | Yes (0.5 TOPS NPU) | No |
| **Portable / battery** | Yes (JST LiPo connector) | Depends on board | Power bank | Power bank |

### Display by Board

| Board | Display | Resolution | Interface | Notes |
|-------|---------|------------|-----------|-------|
| T-Deck | Built-in ST7789V TFT | 320x240 | SPI | No assembly needed, handheld |
| ESP32-P4+C6 | External MIPI-DSI panel | Up to 1024x600 | MIPI-DSI | Higher res, desk-mounted |
| Luckfox Pico Ultra | 4" IPS touch panel (ST7703/JD9365 + GT911 touch) | 720x720 | MIPI DSI + I2C touch | Desk-mounted, rich GUI |
| Pico 2 W | External SPI TFT | 240x240 / 320x240 | SPI | Requires wiring, basic |

## Firmware Architecture

### MCU Tier — T-Deck (ESP-IDF)

```
dirigible-mcu/
├── main/
│   ├── main.c                    # Entry point, task creation
│   ├── wifi.c                    # WiFi provisioning + connection
│   ├── mdns_discovery.c          # mDNS listener for _lee._tcp
│   ├── ws_client.c               # WebSocket client (context + PTY streams)
│   ├── http_client.c             # HTTP client (commands, health, Hester SSE)
│   ├── lee_context.c             # LeeContext parser (minimal JSON)
│   ├── display.c                 # ST7789V SPI display driver (320x240)
│   ├── touch.c                   # GT911 capacitive touch (I2C 0x5D)
│   ├── keyboard.c                # ESP32-C3 I2C keyboard slave (addr 0x55)
│   ├── trackball.c               # Trackball input (GPIO, 4-dir + click)
│   ├── power.c                   # Power gate (GPIO 10), battery ADC (GPIO 4)
│   ├── audio.c                   # ES7210 mic + I2S speaker (later phase)
│   ├── ui/
│   │   ├── status_screen.c       # Main status display (tabs, editor info)
│   │   ├── tab_list.c            # Tab navigator (trackball-driven)
│   │   ├── terminal_view.c       # PTY output renderer (ANSI subset)
│   │   ├── hester_chat.c         # Hester conversation view
│   │   ├── text_input.c          # Keyboard text entry (terminal + Hester)
│   │   ├── machine_picker.c      # Multi-machine selector
│   │   └── file_browser.c        # File tree navigator
│   └── config.c                  # NVS-based config storage
├── components/
│   ├── lvgl/                     # LVGL graphics library
│   └── cJSON/                    # JSON parser
├── partitions.csv
├── sdkconfig
└── CMakeLists.txt
```

**T-Deck peripheral map:**

| Peripheral | Interface | Driver | Notes |
|-----------|-----------|--------|-------|
| Power gate | GPIO 10 (BOARD_POWERON) | `main.c` | **Must be HIGH first** or nothing works |
| ST7789V display | SPI (MOSI=41, SCLK=40, CS=12, DC=11, BL=42) | `display.c` | 320x240 IPS, 16-bit color, custom init sequence |
| GT911 touch | I2C @ 0x5D (INT=16) | `touch.c` | 5-point capacitive, shares I2C bus |
| BB Keyboard | I2C @ 0x55 (INT=46), ESP32-C3 slave | `keyboard.c` | Read 1 byte (0x00=no key), write 0x01+byte for backlight |
| Trackball | GPIO (UP=3, DOWN=15, LEFT=1, RIGHT=2, CLICK=0) | `trackball.c` | Click shares GPIO 0 with BOOT |
| ES7210 mic | I2C @ 0x40 + I2S (MCLK=48, LRCK=21, SCK=47, DIN=14) | `audio.c` | 4-ch ADC, TDM mode, 16kHz (later phase) |
| Speaker | I2S (BCK=7, WS=5, DOUT=6) | `audio.c` | Class-D amp (later phase, alerts first) |
| MicroSD | SPI (CS=39, shared bus with display) | ESP-IDF SDMMC | Log storage, config backup |
| Battery | ADC on GPIO 4 | `power.c` | Voltage monitoring for status bar |

**Key design decisions for T-Deck:**

1. **LVGL for UI** — the 320x240 display is large enough for a proper GUI. LVGL provides scrollable lists, text areas, and styling with reasonable memory use. The T-Deck's display is the same class as the Dashboard Mode spec.

2. **Keyboard as primary input** — the BB keyboard maps naturally to:
   - Terminal input: characters sent to PTY WebSocket as typed
   - Hester chat: type messages, send with Enter
   - Navigation: arrow-like keys or trackball for tab selection
   - Shortcuts: `Sym+key` combos for macros (e.g., `Sym+G` = open git, `Sym+T` = new terminal)

3. **Trackball for navigation** — replaces touch/encoder:
   - Up/Down: scroll through tabs, terminal output, Hester messages
   - Left/Right: switch between UI panels (tab list ↔ content)
   - Click: select/confirm (focus tab, send command)

4. **FreeRTOS task structure:**
   - `wifi_task` — connection management, reconnect
   - `ws_task` — WebSocket receive loop, context + PTY parsing
   - `ui_task` — LVGL rendering (pinned to core 1)
   - `input_task` — keyboard interrupt handler + trackball polling
   - `audio_task` — mic capture / speaker playback (later phase, when active)

5. **Memory budget (T-Deck: 8MB PSRAM):**
   - LVGL framebuffer (2x): 320x240x2 x2 = ~300KB (double-buffered)
   - LVGL working memory: ~64KB
   - WebSocket receive buffer: 4KB (context) + 8KB (PTY ring buffer)
   - Terminal scrollback: ~32KB (holds ~500 lines at 80 cols)
   - Hester chat history: ~16KB (last ~20 messages)
   - HTTP/SSE response buffer: 4KB
   - cJSON working memory: ~8KB
   - WiFi stack: ~50KB
   - Free PSRAM: ~7.5MB (comfortable headroom)

6. **Power management:**
   - Display backlight dimming after idle timeout (from `LeeContext.activity.idleSeconds`)
   - Light sleep between context updates when on battery
   - Deep sleep when all machines offline for >5 minutes, wake on keyboard press
   - Battery voltage monitoring via ADC (show battery level on status bar)

### Linux Tier (Python — Luckfox Pico Ultra)

```
dirigible-linux/
├── dirigible/
│   ├── __init__.py
│   ├── main.py                   # Entry point, asyncio event loop
│   ├── connection.py             # WebSocket + HTTP client (reuse Aeronaut patterns)
│   ├── ssh_client.py             # SSH key management + token fetch
│   ├── discovery.py              # mDNS / Avahi listener
│   ├── context.py                # LeeContext model + state management
│   ├── config.py                 # YAML config (~/.dirigible/config.yaml)
│   ├── display/
│   │   ├── __init__.py
│   │   ├── mipi_dsi.py           # MIPI DSI framebuffer driver (720x720)
│   │   ├── renderer.py           # UI rendering (Pillow or Cairo → framebuffer)
│   │   └── terminal_renderer.py  # ANSI terminal output renderer
│   ├── input/
│   │   ├── __init__.py
│   │   ├── cardkb.py             # M5Stack CardKB I2C driver (addr 0x5F)
│   │   ├── touch.py              # GT911 touch via evdev (/dev/input/eventN)
│   │   └── gpio_buttons.py       # Optional GPIO buttons via gpiod
│   ├── audio/
│   │   ├── __init__.py
│   │   ├── mic.py                # Microphone capture (ALSA)
│   │   ├── speaker.py            # Audio playback for Hester TTS
│   │   └── wake_word.py          # RKNN NPU wake word detection
│   ├── led.py                    # GPIO LED / NeoPixel (via SPI)
│   └── machines.py               # Multi-machine management
├── models/
│   └── wake_word.rknn            # Pre-trained wake word model for NPU
├── config/
│   └── config.example.yaml
├── systemd/
│   └── dirigible.service         # Auto-start on boot
├── setup.py
└── requirements.txt              # websockets, aiohttp, httpx, Pillow, evdev, smbus2, rknn-lite
```

**Key design decisions for Linux (Luckfox Pico Ultra):**

1. **asyncio throughout** — single event loop for WebSocket receive, HTTP commands, display updates, and input polling. Same async patterns as Hester daemon.

2. **Display rendering** — `renderer.py` draws to a Pillow Image (720x720), then blits to the Linux framebuffer (`/dev/fb0`) backed by the MIPI DSI panel. The GT911 touch events come through evdev. This is the same pattern used by many embedded Linux GUI projects — no X11 or Wayland needed.

3. **CardKB integration** — `cardkb.py` polls the ATmega328P at I2C address 0x5F via `smbus2`. Each read returns a single byte (ASCII value of last keypress, or 0x00). Modifier layers (Fn, Sym) are handled by the CardKB firmware — we receive the final mapped character.

4. **SSH-first auth** — on first boot, generate an SSH keypair. User adds the public key to their dev machine. Dirigible then fetches `~/.lee/api-token` via SSH automatically — no manual token entry needed.

5. **NPU wake word (later phase)** — the RV1106's 0.5 TOPS NPU can run a small RKNN model for "hey hester" detection. This is a future feature; initial focus is keyboard-driven interaction via CardKB. When implemented: mic audio is continuously buffered, wake word triggers send subsequent audio to Hester for speech-to-text and intent processing.

6. **Memory budget (256MB DDR3L):**
   - Linux kernel + rootfs: ~40MB
   - Python runtime: ~12MB
   - WebSocket + HTTP clients: ~3MB
   - Display rendering (Pillow, 720x720): ~4MB (framebuffer + working surface)
   - RKNN runtime + model: ~15MB
   - Audio buffers: ~2MB
   - Free: ~180MB (very comfortable)

## Configuration

### MCU Tier (T-Deck)

Provisioned via one of:
1. **On-device setup wizard** — T-Deck has a keyboard and display, so first boot shows a setup screen: select WiFi (scan visible networks), type password, enter Lee host + port + token. No second device needed.
2. **USB serial** — connect to computer, run `dirigible-provision` CLI tool that writes config to NVS
3. **BLE provisioning** — receive config push from Aeronaut app or Lee desktop

```json
// NVS config structure (T-Deck)
{
  "wifi_ssid": "MyNetwork",
  "wifi_pass": "...",
  "machines": [
    {
      "name": "MacBook Pro",
      "host": "192.168.1.100",
      "host_port": 9001,
      "hester_port": 9000,
      "token": "bearer-token-here"
    }
  ],
  "display": {
    "brightness": 80,
    "idle_dim_seconds": 120
  },
  "shortcuts": {
    "sym_g": { "domain": "tui", "action": "git" },
    "sym_t": { "domain": "tui", "action": "terminal" },
    "sym_d": { "domain": "tui", "action": "docker" },
    "sym_h": { "action": "focus_hester" },
    "sym_c": { "domain": "tui", "action": "claude" },
    "sym_s": { "domain": "editor", "action": "save" },
    "sym_m": { "action": "next_machine" },
    "sym_w": { "domain": "system", "action": "close_tab" }
  }
}
```

### Linux Tier (Luckfox Pico Ultra)

```yaml
# ~/.dirigible/config.yaml

machines:
  - name: MacBook Pro
    host: 192.168.1.100
    user: ben
    ssh_port: 22
    lee_port: 9001
    hester_port: 9000
    # token fetched automatically via SSH

  - name: Mac Mini
    host: 192.168.1.101
    user: ben
    lee_port: 9001
    hester_port: 9000

display:
  driver: mipi_dsi          # mipi_dsi | spi | framebuffer
  width: 720
  height: 720
  brightness: 80
  idle_dim_seconds: 120
  touch:
    driver: gt911            # GT911 capacitive touch controller
    i2c_addr: 0x5D           # or 0x14 depending on reset timing

input:
  keyboard:
    driver: cardkb           # M5Stack CardKB
    i2c_addr: 0x5F
  # Same shortcut mapping as T-Deck (Sym/Fn combos → Lee commands)

audio:
  mic: default               # ALSA device (I2S or USB mic)
  speaker: default
  wake_word: "hey hester"       # RKNN NPU inference

led:
  type: neopixel             # neopixel | gpio
  pin: 18
  count: 1

network:
  prefer: wifi               # wifi | ethernet (Ultra W variant has RJ45)
  mdns: true                 # listen for _lee._tcp.local

npu:
  enabled: true
  model_path: /opt/dirigible/models/
  wake_word_model: wake_word.rknn
```

## UI Modes

Dirigible adapts its UI to the display size and device capabilities.

### Handheld Mode (320x240 — T-Deck)

```
┌─────────────────────────────────────────┐
│  MacBook Pro ●                    12:34 │
├──────────────────┬──────────────────────┤
│ Tabs             │ Editor               │
│ ▸ main.py     ✎ │ /src/main.py         │
│   Terminal 1     │ python  L42:C5       │
│   lazygit        │                      │
│   lazydocker     │ ── Terminal 1 ────── │
│   github.com     │ $ npm run build      │
│                  │ ✓ Build complete     │
│                  │ $ _                  │
├──────────────────┴──────────────────────┤
│ Hester: idle  │  Git: 3 staged  │ 2m ↑ │
└─────────────────────────────────────────┘
 [BB keyboard: type commands / Hester chat]
```

- Split layout: tab list (left) + content panel (right)
- Trackball navigates: up/down selects tabs, left/right switches panels, click confirms
- Terminal output rendered with basic ANSI color support
- Keyboard input goes to active context:
  - Terminal tab focused → keystrokes sent to PTY via WebSocket
  - Hester panel focused → typing a Hester query
  - Tab list focused → type-to-filter tabs
- Status bar: Hester state, git summary, idle time, battery level
- `Sym+key` shortcuts for quick actions (see Input Mapping below)

The 320x240 display is small but the split layout is readable at arm's length. The key advantage over a phone is the physical keyboard — typing `git push` on a BB keyboard is faster than any phone keyboard, and the device is always on and connected.

### Desk Mode (720x720 — Luckfox Pico Ultra)

```
┌──────────────────────────────────────────────────┐
│  MacBook Pro ●                          12:34 PM │
├──────────────┬───────────────────────────────────┤
│  Tabs        │                                   │
│              │  /src/main.py                     │
│  ▸ main.py ✎│  python  L42:C5  (modified)       │
│    Term 1    │                                   │
│    lazygit   │  ─── Terminal 1 ──────────────── │
│    docker    │  $ npm run build                  │
│    github    │  > Building modules...            │
│              │  > Compiled 142 modules           │
│              │  ✓ Build complete (4.2s)          │
│              │  $ npm test                       │
│              │  > Running 47 tests...            │
│              │  > 47 passed, 0 failed            │
│              │  $ _                              │
│              │                                   │
├──────────────┤                                   │
│  Hester      │                                   │
│  ┌────────┐  │                                   │
│  │ Ready  │  │                                   │
│  └────────┘  │                                   │
├──────────────┴───────────────────────────────────┤
│  Git: main ↑3  │  Docker: 2 running  │  idle 45s │
└──────────────────────────────────────────────────┘
 [CardKB: type commands / Hester chat / navigate]
```

At 720x720, Dirigible renders a rich GUI comparable to Spyglass:

- **Square aspect ratio** works well for a balanced sidebar + content split
- Full tab strip with type icons in left panel
- Terminal emulation with proper ANSI color rendering (enough resolution for ~80 columns)
- Hester chat panel in left sidebar below tabs — always visible, type to ask
- Touch input: tap tabs, scroll terminal output, interact with Hester
- CardKB for text input: terminal commands, Hester queries, file search
- Editor file content with syntax highlighting
- Machine switcher accessible via touch or keyboard shortcut
- Status bar with git, Docker, idle time

The 720x720 square display is the same pixel count as a 1020x510 widescreen — plenty for a comfortable dashboard that sits next to your monitor. Primary interaction is through the CardKB and touch. In later phases, the NPU enables ambient voice: "Hey Hester, what's the status of the build?"

## Physical Input Mapping

### T-Deck: Keyboard + Trackball

**Trackball navigation:**

| Input | Context: Tab List | Context: Content Panel | Context: Hester |
|-------|-------------------|----------------------|-----------------|
| Up | Previous tab | Scroll up | Scroll up through messages |
| Down | Next tab | Scroll down | Scroll down through messages |
| Left | Focus tab list | Switch to tab list | Switch to tab list |
| Right | Focus content panel | (no-op) | (no-op) |
| Click | Focus selected tab | (context-dependent) | Send message |

**Keyboard input routing:**

The keyboard routes to the active context:
- **Terminal tab focused** → keystrokes sent as PTY input via WebSocket (including Enter, Backspace, Ctrl combos)
- **Hester panel focused** → keystrokes build a query string, Enter sends to Hester SSE endpoint
- **Tab list focused** → type-to-filter tab names

**Sym+key shortcuts** (programmable):

| Shortcut | Default Action | Lee Command |
|----------|---------------|-------------|
| `Sym+G` | Open git (lazygit) | `{domain: "tui", action: "git"}` |
| `Sym+T` | New terminal | `{domain: "tui", action: "terminal"}` |
| `Sym+D` | Open Docker | `{domain: "tui", action: "docker"}` |
| `Sym+H` | Focus Hester panel | Internal: switch context to Hester input |
| `Sym+C` | Open Claude | `{domain: "tui", action: "claude"}` |
| `Sym+S` | Save current file | `{domain: "editor", action: "save"}` |
| `Sym+M` | Next machine | Internal: cycle active machine |
| `Sym+W` | Close current tab | `{domain: "system", action: "close_tab"}` |
| `Sym+1-9` | Switch to tab N | `{domain: "system", action: "focus_tab", params: {tab_id: N}}` |
| `Sym+V` | Voice input (later phase) | Internal: start mic capture → Hester |

Shortcuts are configurable in NVS config. The Sym key acts as the equivalent of Lee's `Cmd` modifier.

### Luckfox Pico Ultra: Touch + CardKB

**Touch input (GT911, 720x720):**

- Tap tab in sidebar → focus tab
- Tap Hester panel → focus Hester input
- Scroll (vertical swipe) → scroll terminal output / Hester messages
- Swipe left on tab → close tab
- Long press tab → context menu (close, move, etc.)
- Tap status bar machine name → machine picker

**CardKB input (I2C 0x5F):**

Same routing logic as T-Deck keyboard — keystrokes go to the active context (terminal, Hester, or tab filter). The CardKB's Fn/Sym layers provide shortcut combos matching the T-Deck mapping above.

The CardKB reads as single ASCII bytes over I2C, so modifier handling (Sym+key → command) is done in firmware by intercepting the mapped byte values before routing to the active context.

## LED Status Indicators

Single NeoPixel or RGB LED communicates device + Lee state:

| Color | Pattern | Meaning |
|-------|---------|---------|
| Green | Solid | Connected, user active |
| Green | Slow pulse | Connected, user idle |
| Yellow | Solid | Connected, Hester processing |
| Blue | Breathing | Hester thinking (ReAct phase) |
| Red | Solid | All machines offline |
| Red | Fast blink | Connection lost, retrying |
| White | Quick flash | Command sent successfully |
| Purple | Solid | Provisioning mode (WiFi AP / BLE) |

LED state derived from:
- `LeeContext.activity.idleSeconds` → idle detection
- WebSocket connection state → online/offline
- Hester SSE phase events → thinking indicator
- HTTP response to commands → confirmation flash

## Discovery & Pairing

### mDNS (Zero-Config)

Lee already plans mDNS advertisement (`_lee._tcp.local`). Dirigible listens for these announcements:

```
Service: _lee._tcp.local
Port: 9001
TXT: { workspace: "/Users/ben/project", name: "MacBook Pro" }
```

MCU tier uses `mdns` component from ESP-IDF. Linux tier uses Avahi (`avahi-browse`).

mDNS provides discovery only — authentication still required via token.

### Pairing Flow (T-Deck)

```
1. First boot → setup wizard on the T-Deck's own screen
2. Display shows list of visible WiFi networks (ESP32 scan)
3. User selects network with trackball, types password on BB keyboard
4. T-Deck connects to WiFi, starts mDNS scan for _lee._tcp
5. If Lee instances found → display list, user selects one
6. If not found → user types host IP + port manually on keyboard
7. User types bearer token (from ~/.lee/api-token on host)
8. Config saved to NVS, WebSocket connects, status displayed
```

The T-Deck's keyboard + display make it fully self-provisioning — no phone, no laptop, no captive portal needed. Alternatively:
- **BLE provisioning** from Aeronaut app — push machine config + token to a nearby T-Deck
- **USB serial** — run `dirigible-provision` CLI tool on the host machine

### Pairing Flow (Luckfox)

```
1. First boot → generate SSH keypair at ~/.dirigible/id_ed25519
2. Display shows public key (and QR code) on 720x720 screen
3. User adds public key to dev machine: ~/.ssh/authorized_keys
4. User creates ~/.dirigible/config.yaml (SSH in, or via web UI if enabled)
5. Dirigible SSH-es to host, fetches ~/.lee/api-token
6. Connects via WebSocket, Desk Mode UI appears
```

With SSH key auth, subsequent connections are automatic — the Luckfox fetches a fresh token on boot without user intervention.

## Multi-Machine Support

Like Aeronaut, Dirigible can connect to multiple Lee instances:

- **MCU tier:** stores up to 4 machine configs in NVS. Button cycles between them. Display shows active machine name. Only one WebSocket connection active at a time (memory constraint).
- **Linux tier:** unlimited machines in config. Can maintain background health pings to all, active WebSocket to one (or multiple on Luckfox with enough RAM).

Machine health status shown as LED color per machine (if multiple LEDs) or cycled on single LED.

## Power & Deployment

### T-Deck
- **Power:** USB-C (5V) or LiPo battery (JST 1.25mm connector, onboard charging)
- **Boot time:** <2 seconds to display, <5 seconds to WiFi connected
- **Enclosure:** T-Deck ships in its own case — no enclosure needed
- **Portable use:** With a LiPo battery, the T-Deck is fully portable. Carry it between rooms, use on the couch, bring to a meeting.
- **Deep sleep current:** ~10uA, wake on keyboard press or trackball click

### Luckfox Desk Unit
- **Power:** USB-C (5V/2A) — powers Pico Ultra, display, and peripherals
- **Boot time:** 5-15 seconds (depends on Linux config, initramfs helps)
- **Enclosure:** 3D-printed desk stand holding display + Pico Ultra + CardKB. The square 720x720 display sits upright, CardKB in front, Pico Ultra mounted behind.
- **Auto-start:** systemd service, starts on boot, restarts on crash
- **Updates:** `git pull` + `systemctl restart dirigible`, or OTA via HTTP endpoint on device

## Integration with Existing Components

### Lee API Server (port 9001) — No Changes Needed

Dirigible is just another WebSocket client, identical to Aeronaut or Spyglass from the server's perspective. The existing API already supports:
- Context streaming via WebSocket
- PTY streaming via WebSocket
- Command execution via HTTP POST
- Bearer token authentication
- Health checks

### Hester Daemon (port 9000) — No Changes Needed

Dirigible can query Hester via the same SSE streaming endpoint Aeronaut uses. The `source` field in requests identifies the client:

```json
POST /context/stream
{
  "session_id": "dirigible-abc123",
  "source": "Dirigible",
  "message": "What's the status of the current branch?"
}
```

### Machine Config (`.lee/config.yaml`) — Optional Addition

Dirigible devices could appear in the machines list for bidirectional awareness:

```yaml
machines:
  - name: Desk Controller
    emoji: "🎛️"
    type: dirigible            # new type, informational
    host: 192.168.1.150
    capabilities:
      - display
      - buttons
      - led
```

This would let Lee show "Desk Controller connected" in the status bar and let Hester know a physical controller is available (e.g., Hester could flash the LED to get your attention).

### Hester → Dirigible (Push Commands)

For the Linux tier, Dirigible could optionally run a small HTTP server (like Lee's API server pattern) that Hester can call to:
- Flash the LED a specific color (alert)
- Display a notification on screen
- Play an audio alert
- Update a status message

```
POST http://dirigible-host:9002/alert
{
  "type": "led",
  "color": "red",
  "pattern": "flash",
  "message": "Build failed on MacBook Pro"
}
```

This is optional — the Luckfox can run a small HTTP server alongside its client. The T-Deck is client-only (no inbound connections).

## Implementation Phases

### Phase 1: T-Deck Core

**Goal:** A handheld Lee controller — see tabs, switch between them, connect to a machine. The foundation everything else builds on.

- [ ] ESP-IDF project scaffold with WiFi + WebSocket client
- [ ] T-Deck hardware init (display, keyboard, trackball)
- [ ] ST7789V display driver (320x240) + LVGL integration
- [ ] TCA8418-compatible keyboard driver (I2C 0x55, interrupt-driven)
- [ ] Trackball driver (GPIO, 4-dir + click)
- [ ] LeeContext JSON parser (cJSON, extract: tabs, editor, activity, workspace)
- [ ] WebSocket client for `/context/stream` with auto-reconnect
- [ ] HTTP client for `POST /command`
- [ ] Handheld Mode UI: split layout (tab list + content panel + status bar)
- [ ] Trackball navigation: scroll tabs, switch panels, select
- [ ] NVS config storage (WiFi + 1 machine)
- [ ] On-device WiFi setup wizard (use keyboard + display, no external device needed)
- [ ] Bearer token auth on WebSocket + HTTP

### Phase 2: T-Deck Interactive

**Goal:** Type commands into remote terminals and chat with Hester from the T-Deck.

- [ ] PTY WebSocket client (`/pty/:id/stream`) — subscribe to active terminal tab
- [ ] Terminal output rendering (basic ANSI color subset on 320x240)
- [ ] Keyboard → PTY input routing (type commands, send on Enter)
- [ ] Terminal scrollback buffer (~500 lines)
- [ ] Hester SSE client (`POST /context/stream`) — send queries, stream responses
- [ ] Hester chat UI in content panel (message list + input line)
- [ ] `Sym+key` shortcut system (configurable macros)
- [ ] Multi-machine support (up to 4, `Sym+M` to cycle)
- [ ] mDNS discovery for Lee instances
- [ ] BLE provisioning (receive config from Aeronaut)

### Phase 3: T-Deck Polish + Portable

**Goal:** Battery-powered portable use, power management, and UX refinements.

- [ ] Battery level monitoring (ADC → status bar display)
- [ ] Power management: backlight dimming, light sleep on idle, deep sleep when offline
- [ ] File tree browser UI (via Lee `/fs/readdir` endpoint, if available)
- [ ] MicroSD logging (debug logs, config backup)
- [ ] Speaker output for alerts (command confirmation beep, error tone)
- [ ] (Later) MSM261S4030H0R mic capture (I2S)
- [ ] (Later) Voice input: `Sym+V` starts recording, release sends to Hester

### Phase 4: Luckfox Desk Unit

**Goal:** Full-featured desk controller with 720x720 touch display, CardKB, and terminal viewing.

- [ ] Python project scaffold (asyncio + websockets + aiohttp)
- [ ] SSH key generation + automatic token fetch from host
- [ ] WebSocket context client (reuse patterns from Hester's `lee_client.py`)
- [ ] MIPI DSI framebuffer driver (720x720)
- [ ] GT911 touch input via evdev
- [ ] M5Stack CardKB I2C driver (smbus2, addr 0x5F)
- [ ] Desk Mode UI: sidebar (tabs + Hester) + content panel + status bar
- [ ] PTY stream rendering (full ANSI color, ~80 column terminal at 720px width)
- [ ] Hester chat panel with SSE streaming + ReAct phase display
- [ ] NeoPixel LED driver
- [ ] systemd service for auto-start
- [ ] YAML config
- [ ] mDNS discovery via Avahi
- [ ] Multi-machine with background health pings

### Phase 5: Voice & AI (Both Devices — Later Priority)

**Goal:** Ambient voice interaction — talk to Hester from your desk or handheld.

- [ ] Luckfox: I2S / USB microphone capture (ALSA)
- [ ] Luckfox: Wake word detection via RKNN NPU ("hey hester")
- [ ] Luckfox: Continuous mic monitoring → NPU inference → trigger on wake word
- [ ] T-Deck: MSM261S4030H0R mic capture (I2S), `Sym+V` push-to-talk
- [ ] Audio → Hester via SSE streaming (both devices)
- [ ] Speaker playback for Hester TTS responses (both devices)
- [ ] Push notification HTTP server on Luckfox (Hester → Dirigible alerts)
- [ ] Notification display + dismissal (touch or keyboard)

### Phase 6: ESP32-P4 + C6 (Future)

**Goal:** High-performance MCU tier for larger desk-mounted displays.

- [ ] P4 + C6 combo firmware (P4 main, C6 radio coprocessor)
- [ ] MIPI-DSI or parallel RGB display driver (up to 1024x600)
- [ ] Touch input driver
- [ ] Full terminal rendering with ANSI color at higher resolution
- [ ] Desk Mode UI adapted for widescreen aspect ratios

## Bill of Materials (Estimated)

### T-Deck Handheld (~$40-50)

| Part | Est. Cost |
|------|-----------|
| LilyGO T-Deck (non-LoRa) | $35-45 |
| USB-C cable | $2 |
| LiPo battery (optional, for portable use) | $5 |

The T-Deck is a single unit — display, keyboard, trackball, mic, speaker, ESP32-S3 all integrated. No assembly, no wiring, no case needed.

### Luckfox Desk Unit (~$55-75)

| Part | Est. Cost |
|------|-----------|
| Luckfox Pico Ultra (256MB) | $12-15 |
| 4" 720x720 MIPI DSI touch display | $18-25 |
| M5Stack CardKB | $10-12 |
| I2S MEMS microphone | $3 |
| Small speaker + amp | $3 |
| NeoPixel (WS2812B) | $0.50 |
| FPC adapter / breakout (if needed for DSI) | $3-5 |
| 3D printed case / desk stand | $5 |
| USB-C cable + power supply | $4 |

## Security Considerations

- **LAN-only by default** — no internet-facing ports, same trust model as Aeronaut
- **Bearer token auth** — same token mechanism as Aeronaut/Spyglass
- **SSH key auth** (Linux tier) — standard key-based auth, no passwords stored
- **No code editing capability** — Dirigible is read + command only, reducing blast radius
- **Captive portal** is HTTP only (local AP, not internet) — acceptable for provisioning
- **BLE pairing** should use passkey confirmation to prevent MITM
- **NVS encryption** (ESP32) — WiFi password and bearer token stored in encrypted NVS partition
- **Config file permissions** (Linux) — `~/.dirigible/config.yaml` mode 0600

## Open Questions

1. **OTA firmware updates for T-Deck?** ESP32-S3 supports OTA via HTTP. Could Lee serve firmware images from the API server, or should Dirigible check a separate update endpoint? OTA is important for iterating on the T-Deck firmware without re-flashing via USB every time.

2. **USB HID dual-mode on T-Deck?** The ESP32-S3 has native USB — when connected to the dev machine via USB-C, Dirigible could act as a USB HID macro keyboard, sending keystrokes directly to the OS. This would enable key combos that aren't possible via the Lee command API (e.g., triggering OS-level shortcuts). Could toggle between USB serial (for flashing/debug) and USB HID (for macro mode).

3. **Luckfox DSI adapter availability?** The Pico Ultra exposes MIPI DSI but the FPC connector/pinout may not match common 720x720 panels directly. Need to verify whether an adapter board is required and whether one exists commercially or needs to be designed.

4. **CardKB latency and key repeat?** The CardKB polls at I2C speed and returns one byte per read — need to verify that key repeat and rapid typing feel responsive enough for terminal input. May need to increase I2C clock or implement client-side key repeat.

5. **Should the Luckfox run a local web UI for config?** A small FastAPI server on the device could serve a config page accessible from a browser on the LAN, making setup easier than SSH + editing YAML.

6. **Notification model?** When Lee/Hester detects events (build failure, test pass, long idle), how should Dirigible display them? Options: toast overlay, dedicated notification panel, LED flash only, audio alert. How dismissed — keyboard press, touch, timeout, or only from Lee?

7. **T-Deck as a standalone Hester terminal?** The T-Deck could work as a pure Hester chat device even without Lee running — connecting directly to Hester daemon for AI queries. Useful for: quick questions while away from desk, portable research tool. Worth supporting as a secondary mode?

8. **Shared shortcut config between T-Deck and Luckfox?** Both devices use the same `Sym+key` → Lee command mapping. Should this config live on the device, or should Lee serve it (so changing shortcuts on one device updates all)?
