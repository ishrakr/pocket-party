// TV Display, Presentation API Receiver, and Google Cast Custom Web Receiver Runtime
import { CAST_NAMESPACE, MSG, PHASE, TEAMS } from '../../shared/protocol.js';
import { GameSocket } from '/js/ws-client.js';
import { CourtRenderer } from '/js/court-renderer.js';
import { TennisAudio } from '/js/audio.js';
import { renderQRToCanvas } from '/js/qr.js';

const params = new URLSearchParams(window.location.search);
let targetRoomCode = (params.get('room') || '').toUpperCase().trim();
const castParam = params.get('cast') || (document.body.dataset.castReceiver ? 'google_cast' : null);

const canvas = document.getElementById('court-canvas');
const qrCanvas = document.getElementById('qr-canvas');
const roomCodeDisplay = document.getElementById('room-code-display');
const joinUrlDisplay = document.getElementById('join-url-display');
const seatsGrid = document.getElementById('seats-grid');
const playerCountPill = document.getElementById('player-count-pill');
const lobbyOverlay = document.getElementById('lobby-overlay');
const summaryOverlay = document.getElementById('summary-overlay');
const summaryTitle = document.getElementById('summary-title');
const summaryScore = document.getElementById('summary-score');
const summaryStatsBody = document.getElementById('summary-stats-body');
const castBadge = document.getElementById('cast-badge');
const btnSound = document.getElementById('btn-sound');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnLobbyBack = document.getElementById('btn-lobby-back');
const btnStartMatch = document.getElementById('btn-start-match');
const btnRematch = document.getElementById('btn-rematch');
const btnReturnLobby = document.getElementById('btn-return-lobby');
const btnOpenCtrl = document.getElementById('btn-open-ctrl');

const renderer = new CourtRenderer(canvas, { showEmbeddedHud: true });
const audio = new TennisAudio();
const socket = new GameSocket();

let serverConfig = { joinBaseUrl: window.location.origin };
let currentRoom = null;
let currentGameState = null;

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
renderer.start();

// Request Screen Wake Lock so TV browser doesn't dim during matches
if (navigator.wakeLock?.request) {
  navigator.wakeLock.request('screen').catch(() => {});
}

// Unlock audio on first interaction
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

// Fetch LAN base URL for scannable QR codes
fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    serverConfig = cfg;
    if (currentRoom?.roomCode) updateQrAndCode(currentRoom.roomCode);
  })
  .catch(() => {});

function updateQrAndCode(code) {
  roomCodeDisplay.textContent = code;
  renderer.setRoomCode(code);
  const base = serverConfig.joinBaseUrl || window.location.origin;
  const joinUrl = `${base}/play?room=${encodeURIComponent(code)}`;
  joinUrlDisplay.textContent = joinUrl;
  try {
    renderQRToCanvas(qrCanvas, joinUrl, { pixelSize: 204 });
  } catch { /* ignore */ }
}

function renderSeats(room) {
  playerCountPill.textContent = `${room.playerCount} / 4 Phones`;
  seatsGrid.innerHTML = '';

  const roleLabels = ['Blue • Baseline', 'Red • Baseline', 'Blue • Net (Doubles)', 'Red • Net (Doubles)'];

  for (const s of room.seats) {
    const div = document.createElement('div');
    div.className = `seat-card team-${s.team === 0 ? 'blue' : 'red'} ${s.isHuman ? 'human' : ''} ${s.active ? '' : 'inactive'}`;
    div.innerHTML = `
      <div class="seat-avatar" style="background:${s.color}">
        ${s.isHuman ? `P${s.seat + 1}` : 'CPU'}
      </div>
      <div class="seat-meta">
        <div class="seat-name">${escapeHtml(s.name)} ${s.isHost ? '👑' : ''}</div>
        <div class="seat-sub">${roleLabels[s.seat]} ${s.isHuman ? `• ${s.handedness === 'left' ? 'Lefty' : 'Righty'}` : (s.active ? '• Auto CPU' : '• Singles Off')}</div>
      </div>
    `;
    seatsGrid.appendChild(div);
  }

  // Highlight active config pills
  document.querySelectorAll('#mode-group .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === room.mode);
  });
  document.querySelectorAll('#format-group .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.format === room.format);
  });
  document.querySelectorAll('#diff-group .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === room.difficulty);
  });
}

function renderSummary(state) {
  const blueWon = state.winnerTeam === TEAMS.BLUE;
  summaryTitle.textContent = blueWon ? 'BLUE TEAM WINS!' : 'RED TEAM WINS!';
  summaryTitle.style.color = blueWon ? '#2563eb' : '#dc2626';
  summaryScore.textContent = `Final Games: ${state.games[0]} – ${state.games[1]}`;

  const st = state.stats;
  const rows = [
    [st.aces[0], 'Aces', st.aces[1]],
    [st.winners[0], 'Winners', st.winners[1]],
    [st.sweetSpots[0], 'Sweet Spots / Smashes', st.sweetSpots[1]],
    [`${st.maxMph[0]} MPH`, 'Fastest Shot', `${st.maxMph[1]} MPH`],
    [st.longestRally, 'Longest Rally', st.longestRally]
  ];
  summaryStatsBody.innerHTML = rows
    .map(([b, label, r]) => `<tr><td>${b}</td><td>${label}</td><td>${r}</td></tr>`)
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function joinOrCreateDisplayRoom(code, method = castParam) {
  targetRoomCode = code || targetRoomCode;
  if (targetRoomCode) {
    socket.send({
      type: MSG.JOIN_ROOM,
      role: 'display',
      roomCode: targetRoomCode,
      createIfMissing: true,
      castMethod: method || 'tv_browser',
      deviceName: method === 'google_cast' ? 'Chromecast' : (method === 'presentation' ? 'Cast Display' : 'TV Screen')
    });
  } else {
    socket.send({
      type: MSG.CREATE_ROOM,
      role: 'display',
      castMethod: method || 'tv_browser',
      deviceName: 'TV Screen'
    });
  }
}

// --- Socket Handlers ---
socket.on('open', () => {
  joinOrCreateDisplayRoom(targetRoomCode);
});

socket.on(MSG.WELCOME, (msg) => {
  targetRoomCode = msg.roomCode;
  const url = new URL(window.location.href);
  if (url.searchParams.get('room') !== msg.roomCode) {
    url.searchParams.set('room', msg.roomCode);
    window.history.replaceState({}, '', url.toString());
  }
  updateQrAndCode(msg.roomCode);
});

socket.on(MSG.ROOM_STATE, ({ room }) => {
  currentRoom = room;
  updateQrAndCode(room.roomCode);
  renderSeats(room);

  const inLobby = room.phase === PHASE.LOBBY;
  const isOver = room.phase === PHASE.MATCH_OVER;
  lobbyOverlay.classList.toggle('hidden', !inLobby);
  summaryOverlay.classList.toggle('hidden', !isOver);
  btnLobbyBack?.classList.toggle('hidden', inLobby);

  if (room.castState?.active && room.castState.method !== 'tv_browser') {
    castBadge.classList.remove('hidden');
    castBadge.textContent = `📺 ${room.castState.deviceName || 'Cast Active'}`;
  }
});

socket.on(MSG.GAME_STATE, ({ state }) => {
  currentGameState = state;
  renderer.updateState(state);
  if (state.phase === PHASE.MATCH_OVER) {
    renderSummary(state);
    summaryOverlay.classList.remove('hidden');
  }
});

socket.on(MSG.GAME_EVENT, ({ event }) => {
  renderer.handleGameEvent(event);
  if (!event) return;
  if (event.type === 'ball_hit') {
    audio.playHit({ power: event.power, shotType: event.shotType, sweetSpot: event.sweetSpot });
  } else if (event.type === 'swing_whoosh') {
    audio.playWhoosh(event.power);
  } else if (event.type === 'ball_bounce') {
    audio.playBounce(event.inBounds);
  } else if (event.type === 'serve_toss') {
    audio.playToss();
  } else if (event.type === 'net_hit' || event.type === 'net_cord') {
    audio.playNetHit();
  } else if (event.type === 'fault') {
    audio.playFault();
  } else if (event.type === 'point_over') {
    audio.playFanfare('point');
  } else if (event.type === 'game_over') {
    audio.playFanfare('game');
  } else if (event.type === 'match_over') {
    audio.playFanfare('match');
  }
});

// --- UI Controls on TV ---
document.querySelectorAll('#mode-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    audio.unlock();
    socket.send({ type: MSG.UPDATE_CONFIG, config: { mode: btn.dataset.mode } });
  });
});

document.querySelectorAll('#format-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    audio.unlock();
    socket.send({ type: MSG.UPDATE_CONFIG, config: { format: btn.dataset.format } });
  });
});

document.querySelectorAll('#diff-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    audio.unlock();
    socket.send({ type: MSG.UPDATE_CONFIG, config: { difficulty: btn.dataset.diff } });
  });
});

btnStartMatch?.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.START_MATCH });
});

btnRematch?.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.REMATCH });
});

btnReturnLobby?.addEventListener('click', () => {
  socket.send({ type: MSG.RETURN_LOBBY });
});

btnLobbyBack?.addEventListener('click', () => {
  socket.send({ type: MSG.RETURN_LOBBY });
});

btnSound?.addEventListener('click', () => {
  audio.unlock();
  audio.setMuted(!audio.muted);
  btnSound.textContent = audio.muted ? '🔇 Muted' : '🔊 Audio On';
});

btnFullscreen?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

btnOpenCtrl?.addEventListener('click', () => {
  if (!targetRoomCode) return;
  window.open(`/controller.html?room=${encodeURIComponent(targetRoomCode)}`, '_blank', 'width=430,height=820');
});

// --- W3C Presentation API Receiver Integration ---
if (navigator.presentation?.receiver) {
  navigator.presentation.receiver.connectionList.then((list) => {
    const bindConn = (conn) => {
      castBadge.classList.remove('hidden');
      castBadge.textContent = '📺 Cast Connected';
      conn.addEventListener('message', (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.type === 'JOIN_ROOM' && data.roomCode) {
            joinOrCreateDisplayRoom(data.roomCode, 'presentation');
          }
        } catch { /* ignore */ }
      });
    };
    list.connections.forEach(bindConn);
    list.addEventListener('connectionavailable', (e) => bindConn(e.connection));
  }).catch(() => {});
}

// --- Google Cast Custom Web Receiver SDK Integration ---
function initGoogleCastReceiverIfPresent() {
  if (!window.cast?.framework?.CastReceiverContext) return;
  try {
    const castCtx = window.cast.framework.CastReceiverContext.getInstance();
    castCtx.addCustomMessageListener(CAST_NAMESPACE, (evt) => {
      const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
      if (data?.type === 'JOIN_ROOM' && data.roomCode) {
        joinOrCreateDisplayRoom(data.roomCode, 'google_cast');
      }
    });
    const opts = new window.cast.framework.CastReceiverOptions();
    opts.disableIdleTimeout = true; // Keep court open during long multiplayer rallies!
    castCtx.start(opts);
    castBadge.classList.remove('hidden');
    castBadge.textContent = '📺 Chromecast Ready';
  } catch { /* ignore if not on Cast hardware */ }
}

if (document.body.dataset.castReceiver) {
  window.addEventListener('load', () => {
    initGoogleCastReceiverIfPresent();
    setTimeout(initGoogleCastReceiverIfPresent, 1200);
  });
}

socket.connect();
