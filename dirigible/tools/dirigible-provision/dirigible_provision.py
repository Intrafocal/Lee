#!/usr/bin/env python3
"""
dirigible-provision — host-side CLI for managing Dirigible's NVS config.

Reads / writes a YAML config at ~/.dirigible/config.yaml on the host, then
generates an ESP-IDF NVS partition image and flashes it to a connected
T-Deck via esptool.

Why this exists: until the on-device WiFi/text-input UI bugs are fixed
upstream (B14, B15, B16 in hardware/docs/DirigibleBugs.md), there's no
way to add a machine or set WiFi credentials from the device itself.
This tool bypasses the broken UI by writing config directly to the NVS
partition over USB.

Usage:
    dirigible-provision wifi set <ssid> <password>
    dirigible-provision machine add <name> <host> [--user user] [--lee-port 9001] [--hester-port 9000]
    dirigible-provision machine remove <name>
    dirigible-provision machine list
    dirigible-provision machine set-token <name> <token>
    dirigible-provision flash [--port /dev/ttyACM0] [--keep-app]
    dirigible-provision status

NVS layout written by this tool (matches dirigible-esp32 ConfigNvs and
screenschema SSWifiManager):

    Namespace "ss_wifi":
        ssid       (string)   WiFi SSID
        password   (string)   WiFi password

    Namespace "dirigible":
        mach_count (u8)       Number of configured machines
        m{i}_name        (string)   Machine display name
        m{i}_host        (string)   Hostname or IP
        m{i}_user        (string)   SSH user (Linux Dirigible only)
        m{i}_lee_port    (u16)      Lee API port (default 9001)
        m{i}_hester_port (u16)      Hester daemon port (default 9000)
        tok_<name>       (string)   Cached bearer token (truncated to NVS key limit)
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "error: missing dependency 'pyyaml'.\n"
        "       install with:  pip install pyyaml\n"
    )
    sys.exit(2)

# ---------------------------------------------------------------------------
# Constants — must match dirigible-esp32 ConfigNvs and screenschema partitions
# ---------------------------------------------------------------------------

NVS_PARTITION_OFFSET = 0x9000
NVS_PARTITION_SIZE   = 0x6000  # 24 KB

DIRIGIBLE_NS = "dirigible"
WIFI_NS      = "ss_wifi"

NVS_KEY_LIMIT = 15  # ESP-IDF NVS key max length

CONFIG_PATH_DEFAULT = Path.home() / ".dirigible" / "config.yaml"

# ---------------------------------------------------------------------------
# Config model
# ---------------------------------------------------------------------------

@dataclass
class Machine:
    name: str
    host: str
    user: str = ""
    lee_port: int = 9001
    hester_port: int = 9000
    token: str = ""

@dataclass
class WifiCreds:
    ssid: str = ""
    password: str = ""

@dataclass
class DirigibleConfig:
    wifi: WifiCreds = field(default_factory=WifiCreds)
    machines: list[Machine] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "DirigibleConfig":
        if not path.exists():
            return cls()
        with open(path, "r") as f:
            raw = yaml.safe_load(f) or {}
        wifi_raw = raw.get("wifi", {}) or {}
        machines_raw = raw.get("machines", []) or []
        return cls(
            wifi=WifiCreds(
                ssid=wifi_raw.get("ssid", ""),
                password=wifi_raw.get("password", ""),
            ),
            machines=[Machine(**m) for m in machines_raw],
        )

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.safe_dump(asdict(self), f, sort_keys=False)
        # Restrict permissions — file contains plaintext WiFi password and
        # bearer tokens.
        path.chmod(0o600)

# ---------------------------------------------------------------------------
# NVS CSV generation
# ---------------------------------------------------------------------------

def generate_nvs_csv(config: DirigibleConfig) -> str:
    """
    Build the NVS CSV string consumed by ESP-IDF's nvs_partition_gen.

    Format:
        key,type,encoding,value
    Type can be 'namespace' (no encoding/value), 'data', or 'file'.
    Encoding for data: u8|u16|u32|i32|string|hex2bin|base64|binary
    """
    lines = ["key,type,encoding,value"]

    # WiFi namespace
    if config.wifi.ssid:
        lines.append(f"{WIFI_NS},namespace,,")
        lines.append(f"ssid,data,string,{config.wifi.ssid}")
        lines.append(f"password,data,string,{config.wifi.password}")

    # Dirigible namespace
    lines.append(f"{DIRIGIBLE_NS},namespace,,")
    lines.append(f"mach_count,data,u8,{len(config.machines)}")
    for i, m in enumerate(config.machines):
        lines.append(f"m{i}_name,data,string,{m.name}")
        lines.append(f"m{i}_host,data,string,{m.host}")
        lines.append(f"m{i}_user,data,string,{m.user}")
        lines.append(f"m{i}_lee_port,data,u16,{m.lee_port}")
        lines.append(f"m{i}_hester_port,data,u16,{m.hester_port}")
        if m.token:
            tok_key = f"tok_{m.name}"[:NVS_KEY_LIMIT]
            lines.append(f"{tok_key},data,string,{m.token}")

    return "\n".join(lines) + "\n"

def build_nvs_image(config: DirigibleConfig, out_path: Path) -> None:
    """
    Generate an NVS binary at out_path. Calls ESP-IDF's nvs_partition_gen
    via Python -m so it works inside the IDF environment.
    """
    # Validate IDF environment
    if "IDF_PATH" not in os.environ:
        sys.exit(
            "error: IDF_PATH not set — run this tool inside an ESP-IDF shell\n"
            "       (or `source $IDF_PATH/export.sh` first)"
        )

    csv_text = generate_nvs_csv(config)
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as csv_file:
        csv_file.write(csv_text)
        csv_path = csv_file.name

    try:
        subprocess.run(
            [
                sys.executable, "-m", "esp_idf_nvs_partition_gen.nvs_partition_gen",
                "generate", csv_path, str(out_path), str(NVS_PARTITION_SIZE),
            ],
            check=True,
        )
    finally:
        os.unlink(csv_path)

# ---------------------------------------------------------------------------
# Flash via esptool
# ---------------------------------------------------------------------------

def flash_nvs(image_path: Path, port: str) -> None:
    """Flash the NVS partition only, leaving everything else untouched."""
    if "IDF_PATH" not in os.environ:
        sys.exit("error: IDF_PATH not set — run inside an ESP-IDF shell")

    cmd = [
        sys.executable, "-m", "esptool",
        "--chip", "esp32s3",
        "--port", port,
        "--before", "default_reset",
        "--after", "hard_reset",
        "write_flash",
        f"0x{NVS_PARTITION_OFFSET:x}", str(image_path),
    ]
    print(f"==> flashing NVS partition: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)

# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def cmd_machine_add(args, config: DirigibleConfig) -> None:
    if any(m.name == args.name for m in config.machines):
        sys.exit(f"error: machine '{args.name}' already exists")
    config.machines.append(Machine(
        name=args.name,
        host=args.host,
        user=args.user or "",
        lee_port=args.lee_port,
        hester_port=args.hester_port,
        token=args.token or "",
    ))
    config.save(args.config)
    print(f"added machine '{args.name}' → {args.host}:{args.lee_port}")
    print(f"config saved to {args.config}")
    print(f"run `dirigible-provision flash` to push to the device")

def cmd_machine_remove(args, config: DirigibleConfig) -> None:
    before = len(config.machines)
    config.machines = [m for m in config.machines if m.name != args.name]
    if len(config.machines) == before:
        sys.exit(f"error: no machine named '{args.name}'")
    config.save(args.config)
    print(f"removed machine '{args.name}'")

def cmd_machine_list(args, config: DirigibleConfig) -> None:
    if not config.machines:
        print("(no machines configured)")
        return
    print(f"{'NAME':20} {'HOST':25} {'LEE':>6} {'HESTER':>7}  TOKEN")
    for m in config.machines:
        token = "(set)" if m.token else "(none)"
        print(f"{m.name:20} {m.host:25} {m.lee_port:>6} {m.hester_port:>7}  {token}")

def cmd_machine_set_token(args, config: DirigibleConfig) -> None:
    for m in config.machines:
        if m.name == args.name:
            m.token = args.token
            config.save(args.config)
            print(f"token set for machine '{args.name}'")
            return
    sys.exit(f"error: no machine named '{args.name}'")

def cmd_wifi_set(args, config: DirigibleConfig) -> None:
    config.wifi.ssid = args.ssid
    config.wifi.password = args.password
    config.save(args.config)
    print(f"wifi set: ssid='{args.ssid}'")
    print(f"config saved to {args.config}")
    print(f"run `dirigible-provision flash` to push to the device")

def cmd_status(args, config: DirigibleConfig) -> None:
    print(f"config: {args.config}")
    print(f"wifi:   {'(set)' if config.wifi.ssid else '(unset)'}")
    if config.wifi.ssid:
        print(f"        ssid={config.wifi.ssid}")
    print(f"machines: {len(config.machines)}")
    for m in config.machines:
        token = "(set)" if m.token else "(none)"
        print(f"  - {m.name}  {m.host}:{m.lee_port}  token={token}")

def cmd_flash(args, config: DirigibleConfig) -> None:
    if not config.machines and not config.wifi.ssid:
        sys.exit("error: nothing to flash — config is empty\n"
                 "       add a machine or set wifi first")
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as tmp:
        out_path = Path(tmp.name)
    try:
        build_nvs_image(config, out_path)
        flash_nvs(out_path, args.port)
        print()
        print("==> NVS partition flashed. Device will reboot.")
        print("    Watch boot log:  python3 -m serial.tools.miniterm "
              f"{args.port} 115200")
    finally:
        if out_path.exists():
            out_path.unlink()

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dirigible-provision",
        description="Provision Dirigible NVS config (machines + wifi credentials).",
    )
    p.add_argument(
        "--config", type=Path, default=CONFIG_PATH_DEFAULT,
        help=f"path to dirigible config YAML (default: {CONFIG_PATH_DEFAULT})",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # status
    sp = sub.add_parser("status", help="show current config")
    sp.set_defaults(func=cmd_status)

    # wifi
    sp_wifi = sub.add_parser("wifi", help="manage WiFi credentials")
    sp_wifi_sub = sp_wifi.add_subparsers(dest="wifi_command", required=True)
    sp = sp_wifi_sub.add_parser("set", help="set WiFi credentials")
    sp.add_argument("ssid")
    sp.add_argument("password")
    sp.set_defaults(func=cmd_wifi_set)

    # machine
    sp_mach = sub.add_parser("machine", help="manage Lee machines")
    sp_mach_sub = sp_mach.add_subparsers(dest="machine_command", required=True)

    sp = sp_mach_sub.add_parser("add", help="add a Lee machine")
    sp.add_argument("name", help="display name for this machine")
    sp.add_argument("host", help="hostname or IP")
    sp.add_argument("--user", help="SSH user (Linux Dirigible only)", default="")
    sp.add_argument("--lee-port",    type=int, default=9001, dest="lee_port")
    sp.add_argument("--hester-port", type=int, default=9000, dest="hester_port")
    sp.add_argument("--token", help="bearer token (or use `machine set-token` later)", default="")
    sp.set_defaults(func=cmd_machine_add)

    sp = sp_mach_sub.add_parser("remove", help="remove a machine")
    sp.add_argument("name")
    sp.set_defaults(func=cmd_machine_remove)

    sp = sp_mach_sub.add_parser("list", help="list configured machines")
    sp.set_defaults(func=cmd_machine_list)

    sp = sp_mach_sub.add_parser("set-token", help="set/update a machine's bearer token")
    sp.add_argument("name")
    sp.add_argument("token")
    sp.set_defaults(func=cmd_machine_set_token)

    # flash
    sp = sub.add_parser("flash", help="generate NVS image and flash it to the device")
    sp.add_argument("--port", default="/dev/ttyACM0", help="serial port (default /dev/ttyACM0)")
    sp.set_defaults(func=cmd_flash)

    return p

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    config = DirigibleConfig.load(args.config)
    args.func(args, config)

if __name__ == "__main__":
    main()
