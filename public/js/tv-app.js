// TV display, Presentation API receiver, and Google Cast custom Web Receiver runtime.
import { CAST_NAMESPACE, GAMES, MSG, PHASE, TEAMS } from '../../shared/protocol.js';
import { GameSocket } from '/js/ws-client.js';
import { CourtRenderer } from '/js/court-renderer.js';
import { BowlingRenderer } from '/js/bowling-renderer.js';
import { TennisAudio } from '/js/audio.js';
import { renderQRToCanvas } from '/js/qr.js';

const params = new URLSearchParams(window.location.search);
let targetRoomCode = (params.get('room') || '').toUpperCase().trim();
const castParam = params.get('cast') || (document.body.dataset.castReceiver ? 'google_cast' : null);
const isCastReceiver = Boolean(document.body.dataset.castReceiver);

const $ = (id) => document.getElementById(id);
const canvas = $('court-canvas');
const qrCanvas = $('qr-canvas');
const roomCodeDisplay = $('room-code-display');
const joinUrlDisplay = $('join-url-display');
const seatsGrid = $('seats-grid');
const playerCount = $('player-count-pill');
const lobbyOverlay = $('lobby-overlay');
const summaryOverlay = $('summary-overlay');
const summaryKicker = $('summary-kicker');
const summaryTitle = $('summary-title');
const summaryScore = $('summary-score');
const summaryStatsHead = $('summary-stats-head');
const summaryStatsBody = $('summary-stats-body');
const castBadge = $('cast-badge');
const modeField = $('mode-field');
const formatField = $('format-field');
const bowlingFormatField = $('bowling-format-field');
const btnSound = $('btn-sound');
const btnFullscreen = $('btn-fullscreen');
const btnLobbyBack = $('btn-lobby-back');
const btnStartMatch = $('btn-start-match');
const btnRematch = $('btn-rematch');
const btnReturnLobby = $('btn-return-lobby');
const btnOpenCtrl = $('btn-open-ctrl');

const TEAM_CSS = ['var(--blue)', 'var(--red)'];
const SEAT_CSS = ['var(--blue)', 'var(--red)', '#4fd1e8', '#ff9a4d'];

let activeGameId = GAMES.TENNIS.id;
let renderer = new CourtRenderer(canvas, { showEmbeddedHud: true });
const audio = new TennisAudio();
const socket = new GameSocket();

let serverConfig = { joinBaseUrl: window.location.origin };
let currentRoom = null;
let currentGameState = null;
let lastQrUrl = '';
let lastSeatsKey = '';
let summaryShownFor = null;

function ensureRendererForGame(gameId) {
  const normalized = gameId === GAMES.BOWLING.id ? GAMES.BOWLING.id : GAMES.TENNIS.id;
  if (activeGameId === normalized && renderer) return;
  activeGameId = normalized;
  renderer.stop();
  renderer = normalized === GAMES.BOWLING.id
    ? new BowlingRenderer(canvas, { showEmbeddedHud: true })
    : new CourtRenderer(canvas, { showEmbeddedHud: true });
  if (currentRoom?.roomCode) renderer.setRoomCode(currentRoom.roomCode);
  if (currentGameState && currentGameState.gameId === normalized) {
    renderer.updateState(currentGameState);
  }
  renderer.start();
}

// Cap the backing store at 1920px wide: 4K TVs and Chromecasts gain nothing visible
// from more pixels but pay for every fill.
const MAX_BACKING_WIDTH = 1920;
function resizeCanvas() {
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2, MAX_BACKING_WIDTH / Math.max(1, cssW));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}
let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(resizeCanvas);
});
resizeCanvas();
renderer.start();

if (navigator.wakeLock?.request) {
  const requestWake = () => navigator.wakeLock.request('screen').catch(() => {});
  requestWake();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWake();
  });
}

window.addEventListener('pointerdown', () => audio.unlock(), { once: true });

// Hide the toolbar and cursor while a match is running and nobody touches the mouse
let idleTimer = 0;
function wake() {
  document.body.classList.remove('tv-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (currentRoom && currentRoom.phase !== PHASE.LOBBY) document.body.classList.add('tv-idle');
  }, 3000);
}
window.addEventListener('pointermove', wake, { passive: true });
window.addEventListener('keydown', wake);

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    serverConfig = cfg;
    if (currentRoom?.roomCode) updateQrAndCode(currentRoom.roomCode);
  })
  .catch(() => {});

function updateQrAndCode(code) {
  if (roomCodeDisplay.textContent !== code) roomCodeDisplay.textContent = code;
  renderer.setRoomCode(code);
  const base = serverConfig.joinBaseUrl || window.location.origin;
  const joinUrl = `${base}/play?room=${encodeURIComponent(code)}`;
  if (joinUrl === lastQrUrl) return;
  lastQrUrl = joinUrl;
  joinUrlDisplay.textContent = joinUrl.replace(/^https?:\/\//, '');
  try {
    renderQRToCanvas(qrCanvas, joinUrl, { pixelSize: 204 });
  } catch { /* ignore */ }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setPressed(selector, predicate) {
  document.querySelectorAll(selector).forEach((b) => {
    const on = predicate(b);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function seatRole(s, isBowling) {
  if (isBowling) return `Bowler ${s.seat + 1}`;
  const team = s.team === TEAMS.BLUE ? 'Blue' : 'Red';
  return s.role === 'front' ? `${team}, at the net` : `${team}, baseline`;
}

function seatTag(s, isBowling) {
  if (s.isHuman) return s.isHost ? 'Host' : 'Phone';
  if (s.active) return 'Computer';
  return isBowling ? 'Open' : 'Doubles only';
}

function renderSeats(room) {
  const isBowling = room.gameId === GAMES.BOWLING.id;
  playerCount.innerHTML = `<strong>${room.playerCount}</strong> of 4 phones`;

  const key = JSON.stringify([room.gameId, room.seats.map((s) => [s.name, s.isHuman, s.isHost, s.active, s.team])]);
  if (key !== lastSeatsKey) {
    lastSeatsKey = key;
    seatsGrid.innerHTML = room.seats.map((s) => {
      const color = isBowling ? SEAT_CSS[s.seat] : TEAM_CSS[s.team];
      const cls = ['lineup-row', s.isHuman ? 'is-human' : '', s.active || s.isHuman ? '' : 'is-off'].join(' ');
      return `
        <div class="${cls}" style="--seat:${color}">
          <span class="lineup-bar"></span>
          <span class="lineup-num">${s.seat + 1}</span>
          <span class="lineup-name">${escapeHtml(s.name)}<span class="lineup-role">${seatRole(s, isBowling)}</span></span>
          <span class="lineup-tag">${seatTag(s, isBowling)}</span>
        </div>`;
    }).join('');
  }

  const gameId = room.gameId || GAMES.TENNIS.id;
  setPressed('#game-group .game-tile', (b) => b.dataset.game === gameId);
  modeField?.classList.toggle('hidden', isBowling);
  formatField?.classList.toggle('hidden', isBowling);
  bowlingFormatField?.classList.toggle('hidden', !isBowling);

  setPressed('#mode-group .seg-btn', (b) => b.dataset.mode === room.mode);
  setPressed('#format-group .seg-btn', (b) => b.dataset.format === room.format);
  setPressed('#bowling-format-group .seg-btn', (b) => b.dataset.format === room.format);
  setPressed('#diff-group .seg-btn', (b) => b.dataset.diff === room.difficulty);
}

function renderSummary(state) {
  summaryKicker.textContent = 'Match over';
  if (state.gameId === GAMES.BOWLING.id) {
    const ranked = (state.players || []).filter((p) => p.active).sort((a, b) => b.totalScore - a.totalScore);
    const top = ranked[0];
    const isTie = (state.winnerSeats?.length || 0) > 1;
    summaryTitle.textContent = isTie ? 'It’s a tie' : `${top?.name || 'Player 1'} wins`;
    summaryScore.textContent = `${top?.totalScore ?? 0} points over ${state.totalFrames} frames`;
    summaryStatsHead.innerHTML = '<tr><th style="text-align:left">Bowler</th><th>Strikes</th><th>Spares</th><th style="text-align:right">Total</th></tr>';
    summaryStatsBody.innerHTML = ranked.map((p, i) => `
      <tr>
        <td style="text-align:left; color:${SEAT_CSS[p.seat]}">${escapeHtml(p.name)}</td>
        <td>${p.strikes}</td>
        <td>${p.spares}</td>
        <td style="text-align:right" class="${i === 0 ? 'win' : ''}">${p.totalScore}</td>
      </tr>`).join('');
    return;
  }

  const blueWon = state.winnerTeam === TEAMS.BLUE;
  summaryKicker.innerHTML = `Match over <span style="color:${blueWon ? 'var(--blue)' : 'var(--red)'}">●</span>`;
  summaryTitle.textContent = blueWon ? 'Blue wins' : 'Red wins';
  summaryScore.textContent = `${state.games[0]}–${state.games[1]} in games`;
  summaryStatsHead.innerHTML = '<tr><th style="color:var(--blue)">Blue</th><th></th><th style="color:var(--red)">Red</th></tr>';

  const st = state.stats;
  const rows = [
    [st.aces[0], 'Aces', st.aces[1]],
    [st.winners[0], 'Winners', st.winners[1]],
    [st.sweetSpots[0], 'Sweet spots and smashes', st.sweetSpots[1]],
    [st.maxMph[0], 'Fastest shot (mph)', st.maxMph[1]]
  ];
  summaryStatsBody.innerHTML = rows.map(([b, label, r]) => `
    <tr>
      <td class="${b > r ? 'win' : ''}">${b}</td>
      <td>${label}</td>
      <td class="${r > b ? 'win' : ''}">${r}</td>
    </tr>`).join('') +
    `<tr><td colspan="3" style="font-size:0.9375em; font-weight:500; color:var(--chalk-dim)">Longest rally: ${st.longestRally} shots</td></tr>`;
}

function showOverlay(el, show) {
  const wasHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  if (show && wasHidden) {
    el.removeAttribute('data-enter');
    void el.offsetWidth;
    el.setAttribute('data-enter', '');
  }
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
      deviceName: method === 'google_cast' ? 'Chromecast' : (method === 'presentation' ? 'Cast display' : 'TV screen')
    });
  } else {
    socket.send({
      type: MSG.CREATE_ROOM,
      role: 'display',
      castMethod: method || 'tv_browser',
      deviceName: 'TV screen'
    });
  }
}

function setCastBadge(text) {
  castBadge.textContent = text;
  castBadge.classList.remove('hidden');
}

// --- Socket handlers ---
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
  ensureRendererForGame(room.gameId);
  updateQrAndCode(room.roomCode);
  renderSeats(room);

  const inLobby = room.phase === PHASE.LOBBY;
  const isOver = room.phase === PHASE.MATCH_OVER;
  showOverlay(lobbyOverlay, inLobby);
  if (!isOver) {
    showOverlay(summaryOverlay, false);
    summaryShownFor = null;
  }
  btnLobbyBack?.classList.toggle('hidden', inLobby);
  if (inLobby) document.body.classList.remove('tv-idle');
  else wake();

  if (room.castState?.active && room.castState.method !== 'tv_browser') {
    setCastBadge(room.castState.deviceName || 'Casting');
  }
});

socket.on(MSG.GAME_STATE, ({ state }) => {
  currentGameState = state;
  if (state.gameId) ensureRendererForGame(state.gameId);
  renderer.updateState(state);
  if (state.phase === PHASE.MATCH_OVER) {
    // State keeps streaming after the match; build the summary once per result
    const key = `${state.gameId}:${state.clock > 0 ? Math.floor(state.clock / 3600) : 0}:${state.winnerTeam ?? ''}:${(state.winnerSeats || []).join(',')}`;
    if (summaryShownFor !== key) {
      summaryShownFor = key;
      renderSummary(state);
    }
    showOverlay(summaryOverlay, true);
    document.body.classList.remove('tv-idle');
  }
});

const AUDIO_EVENTS = {
  ball_hit: (e) => audio.playHit({ power: e.power, shotType: e.shotType, sweetSpot: e.sweetSpot }),
  swing_whoosh: (e) => audio.playWhoosh(e.power),
  ball_bounce: (e) => audio.playBounce(e.inBounds),
  serve_toss: () => audio.playToss(),
  net_hit: () => audio.playNetHit(),
  net_cord: () => audio.playNetHit(),
  fault: () => audio.playFault(),
  point_over: () => audio.playFanfare('point'),
  game_over: () => audio.playFanfare('game'),
  bowl_throw: () => audio.playBowlRoll(),
  pin_hit: (e) => audio.playPinCrash(e.intensity),
  gutter_ball: () => audio.playGutter(),
  roll_over: (e) => { if (e.isStrike || e.isSpare) audio.playFanfare(e.isStrike ? 'game' : 'point'); },
  match_over: () => audio.playFanfare('match')
};

socket.on(MSG.GAME_EVENT, ({ event }) => {
  renderer.handleGameEvent(event);
  if (!event) return;
  AUDIO_EVENTS[event.type]?.(event);
});

// --- TV controls ---
function bindGroup(selector, toMessage) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.unlock();
      socket.send(toMessage(btn));
    });
  });
}

bindGroup('#game-group .game-tile', (b) => ({ type: MSG.SELECT_GAME, gameId: b.dataset.game }));
bindGroup('#mode-group .seg-btn', (b) => ({ type: MSG.UPDATE_CONFIG, config: { mode: b.dataset.mode } }));
bindGroup('#format-group .seg-btn', (b) => ({ type: MSG.UPDATE_CONFIG, config: { format: b.dataset.format } }));
bindGroup('#bowling-format-group .seg-btn', (b) => ({ type: MSG.UPDATE_CONFIG, config: { format: b.dataset.format } }));
bindGroup('#diff-group .seg-btn', (b) => ({ type: MSG.UPDATE_CONFIG, config: { difficulty: b.dataset.diff } }));

btnStartMatch?.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.START_MATCH });
});

btnRematch?.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.REMATCH });
});

btnReturnLobby?.addEventListener('click', () => socket.send({ type: MSG.RETURN_LOBBY }));
btnLobbyBack?.addEventListener('click', () => socket.send({ type: MSG.RETURN_LOBBY }));

function setIcon(btn, id) {
  btn?.querySelector('use')?.setAttribute('href', `/icons.svg#${id}`);
}

btnSound?.addEventListener('click', () => {
  audio.unlock();
  audio.setMuted(!audio.muted);
  setIcon(btnSound, audio.muted ? 'i-volume-off' : 'i-volume');
  const label = audio.muted ? 'Unmute' : 'Mute';
  btnSound.title = label;
  btnSound.setAttribute('aria-label', label);
  btnSound.setAttribute('aria-pressed', String(audio.muted));
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
  window.open(`/controller.html?room=${encodeURIComponent(targetRoomCode)}`, '_blank', 'width=430,height=860');
});

// --- W3C Presentation API receiver ---
if (navigator.presentation?.receiver) {
  navigator.presentation.receiver.connectionList.then((list) => {
    const bindConn = (conn) => {
      setCastBadge('Casting');
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

// --- Google Cast custom Web Receiver ---
let castReceiverStarted = false;
function initGoogleCastReceiverIfPresent() {
  if (castReceiverStarted || !window.cast?.framework?.CastReceiverContext) return;
  try {
    const castCtx = window.cast.framework.CastReceiverContext.getInstance();
    castCtx.addCustomMessageListener(CAST_NAMESPACE, (evt) => {
      const data = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
      if (data?.type === 'JOIN_ROOM' && data.roomCode) {
        joinOrCreateDisplayRoom(data.roomCode, 'google_cast');
      }
    });
    const opts = new window.cast.framework.CastReceiverOptions();
    opts.disableIdleTimeout = true;
    castCtx.start(opts);
    castReceiverStarted = true;
    setCastBadge('Chromecast');
  } catch { /* not on Cast hardware */ }
}

if (isCastReceiver) {
  window.addEventListener('load', () => {
    initGoogleCastReceiverIfPresent();
    setTimeout(initGoogleCastReceiverIfPresent, 1200);
  });
}

socket.connect();
