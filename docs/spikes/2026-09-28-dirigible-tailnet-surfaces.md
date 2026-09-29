# Dirigible Spike: Tailnet and Surfaces

Spike date: 2026-09-28. The source is the Page "Aeronaut & Dirigible" (pg-282d8a4e).
The prototype code is throwaway and not for merging. It is uncommitted in the
`spike-aeronaut-dirigible-086d` worktree (`.claude/worktrees/`, branch
`worktree-spike-aeronaut-dirigible-086d`, based on 76e30ea); see Reproducing.

Related: [`../Dirigible.md`](../Dirigible.md); the Tether plan
[`../plans/2026-09-28-tether-review-voice.md`](../plans/2026-09-28-tether-review-voice.md),
which left "Dirigible over Tailscale" as a research question; and the Desk's
Surface item ([`../16-Desk.md`](../16-Desk.md) §3), a different thing: a living app
on the Desk, where a device Surface here is declarative JSON the T-Deck renders.

Two questions:

1. Can Dirigible (T-Deck, ESP32-S3) join a Tailscale-like network, so it can reach
   Lee at home from another network?
2. Can Dirigible run side-loaded, agent-built "Surfaces" stored on SD and updated
   OTA?

## Summary

| Question | Answer |
|---|---|
| Tailnet via MicroLink | **Partly works.** The device joins the tailnet, gets its peer list and finds a direct route, but the WireGuard handshake is never answered by Tailscale 1.102.4. No data flows. |
| Surfaces from SD | **Works on hardware.** A JSON surface renders in about 58 ms, sends events and loads from SD. |

## 1. Tailnet (MicroLink)

### What MicroLink is

- Repository: github.com/CamM2325/microlink, MIT licence.
- It is a native Tailscale client:
  - ts2021 control protocol (Noise login, then HTTP/2)
  - DERP relay
  - disco and STUN for NAT traversal
  - MagicDNS
  - custom control servers (Headscale)
- Auth is by pre-generated auth key only (`tskey-auth-…`). There is no interactive login.
- It adds a real lwIP network interface at `<device 100.x>/10` (`ml_wg_mgr.c:257`). In
  principle Dirigible's existing WebSocket and HTTP transports could reach Lee at its
  100.x address unchanged. MagicDNS names do not resolve through lwIP, so pairing
  would have to use the IP.
- Upstream has had no commits since 2026-03-17 and has open data-path bugs (#15/#17
  pbuf double-free, #34 MTU, #36 map parse, #41 stale endpoint).
- The maintained fork `fugo101/microlink` (3.2.0, Aug 2026) requires ESP-IDF 6.x.
  Dirigible is on 5.4.

### Build cost (IDF 5.4, `idf.py size`)

| | Baseline `main` | Spike (MicroLink + SD + Surfaces) |
|---|---|---|
| Image (6 MB OTA slot) | 1,382,960 B | 1,555,600 B (+172.6 KB) |
| Static DIRAM free | 201.0 KB | 198.3 KB |

Largest components: `libmicrolink.a` 54 KB, `libwireguard_lwip.a` 19 KB,
`libfatfs.a` 19 KB, `libsdmmc.a` 14 KB.

Flash is not a constraint.

### Runtime on hardware

Internal RAM free, from a heap log every 10 s:

| State | Internal free | Minimum seen |
|---|---|---|
| Before MicroLink (Lee WS connected, LVGL running) | 111 KB | 110 KB |
| Tailnet connected | 50–70 KB | 39 KB |

Without the spike, a normal Dirigible build ran at 76–88 KB free with a 36 KB
minimum. Internal RAM is the binding constraint.

The following changes were needed to make it run:

| Problem | Change |
|---|---|
| MicroLink's 4 task stacks need 42 KB of internal RAM | 3 of them (`net_io`, `derp_tx`, `coord`) moved to PSRAM with `xTaskCreatePinnedToCoreWithCaps`. `wg_mgr` stays internal because it writes NVS, and a task with a PSRAM stack must not touch flash. |
| TLS buffers | `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y` |
| UI became sluggish | Dirigible runs FreeRTOS at 100 Hz, so MicroLink's `vTaskDelay(pdMS_TO_TICKS(1))` becomes 0 ticks and the DERP task busy-spins (about 6,000 loops/s). Fixed with `CONFIG_FREERTOS_HZ=1000`, which MicroLink's example uses. This is a firmware-wide change. |
| Lee machine dropped from the peer table | With `max_peers=4`, offline peers filled the table (`Peer table full (4 slots), cannot add air-m3`). Fixed with `priority_peer_ip` set to the Lee machine. |

### Connection results (T-Deck and AirM3 on the same LAN)

| Step | Result |
|---|---|
| Noise login | Works, 411 ms |
| Joined tailnet | Works, 100.113.90.37, about 7–9 s after WiFi |
| DERP relay and peer list | Works |
| Disco/STUN path discovery | Works. `tailscale ping` from the Mac got a pong via the direct LAN path `10.2.0.145:51820`. |
| **WireGuard handshake** | **Fails.** The device sent 26 handshake initiations (`type=1`, 148 B) to `10.2.0.158:41641` and received 0 responses. 44 DISCO and 7 STUN packets arrived on the same socket over the same period. `tailscale ping --tsmp` from the Mac also gets no reply. |
| TCP to Lee (`100.75.219.50:9001`) | Fails with `EHOSTUNREACH`. This happens both with plain BSD sockets and with MicroLink's own `microlink_tcp_connect`, which re-triggers the handshake every 5 s. |

Tailscale 1.102.4 on the Mac receives MicroLink's handshakes and silently drops them.

**Unverified hypothesis:** protocol drift between MicroLink (last updated March 2026)
and current Tailscale. Confirming it needs Mac-side tailscaled logs, or a test
against an older client or Headscale.

### Other findings

- **Handshakes are passive.** MicroLink's WireGuard peers are "passive, waiting for
  peer-initiated handshake". Plain sockets never start a handshake; only
  `microlink_tcp_connect` does. Dirigible's transports would need a
  "trigger handshake, then wait" step before dialling a 100.x address.
- **The "online" flag is wrong.** MicroLink reported every peer as "online". Meanwhile
  DERP answered `PeerGone` for pi-server, pi-dev and the iPhone, and those have been
  offline for days to months.
- **Peers added later are ignored.** A peer that joins after boot isn't picked up:
  the device logged `DISCO ping from unknown peer` until it rebooted.
- **Control plane on port 80.** The control plane uses plain TCP on port 80
  (`ml_coord.c`). Office networks that block port 80 would break it.
- **Your tailnet's DNS.** It points at a nameserver that is down. With
  `--accept-dns` on, the Mac loses name resolution, so internet appears broken. This
  is likely the real "exit node isn't working" symptom. `pi-server` (the exit node)
  is also down on the tailnet.

### Options from here

1. **Try the `fugo101/microlink` fork** in a separate IDF 6 project, against the same
   AirM3. This is the cheapest way to test the drift hypothesis.
2. **Tailscale Funnel on the Mac.** Dirigible calls HTTPS/WSS with its existing
   pairing token. Nothing extra runs on the device, and it only needs outbound 443.
   The Lee endpoint becomes public, so its security rests entirely on the token.
3. **Plain WireGuard** (`esphome/wireguard`) to a VPS or a port-forwarded home peer.
   This needs a public UDP endpoint and does no NAT traversal.

## 2. Surfaces

### Design

A surface is **declarative JSON, not code**. The device renders it with LVGL and sends
events. The logic lives in the agent's sandbox on the Lee machine, which replies with
data patches. Nothing an agent writes ever executes on the ESP32, so side-loading
from SD or OTA is safe by construction.

```json
{ "surface": "standup", "v": 1, "title": "Standup",
  "data": { "done": 3, "total": 8, "who": "agent-7",
            "items": ["Refactor pty-manager", "Fix MTU 1280", "Write tests"] },
  "root": { "col": [
    { "text": "{who}: {done}/{total} tasks" },
    { "bar": "done", "max": "total" },
    { "list": "items", "on": "pick" },
    { "row": [ { "button": "Ship", "on": "ship" }, { "button": "Hold", "on": "hold" } ] },
    { "input": "Feedback...", "on": "note", "lines": 2 }
  ] } }
```

Messages in each direction:

- Event out: `{"surface":"standup","on":"pick","value":"Fix MTU 1280","index":1}`
- Patch in: `{"surface":"standup","data":{"done":8}}`. This is a shallow merge, after
  which bound widgets re-render.

Node types:

- `col` / `row` for layout
- `text`, with `{key}` templates
- `bar`
- `list`
- `button`
- `input`, multi-line; the keyboard is the point. Enter submits.

### Results on hardware

| | Result |
|---|---|
| Render the demo (503 B JSON, 3 bindings) | 57–60 ms, about 6 KB heap |
| Events (list pick, Ship, Hold) | Correct JSON emitted |
| Patch, then re-render | Works. Tested with a local echo patch on "ship". |
| SD mount | 32 GB card (SD32G) mounts |
| SD round trip | The first open seeds `/sdcard/surfaces/standup.json`; the second open loads it from SD |

### Constraints found

- **SD needs a shared-bus change.** The SD card shares SPI2 with the ST7789, and
  `tdeck-bsp` initialised the bus with `MISO = -1`. The spike:
  - passes MISO 38
  - holds SD CS (39) and LoRa CS (9) high before bus init

  The display still works after this change.
- **Long filenames.** FAT defaults to 8.3 names, so `.json` fails to open for
  writing. It needs `CONFIG_FATFS_LFN_HEAP=y`.
- **No Lee side yet.** Lee has no `/surfaces` endpoint. Events are only logged, and
  the patch path is exercised with a local echo.
- **Small widget set.** Charts, images and Board-style canvases are out of scope for
  this format.

## Reproducing

Prototype files, all behind `DIRIGIBLE_SPIKE`:

| Path | Contents |
|---|---|
| `dirigible/firmware/main/spike_tailnet.cpp` | MicroLink start, heap logger, Lee probe |
| `dirigible/firmware/main/spike_surface.cpp` | Renderer, SD mount, save and load |
| `dirigible/firmware/main/spike.hpp` | Spike interface |
| `dirigible/firmware/sdkconfig.spike` | Config overlay (1000 Hz tick, mbedTLS in PSRAM, LFN, …) |
| `dirigible/spike/components/{microlink,wireguard_lwip}` | Vendored upstream `216da33`, with PSRAM stacks patched in `microlink.c` |
| `dirigible/platform/esp32/components/tdeck-bsp/tdeck_display.cpp` | MISO 38 and CS holds |
| `app.cpp`, `app.hpp`, both `CMakeLists.txt` | Surface view, menu entry, WiFi hook |

Build and flash. NVS is kept, so WiFi and Lee pairing survive:

```bash
DIRIGIBLE_SPIKE=1 DIRIGIBLE_TS_AUTHKEY_FILE=/path/to/tskey \
  idf.py -B build-spike -DSDKCONFIG=build-spike/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.spike" \
  -p /dev/cu.usbmodem1101 build flash
```

The key file is copied into NVS (`tailnet`/`authkey`) on first boot. The build output
contains the key, so don't share `build-spike/`.

Serial logs: `idf.py monitor`, or pyserial at 115200. Useful tags:

- `spike-tailnet`
- `spike-surface`
- `ml_wg_mgr` (look for `WG UDP TX … type=1` and `type=2`)

To restore the normal firmware:

```bash
idf.py -B build -p /dev/cu.usbmodem1101 flash
```

Then revoke the auth key in the Tailscale admin console.
