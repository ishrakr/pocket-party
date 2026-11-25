// Landing Hub Runtime: creates rooms, detects Cast/AirPlay capabilities, and routes players cleanly.
import { CastBridge } from '/js/cast-bridge.js';

const btnCastAndPlay = document.getElementById('btn-cast-and-play');
const btnAirplayAndPlay = document.getElementById('btn-airplay-and-play');
const joinForm = document.getElementById('join-form');
const inputRoomCode = document.getElementById('input-room-code');
const capList = document.getElementById('cap-list');
const lanHint = document.getElementById('lan-hint');
const btnToggleCastCfg = document.getElementById('btn-toggle-cast-cfg');
const castCfgBox = document.getElementById('cast-cfg-box');
const inputCastAppId = document.getElementById('input-cast-appid');
const btnSaveAppId = document.getElementById('btn-save-appid');

const bridge = new CastBridge();

function renderCapabilities() {
  const c = bridge.capabilities;
  const items = [
    { label: c.googleCast ? 'Google Cast SDK Ready' : 'Google Cast SDK (Optional App ID)', ready: c.googleCast },
    { label: c.presentation ? 'Chrome Cast / Presentation API Ready' : 'Presentation API (Chrome)', ready: c.presentation },
    { label: c.airplay ? 'Apple AirPlay Picker Ready' : 'Apple AirPlay (Safari iOS/macOS)', ready: c.airplay },
    { label: c.remotePlayback ? 'Remote Playback Ready' : 'Remote Playback API', ready: c.remotePlayback },
    { label: 'DeviceMotionEvent' in window ? 'Motion Sensors API Supported' : 'Desktop Swipe / Keyboard Mode', ready: 'DeviceMotionEvent' in window }
  ];
  capList.innerHTML = items
    .map((it) => `<span class="cap-chip ${it.ready ? 'ready' : ''}">${it.ready ? '✓' : '•'} ${it.label}</span>`)
    .join('');
}

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.castAppId && !bridge.castAppId) {
      bridge.setCastAppId(cfg.castAppId);
    } else if (bridge.castAppId) {
      bridge.initGoogleCast();
    }
    inputCastAppId.value = bridge.castAppId || cfg.castAppId || '';

    const isPublicOrSecure = Boolean(cfg.isPublicDeployment || cfg.secure || window.location.protocol === 'https:');
    if (isPublicOrSecure && cfg.isPublicDeployment) {
      lanHint.innerHTML = `Phone Join URL: <strong>${cfg.joinBaseUrl || window.location.origin}</strong>${cfg.secure || window.location.protocol === 'https:' ? ' (HTTPS Secure ✓)' : ''}`;
    } else {
      const lanList = cfg.lanIPs?.length
        ? cfg.lanIPs.map((ip) => `${cfg.httpsEnabled ? 'https' : 'http'}://${ip}:${cfg.httpsEnabled ? cfg.httpsPort : cfg.httpPort}`).join('  •  ')
        : window.location.origin;

      lanHint.innerHTML = `Phone Join URL: <strong>${lanList}</strong>${!cfg.httpsEnabled && window.location.protocol !== 'https:' ? ' — Tip: start with <code>npm run start:https</code> for iOS/Android motion sensors over Wi-Fi.' : ' (HTTPS Secure ✓)'}`;
    }
    renderCapabilities();
  })
  .catch(() => renderCapabilities());

renderCapabilities();

async function createRoomCode() {
  const res = await fetch('/api/rooms', { method: 'POST' });
  const data = await res.json();
  return data.roomCode;
}

btnCastAndPlay.addEventListener('click', async () => {
  btnCastAndPlay.disabled = true;
  try {
    const code = await createRoomCode();
    window.location.href = `/controller.html?room=${encodeURIComponent(code)}&cast=auto`;
  } catch {
    window.location.href = '/controller.html?cast=auto';
  }
});

btnAirplayAndPlay.addEventListener('click', async () => {
  btnAirplayAndPlay.disabled = true;
  try {
    const code = await createRoomCode();
    window.location.href = `/controller.html?room=${encodeURIComponent(code)}&airplay=1`;
  } catch {
    window.location.href = '/controller.html?airplay=1';
  }
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = inputRoomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return;
  window.location.href = `/controller.html?room=${encodeURIComponent(code)}`;
});

btnToggleCastCfg.addEventListener('click', () => {
  castCfgBox.classList.toggle('hidden');
});

btnSaveAppId.addEventListener('click', async () => {
  bridge.setCastAppId(inputCastAppId.value.trim());
  await bridge.initGoogleCast();
  renderCapabilities();
  alert(inputCastAppId.value.trim() ? 'Cast App ID saved! Reloading Cast SDK.' : 'Cast App ID cleared.');
});
