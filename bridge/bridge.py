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
import string
import subprocess
import socket
import webbrowser
import winreg
from datetime import datetime
from pathlib import Path

import websockets
import pystray
from PIL import Image, ImageDraw, ImageGrab

from voicemeeter import VoiceMeeterRemote

try:
    import sounddevice as sd
    _sounddevice_available = True
except ImportError:
    sd = None
    _sounddevice_available = False

try:
    import miniaudio
    import numpy as np
    _miniaudio_available = True
except ImportError:
    miniaudio = None
    np = None
    _miniaudio_available = False

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
WEB_PORT   = cfg.get("web_port", 3002)
LOG_LEVEL  = cfg.get("log_level", "INFO")
POLL_MS    = cfg.get("poll_interval_ms", 50)

_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCKFILE    = os.path.join(_BRIDGE_DIR, "bridge.pid")
LOG_FILE    = os.path.join(_BRIDGE_DIR, "bridge.log")

STATE_COLORS = {
    "starting":     "#6c63ff",
    "vm_wait":      "#f59e0b",
    "connecting":   "#6c63ff",
    "connected":    "#1db954",
    "reconnecting": "#f59e0b",
    "error":        "#dc2626",
}
STATE_LABELS = {
    "starting":     "Starting…",
    "vm_wait":      "Waiting for VoiceMeeter…",
    "connecting":   "Connecting…",
    "connected":    "Connected",
    "reconnecting": "Reconnecting…",
    "error":        "Error",
}

STARTUP_REG_KEY   = r"Software\Microsoft\Windows\CurrentVersion\Run"
STARTUP_REG_VALUE = "VMControlBridge"


def slugify_device_id(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value or "").strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "windows-device"


DEVICE_NAME = cfg.get("device_name") or socket.gethostname()
DEVICE_ID = cfg.get("device_id") or slugify_device_id(DEVICE_NAME)

# ── Logging ───────────────────────────────────────────────────────────────────
_log_fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
_log_level = getattr(logging, LOG_LEVEL, logging.INFO)

_file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
_file_handler.setFormatter(_log_fmt)
_file_handler.setLevel(_log_level)

_stream_handler = logging.StreamHandler(sys.stdout)
_stream_handler.setFormatter(_log_fmt)
_stream_handler.setLevel(_log_level)

logging.basicConfig(level=_log_level, handlers=[_stream_handler, _file_handler])
log = logging.getLogger(__name__)

# ── Globals ───────────────────────────────────────────────────────────────────
vm = VoiceMeeterRemote()
running      = True
tray_icon    = None
conn_state   = "starting"
vm_connected = False          # True once vm.login() succeeds
_async_thread: threading.Thread = None
_event_loop: asyncio.AbstractEventLoop = None
_reconnect_requested = threading.Event()
_current_ws  = None           # active websocket, used by force-reconnect

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
    bars = [(8, 32, 20, 60), (24, 16, 36, 60), (40, 8, 52, 60)]
    r, g, b = int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16)
    for bar in bars:
        d.rectangle(bar, fill=(r, g, b, 220))
    return img

def set_conn_state(state: str, notify: str = None):
    """Update connection state, tray icon colour, and tooltip. Optionally show balloon."""
    global conn_state
    conn_state = state
    color = STATE_COLORS.get(state, "#6c63ff")
    label = STATE_LABELS.get(state, state)
    if tray_icon:
        tray_icon.icon  = make_icon_image(color)
        tray_icon.title = f"VM Control Bridge — {label}"
        if notify:
            try:
                tray_icon.notify(notify, "VM Control Bridge")
            except Exception:
                pass

def update_tray_status(text: str):
    """Legacy helper — maps text to nearest conn_state."""
    if "connected" in text.lower() and "re" not in text.lower():
        set_conn_state("connected")
    elif "reconnect" in text.lower():
        set_conn_state("reconnecting")
    elif "connect" in text.lower():
        set_conn_state("connecting")

# ── Startup registry helpers ───────────────────────────────────────────────────
def _startup_cmd():
    """Command to register for Windows startup."""
    python_dir = os.path.dirname(sys.executable)
    pythonw = os.path.join(python_dir, "pythonw.exe")
    if not os.path.exists(pythonw):
        pythonw = sys.executable
    return f'"{pythonw}" "{os.path.abspath(__file__)}"'

def is_startup_enabled() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, STARTUP_REG_KEY) as key:
            val, _ = winreg.QueryValueEx(key, STARTUP_REG_VALUE)
            return bool(val)
    except Exception:
        return False

def _set_startup(enabled: bool):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, STARTUP_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, STARTUP_REG_VALUE, 0, winreg.REG_SZ, _startup_cmd())
                log.info("Added to Windows startup")
            else:
                try:
                    winreg.DeleteValue(key, STARTUP_REG_VALUE)
                    log.info("Removed from Windows startup")
                except FileNotFoundError:
                    pass
    except Exception as e:
        log.error("Registry error: %s", e)

# ── Single-instance helpers ────────────────────────────────────────────────────
def _kill_pid(pid: int):
    try:
        subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True,
            **hidden_subprocess_kwargs(),
        )
    except Exception:
        pass

def ensure_single_instance():
    """Kill any previous bridge instance, then write our PID to the lockfile."""
    if os.path.exists(LOCKFILE):
        try:
            with open(LOCKFILE) as f:
                old_pid = int(f.read().strip())
            if old_pid != os.getpid():
                log.info("Killing previous instance (PID %d)", old_pid)
                _kill_pid(old_pid)
                time.sleep(0.5)
        except Exception:
            pass
    try:
        with open(LOCKFILE, "w") as f:
            f.write(str(os.getpid()))
    except Exception as e:
        log.warning("Could not write lockfile: %s", e)

# ── Tray action handlers ───────────────────────────────────────────────────────
def _tray_reconnect(icon, item):
    """Force-close the current websocket so run_bridge() retries immediately."""
    global _current_ws
    _reconnect_requested.set()
    ws = _current_ws
    if ws and _event_loop:
        asyncio.run_coroutine_threadsafe(ws.close(), _event_loop)

def _tray_open_web_ui(icon, item):
    webbrowser.open(f"http://{PI_HOST}:{WEB_PORT}")

def _tray_open_log(icon, item):
    try:
        os.startfile(LOG_FILE)
    except Exception:
        subprocess.Popen(["notepad.exe", LOG_FILE], **hidden_subprocess_kwargs())

def _tray_toggle_startup(icon, item):
    _set_startup(not is_startup_enabled())

def quit_app(icon, item):
    global running
    running = False
    try:
        os.remove(LOCKFILE)
    except Exception:
        pass
    icon.stop()

def setup_tray():
    global tray_icon
    icon_img = make_icon_image(STATE_COLORS["starting"])
    menu = pystray.Menu(
        pystray.MenuItem("VM Control Bridge", None, enabled=False),
        pystray.MenuItem(lambda item: STATE_LABELS.get(conn_state, conn_state), None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Reconnect",          _tray_reconnect),
        pystray.MenuItem("Open Web UI",        _tray_open_web_ui),
        pystray.MenuItem("Open Log",           _tray_open_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Start with Windows",
            _tray_toggle_startup,
            checked=lambda item: is_startup_enabled(),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", quit_app),
    )
    tray_icon = pystray.Icon("VMControl", icon_img, "VM Control Bridge — Starting…", menu)
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


# Track active soundboard playback so we can stop them.
# Each entry is a threading.Event; the write loop checks it and exits early when set.
_active_stop_events: list = []
_active_streams_lock = threading.Lock()

def _find_device_index(device: str):
    """Return the output device index matching `device` (exact first, then substring)."""
    if not device:
        return None
    try:
        devices = sd.query_devices()
        device_lower = device.lower()
        # Pass 1: exact name match
        for i, d in enumerate(devices):
            if d.get('max_output_channels', 0) > 0 and d['name'].lower() == device_lower:
                log.debug("Soundboard device exact match: [%d] %s", i, d['name'])
                return i
        # Pass 2: substring match (device name contains the search string)
        for i, d in enumerate(devices):
            if d.get('max_output_channels', 0) > 0 and device_lower in d['name'].lower():
                log.debug("Soundboard device substring match: [%d] %s", i, d['name'])
                return i
        log.warning("Soundboard: no output device matching %r — available devices:", device)
        for i, d in enumerate(devices):
            if d.get('max_output_channels', 0) > 0:
                log.warning("  [%d] %s", i, d['name'])
    except Exception as e:
        log.error("Soundboard: error querying devices: %s", e)
    return None

def play_sound(file_path: str, device=None, volume: float = 1.0):
    """Play an audio file in a background thread using its own OutputStream.
    Supports MP3/WAV/FLAC/OGG via miniaudio. Multiple simultaneous sounds allowed."""
    if not _sounddevice_available:
        raise RuntimeError("sounddevice not installed – run: pip install sounddevice")
    if not _miniaudio_available:
        raise RuntimeError("miniaudio/numpy not installed – run: pip install miniaudio numpy")
    if not os.path.isfile(file_path):
        raise FileNotFoundError(f"Sound file not found: {file_path}")

    # Decode audio file (supports MP3, WAV, FLAC, OGG, etc.)
    decoded = miniaudio.decode_file(file_path, output_format=miniaudio.SampleFormat.FLOAT32)
    samplerate = decoded.sample_rate
    data = np.frombuffer(decoded.samples, dtype=np.float32).copy()
    if decoded.nchannels > 1:
        data = data.reshape(-1, decoded.nchannels)
    else:
        data = data.reshape(-1, 1)

    if volume != 1.0:
        data = data * max(0.0, min(2.0, float(volume)))

    device_idx = _find_device_index(device) if device else None

    stop_event = threading.Event()

    def _run():
        try:
            stream = sd.OutputStream(
                samplerate=samplerate,
                channels=data.shape[1],
                dtype='float32',
                device=device_idx,
            )
        except Exception as e:
            log.error("Soundboard: failed to open OutputStream: %s", e)
            with _active_streams_lock:
                try: _active_stop_events.remove(stop_event)
                except ValueError: pass
            return

        try:
            stream.start()
            chunk = 1024
            offset = 0
            while offset < len(data) and not stop_event.is_set():
                block = data[offset:offset + chunk]
                try:
                    stream.write(block)
                except Exception as e:
                    log.warning("Soundboard: stream write error (stopping): %s", e)
                    break
                offset += chunk
        except Exception as e:
            log.warning("Soundboard: playback error: %s", e)
        finally:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
            with _active_streams_lock:
                try: _active_stop_events.remove(stop_event)
                except ValueError: pass

    with _active_streams_lock:
        _active_stop_events.append(stop_event)

    threading.Thread(target=_run, daemon=True).start()


def stop_all_sounds():
    """Stop all currently playing soundboard sounds."""
    with _active_streams_lock:
        events = list(_active_stop_events)
    for ev in events:
        ev.set()


_AUDIO_EXTENSIONS = {'.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a', '.opus', '.wma'}


def _get_drive_roots():
    """Return a list of available drive root paths on Windows (e.g. ['C:\\', 'D:\\'])."""
    roots = []
    try:
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        for letter in string.ascii_uppercase:
            if bitmask & 1:
                roots.append(f"{letter}:\\")
            bitmask >>= 1
    except Exception:
        # Fallback: just offer C:\
        roots = ["C:\\"]
    return roots


def _browse_directory(path: str):
    """
    List the contents of `path`.
    Returns a dict: { path, parent, entries: [{name, isDir, ext}] }
    Entries are sorted: directories first (alphabetical), then audio files (alphabetical).
    """
    path = (path or "").strip()
    # Normalise separators
    path = os.path.normpath(path) if path else ""

    if not path or not os.path.isdir(path):
        return {"path": path, "parent": None, "entries": [], "error": "Directory not found"}

    try:
        raw = os.listdir(path)
    except PermissionError:
        return {"path": path, "parent": str(Path(path).parent) if path else None, "entries": [], "error": "Access denied"}
    except Exception as e:
        return {"path": path, "parent": None, "entries": [], "error": str(e)}

    dirs = []
    files = []
    for name in raw:
        full = os.path.join(path, name)
        try:
            if os.path.isdir(full):
                dirs.append({"name": name, "isDir": True, "ext": ""})
            else:
                ext = os.path.splitext(name)[1].lower()
                if ext in _AUDIO_EXTENSIONS:
                    files.append({"name": name, "isDir": False, "ext": ext})
        except Exception:
            pass

    dirs.sort(key=lambda e: e["name"].lower())
    files.sort(key=lambda e: e["name"].lower())

    parent_path = str(Path(path).parent)
    # At a drive root (e.g. C:\) the parent == path itself — signal no parent
    parent = None if parent_path == path else parent_path

    return {
        "path": path,
        "parent": parent,
        "entries": dirs + files,
    }


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
    global _current_ws
    url = f"ws://{PI_HOST}:{PI_PORT}"
    log.info("Connecting to %s", url)
    attempt = 0

    while running:
        _reconnect_requested.clear()
        attempt += 1
        set_conn_state("connecting")
        try:
            async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                _current_ws = ws
                attempt = 0
                log.info("Connected to server")
                set_conn_state("connected", notify="Connected to server")

                vm_type = vm.get_type() if vm_connected else 0
                vm_ver  = vm.get_version() if vm_connected else "unknown"
                await ws.send(json.dumps({
                    "type": "hello",
                    "deviceId": DEVICE_ID,
                    "deviceName": DEVICE_NAME,
                    "platform": "windows",
                    "vmType": vm_type,
                    "vmVersion": vm_ver,
                    "capabilities": {
                        "voiceMeeter": vm_connected,
                        "desktopActions": True,
                        "desktopIcons": True,
                        "soundboard": _sounddevice_available and _miniaudio_available,
                    },
                }))
                if vm_connected:
                    log.info("VoiceMeeter type=%d version=%s", vm_type, vm_ver)
                    state = vm.get_all_params()
                    await ws.send(json.dumps({"type": "state", "data": state}))

                poll_task = asyncio.create_task(poll_loop(ws))
                try:
                    await receive_loop(ws)
                finally:
                    _current_ws = None
                    poll_task.cancel()
                    try: await poll_task
                    except asyncio.CancelledError: pass

        except (websockets.ConnectionClosed, OSError, ConnectionRefusedError) as e:
            _current_ws = None
            log.warning("Connection lost: %s", e)
            set_conn_state("reconnecting", notify="Connection lost — reconnecting…")
        except Exception as e:
            _current_ws = None
            log.error("Unexpected error: %s", e, exc_info=True)
            set_conn_state("reconnecting")

        if not running:
            break

        # Wait up to 5 s before retrying, but bail immediately if force-reconnect
        delay = min(5, attempt * 2)
        log.info("Retrying in %ds (attempt %d)…", delay, attempt)
        for _ in range(delay * 10):
            if not running or _reconnect_requested.is_set():
                break
            await asyncio.sleep(0.1)

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
            log.info("Soundboard: received play — file=%r  device=%r  volume=%s", file_path, device, volume)
            if file_path:
                try:
                    play_sound(file_path, device, volume)
                    log.info("Soundboard: playback started — file=%r via device=%r", file_path, device or "OS default")
                    await ws.send(json.dumps({"type": "soundboardPlaying", "file": file_path}))
                except Exception as e:
                    log.error("Soundboard playback failed: %s", e)
                    await ws.send(json.dumps({
                        "type": "error",
                        "message": f"Soundboard playback failed: {e}",
                    }))

        elif msg_type == "soundboardStop":
            stop_all_sounds()
            log.info("Soundboard: stopped all sounds")

        elif msg_type == "soundboardDevicesRequest":
            await ws.send(json.dumps({
                "type": "soundboardDevices",
                "devices": get_output_devices(),
            }))

        elif msg_type == "soundboardBrowseRoots":
            await ws.send(json.dumps({
                "type": "soundboardBrowseRootsResult",
                "roots": _get_drive_roots(),
            }))

        elif msg_type == "soundboardBrowse":
            path = msg.get("path", "")
            await ws.send(json.dumps({
                "type": "soundboardBrowseResult",
                **_browse_directory(path),
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
    global vm_connected
    interval = POLL_MS / 1000.0
    vm_retry_ticks = 0   # countdown before next VM login attempt

    while running:
        try:
            # ── VoiceMeeter reconnect ──────────────────────────────────────
            if not vm_connected:
                if vm_retry_ticks <= 0:
                    result = vm.login()
                    if result >= 0:
                        vm_connected = True
                        log.info("VoiceMeeter connected (login code %d)", result)
                        # Announce updated capabilities now that VM is live
                        await ws.send(json.dumps({
                            "type": "hello",
                            "deviceId": DEVICE_ID,
                            "deviceName": DEVICE_NAME,
                            "platform": "windows",
                            "vmType": vm.get_type(),
                            "vmVersion": vm.get_version(),
                            "capabilities": {
                                "voiceMeeter": True,
                                "desktopActions": True,
                                "desktopIcons": True,
                                "soundboard": _sounddevice_available and _miniaudio_available,
                            },
                        }))
                        state = vm.get_all_params()
                        await ws.send(json.dumps({"type": "state", "data": state}))
                    else:
                        vm_retry_ticks = int(5.0 / interval)
                else:
                    vm_retry_ticks -= 1
                await asyncio.sleep(interval)
                continue

            # ── Normal poll ───────────────────────────────────────────────
            if vm.is_dirty():
                state = vm.get_all_params()
                await ws.send(json.dumps({"type": "state", "data": state}))
                log.debug("State update sent")

            levels = vm.get_all_levels()
            await ws.send(json.dumps({"type": "levels", "data": levels}))

        except websockets.ConnectionClosed:
            log.warning("Connection closed during poll")
            break
        except Exception as e:
            log.error("Poll error: %s", e)
            # If VoiceMeeter disappeared, flag for reconnect
            if vm_connected and ("dll" in str(e).lower() or "voicemeeter" in str(e).lower() or isinstance(e, OSError)):
                log.warning("VoiceMeeter connection lost, will retry…")
                vm_connected = False
                set_conn_state("vm_wait")
                vm_retry_ticks = int(5.0 / interval)

        await asyncio.sleep(interval)

# ── Asyncio thread ────────────────────────────────────────────────────────────
def run_async_thread():
    """Run the asyncio event loop in a background thread."""
    global _event_loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _event_loop = loop
    try:
        loop.run_until_complete(run_bridge())
    except Exception as e:
        log.error("Async thread error: %s", e)
    finally:
        _event_loop = None
        loop.close()

# ── Async-thread watchdog ──────────────────────────────────────────────────────
def _watchdog_thread():
    """Restart the async networking thread if it unexpectedly dies."""
    global _async_thread
    while running:
        time.sleep(10)
        if not running:
            break
        if _async_thread and not _async_thread.is_alive():
            log.warning("Networking thread died unexpectedly — restarting…")
            set_conn_state("reconnecting")
            _async_thread = threading.Thread(target=run_async_thread, daemon=True, name="bridge-async")
            _async_thread.start()

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    global running, vm_connected, _async_thread

    log.info("=" * 60)
    log.info("VM Control Bridge starting (PID %d)", os.getpid())

    # ── Single instance: kill old process if running ──────────────────────────
    ensure_single_instance()

    # ── VoiceMeeter DLL ───────────────────────────────────────────────────────
    if not vm.initialize():
        log.error("VoiceMeeter DLL not found — is VoiceMeeter installed?")
        # Don't exit; VM ops will just be disabled until DLL appears
    else:
        result = vm.login()
        if result >= 0:
            vm_connected = True
            log.info("VoiceMeeter login OK (code %d)", result)
        else:
            log.warning("VoiceMeeter not running yet (code %d) — will retry automatically", result)
            set_conn_state("vm_wait")

    # ── Audio device log ──────────────────────────────────────────────────────
    if _sounddevice_available:
        try:
            log.info("Available audio output devices:")
            for i, d in enumerate(sd.query_devices()):
                if d.get('max_output_channels', 0) > 0:
                    log.info("  [%d] %s", i, d['name'])
        except Exception as e:
            log.warning("Could not query audio devices: %s", e)

    # ── Start networking thread + watchdog ────────────────────────────────────
    _async_thread = threading.Thread(target=run_async_thread, daemon=True, name="bridge-async")
    _async_thread.start()

    watchdog = threading.Thread(target=_watchdog_thread, daemon=True, name="bridge-watchdog")
    watchdog.start()

    # ── Tray icon runs on main thread (Windows requirement) ───────────────────
    icon = setup_tray()
    log.info("Tray icon running — right-click to reconnect, open web UI, or quit")
    icon.run()  # blocks until quit_app() calls icon.stop()

    # ── Cleanup ───────────────────────────────────────────────────────────────
    running = False
    log.info("Shutting down…")
    try:
        vm.logout()
    except Exception:
        pass
    log.info("Bye.")

if __name__ == "__main__":
    main()
