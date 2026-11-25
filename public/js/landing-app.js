// Landing page: creates rooms, routes players, and shows casting/network setup.
import { CastBridge } from '/js/cast-bridge.js';

const btnCastAndPlay = document.getElementById('btn-cast-and-play');
const btnAirplayAndPlay = document.getElementById('btn-airplay-and-play');
const joinForm = document.getElementById('join-form');
const inputRoomCode = document.getElementById('input-room-code');
const joinError = document.getElementById('join-error');
const capList = document.getElementById('cap-list');
const lanHint = document.getElementById('lan-hint');
const tvUrlInline = document.getElementById('tv-url-inline');
const inputCastAppId = document.getElementById('input-cast-appid');
const btnSaveAppId = document.getElementById('btn-save-appid');
const appIdStatus = document.getElementById('appid-status');

const bridge = new CastBridge();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCapabilities() {
  const c = bridge.capabilities;
  const items = [
    { label: 'Chrome casting', ready: c.presentation },
    { label: 'Chromecast app', ready: c.googleCast },
    { label: 'AirPlay', ready: c.airplay },
    { label: 'Remote playback', ready: c.remotePlayback },
    { label: 'Motion sensors', ready: 'DeviceMotionEvent' in window }
  ];
  capList.innerHTML = items
    .map((it) => `<li class="${it.ready ? 'ready' : ''}"><span class="dot"></span>${it.label}<span class="sr-only">${it.ready ? ' available' : ' not available'}</span></li>`)
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

    const base = cfg.joinBaseUrl || window.location.origin;
    tvUrlInline.textContent = `${base.replace(/^https?:\/\//, '')}/tv`;

    if (cfg.isPublicDeployment) {
      lanHint.innerHTML = `<span class="url">${escapeHtml(base)}</span>`;
    } else {
      const proto = cfg.httpsEnabled ? 'https' : 'http';
      const p = cfg.httpsEnabled ? cfg.httpsPort : cfg.httpPort;
      const urls = cfg.lanIPs?.length ? cfg.lanIPs.map((ip) => `${proto}://${ip}:${p}`) : [window.location.origin];
      const secure = cfg.httpsEnabled || window.location.protocol === 'https:';
      lanHint.innerHTML = urls.map((u) => `<span class="url">${escapeHtml(u)}</span>`).join('<br>') +
        (secure ? '' : '<br>Phones need HTTPS for motion sensors on Wi-Fi. Start the server with <span class="url">npm run start:https</span>.');
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

async function hostAndGo(btn, query) {
  btn.disabled = true;
  try {
    const code = await createRoomCode();
    window.location.href = `/controller.html?room=${encodeURIComponent(code)}&${query}`;
  } catch {
    window.location.href = `/controller.html?${query}`;
  }
}

btnCastAndPlay.addEventListener('click', () => hostAndGo(btnCastAndPlay, 'cast=auto'));
btnAirplayAndPlay.addEventListener('click', () => hostAndGo(btnAirplayAndPlay, 'airplay=1'));

inputRoomCode.addEventListener('input', () => {
  const cleaned = inputRoomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned !== inputRoomCode.value) inputRoomCode.value = cleaned;
  joinError.classList.add('hidden');
});

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = inputRoomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 4) {
    joinError.textContent = 'Room codes have four characters. Check the code on the TV.';
    joinError.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
    if (res.status === 404) {
      joinError.textContent = `No room ${code} is open. Check the code on the TV.`;
      joinError.classList.remove('hidden');
      return;
    }
  } catch { /* offline check failed: try joining anyway */ }
  window.location.href = `/controller.html?room=${encodeURIComponent(code)}`;
});

btnSaveAppId.addEventListener('click', async () => {
  const id = inputCastAppId.value.trim();
  bridge.setCastAppId(id);
  await bridge.initGoogleCast();
  renderCapabilities();
  appIdStatus.textContent = id ? `Saved app ID ${id}. The Cast SDK will use it on this device.` : 'App ID cleared.';
});
