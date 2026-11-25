# 🎾 PocketParty

A **100% web-based motion-controlled party tennis game** built for **Google Cast**, **Apple AirPlay**, and **1–4 player multiplayer** — cast the 3D court to your TV and immediately swing the very phone you casted with as a wireless motion-sensing tennis racket!

---

## ✨ Features

- **Real Web Casting + Phone-as-Controller Flow**
  - **Google Cast Web Sender & Custom Web Receiver (`/receiver.html`)**: Connects over `urn:x-cast:com.pocketparty.tennis` + low-latency WebSockets so up to 4 phones play together on one Chromecast.
  - **W3C Presentation API (`PresentationRequest`)**: Cast `/tv.html` directly from Chrome (Android / Desktop) to Cast displays or secondary monitors with **zero Cast Developer registration required**.
  - **Apple AirPlay & W3C Remote Playback**: Renders a live 1280×720 3D court stream (`canvas.captureStream` + Web Audio track) into an AirPlay-enabled `<video x-webkit-airplay="allow">` element via `webkitShowPlaybackTargetPicker()` / `video.remote.prompt()`, keeping your phone in full-screen **Motion Racket Controller** mode while the TV displays the match!
  - **Universal TV Screen + Scannable QR Code**: Open `/tv` on any Smart TV browser, Apple TV Mirroring, or HDMI laptop — a crisp QR Code & 4-character Room Code let up to 4 phones join in seconds.
- **Arcade Motion Tennis Gameplay & Physics**
  - **60 Hz Authoritative 3D Physics Engine**: Gravity, air drag, **Magnus spin physics** (heavy topspin dips & kicks forward; backspin slice floats & skids low), net-cord deflections, serve **Let** replays, line calls, **Fault / Double Fault**, **Deuce / Advantage**, and realistic ball bounce decals.
  - **Automatic Court Positioning**: No joystick needed — your athlete runs intelligently toward incoming shots so you keep your eyes on the TV and focus purely on swing timing, spin, and placement!
  - **Full Motion Racket IMU Detection (`DeviceMotionEvent` & `DeviceOrientationEvent`)**:
    - Flick phone **UP** to toss your serve, then swing at the **Golden Sweet-Spot Apex** for a **120+ MPH Rocket Serve!**
    - Early / center / late swing timing steers shots cross-court, down-the-line, or angled wide.
    - Forehand vs Backhand detection, upward scoop **Lob**, downward **Power Smash**, wrist-twist **Topspin / Slice**, **Calibration**, and **Haptic Rumble (`navigator.vibrate`)** on hits & smashes.
    - Live 20 Hz phone orientation streams straight to your character's 3D racket on the TV!
  - **Desktop / Touch Swipe & Keyboard Support**: Built-in interactive swipe racket pad + keyboard controls (`Space`, `W/A/S/D`, `Shift`) + an instant **Split-Screen Demo (`/demo.html`)** so you can play or test multiplayer on any device.
- **1–4 Player Multiplayer**
  - **1v1 Singles** (1 Player vs CPU, or 2 Phones head-to-head)
  - **2v2 Doubles** (Co-op 2 Phones vs 2 CPUs, 3 Phones + 1 CPU, or full 4-Phone party match!)
  - Selectable Match Formats (**1 Game (Quick Match)**, **Best of 3**, **Best of 5**) and CPU skill tiers (**Rookie**, **Pro**, **Champion**).
- **Zero External Runtime Dependencies**: Runs natively on Node.js 20+ with a built-in RFC 6455 WebSocket server, pure-JS ISO 18004 QR generator, synthesized Web Audio API sound effects, and automatic self-signed LAN HTTPS cert generation.

---

## 🚀 Quick Start

### 1. Run Locally (HTTP — Instant Desktop / Split-Screen Play)
```bash
npm start
```
Open `http://localhost:3000` in your browser!
- Click **Instant Split-Screen Demo (TV + Phone)** to play immediately on one computer.
- Or open `http://localhost:3000/tv` on your big screen and connect phones via `http://<your-lan-ip>:3000/play?room=XXXX`.

### 2. Run with HTTPS over LAN Wi-Fi (Recommended for Real iPhone / Android Motion Sensors!)
Mobile Safari (iOS) and Chrome (Android) require **HTTPS** before allowing `DeviceMotionEvent` and `DeviceOrientationEvent` on non-localhost addresses. PocketParty automatically generates a LAN-IP TLS certificate via `openssl`:
```bash
npm run start:https
```
The server prints your exact LAN HTTPS URL (e.g. `https://192.168.1.42:3443`).
1. Open that HTTPS URL on your phone (accept the local self-signed dev certificate once).
2. Tap **Cast to TV & Be P1 Controller** (or **AirPlay Stream & Be P1 Controller**).
3. Tap **Enable Motion** when prompted by iOS/Android, hold your phone pointing at the TV, tap **Calibrate**, and swing!
4. Friends scan the **QR Code** on the TV to join as Player 2, 3, or 4!

### 3. Optional: Native Google Cast Custom Web Receiver App ID
Presentation API, AirPlay, and TV Browser modes work out of the box with no setup. If you also want native Chromecast app launching via the Google Cast SDK:
1. Host this server at a public HTTPS URL (or register your local testing Chromecast device in the [Google Cast SDK Developer Console](https://cast.google.com/publish/)).
2. Register a Custom Web Receiver pointing to `https://<your-domain>/receiver.html`.
3. Pass your Cast App ID via environment variable or enter it on the home page under **Configure Google Cast App ID**:
   ```bash
   CAST_APP_ID=YOUR_APP_ID npm run start:https
   ```

---

## ☁️ Deployment

PocketParty has **zero npm runtime dependencies** and runs on any Node.js 20+ host with WebSocket support (`ws://` / `wss://`), providing `/health` (and `/healthz`) health check endpoints and reverse-proxy header awareness (`X-Forwarded-Proto`, `X-Forwarded-Host`).

### Environment Variables
Copy `.env.example` if needed:
- `PORT` — HTTP server port (default `3000`, automatically set by Render/Railway/Fly/Heroku).
- `PUBLIC_URL` — Optional canonical public HTTPS URL (e.g. `https://pocketparty.example.com`) used for QR codes and phone join links when behind a proxy.
- `CAST_APP_ID` — Optional Google Cast Custom Web Receiver App ID.
- `HTTPS` — Set to `true` only when running standalone LAN HTTPS without a reverse proxy (cloud platforms terminate TLS at their edge).
- `HTTPS_PORT` — Standalone LAN HTTPS port (default `3443`).

### Deploy to Render
Includes [`render.yaml`](render.yaml) Blueprint configuration:
1. Connect `https://github.com/ishrakr/pocket-party` in the Render Dashboard as a **Blueprint** or **Web Service**.
2. Render runs `npm start` and checks `/health`.
3. HTTPS and `wss://` WebSockets work automatically out of the box for iOS/Android motion sensors!

### Deploy to Railway / Fly.io / Heroku
- Includes [`Procfile`](Procfile) (`web: node server/index.js`) and [`Dockerfile`](Dockerfile).
- Set `PORT` (handled automatically by the platform) and optionally `PUBLIC_URL`.

### Run with Docker
```bash
docker build -t pocket-party .
docker run -p 3000:3000 -e PUBLIC_URL=https://your-domain.example pocket-party
```

---

## 🎮 Controls Reference

| Action | Phone Motion Controller (IMU) | Touch Swipe Pad | Desktop Keyboard |
|---|---|---|---|
| **Serve Toss** | Flick phone upward | Tap or swipe up | `Space` |
| **Power / Rocket Serve** | Swing forward at Golden Apex | Swipe fast at Golden Apex | `Shift + Space` |
| **Forehand / Backhand** | Natural forehand/backhand swing | Swipe right / left | `Space` (+ `A`/`D` aim) |
| **Topspin / Slice** | Roll wrist forward / under | Swipe up-forward / down-across (or tap modifier) | `Space` / `S + Space` |
| **High Lob** | Upward scoop swing | Long swipe straight up (or tap Lob) | `W + Space` |
| **Overhead Smash** | Fast downward chop on high ball | Fast downward swipe | `Shift + Space` |

---

## 🧪 Running Tests
```bash
npm test
```
