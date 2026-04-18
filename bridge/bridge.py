"""
VoiceMeeter Control Bridge
Runs on Windows PC. Connects to the Pi server via WebSocket.
Reads/writes VoiceMeeter parameters via the VoiceMeeter Remote API.
Runs minimized to the system tray.
"""
import asyncio
import json
import logging
import sys
import threading
import time
import os

import websockets
import pystray
from PIL import Image, ImageDraw

from voicemeeter import VoiceMeeterRemote

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
PI_PORT    = cfg.get("bridge_port", 3001)
LOG_LEVEL  = cfg.get("log_level", "INFO")
POLL_MS    = cfg.get("poll_interval_ms", 50)

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
                    "vmType": vm_type,
                    "vmVersion": vm_ver,
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
