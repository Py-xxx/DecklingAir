# DecklingAir

A self-hosted, touch-friendly control panel that runs on a Raspberry Pi and is reachable from any device on your network (iPad, phone, laptop). It is two things in one app:

1. **A VoiceMeeter remote** — faders, mutes, routing, macros and desktop shortcuts for a Windows PC running VoiceMeeter Potato, driven over the network through a small Python bridge.
2. **A deep, self-learning Spotify dashboard** — a player, search, playlists, and an *intelligence engine* that builds and continuously steers your queue around your taste, mood, genre and time-of-day, entirely locally.

The grid is fully editable: you drag, drop, resize and configure cards, organise them into pages, and the layout persists on the Pi.

---

## Table of contents

- [Architecture](#architecture)
- [Setup](#setup)
- [The control surface](#the-control-surface)
  - [VoiceMeeter controls](#voicemeeter-controls)
  - [Desktop shortcuts](#desktop-shortcuts)
- [The Spotify dashboard](#the-spotify-dashboard)
  - [Player, Search, Playlists, Queue](#player-search-playlists-queue)
  - [The Smart Queue engine](#the-smart-queue-engine)
  - [The Insights card](#the-insights-card)
  - [Mixes — the genre × mood map](#mixes--the-genre--mood-map)
  - [The genre system](#the-genre-system)
  - [Taste learning & artist ratings](#taste-learning--artist-ratings)
  - [Feelings & check-ins](#feelings--check-ins)
  - [Now Playing intelligence](#now-playing-intelligence)
  - [Tuning — the dials](#tuning--the-dials)
  - [Data — the diagnostics tab](#data--the-diagnostics-tab)
- [How it works under the hood](#how-it-works-under-the-hood)
- [Configuration & data files](#configuration--data-files)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
 iPad / phone / browser
        │   Socket.IO  (HTTP :3002)
        ▼
 Raspberry Pi  ───────────────  server/   (Node.js: Express + Socket.IO)
   • serves the web UI                     • Spotify intelligence engine
   • persists your layout + learned data   • talks to Spotify / ReccoBeats / Last.fm
        │   WebSocket  (:3003)
        ▼
 Windows PC   ───────────────  bridge/   (Python)
   • polls + sets VoiceMeeter params
        │   ctypes → VoiceMeeter Remote DLL
        ▼
 VoiceMeeter Potato
```

- The **Pi** is the brain and the only thing your devices connect to.
- The **bridge** is optional — you only need it for the VoiceMeeter half. The Spotify half works on its own. (A `macos_bridge.py` is included for driving a Mac instead of a Windows PC.)
- Everything the engine learns about you lives in flat files on the Pi (`server/data/`) — nothing leaves your network except the calls to Spotify.

---

## Setup

### 1. Raspberry Pi (the server)

```bash
# Install Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone & install
git clone https://github.com/py-xxx/DecklingAir.git
cd DecklingAir/server
npm install

# Run it
npm start          # → http://<Pi-IP>:3002
```

Auto-start on boot with **PM2**:

```bash
sudo npm install -g pm2
pm2 start index.js --name "vm-control"
pm2 save
pm2 startup        # run the command it prints
pm2 logs vm-control
```

Find the Pi's IP with `hostname -I`. Open `http://<Pi-IP>:3002` on any device (on iPad, *Add to Home Screen* for an app-like experience).

> Ports: web UI **3002**, bridge **3003** (override with `PORT` / `BRIDGE_PORT`).

### 2. Connect Spotify

1. Create an app at [developer.spotify.com](https://developer.spotify.com) and set the Redirect URI to `http://<Pi-IP>:3002/api/spotify/callback`.
2. In the panel: **Settings → Spotify**, paste your **Client ID** and **Client Secret**, click **Connect Spotify**, and authorise.

### 3. Add a Last.fm key (for genres)

1. Get a free key at [last.fm/api/account/create](https://www.last.fm/api/account/create) (you only need the **API key**, not the shared secret).
2. **Settings → Spotify → Last.fm API Key → Save.** The genre backfill starts immediately — watch `pm2 logs` for the `[Genre]` lines.

### 4. (Optional) Windows bridge for VoiceMeeter

Only needed for the VoiceMeeter half.

1. Install Python 3.9+ and VoiceMeeter Potato (have VoiceMeeter running first).
2. Edit `bridge/config.json` → set `pi_host` to your Pi's IP and `bridge_port` to `3003`.
3. `pip install -r bridge/requirements.txt`, then `python bridge.py` (a tray icon appears).
4. Auto-start it via the Startup folder, Task Scheduler, or build a standalone exe with `bridge/build.bat`. (Use `macos_bridge.py` to drive a Mac instead.)

---

## The control surface

Enter **Edit** mode (top-right) to add, move, resize and configure cards; tap **+** to add one. Drag cards to rearrange, drag the corner to resize. Group cards into **Pages** (Settings → Pages) — e.g. *Gaming*, *Music*, *Streaming* — shown as tabs.

### VoiceMeeter controls

| Card | What it does |
|------|--------------|
| **Fader** | A vertical gain slider for any strip or bus. |
| **Strip Panel** | A full input channel strip — fader, mute, and A/B bus routing toggles. |
| **Bus Panel** | An output bus with fader and mute. |
| **Toggle** | An on/off button bound to any parameter (mute, solo, A1–A5 / B1–B3 routing…). |
| **Macro** | One button that sets several parameters at once. Optional **Momentary** mode un-does the change on release (push-to-talk style). |
| **VU Meter** | A live animated level display. |
| **Label** | A text header / separator for organising the grid. |

Live levels and parameter state stream back from VoiceMeeter through the bridge, so faders and meters reflect the real mixer in real time.

### Desktop shortcuts

A **Shortcut** card fires actions on the Windows PC:

- **Launch app / open file**, **Open URL**
- **Media keys** — Play/Pause, Next, Previous
- **System** — Volume Up/Down, Mute, Screenshot, Lock, Sleep
- **Custom key combo** — e.g. `ctrl+shift+esc`, `win+d`

Screenshots are saved on the PC under `Pictures\VM Control Screenshots`.

---

## The Spotify dashboard

This is where most of the depth lives. Connect your Spotify account once (Settings → Spotify) and you get a full player plus an engine that treats your queue as something to be *built and steered*, not just played.

A guiding principle runs through the whole thing: **local-first and API-frugal.** Spotify has progressively locked down its Web API — audio features, recommendations, related-artists, and even artist *genres* are blocked or stripped for ordinary apps. Rather than fight that, the engine learns from your own listening on the Pi, leans on free fallbacks (ReccoBeats for audio features, Last.fm for genres), and spends live API calls rarely and deliberately.

### Player, Search, Playlists, Queue

- **Player** — album art, title/artist (with a marquee for long names), scrubber, transport, shuffle/repeat, like, and device picker.
- **Search** — find and play any track.
- **Playlists** — browse and play your playlists, with a "Recent" sort.
- **Queue ("Up Next")** — the real upcoming queue, annotated with *why* each pick is there. When the engine rebuilds the queue (e.g. you pick a mix), a **loading overlay** covers it until the new queue is built and playing.

### The Smart Queue engine

Spotify's Web API won't autoplay a bare track — start a single song via the API and "Up Next" stays empty. So the engine sources its own continuation:

1. It builds a **window** — a short spine of discovery "anchors" with **your** taste-tuned picks woven into the gaps where the flow between anchors is roughest (so each of your songs does the most bridging work).
2. It **enqueues that window** into Spotify's native Up Next, so the queue populates immediately and looks exactly like normal playback.
3. As the current track advances and few slots remain, it **extends** the window — fetching a fresh batch that bridges from the last song — so playback never runs dry.
4. If you manually skip or play something new (which clears Spotify's queue), it **rebuilds** from where you are.

**Flow ordering** sequences picks harmonically — Camelot key compatibility, BPM and energy smoothness — and is **genre-aware**: a soft genre-similarity term (using your artists' Last.fm tags, so *metalcore↔hardcore* reads as close while *metal↔bedroom-pop* reads as far) nudges transitions toward genre coherence and away from the jarring "same key, opposite genre" jump. The whole window also avoids repeating an artist back-to-back and won't replay a song until many others have passed.

**Fit-to-the-song.** When you search a track and play it, the queue is pulled toward *that* song — its energy/valence neighbourhood and (weighted most strongly) its **genre** — so Up Next actually matches what you played, not just the seed artist. How tightly it sticks is governed by the Variety slider.

Toggle the whole engine on/off from the Queue card's **Auto** pill; when off, playback falls back to Spotify's own anchors.

### The Insights card

A tabbed card that is the cockpit for the intelligence engine:

**Profile · Artists · Portraits · Mixes · Tuning · Data**

- **Profile** — your listening at a glance: totals, a time-of-day/day-of-week heatmap, and patterns.
- **Artists** — every recently-played artist with a 5-level rating (see [ratings](#taste-learning--artist-ratings)).
- **Portraits** — "your day in music": who you are at each part of the day, plus a *time-machine* that can replay a real past track from this same slot.
- **Mixes** — the genre × mood builder (below).
- **Tuning** — the six dials that shape every pick (below).
- **Data** — a read-only diagnostics view of everything the engine knows (below).

### Mixes — the genre × mood map

One unified way to say "play exactly this kind of music":

- A **2D pad** where the X axis is mood (Dark ↔ Bright = sad ↔ happy / low ↔ high valence) and the Y axis is energy (Calm ↔ Intense). The glowing **heat-cloud** is your *own* listening, so you can see where your music actually lives. Drag the puck anywhere to target an exact point; it defaults onto the song you're currently playing.
- A row of **genre chips** (Hip-Hop, Rock, Pop, … plus **Any**) layered on top. Pick **Any** for a pure mood mix; pick a genre to constrain the mix to it.

Behind a single **Play this** button, both feed one builder: it pulls your library/history near the chosen point, gates fresh discovery to that region, then runs the shared taste/flow/spacing tail — so a mood, a genre, or a genre-and-mood are all the same engine with different parameters. A running mix **keeps going** (continuous), and **auto-disables** if the music drifts too far from what you picked.

### The genre system

Spotify no longer returns genres for ordinary apps (the field is stripped from artist objects, and the bulk-artist endpoint 403s). So genres come from **Last.fm**:

- A background job resolves **every artist in your local library** to its Last.fm genre tags, rolls those granular tags up into ~10 macro-buckets (Hip-Hop, Pop, Rock, Electronic, R&B/Soul, Metal, Indie/Alt, Country, Jazz, Classical), and caches them permanently to disk. It runs in throttled passes until 100% covered, then re-scans periodically for newly-played artists. The console logs progress (`[Genre] … 467/467 = 100% covered`).
- Picking a genre is **strict** — a "Rock" mix plays only confirmed-rock tracks, and fresh discovery is sourced from Spotify's `genre:"rock"` *search* (which still works), whose results are also used to *build* the genre DB further.
- Genre also acts as a **soft, supporting signal** in the everyday queue — smoothing transitions and gently biasing selection — without ever hard-filtering, so unknown-genre songs still play (and get resolved over time).

You provide a free Last.fm API key once (Settings → Spotify → Last.fm API Key).

### Taste learning & artist ratings

The engine builds a durable model of what you like:

- **Artist ratings** (on the Artists tab) — an explicit 5-level scale: ❤️ Love · 👍 Like · 😐 Neutral · 👎 Dislike · 🚫 Never. These **override** the engine's guesses — *Love/Like* surfaces an artist more, *Dislike/Never* strongly down-weights it (but never hard-blocks it; you can still hear them occasionally).
- **Learned scores** — every engaged listen nudges an artist up; every early skip nudges it down (how hard is the Skip-sensitivity dial). Skips also remember the *context* they happened in.
- **Transition memory** — it learns which song→song sequences survive in *your* listening and reinforces those "bonded pairs."
- **Favourites** — most-played artists and on-repeat tracks are detected from history.
- Selection is **taste-weighted but randomised**, so loved artists are far more likely without the queue becoming the same songs every session.

### Feelings & check-ins

Occasionally the app asks **"How are you feeling?"** with a quick set of moods (Sad, Chill, Focused, Happy, Energetic, Hype, Angsty). Crucially, an answer is a **label, not a command** — it doesn't change what's playing. It records the association between *how you said you felt* and *what you were actually listening to* at that moment.

That log powers two things:

- The **time-of-day prediction** ("It's Wednesday 9pm — your evenings usually feel angsty") on the Now Playing card.
- A **learned, personal feeling** mode: over time the app discovers that *your* "sad" might sit nowhere near the textbook definition — maybe it's mid-energy and indie-leaning. Once a feeling has enough check-ins **and** has drifted meaningfully off its generic box, playing it draws from the songs *you* actually reach for when you feel that way (recency-weighted). Until then it falls back to the generic energy/valence band. You can watch this divergence accumulate on the Data tab.

### Now Playing intelligence

A compact card focused on the current moment. It shows the **active selection** (a mix/genre/mood and its "drawing from N of your songs" pool) only when you've picked one, and a **time-of-day prediction** card with a ▶ to play it. A confidence bar reflects how firmly it has read your current vibe. The artist line scrolls as a smooth, continuous marquee.

### Tuning — the dials

Six sliders shape **every** feature — autoplay, mixes, genres, feelings, the lot:

| Dial | Effect |
|------|--------|
| **Fresh vs Familiar** | How much of each batch is new discovery vs your own library. |
| **Variety** | How far the engine wanders from your core taste / the seed; also how tightly a search-play sticks to the played song. |
| **Fade smoothness** | How closely consecutive tracks must blend — drives harmonic flow ordering **and** how strongly genre shapes transitions. |
| **Mood lock vs Flow** | 0 = lock tight to the chosen mood point, 100 = roam. |
| **Skip sensitivity** | How hard an early skip steers away from an artist. |
| **Lookahead** | How many tracks are staged per refill. |

Changes apply live and persist.

### Data — the diagnostics tab

A read-only window into everything the engine knows about you and how it's using it:

- **Library** — tracks known, how many have audio features, your logged plays, saved-library size, sessions, features cached.
- **Taste** — artists learned, loved/rated counts, disliked tracks, transitions learned, and your top artists (with taste score, rating badge and genres).
- **Genre knowledge** — coverage bar and per-bucket counts.
- **Right now** — the live vibe (energy/valence/bpm/genre) and the time-of-day guess.
- **Your feelings (learned vs generic)** — per feeling: how many check-ins, your learned energy/valence vs the generic box, the **drift**, the genre lean, and your anchor songs — tagged `personalized · live`, `on the box`, or `learning`.
- **Smart queue state** — on/off, source, active selection, pool size, window size, and the current genre-aware-transition weight.
- **Tuning** — your current dial values, explained.

---

## How it works under the hood

- **Local-first.** All learning — history, taste, ratings, transitions, genres, feelings — lives in flat files on the Pi and is computed in-memory. The queue is built from your own data first; live API calls are a last resort, rate-limit-gated, and well-spaced.
- **Audio features via ReccoBeats.** Spotify's `/audio-features` is blocked, so energy/valence/bpm/key come from the free [ReccoBeats](https://reccobeats.com) API (serialised + backed-off to avoid 429s) and are cached to disk.
- **Genres via Last.fm.** As above — `artist.getTopTags`, rolled into macro-buckets, cached forever.
- **No recommendations endpoint.** Spotify's recommendation/radio API is also blocked, which is precisely why the Smart Queue sources its own continuation rather than relying on native autoplay.
- **Resilient.** A health monitor watches the Spotify API (success rate, 429s, a circuit breaker) and the engine degrades gracefully — a failed analysis can never blank the dashboard.

---

## Configuration & data files

Everything the engine persists lives under `server/data/` (git-ignored):

| File | Contents |
|------|----------|
| `layout.json` | Your grid: pages, cards, settings. |
| `spotify-config.json` | Spotify Client ID/Secret, Last.fm key, timezone override. |
| `spotify-tokens.json` | Spotify OAuth tokens. |
| history / sessions | Your play history and past listening sessions. |
| taste profile | Learned artist scores, ratings, disliked tracks, transitions, **artist→genre tags**, slot biases. |
| feature cache | Cached audio features (ReccoBeats). |
| feeling log | Your check-in labels + the snapshots behind them. |
| user prefs | Tuning, Smart-Queue toggle, check-in auto. |

A **timezone override** (Settings, or the Tuning tab) corrects hour-of-day/weekday for the heatmap, vibes and predictions — and repairs past history when changed.

---

## Troubleshooting

**Web UI won't load** — check `pm2 logs vm-control`; confirm port 3002 is reachable and you're on the same network.

**Spotify actions fail** — re-check Client ID/Secret and that the Redirect URI exactly matches `http://<Pi-IP>:3002/api/spotify/callback`. If likes/search/playlists error, disconnect and reconnect (token scopes).

**No genres / empty Mixes genre chips** — make sure a **Last.fm key** is saved; watch the `[Genre]` log lines climb toward `100% covered`. Artists Last.fm doesn't know stay genre-less (a small minority).

**"Audio features unavailable"** — ReccoBeats was momentarily unreachable; it retries and caches. Harmless and transient.

**Queue stops after one song / feels generic** — confirm the **Auto** pill on the Queue card is on (Smart Queue enabled).

**VoiceMeeter shows "Offline"** — make sure VoiceMeeter is open *before* the bridge, the bridge's `config.json` points at the right Pi IP/port, and the bridge tray icon is present. Check both the Pi (`pm2 logs`) and the bridge console.

**iPad can't reach the Pi** — same Wi-Fi, correct IP (`hostname -I`), try `http://<Pi-IP>:3002` directly.
