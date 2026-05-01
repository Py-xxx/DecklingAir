"""
VM Control macOS Bridge
Connects a macOS device to the VM Control server so the UI can manage
desktop shortcuts, screenshots, media controls, and per-device layouts.
"""
import asyncio
import base64
import json
import logging
import os
import plistlib
import shlex
import socket
import subprocess
import sys
import tempfile
import webbrowser
from datetime import datetime

import websockets


CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
SCREENSHOT_DIR = os.path.join(os.path.expanduser("~"), "Pictures", "VM Control Screenshots")
ICON_CACHE = {}
running = True

APPLE_KEY_CODES = {
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "backspace": 51,
    "escape": 53,
    "esc": 53,
    "left": 123,
    "right": 124,
    "down": 125,
    "up": 126,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121,
    "f1": 122,
    "f2": 120,
    "f3": 99,
    "f4": 118,
    "f5": 96,
    "f6": 97,
    "f7": 98,
    "f8": 100,
    "f9": 101,
    "f10": 109,
    "f11": 103,
    "f12": 111,
}

MODIFIER_MAP = {
    "cmd": "command down",
    "command": "command down",
    "meta": "command down",
    "option": "option down",
    "alt": "option down",
    "shift": "shift down",
    "control": "control down",
    "ctrl": "control down",
}


def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


cfg = load_config()
PI_HOST = cfg.get("pi_host", "192.168.1.100")
PI_PORT = cfg.get("bridge_port", 3003)
LOG_LEVEL = cfg.get("log_level", "INFO")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def run_command(args, check=True, capture_output=False):
    return subprocess.run(
        args,
        check=check,
        capture_output=capture_output,
        text=True,
    )


def run_applescript(script: str, capture_output=False):
    return subprocess.run(
        ["osascript", "-e", script],
        check=True,
        capture_output=capture_output,
        text=True,
    )


def slugify_device_id(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value or "").strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "macos-device"


def get_device_name() -> str:
    configured = cfg.get("device_name")
    if configured:
        return configured

    try:
        name = run_command(["scutil", "--get", "ComputerName"], capture_output=True).stdout.strip()
        if name:
            return name
    except Exception:
        pass

    return socket.gethostname()


DEVICE_NAME = get_device_name()
DEVICE_ID = cfg.get("device_id") or slugify_device_id(DEVICE_NAME)


def escape_applescript_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def capture_screenshot() -> str:
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_path = os.path.join(SCREENSHOT_DIR, f"vm-control-{stamp}.png")
    run_command(["screencapture", "-x", out_path])
    return out_path


def launch_target(target: str, args: str = ""):
    target = (target or "").strip()
    if not target:
        raise RuntimeError("No launch target provided")

    if target.lower().startswith(("http://", "https://")):
        webbrowser.open(target)
        return

    target = os.path.expanduser(target)
    arg_list = shlex.split(args) if args else []

    if target.endswith(".app") and os.path.exists(target):
        command = ["open", "-a", target]
        if arg_list:
            command.extend(["--args", *arg_list])
        subprocess.Popen(command)
        return

    if os.path.isfile(target) and os.access(target, os.X_OK):
        subprocess.Popen([target, *arg_list])
        return

    if os.path.exists(target):
        subprocess.Popen(["open", target])
        return

    raise RuntimeError(f"Target not found: {target}")


def adjust_volume(delta: int):
    current = int(run_applescript("output volume of (get volume settings)", capture_output=True).stdout.strip() or "0")
    updated = max(0, min(100, current + delta))
    run_applescript(f"set volume output volume {updated}")


def toggle_mute():
    run_applescript(
        """
set wasMuted to output muted of (get volume settings)
set volume with output muted (not wasMuted)
""".strip()
    )


def control_media(action: str):
    command_map = {
        "media_play_pause": "playpause",
        "media_next": "next track",
        "media_previous": "previous track",
    }
    app_command = command_map.get(action)
    if not app_command:
        raise RuntimeError(f"Unsupported media action: {action}")

    script = f"""
tell application "System Events"
  set appNames to name of every process
end tell
if appNames contains "Music" then
  tell application "Music" to {app_command}
else if appNames contains "Spotify" then
  tell application "Spotify" to {app_command}
else
  error "No supported media app is running."
end if
""".strip()
    run_applescript(script)


def send_key_combo(combo: str):
    tokens = [token.strip().lower() for token in str(combo or "").replace(" ", "").split("+") if token.strip()]
    if not tokens:
        raise RuntimeError("No key combo provided")

    modifiers = []
    for token in tokens[:-1]:
        mapped = MODIFIER_MAP.get(token)
        if not mapped:
            raise RuntimeError(f"Unsupported modifier: {token}")
        modifiers.append(mapped)

    key_token = tokens[-1]
    if len(key_token) == 1:
        action = f'keystroke "{escape_applescript_string(key_token)}"'
    elif key_token in APPLE_KEY_CODES:
        action = f"key code {APPLE_KEY_CODES[key_token]}"
    else:
        raise RuntimeError(f"Unsupported key: {key_token}")

    using = f" using {{{', '.join(modifiers)}}}" if modifiers else ""
    run_applescript(f'tell application "System Events" to {action}{using}')


def run_desktop_action(action_data: dict):
    action = (action_data or {}).get("action", "")
    target = (action_data or {}).get("target", "")
    args = (action_data or {}).get("args", "")

    if action == "launch":
        launch_target(target, args)
        return
    if action == "open_url":
        webbrowser.open(target)
        return
    if action == "screenshot":
        path = capture_screenshot()
        log.info("Screenshot saved to %s", path)
        return
    if action in {"media_play_pause", "media_next", "media_previous"}:
        control_media(action)
        return
    if action == "volume_up":
        adjust_volume(6)
        return
    if action == "volume_down":
        adjust_volume(-6)
        return
    if action == "volume_mute":
        toggle_mute()
        return
    if action == "lock":
        subprocess.Popen([
            "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
            "-suspend",
        ])
        return
    if action == "sleep":
        run_applescript('tell application "System Events" to sleep')
        return
    if action == "key_combo":
        send_key_combo(target)
        return

    raise RuntimeError(f"Unsupported desktop action: {action}")


def icon_data_url_from_png(png_path: str):
    with open(png_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def resolve_app_icon_path(app_path: str):
    info_path = os.path.join(app_path, "Contents", "Info.plist")
    resources_dir = os.path.join(app_path, "Contents", "Resources")
    candidates = []

    if os.path.exists(info_path):
        try:
            with open(info_path, "rb") as f:
                plist = plistlib.load(f)
            if plist.get("CFBundleIconFile"):
                candidates.append(plist["CFBundleIconFile"])

            primary = (((plist.get("CFBundleIcons") or {}).get("CFBundlePrimaryIcon") or {}).get("CFBundleIconFiles") or [])
            candidates.extend(reversed(primary))
        except Exception:
            pass

    for candidate in candidates:
        filename = candidate if candidate.endswith(".icns") else f"{candidate}.icns"
        path = os.path.join(resources_dir, filename)
        if os.path.exists(path):
            return path

    if os.path.isdir(resources_dir):
        icns_files = sorted(
            name for name in os.listdir(resources_dir)
            if name.lower().endswith(".icns")
        )
        if icns_files:
            return os.path.join(resources_dir, icns_files[0])

    return None


def convert_icns_to_data_url(icon_path: str):
    with tempfile.TemporaryDirectory() as tmpdir:
        out_path = os.path.join(tmpdir, "icon.png")
        result = subprocess.run(
            ["sips", "-s", "format", "png", icon_path, "--out", out_path],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not os.path.exists(out_path):
            return None
        return icon_data_url_from_png(out_path)


def quicklook_icon_data_url(target: str):
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(
            ["qlmanage", "-t", "-s", "256", "-o", tmpdir, target],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        pngs = [
            os.path.join(tmpdir, name)
            for name in os.listdir(tmpdir)
            if name.lower().endswith(".png")
        ]
        if not pngs:
            return None
        return icon_data_url_from_png(pngs[0])


def resolve_desktop_icon(target: str):
    target = (target or "").strip()
    if not target:
        return None
    if target in ICON_CACHE:
        return ICON_CACHE[target]
    if target.lower().startswith(("http://", "https://")):
        return None

    resolved_path = os.path.expanduser(target)
    if not os.path.exists(resolved_path):
        return None

    data_url = None
    if resolved_path.endswith(".app"):
        icon_path = resolve_app_icon_path(resolved_path)
        if icon_path:
            data_url = convert_icns_to_data_url(icon_path)

    if not data_url:
        data_url = quicklook_icon_data_url(resolved_path)

    if data_url:
        ICON_CACHE[target] = data_url
    return data_url


async def run_bridge():
    url = f"ws://{PI_HOST}:{PI_PORT}"
    log.info("Connecting to %s", url)

    while running:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                log.info("Connected to server")
                await ws.send(json.dumps({
                    "type": "hello",
                    "deviceId": DEVICE_ID,
                    "deviceName": DEVICE_NAME,
                    "platform": "macos",
                    "vmType": None,
                    "vmVersion": None,
                    "capabilities": {
                        "voiceMeeter": False,
                        "desktopActions": True,
                        "desktopIcons": True,
                    },
                }))
                await ws.send(json.dumps({"type": "state", "data": {}}))

                await receive_loop(ws)

        except (websockets.ConnectionClosed, OSError, ConnectionRefusedError) as error:
            log.warning("Connection lost: %s. Retrying in 5s...", error)
        except Exception as error:
            log.error("Unexpected error: %s", error, exc_info=True)

        if not running:
            break
        await asyncio.sleep(5)


async def receive_loop(ws):
    async for raw in ws:
        if not running:
            break

        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")

        if msg_type == "requestState":
            await ws.send(json.dumps({"type": "state", "data": {}}))

        elif msg_type == "desktopAction":
            try:
                run_desktop_action(msg.get("action", {}))
            except Exception as error:
                log.error("Desktop action failed: %s", error)
                await ws.send(json.dumps({
                    "type": "error",
                    "message": f"Desktop action failed: {error}",
                }))

        elif msg_type == "desktopIconRequest":
            target = msg.get("target", "")
            try:
                icon = resolve_desktop_icon(target)
                if icon:
                    await ws.send(json.dumps({
                        "type": "desktopIcon",
                        "target": target,
                        "icon": icon,
                    }))
            except Exception as error:
                log.error("Desktop icon resolve failed: %s", error)


def main():
    log.info("VM Control macOS bridge starting for %s (%s)", DEVICE_NAME, DEVICE_ID)
    try:
        asyncio.run(run_bridge())
    except KeyboardInterrupt:
        log.info("Interrupted, shutting down")


if __name__ == "__main__":
    main()
