# Dirigible

A LilyGO T-Deck running firmware that talks to Lee: watch the live tab list,
type into one terminal, ask Hester a question. Plain ESP-IDF + LVGL — no
framework, no code generation.

```
dirigible/
├── core/                     portable C++ protocol layer, no ESP-IDF in it
│   ├── include/dirigible/    LeeConnection, PTYClient, HesterClient,
│   └── src/                  MachineManager, LeeContext models, EventBus
├── platform/esp32/components/
│   ├── dirigible-core/       wraps core/ as an ESP-IDF component
│   ├── dirigible-esp32/      transports (websocket/http/mdns), WiFi, NVS config
│   └── tdeck-bsp/            T-Deck board support: ST7789, GT911, keyboard,
│                             trackball, battery, LVGL glue
├── firmware/                 the ESP-IDF project (main/, sdkconfig.defaults,
│                             partitions.csv)
└── tools/dirigible-provision/  host-side NVS provisioning over USB
```

## Build

Requires ESP-IDF v5.4.

```bash
source /path/to/esp-idf/export.sh
cd dirigible/firmware
idf.py set-target esp32s3      # first time only
idf.py build
idf.py -p /dev/tty.usbmodem* flash monitor
```

The component manager fetches `lvgl`, `esp_lcd_touch_gt911`,
`esp_websocket_client` and `mdns` on the first configure, so that step needs
network access.

## Pairing

On first boot (no WiFi credentials or no machine in NVS) the device opens the
pairing flow; you can reach it later from the menu (hold the trackball).

1. pick a WiFi network from the scan
2. type the password — Enter connects and saves it
3. pick a Lee instance found over mDNS (`_lee._tcp`), or choose **Manual entry**
   and type `host` / `host:port`
4. the device shows a **6-digit code**; Lee pops a "Pair a device" dialog with
   the same code — click **Approve** there and the token arrives on its own

Step 4 is code approval (E19): the device POSTs the code and a random nonce to
Lee's unauthenticated `/pair/request`, then polls `/pair/poll` every 1.5 s for
up to 120 s while a bar counts down. Lee's dialog names the device, its kind and
its IP, defaults to **Deny**, and only an Approve releases the bearer — once.
Nobody types 36 characters on a thumb keyboard, and because the code lives on
the device's screen, a machine that merely knows Lee's address cannot pair
itself. Lee logs every approval and denial to `lee.log`.

If pairing fails (denied, expired, or Lee unreachable) the card turns red and
the footer offers **Retry** and **Token**.

**Typed-token fallback.** The old step is still there behind that **Token**
button — for a Lee older than E19, one with `hester: { pairing_enabled: false }`
in `~/.lee/config.yaml`, or a network that will not pass the POST. Type the
bearer from `cat ~/.lee/api-token`; the field counts up to `n/36` and turns
green when what you typed is a UUID. **Code** goes back to the approve screen.

Every screen carries a 20 px header (title | step/status | battery, WiFi, link
dot) and a 16 px footer key legend. The pairing screen shows four step chips
across the top, a summary card down the right that fills in as you go (SSID and
signal, IP, Lee name/host:port/workspace, Hester port, and failures in red), and
the step's own list or text entry on the left. **Back** is a footer button as
well as the ESC key, so the trackball and touch can both step backwards.

To eyeball every pairing state without a network:

```bash
idf.py -DDIRIGIBLE_UI_DEMO=1 build flash monitor   # cycles the steps every 3 s
```

Do not ship a `DIRIGIBLE_UI_DEMO` build — it drives the UI with canned data.

The token is never discovered: the mDNS advertisement deliberately carries no
`token` TXT record, since any device on the LAN can read one. It is either
approved (step 4) or typed (the fallback).

Alternatively provision over USB without touching the UI:

```bash
source /path/to/esp-idf/export.sh
python3 tools/dirigible-provision/dirigible_provision.py wifi set MySSID hunter2
python3 tools/dirigible-provision/dirigible_provision.py machine add studio 192.168.1.10 \
    --token "$(cat ~/.lee/api-token)"
python3 tools/dirigible-provision/dirigible_provision.py flash --port /dev/tty.usbmodem1101
```

## Screens

| Screen   | What it does                                                    |
|----------|-----------------------------------------------------------------|
| Tabs     | live list of Lee tabs with a type badge and a focus marker; select to focus it on the host, and open the terminal if it has a PTY. Disconnected, it names the machine it cannot reach and offers Reconnect / Re-pair |
| Terminal | character grid over the PTY WebSocket; ESC returns to Tabs. Keeps the whole content band — the footer legend flashes for 2 s on entry, then collapses so no character row is lost |
| Hester   | chat-shaped: question at the bottom, scrolling answer above, ReAct phases in the header's status slot |
| Pairing  | WiFi → Lee host → approve a 6-digit code (or type the token)      |

| Input                   | Effect                                          |
|-------------------------|-------------------------------------------------|
| trackball roll          | moves the LVGL pointer (arrow keys in Terminal) |
| trackball click         | activates what's under the pointer              |
| trackball hold (0.8 s)  | opens the menu: Tabs / Hester / Pairing / Reconnect |
| ESC                     | leaves Terminal, steps back in Pairing          |
| Tab                     | moves focus within a screen (reaches the password `show` toggle and the footer buttons) |
| touch                   | works everywhere the pointer does               |

Sym+key chords are **not** available: the T-Deck's keypad MCU resolves the
modifier itself and reports a single ASCII byte, so the firmware cannot tell
Sym+X from the symbol X produces.

## Wire protocol

Everything is authenticated with Lee's persistent API token (`~/.lee/api-token`).

| Direction | Endpoint |
|-----------|----------|
| device → Lee  | `ws://host:9001/context/stream?token=…` — live `LeeContext` |
| device → Lee  | `ws://host:9001/pty/<id>/stream?token=…` — PTY bytes out, raw text in, `{"type":"resize","cols":C,"rows":R}` to resize |
| device → Lee  | `POST http://host:9001/command` with `Authorization: Bearer …` |
| device → Lee  | `POST http://host:9001/pair/request` — **no auth**; `{device,kind,code,nonce}` → `{status:"pending",expires_in}` |
| device → Lee  | `GET http://host:9001/pair/poll?nonce=…` — **no auth**; → `pending` / `denied` / `expired` / `approved` + `{token,hester_port,name}` |
| device → Hester | `POST http://host:9000/context/stream` with the same bearer → SSE |

See `docs/Dirigible.md` for the longer version.
