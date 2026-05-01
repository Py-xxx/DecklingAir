"""
VoiceMeeter Control Bridge
Runs on Windows PC. Connects to the Pi server via WebSocket.
Reads/writes VoiceMeeter parameters via the VoiceMeeter Remote API.
Runs minimized to the system tray.
"""
import asyncio
import ctypes
import json
import logging
import sys
import threading
import time
import os
import shlex
import subprocess
import socket
import webbrowser
from datetime import datetime

import websockets
import pystray
from PIL import Image, ImageDraw, ImageGrab

from voicemeeter import VoiceMeeterRemote

try:
    import sounddevice as sd
    import soundfile as sf
    _sounddevice_available = True
except ImportError:
    sd = None
    sf = None
    _sounddevice_available = False

# ── Config ────────────────────────────────────────────────────────────────────
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

def load_config():
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

cfg = load_config()
PI_HOST    = cfg.get("pi_host", "192.168.1.100")
PI_PORT    = cfg.get("bridge_port", 3003)
LOG_LEVEL  = cfg.get("log_level", "INFO")
POLL_MS    = cfg.get("poll_interval_ms", 50)


def slugify_device_id(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value or "").strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "windows-device"


DEVICE_NAME = cfg.get("device_name") or socket.gethostname()
DEVICE_ID = cfg.get("device_id") or slugify_device_id(DEVICE_NAME)

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)

# ── Globals ───────────────────────────────────────────────────────────────────
vm = VoiceMeeterRemote()
running = True
tray_icon = None
status_text = "Starting..."
SCREENSHOT_DIR = os.path.join(os.path.expanduser("~"), "Pictures", "VM Control Screenshots")
KEYEVENTF_KEYUP = 0x0002
ICON_CACHE = {}

VK_CODES = {
    "ctrl": 0x11,
    "control": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "win": 0x5B,
    "windows": 0x5B,
    "cmd": 0x5B,
    "meta": 0x5B,
    "enter": 0x0D,
    "return": 0x0D,
    "space": 0x20,
    "tab": 0x09,
    "esc": 0x1B,
    "escape": 0x1B,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "delete": 0x2E,
    "del": 0x2E,
    "backspace": 0x08,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "insert": 0x2D,
}

# ── Tray icon ─────────────────────────────────────────────────────────────────
def make_icon_image(color="#6c63ff"):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Simple bar-chart icon
    bars = [(8, 32, 20, 60), (24, 16, 36, 60), (40, 8, 52, 60)]
    r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
    for bar in bars:
        d.rectangle(bar, fill=(r, g, b, 220))
    return img

def update_tray_status(text: str):
    global status_text, tray_icon
    status_text = text
    if tray_icon:
        tray_icon.title = f"VM Control Bridge — {text}"

def quit_app(icon, item):
    global running
    running = False
    icon.stop()

def setup_tray():
    global tray_icon
    icon_img = make_icon_image()
    menu = pystray.Menu(
        pystray.MenuItem("VM Control Bridge", None, enabled=False),
        pystray.MenuItem(lambda item: status_text, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", quit_app),
    )
    tray_icon = pystray.Icon("VMControl", icon_img, "VM Control Bridge", menu)
    return tray_icon


def send_virtual_key(vk_code: int):
    ctypes.windll.user32.keybd_event(vk_code, 0, 0, 0)
    time.sleep(0.03)
    ctypes.windll.user32.keybd_event(vk_code, 0, KEYEVENTF_KEYUP, 0)


def hidden_subprocess_kwargs():
    kwargs = {}
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
        kwargs["startupinfo"] = startupinfo
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return kwargs


def parse_key_token(token: str):
    token = token.strip().lower()
    if not token:
        return None
    if token in VK_CODES:
        return VK_CODES[token]
    if len(token) == 1 and "a" <= token <= "z":
        return ord(token.upper())
    if len(token) == 1 and token.isdigit():
        return ord(token)
    if token.startswith("f") and token[1:].isdigit():
        idx = int(token[1:])
        if 1 <= idx <= 24:
            return 0x70 + idx - 1
    return None


def send_key_combo(combo: str):
    tokens = [token.strip() for token in combo.replace(" ", "").split("+") if token.strip()]
    codes = [parse_key_token(token) for token in tokens]
    if not codes or any(code is None for code in codes):
        raise RuntimeError(f"Unsupported key combo: {combo}")

    for code in codes[:-1]:
        ctypes.windll.user32.keybd_event(code, 0, 0, 0)
        time.sleep(0.02)

    last = codes[-1]
    ctypes.windll.user32.keybd_event(last, 0, 0, 0)
    time.sleep(0.03)
    ctypes.windll.user32.keybd_event(last, 0, KEYEVENTF_KEYUP, 0)

    for code in reversed(codes[:-1]):
        time.sleep(0.02)
        ctypes.windll.user32.keybd_event(code, 0, KEYEVENTF_KEYUP, 0)


def capture_screenshot() -> str:
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    out_path = os.path.join(SCREENSHOT_DIR, f"vm-control-{stamp}.png")
    try:
        image = ImageGrab.grab(all_screens=True)
    except TypeError:
        image = ImageGrab.grab()
    image.save(out_path, "PNG")
    return out_path


def launch_target(target: str, args: str = ""):
    target = target.strip()
    if not target:
        raise RuntimeError("No launch target provided")

    if target.lower().startswith(("http://", "https://")):
        webbrowser.open(target)
        return

    if args:
        os.startfile(target, arguments=args)
        return

    os.startfile(target)


def run_desktop_action(action_data: dict):
    action = (action_data or {}).get("action", "")
    target = (action_data or {}).get("target", "")
    args = (action_data or {}).get("args", "")

    media_keys = {
        "media_play_pause": 0xB3,
        "media_next": 0xB0,
        "media_previous": 0xB1,
        "volume_up": 0xAF,
        "volume_down": 0xAE,
        "volume_mute": 0xAD,
    }

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
    if action in media_keys:
        send_virtual_key(media_keys[action])
        return
    if action == "lock":
        ctypes.windll.user32.LockWorkStation()
        return
    if action == "sleep":
        subprocess.Popen(
            ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"],
            shell=False,
            **hidden_subprocess_kwargs(),
        )
        return
    if action == "key_combo":
        send_key_combo(target)
        return

    raise RuntimeError(f"Unsupported desktop action: {action}")


def get_output_devices():
    """Return list of audio output devices available on this system."""
    if not _sounddevice_available:
        return []
    try:
        result = []
        for i, d in enumerate(sd.query_devices()):
            if d.get('max_output_channels', 0) > 0:
                result.append({'id': i, 'name': d['name']})
        return result
    except Exception as e:
        log.error("Failed to query audio devices: %s", e)
        return []


def play_sound(file_path: str, device=None, volume: float = 1.0):
    """Play an audio file through the specified output device (by name substring)."""
    if not _sounddevice_available:
        raise RuntimeError("sounddevice/soundfile not installed – run: pip install sounddevice soundfile")
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"Sound file not found: {file_path}")

    data, samplerate = sf.read(file_path, dtype='float32', always_2d=True)
    if volume != 1.0:
        data = data * max(0.0, min(2.0, float(volume)))

    device_idx = None
    if device:
        try:
            for i, d in enumerate(sd.query_devices()):
                if d.get('max_output_channels', 0) > 0 and device.lower() in d['name'].lower():
                    device_idx = i
                    break
        except Exception:
            pass

    sd.play(data, samplerate, device=device_idx, blocking=False)


def resolve_desktop_icon(target: str):
    target = (target or "").strip()
    if not target:
        return None
    if target in ICON_CACHE:
        return ICON_CACHE[target]

    ps_script = r"""
Add-Type -AssemblyName System.Drawing
$target = $args[0]
if (-not (Test-Path -LiteralPath $target)) { exit 0 }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $target))
if ($null -eq $icon) { exit 0 }
$bitmap = $icon.ToBitmap()
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($stream.ToArray())
"""

    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script, target],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
            **hidden_subprocess_kwargs(),
        )
        base64_data = (result.stdout or "").strip()
        if not base64_data:
            return None
        data_url = f"data:image/png;base64,{base64_data}"
        ICON_CACHE[target] = data_url
        return data_url
    except Exception as e:
        log.warning("Icon resolve failed for %s: %s", target, e)
        return None

# ── WebSocket bridge session ──────────────────────────────────────────────────
async def run_bridge():
    url = f"ws://{PI_HOST}:{PI_PORT}"
    log.info("Connecting to %s", url)

    while running:
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                log.info("Connected to server")
                update_tray_status("Connected")

                # Send hello
                vm_type = vm.get_type()
                vm_ver  = vm.get_version()
                await ws.send(json.dumps({
                    "type": "hello",
                    "deviceId": DEVICE_ID,
                    "deviceName": DEVICE_NAME,
                    "platform": "windows",
                    "vmType": vm_type,
                    "vmVersion": vm_ver,
                    "capabilities": {
                        "voiceMeeter": True,
                        "desktopActions": True,
                        "desktopIcons": True,
                        "soundboard": _sounddevice_available,
                    },
                }))
                log.info("VoiceMeeter type=%d version=%s", vm_type, vm_ver)

                # Send initial full state
                state = vm.get_all_params()
                await ws.send(json.dumps({"type": "state", "data": state}))

                # Start polling task
                poll_task = asyncio.create_task(poll_loop(ws))
                try:
                    await receive_loop(ws)
                finally:
                    poll_task.cancel()
                    try: await poll_task
                    except asyncio.CancelledError: pass

        except (websockets.ConnectionClosed, OSError, ConnectionRefusedError) as e:
            log.warning("Connection lost: %s. Retrying in 5s...", e)
            update_tray_status("Reconnecting...")
        except Exception as e:
            log.error("Unexpected error: %s", e, exc_info=True)

        if not running:
            break
        await asyncio.sleep(5)

async def receive_loop(ws):
    """Handle incoming commands from the Pi server."""
    async for raw in ws:
        if not running:
            break
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")

        if msg_type == "set":
            param = msg.get("param", "")
            value = msg.get("value")
            if param and value is not None:
                try:
                    vm.set_float(param, float(value))
                    log.debug("SET %s = %s", param, value)
                except Exception as e:
                    log.error("Failed to set %s: %s", param, e)

        elif msg_type == "macro":
            params = msg.get("params", [])
            for item in params:
                p = item.get("param", "")
                v = item.get("value")
                if p and v is not None:
                    try:
                        vm.set_float(p, float(v))
                    except Exception as e:
                        log.error("Macro set %s failed: %s", p, e)

        elif msg_type == "requestState":
            state = vm.get_all_params()
            await ws.send(json.dumps({"type": "state", "data": state}))

        elif msg_type == "setString":
            param = msg.get("param", "")
            value = msg.get("value", "")
            if param:
                try:
                    vm.set_string(param, str(value))
                except Exception as e:
                    log.error("Failed to set string %s: %s", param, e)

        elif msg_type == "desktopAction":
            try:
                run_desktop_action(msg.get("action", {}))
            except Exception as e:
                log.error("Desktop action failed: %s", e)
                await ws.send(json.dumps({
                    "type": "error",
                    "message": f"Desktop action failed: {e}",
                }))

        elif msg_type == "soundboard":
            file_path = msg.get("file", "")
            device    = msg.get("device") or None
            volume    = float(msg.get("volume", 1.0))
            if file_path:
                try:
                    play_sound(file_path, device, volume)
                    log.info("Soundboard: playing %s via %s", file_path, device or "default")
                except Exception as e:
                    log.error("Soundboard playback failed: %s", e)
                    await ws.send(json.dumps({
                        "type": "error",
                        "message": f"Soundboard playback failed: {e}",
                    }))

        elif msg_type == "soundboardDevicesRequest":
            await ws.send(json.dumps({
                "type": "soundboardDevices",
                "devices": get_output_devices(),
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
            except Exception as e:
                log.error("Desktop icon resolve failed: %s", e)

async def poll_loop(ws):
    """Periodically poll VoiceMeeter for state changes and level data."""
    interval = POLL_MS / 1000.0
    level_tick = 0

    while running:
        try:
            # Check for parameter changes
            if vm.is_dirty():
                state = vm.get_all_params()
                await ws.send(json.dumps({"type": "state", "data": state}))
                log.debug("State update sent")

            # Send level data every tick
            levels = vm.get_all_levels()
            await ws.send(json.dumps({"type": "levels", "data": levels}))

        except websockets.ConnectionClosed:
            log.warning("Connection closed during poll")
            break
        except Exception as e:
            log.error("Poll error: %s", e)

        await asyncio.sleep(interval)

# ── Asyncio thread ────────────────────────────────────────────────────────────
def run_async_thread():
    """Run the asyncio event loop in a background thread."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(run_bridge())
    except Exception as e:
        log.error("Async thread error: %s", e)
    finally:
        loop.close()

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    global running

    log.info("VM Control Bridge starting...")

    # Initialize VoiceMeeter DLL
    if not vm.initialize():
        log.error("Could not load VoiceMeeter DLL. Exiting.")
        sys.exit(1)

    result = vm.login()
    if result < 0:
        log.error("VoiceMeeter login failed (code %d). Is VoiceMeeter running?", result)
        # Don't exit — VM might start later; keep trying

    log.info("VoiceMeeter login code: %d (0=ok, 1=launched, <0=error)", result)
    update_tray_status("Connecting...")

    # Start async networking thread
    async_thread = threading.Thread(target=run_async_thread, daemon=True)
    async_thread.start()

    # Run tray icon on main thread (required on Windows)
    icon = setup_tray()
    log.info("Starting system tray icon (close via tray menu)")
    icon.run()  # Blocks until quit

    # Cleanup
    running = False
    log.info("Shutting down...")
    try:
        vm.logout()
    except Exception:
        pass
    log.info("Bye.")

if __name__ == "__main__":
    main()
