# VoiceMeeter Control

A web-based remote control panel for VoiceMeeter Potato, running on a Raspberry Pi and accessible from any device on your network (iPad, phone, etc.).

## Architecture

```
iPad / Browser
      │  Socket.io (port 3000)
      ▼
Raspberry Pi  ←──── server/
  (Node.js server)
      │  WebSocket (port 3001)
      ▼
Windows PC  ←──── bridge/
  (Python bridge)
      │  ctypes DLL
      ▼
VoiceMeeter Potato
```

---

## Raspberry Pi Setup

### 1. Install Node.js (if not already installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/voicemeeter-control.git
cd voicemeeter-control/server
npm install
```

### 3. Test it runs

```bash
npm start
# Open http://<Pi-IP>:3000 in a browser
```

### 4. Auto-start with PM2

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the server
cd ~/voicemeeter-control/server
pm2 start index.js --name "vm-control"

# Save so it restarts on boot
pm2 save
pm2 startup   # Follow the printed command (copy-paste it)
```

> **Note on the existing app:** If you already have another app running on PM2, this just adds a second process. They run independently. Check with `pm2 list`.

### 5. Check it's running

```bash
pm2 list
pm2 logs vm-control
```

To find your Pi's IP: `hostname -I`

---

## Windows Bridge Setup

### Prerequisites

- Python 3.9+ installed ([python.org](https://python.org))
- VoiceMeeter Potato installed and running
- Python added to PATH during install

### 1. Edit the config

Open `bridge/config.json` and set your Pi's IP address:

```json
{
  "pi_host": "192.168.1.100",   ← change this to your Pi's IP
  "bridge_port": 3001,
  "poll_interval_ms": 50,
  "log_level": "INFO"
}
```

### 2. Install Python dependencies

```batch
cd bridge
pip install -r requirements.txt
```

### 3. Test it

```batch
python bridge.py
```

You should see a tray icon appear. If VoiceMeeter is running, it will connect and the web UI will show "Connected".

### 4. Auto-start on Windows boot

**Option A — Startup folder (easiest):**

1. Press `Win + R`, type `shell:startup`, press Enter
2. Create a shortcut to `startup.bat` in that folder
3. The bridge will launch minimized at login

**Option B — Task Scheduler (more reliable, starts before login):**

1. Open Task Scheduler
2. Create Basic Task → "VM Control Bridge"
3. Trigger: "When the computer starts"
4. Action: Start a program → `pythonw.exe`
5. Arguments: `"C:\path\to\bridge\bridge.py"`
6. Start in: `C:\path\to\bridge\`
7. Enable "Run whether user is logged on or not" if desired

**Option C — Build a standalone .exe (no Python required after):**

```batch
cd bridge
build.bat
```

The `dist\VMControlBridge.exe` can be used instead of `python bridge.py`. Place a shortcut to it in the Startup folder.

---

## Usage

1. Open `http://<Pi-IP>:3000` in any browser on your network
2. Bookmark it on your iPad for easy access (Add to Home Screen for app-like experience)
3. The header shows connection status — it will say "Potato" (or your VM version) when the bridge is connected

### Adding Controls

1. Click **Edit** in the top-right
2. Click the **+** button (bottom right)
3. Choose a control type:
   - **Fader** — vertical gain slider for any strip or bus
   - **Strip Panel** — full channel strip (fader + mute + routing)
   - **Bus Panel** — output bus with fader and mute
   - **Toggle** — on/off button for any parameter (mute, solo, A1/B1 routing...)
   - **Macro** — one button that sets multiple parameters at once
   - **Shortcut** — desktop actions like launching apps, screenshots, media keys, volume, lock, sleep, or custom key combos
   - **VU Meter** — animated level display
   - **Label** — text separator/header
4. Configure and click **Save**
5. Click **Edit** again to exit edit mode

### Drag to Reorder

In edit mode, drag any control card to reorder it.

### Pages

Add multiple pages (e.g. Gaming, Music, Streaming) via **Settings → Pages**. Tabs appear at the top.

### Macro Example — "Mute all mics"

Add a Macro control with these actions:
- `Strip[0].Mute` = 1
- `Strip[1].Mute` = 1
- `Strip[2].Mute` = 1

Enable **Momentary** if you want it to un-mute when released (push-to-talk style).

### Desktop Shortcut Examples

- Launch Discord: action `Launch App / File`, target `C:\Users\YourName\AppData\Local\Discord\Update.exe`, args `--processStart Discord.exe`
- Open Spotify Web: action `Open URL`, target `https://open.spotify.com`
- Media hotkeys: `Play / Pause`, `Next Track`, `Previous Track`
- System actions: `Screenshot`, `Volume Up`, `Volume Down`, `Mute / Unmute`, `Lock PC`
- Custom shortcut: action `Key Combo`, target `ctrl+shift+esc` or `win+d`

Screenshots are saved on the Windows PC under `Pictures\VM Control Screenshots`.

---

## VoiceMeeter Parameters Reference

| Parameter | Range | Notes |
|-----------|-------|-------|
| `Strip[n].Gain` | -60 to +12 | dB. n=0-7 |
| `Strip[n].Mute` | 0 or 1 | |
| `Strip[n].Solo` | 0 or 1 | |
| `Strip[n].A1` … `A5` | 0 or 1 | Hardware bus routing |
| `Strip[n].B1` … `B3` | 0 or 1 | Virtual bus routing |
| `Bus[n].Gain` | -60 to +12 | dB. n=0-7 |
| `Bus[n].Mute` | 0 or 1 | |
| `Command.Restart` | 1 | Restart audio engine |

Strip indices: 0-4 = Hardware inputs, 5-7 = Virtual inputs  
Bus indices: 0-4 = A1-A5 (hardware), 5-7 = B1-B3 (virtual)

---

## Troubleshooting

**Bridge won't connect to VoiceMeeter:**
- Make sure VoiceMeeter is open before starting the bridge
- Check the DLL path in `voicemeeter.py` matches your installation

**Web UI shows "Offline":**
- Check the bridge is running (look for tray icon)
- Verify `config.json` has the correct Pi IP
- Ensure port 3001 is not blocked by Windows Firewall
  - Run: `netsh advfirewall firewall add rule name="VM Bridge" dir=in action=allow protocol=TCP localport=3001`
  - (Actually the Pi connects *to* Windows, so Windows firewall outbound rules apply — usually fine by default)

**iPad can't reach the Pi:**
- Confirm both devices are on the same WiFi network
- Check Pi IP with `hostname -I`
- Test with `http://<Pi-IP>:3000` in Safari

**Controls don't respond:**
- Check `pm2 logs vm-control` on the Pi for errors
- Check the bridge console/log for errors
# DecklingAir
