// Phone motion controller runtime + AirPlay live court/alley streamer + Google Cast / Presentation sender
import { BOWLING_PHASE, GAMES, MSG, PHASE, TEAMS, clamp } from '../../shared/protocol.js';
import { GameSocket } from '/js/ws-client.js';
import { PhoneMotionController } from '/js/motion-controller.js';
import { CastBridge } from '/js/cast-bridge.js';
import { CourtRenderer } from '/js/court-renderer.js';
import { BowlingRenderer } from '/js/bowling-renderer.js';
import { TennisAudio } from '/js/audio.js';

const params = new URLSearchParams(window.location.search);
let roomCode = (params.get('room') || '').toUpperCase().trim();
const autoCastMode = params.get('cast') || '';
const autoAirplay = params.get('airplay') === '1';

const $ = (id) => document.getElementById(id);

// Header
const seatBadge = $('seat-badge');
const seatLabel = $('seat-label');
const seatRole = $('seat-role');
const connMeta = $('conn-meta');
const roomPill = $('room-pill');
const ctrlRtt = $('ctrl-rtt');
const btnCastTv = $('btn-cast-tv');
const castBtnLabel = $('cast-btn-label');

// Sensor banner
const sensorBanner = $('sensor-banner');
const sensorBannerText = $('sensor-banner-text');
const btnEnableSensors = $('btn-enable-sensors');
const sensorModeLabel = $('sensor-mode-label');

// Views
const ctrlLobbyView = $('ctrl-lobby-view');
const ctrlPlayView = $('ctrl-play-view');
const ctrlOverView = $('ctrl-over-view');
const ctrlOverTitle = $('ctrl-over-title');
const ctrlOverSub = $('ctrl-over-sub');

// Lobby
const inputPlayerName = $('input-player-name');
const seatPickerGrid = $('seat-picker-grid');
const ctrlModeRow = $('ctrl-mode-row');
const ctrlFormatRow = $('ctrl-format-row');
const ctrlBowlingFormatRow = $('ctrl-bowling-format-row');
const ctrlLobbyTip = $('ctrl-lobby-tip');
const btnCtrlStart = $('btn-ctrl-start');
const btnCtrlRematch = $('btn-ctrl-rematch');
const btnCtrlLobby = $('btn-ctrl-lobby');

// Play
const ctrlTennisStrip = $('ctrl-tennis-strip');
const ctrlBowlingStrip = $('ctrl-bowling-strip');
const ctrlBowlFrame = $('ctrl-bowl-frame');
const ctrlBowlTurn = $('ctrl-bowl-turn');
const ctrlBowlScore = $('ctrl-bowl-score');
const ctrlGamesBlue = $('ctrl-games-blue');
const ctrlPtsBlue = $('ctrl-pts-blue');
const ctrlGamesRed = $('ctrl-games-red');
const ctrlPtsRed = $('ctrl-pts-red');
const ctrlPrompt = $('ctrl-prompt');
const racketPad = $('racket-pad');
const racketSvg = $('racket-svg');
const bowlingBallSvg = $('bowling-ball-svg');
const padHint = $('pad-hint');
const shotFeedback = $('shot-feedback');
const shotModGroup = $('shot-mod-group');
const bowlingControlsGroup = $('bowling-controls-group');
const btnBowlLeft = $('btn-bowl-left');
const btnBowlCenter = $('btn-bowl-center');
const btnBowlRight = $('btn-bowl-right');
const swingMeterFill = $('swing-meter-fill');
const btnTapAction = $('btn-tap-action');
const btnCalibrate = $('btn-calibrate');

// Cast sheet
const castModal = $('cast-modal');
const btnCloseCastModal = $('btn-close-cast-modal');
const castStatusLine = $('cast-status-line');
const castStatusText = $('cast-status-text');
const castTvUrl = $('cast-tv-url');
const btnCastGoogle = $('btn-cast-google');
const btnCastAirplay = $('btn-cast-airplay');
const btnCastWindow = $('btn-cast-window');
const airplayPip = $('airplay-pip');
const airplayVideo = $('airplay-video');
const btnAirplayPickerInline = $('btn-airplay-picker-inline');
const btnHidePip = $('btn-hide-pip');

// Settings sheet
const btnCtrlSettings = $('btn-ctrl-settings');
const settingsModal = $('settings-modal');
const btnCloseSettings = $('btn-close-settings');
const inputSensitivity = $('input-sensitivity');
const sensVal = $('sens-val');
const chkPhoneSound = $('chk-phone-sound');
const btnModalLobby = $('btn-modal-lobby');

const toastEl = $('toast');

const TEAM_CSS = ['var(--blue)', 'var(--red)'];
const SEAT_CSS = ['var(--blue)', 'var(--red)', '#4fd1e8', '#ff9a4d'];

// State
let activeGameId = GAMES.TENNIS.id;
let myClientId = null;
let mySeat = 0;
let hasJoinedOnce = false;
let myHand = localStorage.getItem('pocketparty_hand') || 'right';
let myName = localStorage.getItem('pocketparty_name') || '';
let shotMod = 'auto';
let bowlHook = 0;
let bowlLaneX = 0.08;
let currentRoom = null;
let currentState = null;
let phoneSoundEnabled = localStorage.getItem('pocketparty_sound') !== 'off';
let airplayRenderer = null;
let airplayRendererGameId = GAMES.TENNIS.id;
let airplayCanvas = null;
let feedbackTimer = null;
let toastTimer = null;

chkPhoneSound.checked = phoneSoundEnabled;
const savedSens = Number(localStorage.getItem('pocketparty_sens'));
if (savedSens) {
  inputSensitivity.value = String(savedSens);
  sensVal.textContent = `${savedSens.toFixed(2)}×`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Game state arrives ~30 times a second; only touch the DOM when something changed.
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function setPrompt(text, tone = '') {
  setText(ctrlPrompt, text);
  if (ctrlPrompt.dataset.tone !== tone) ctrlPrompt.dataset.tone = tone;
}

function setPressed(selector, predicate) {
  document.querySelectorAll(selector).forEach((b) => {
    const on = predicate(b);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function toast(message, tone = '') {
  toastEl.textContent = message;
  toastEl.dataset.tone = tone;
  toastEl.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('is-hidden'), tone === 'error' ? 5000 : 3000);
}

function openSheet(dlg) {
  if (dlg.open) return;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeSheet(dlg) {
  if (!dlg.open) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

for (const dlg of [castModal, settingsModal]) {
  // Tap on the dimmed backdrop closes the sheet
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeSheet(dlg);
  });
}

const audio = new TennisAudio();
const socket = new GameSocket();
const castBridge = new CastBridge({
  roomCode,
  onStatusChange: (status) => {
    updateCastUI(status);
    socket.send({
      type: MSG.CAST_STATUS,
      active: status.active,
      method: status.method,
      deviceName: status.deviceName
    });
  }
});

fetch('/api/config')
  .then((r) => r.json())
  .then((cfg) => {
    if (cfg.castAppId && !castBridge.castAppId) {
      castBridge.setCastAppId(cfg.castAppId);
    } else if (castBridge.castAppId) {
      castBridge.initGoogleCast();
    }
  })
  .catch(() => {});

if (navigator.wakeLock?.request) {
  const requestWake = () => navigator.wakeLock.request('screen').catch(() => {});
  requestWake();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWake();
  });
}

// --- Motion controller ---
const motion = new PhoneMotionController({
  handedness: myHand,
  isServeReadyFn: () => activeGameId === GAMES.TENNIS.id && currentState?.phase === PHASE.SERVE_READY && currentState?.serverSeat === mySeat,
  onToss: () => triggerToss(),
  onSwing: (swing) => triggerSwing(swing),
  onPose: (pose) => {
    socket.send({ type: MSG.POSE, pose });
    if (swipeStart) return;
    const deg = clamp(pose.roll * 45, -45, 45);
    const tilt = clamp(pose.pitch * 18, -22, 22);
    activeVisual().style.transform = `rotate(${deg}deg) translateY(${tilt}px)`;
  },
  onSensorState: (st) => {
    if (st.active) {
      sensorBanner.classList.add('hidden');
      setText(sensorModeLabel, 'Motion on');
      startMeterLoop();
    } else if (st.permission === 'denied' || st.permission === 'unavailable') {
      sensorBanner.classList.add('warn');
      const needsHttps = window.location.protocol !== 'https:' && window.location.hostname !== 'localhost';
      sensorBannerText.textContent = needsHttps
        ? 'Motion needs a secure (https) link. Swipe on the court to play for now.'
        : `Motion is off (${(st.reason || 'no sensor access').toLowerCase()}). Swipe on the court to play.`;
      btnEnableSensors.textContent = 'Try again';
      setText(sensorModeLabel, 'Touch');
    }
  }
});
if (savedSens) motion.setSensitivity(savedSens);

const isLikelyMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
if (!isLikelyMobile && !PhoneMotionController.needsPermissionPrompt()) {
  sensorBannerText.textContent = 'On a computer, swipe the court or press Space to swing.';
  btnEnableSensors.textContent = 'Try motion';
  btnEnableSensors.classList.replace('btn-ball', 'btn-court');
}

// Live power meter: only runs while sensors stream, and only writes on change
let meterRaf = 0;
let lastMeter = -1;
function setMeter(v) {
  const q = Math.round(clamp(v, 0, 1) * 100);
  if (q === lastMeter) return;
  lastMeter = q;
  swingMeterFill.style.transform = `scaleX(${q / 100})`;
}
function startMeterLoop() {
  if (meterRaf) return;
  const loop = () => {
    if (!motion.sensorActive) { meterRaf = 0; return; }
    if (!document.hidden) setMeter(motion.lastEnergy);
    meterRaf = requestAnimationFrame(loop);
  };
  meterRaf = requestAnimationFrame(loop);
}

function pulseMeter(power) {
  setMeter(power);
  setTimeout(() => { if (!motion.sensorActive) setMeter(0); }, 260);
}

function activeVisual() {
  return activeGameId === GAMES.BOWLING.id ? bowlingBallSvg : racketSvg;
}

// --- Swing / toss dispatch ---
function triggerToss() {
  audio.unlock();
  if (phoneSoundEnabled) audio.playToss();
  motion.vibrate('toss');
  flashPad();
  socket.send({ type: MSG.TOSS });
}

function isMyBowlingTurn() {
  return activeGameId === GAMES.BOWLING.id &&
    currentState?.phase === BOWLING_PHASE.AIMING &&
    currentState?.activeSeat === mySeat;
}

function triggerSwing(raw = {}) {
  audio.unlock();
  if (activeGameId === GAMES.BOWLING.id) {
    if (!isMyBowlingTurn()) return;
    const spin = clamp(bowlHook !== 0 ? bowlHook : (raw.spin ?? 0), -1, 1);
    const power = clamp(raw.power ?? 0.82, 0.35, 1.0);
    const aimOffset = clamp(raw.aim ?? 0, -1, 1);
    socket.send({ type: MSG.BOWL_THROW, power, spin, aimOffset });
    if (phoneSoundEnabled) audio.playWhoosh(power);
    flashPad();
    pulseMeter(power);
    bowlingBallSvg.style.transform = 'translateY(-36px) scale(1.08)';
    setTimeout(() => { bowlingBallSvg.style.transform = ''; }, 200);
    return;
  }

  const isServeReady = currentState?.phase === PHASE.SERVE_READY && currentState?.serverSeat === mySeat;
  if (isServeReady) {
    triggerToss();
    return;
  }

  let spin = raw.spin ?? 0;
  let elevation = raw.elevation || 'flat';
  if (shotMod === 'topspin') spin = Math.max(spin, 0.78);
  else if (shotMod === 'slice') spin = Math.min(spin, -0.78);
  else if (shotMod === 'lob') elevation = 'lob';

  const payload = {
    type: MSG.SWING,
    power: clamp(raw.power ?? 0.78, 0.25, 1.0),
    spin: clamp(spin, -1, 1),
    aim: clamp(raw.aim ?? 0, -1, 1),
    elevation,
    side: raw.side || 'auto'
  };

  socket.send(payload);
  if (phoneSoundEnabled) audio.playWhoosh(payload.power);
  flashPad();
  pulseMeter(payload.power);
  racketSvg.style.transform = `rotate(${payload.side === 'backhand' ? 42 : -42}deg) scale(1.08)`;
  setTimeout(() => { racketSvg.style.transform = ''; }, 180);
}

function nudgeBowlingLane(delta) {
  if (!isMyBowlingTurn()) return;
  bowlLaneX = clamp(bowlLaneX + delta, -0.42, 0.42);
  socket.send({ type: MSG.BOWL_AIM, laneX: bowlLaneX, spin: bowlHook });
}

function flashPad() {
  racketPad.classList.add('swing-flash');
  setTimeout(() => racketPad.classList.remove('swing-flash'), 160);
}

function showShotFeedback(text) {
  shotFeedback.textContent = text;
  shotFeedback.classList.remove('hidden');
  // Restart the pop animation
  shotFeedback.style.animation = 'none';
  void shotFeedback.offsetWidth;
  shotFeedback.style.animation = '';
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => shotFeedback.classList.add('hidden'), 1800);
}

// --- AirPlay offscreen renderer -> live video stream ---
function createAirPlayRenderer(gameId, canvas) {
  const r = gameId === GAMES.BOWLING.id
    ? new BowlingRenderer(canvas, { showEmbeddedHud: true })
    : new CourtRenderer(canvas, { showEmbeddedHud: true });
  r.setRoomCode(roomCode);
  if (currentState && (!currentState.gameId || currentState.gameId === gameId)) {
    r.updateState(currentState);
  }
  r.start();
  return r;
}

function ensureAirPlayRendererForGame(gameId) {
  const normalized = gameId === GAMES.BOWLING.id ? GAMES.BOWLING.id : GAMES.TENNIS.id;
  if (!airplayCanvas || !airplayRenderer || airplayRendererGameId === normalized) return;
  airplayRenderer.stop();
  airplayRendererGameId = normalized;
  airplayRenderer = createAirPlayRenderer(normalized, airplayCanvas);
}

function ensureAirPlayStreamReady() {
  if (airplayRenderer) return;
  airplayCanvas = document.createElement('canvas');
  airplayCanvas.width = 1280;
  airplayCanvas.height = 720;
  airplayRendererGameId = activeGameId;
  airplayRenderer = createAirPlayRenderer(activeGameId, airplayCanvas);
  castBridge.attachAirPlayStream(airplayVideo, airplayCanvas, audio.getMediaStreamTrack());
}

const METHOD_LABELS = {
  google_cast: 'Chromecast',
  presentation: 'Chrome casting',
  airplay: 'AirPlay',
  window: 'TV window'
};

function updateCastUI(status) {
  castTvUrl.textContent = `${window.location.host}/tv?room=${roomCode || ''}`;
  if (status.active) {
    const name = status.deviceName || METHOD_LABELS[status.method] || 'TV';
    castStatusText.textContent = `Showing on ${name}`;
    castStatusLine.dataset.state = 'on';
    castBtnLabel.textContent = 'On TV';
    btnCastTv.dataset.active = 'true';
  } else {
    castStatusText.textContent = 'Not showing on a TV yet';
    castStatusLine.dataset.state = 'off';
    castBtnLabel.textContent = 'Cast';
    btnCastTv.dataset.active = 'false';
  }
}

function currentCastStatus() {
  return { active: Boolean(castBridge.activeMethod), method: castBridge.activeMethod, deviceName: castBridge.deviceName };
}

// --- Socket handlers ---
socket.on('open', () => {
  connMeta.dataset.conn = 'on';
  if (roomCode) {
    socket.send({
      type: MSG.JOIN_ROOM,
      role: 'controller',
      roomCode,
      createIfMissing: true,
      preferredSeat: hasJoinedOnce ? mySeat : undefined,
      name: myName || undefined,
      handedness: myHand
    });
  } else {
    socket.send({
      type: MSG.CREATE_ROOM,
      role: 'controller',
      name: myName || undefined,
      handedness: myHand
    });
  }
});

socket.on('close', () => {
  connMeta.dataset.conn = 'off';
  setText(ctrlRtt, 'Reconnecting…');
});

socket.on('rtt', (ms) => {
  setText(ctrlRtt, `${ms} ms`);
});

socket.on(MSG.WELCOME, (msg) => {
  myClientId = msg.clientId;
  mySeat = msg.seat;
  hasJoinedOnce = true;
  roomCode = msg.roomCode;
  roomPill.textContent = roomCode;
  castBridge.setRoomCode(roomCode);
  if (airplayRenderer) airplayRenderer.setRoomCode(roomCode);

  const url = new URL(window.location.href);
  if (url.searchParams.get('room') !== roomCode) {
    url.searchParams.set('room', roomCode);
    url.searchParams.delete('cast');
    url.searchParams.delete('airplay');
    window.history.replaceState({}, '', url.toString());
  }

  updateCastUI(currentCastStatus());
  if (autoCastMode || autoAirplay) openSheet(castModal);
});

socket.on(MSG.ERROR, ({ message }) => {
  toast(message, 'error');
});

socket.on(MSG.ROOM_STATE, ({ room }) => {
  currentRoom = room;
  activeGameId = room.gameId || GAMES.TENNIS.id;
  const isBowling = activeGameId === GAMES.BOWLING.id;
  ensureAirPlayRendererForGame(activeGameId);

  const mine = room.seats.find((s) => s.clientId === myClientId);
  if (mine) {
    mySeat = mine.seat;
    const color = isBowling ? SEAT_CSS[mine.seat] : TEAM_CSS[mine.team];
    seatBadge.textContent = String(mine.seat + 1);
    seatBadge.style.setProperty('--seat', color);
    bowlingBallSvg.style.setProperty('--seat', color);
    const role = isBowling ? `Bowler ${mine.seat + 1}` : `${mine.team === TEAMS.BLUE ? 'Blue' : 'Red'} ${mine.role === 'front' ? 'net' : 'baseline'}`;
    setText(seatLabel, mine.name);
    setText(seatRole, `${role} ·`);
    if (!inputPlayerName.value && document.activeElement !== inputPlayerName) inputPlayerName.value = mine.name;
  }

  setPressed('#ctrl-game-group .game-tile', (b) => b.dataset.game === activeGameId);
  ctrlModeRow.classList.toggle('hidden', isBowling);
  ctrlFormatRow.classList.toggle('hidden', isBowling);
  ctrlBowlingFormatRow.classList.toggle('hidden', !isBowling);
  ctrlTennisStrip.classList.toggle('hidden', isBowling);
  ctrlBowlingStrip.classList.toggle('hidden', !isBowling);
  racketSvg.classList.toggle('hidden', isBowling);
  bowlingBallSvg.classList.toggle('hidden', !isBowling);
  shotModGroup.classList.toggle('hidden', isBowling);
  bowlingControlsGroup.classList.toggle('hidden', !isBowling);

  setPressed('#ctrl-mode-group .seg-btn', (b) => b.dataset.mode === room.mode);
  setPressed('#ctrl-format-group .seg-btn', (b) => b.dataset.format === room.format);
  setPressed('#ctrl-bowling-format-group .seg-btn', (b) => b.dataset.format === room.format);
  setPressed('#ctrl-diff-group .seg-btn', (b) => b.dataset.diff === room.difficulty);

  if (isBowling) {
    ctrlLobbyTip.textContent = 'Line up with the arrows, then swing forward or swipe up to roll.';
    padHint.textContent = 'Swing forward, or swipe up on the lane.';
  } else {
    ctrlLobbyTip.textContent = 'Hold the phone like a racket handle. Flick up to serve, swing to hit.';
    padHint.textContent = 'Swing your phone, or swipe across the court.';
  }

  renderSeatPicker(room);

  const inLobby = room.phase === PHASE.LOBBY;
  const isOver = room.phase === PHASE.MATCH_OVER;
  ctrlLobbyView.classList.toggle('hidden', !inLobby);
  ctrlPlayView.classList.toggle('hidden', inLobby || isOver);
  ctrlOverView.classList.toggle('hidden', !isOver);
});

function showOver(title, sub) {
  ctrlLobbyView.classList.add('hidden');
  ctrlPlayView.classList.add('hidden');
  ctrlOverView.classList.remove('hidden');
  setText(ctrlOverTitle, title);
  setText(ctrlOverSub, sub);
}

function setAction(label, enabled = true) {
  setText(btnTapAction, label);
  if (btnTapAction.disabled === enabled) btnTapAction.disabled = !enabled;
}

function setReady(on) {
  racketPad.classList.toggle('is-ready', on);
}

socket.on(MSG.GAME_STATE, ({ state }) => {
  currentState = state;
  if (state.gameId && state.gameId !== activeGameId) {
    activeGameId = state.gameId;
    ensureAirPlayRendererForGame(activeGameId);
  }
  if (airplayRenderer) airplayRenderer.updateState(state);

  if (state.gameId === GAMES.BOWLING.id) {
    setText(ctrlBowlFrame, `Frame ${state.currentFrame}/${state.totalFrames}`);
    const me = state.players?.[mySeat];
    setText(ctrlBowlScore, String(me?.totalScore ?? 0));
    const isMyTurn = state.activeSeat === mySeat;
    const bowler = state.players?.[state.activeSeat];
    const bowlerName = bowler?.name || 'Computer';
    setText(ctrlBowlTurn, isMyTurn ? 'Your turn' : `${bowlerName}’s turn`);
    if (ctrlBowlTurn.dataset.mine !== String(isMyTurn)) ctrlBowlTurn.dataset.mine = String(isMyTurn);
    bowlLaneX = state.aimX ?? bowlLaneX;
    setReady(isMyTurn && state.phase === BOWLING_PHASE.AIMING);

    if (state.phase === BOWLING_PHASE.AIMING) {
      if (isMyTurn) {
        setPrompt('Aim, then swing forward to bowl', 'go');
        setAction('Bowl');
      } else {
        setPrompt(`${bowlerName} is bowling`, 'wait');
        setAction('Wait for your turn', false);
      }
    } else if (state.phase === BOWLING_PHASE.ROLLING) {
      setPrompt('Rolling…', 'wait');
      setAction('Rolling…', false);
    } else if (state.phase === BOWLING_PHASE.PIN_SETTLE) {
      setPrompt(state.callout?.text ? sentence(state.callout.text) : 'Counting pins…', '');
      setAction('Counting pins…', false);
    } else if (state.phase === BOWLING_PHASE.MATCH_OVER) {
      const iWon = Array.isArray(state.winnerSeats) ? state.winnerSeats.includes(mySeat) : state.winnerSeat === mySeat;
      showOver(iWon ? 'You win' : 'Good game', `You scored ${me?.totalScore ?? 0} over ${state.totalFrames} frames.`);
    }
    return;
  }

  setText(ctrlGamesBlue, String(state.games[0]));
  setText(ctrlGamesRed, String(state.games[1]));
  setText(ctrlPtsBlue, String(state.scoreText.blue));
  setText(ctrlPtsRed, String(state.scoreText.red));

  const isMyServe = state.serverSeat === mySeat;
  setReady(isMyServe && (state.phase === PHASE.SERVE_READY || state.phase === PHASE.SERVE_TOSS));

  if (state.phase === PHASE.SERVE_READY) {
    if (isMyServe) {
      setPrompt('Your serve. Flick up to toss.', 'go');
      setAction('Toss');
    } else {
      setPrompt('Opponent to serve', 'wait');
      setAction('Swing');
    }
  } else if (state.phase === PHASE.SERVE_TOSS) {
    if (isMyServe) {
      setPrompt(state.ball.sweetSpotWindow > 0.65 ? 'Swing now!' : 'Watch the toss…', 'go');
      setAction('Serve');
    } else {
      setPrompt('Serve coming. Get ready.', '');
      setAction('Swing');
    }
  } else if (state.phase === PHASE.RALLY) {
    setPrompt(state.rallyCount > 1 ? `Rally: ${state.rallyCount} shots` : 'Ball in play', '');
    setAction('Swing');
  } else if (state.phase === PHASE.POINT_OVER || state.phase === PHASE.GAME_OVER) {
    setPrompt(state.callout?.text ? sentence(state.callout.text) : (state.phase === PHASE.GAME_OVER ? 'Game' : 'Point'), '');
    setAction('Next point…', false);
  } else if (state.phase === PHASE.MATCH_OVER) {
    const myTeam = mySeat % 2 === 0 ? TEAMS.BLUE : TEAMS.RED;
    const iWon = state.winnerTeam === myTeam;
    showOver(iWon ? 'You win' : 'Good game', `Blue ${state.games[0]}, Red ${state.games[1]} in games.`);
  }
});

// Server callouts are shouted ("ACE!", "OUT • DEUCE"); calm them down for the phone
function sentence(text) {
  const t = String(text).replace(/\s*•\s*/g, '. ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const SHOT_NAMES = {
  drive: 'Drive', topspin: 'Topspin', slice: 'Slice', lob: 'Lob', smash: 'Smash',
  serve: 'Serve', rocket_serve: 'Rocket serve', volley: 'Volley'
};

socket.on(MSG.GAME_EVENT, ({ event }) => {
  if (airplayRenderer) airplayRenderer.handleGameEvent(event);
  if (!event) return;
  if (event.type === 'ball_hit' && event.seat === mySeat) {
    if (phoneSoundEnabled) audio.playHit({ power: event.power, shotType: event.shotType, sweetSpot: event.sweetSpot });
    const name = SHOT_NAMES[event.shotType] || 'Hit';
    showShotFeedback(`${name} · ${event.mph} mph${event.sweetSpot ? ' · sweet spot' : ''}`);
  } else if (event.type === 'bowl_throw' && event.seat === mySeat) {
    if (phoneSoundEnabled) audio.playBowlRoll();
    showShotFeedback(`${event.mph} mph`);
  } else if (event.type === 'roll_over' && event.seat === mySeat) {
    if (event.isStrike) showShotFeedback('Strike!');
    else if (event.isSpare) showShotFeedback('Spare!');
    else showShotFeedback(`${event.knocked} pin${event.knocked === 1 ? '' : 's'}`);
  }
});

socket.on(MSG.HAPTIC, ({ pattern }) => {
  motion.vibrate(pattern);
});

let lastSeatKey = '';
function renderSeatPicker(room) {
  const isBowling = room.gameId === GAMES.BOWLING.id;
  const key = JSON.stringify([room.gameId, myClientId, room.seats.map((s) => [s.clientId, s.name, s.isHuman])]);
  if (key === lastSeatKey) return;
  lastSeatKey = key;

  seatPickerGrid.innerHTML = '';
  for (const s of room.seats) {
    const isMine = s.clientId === myClientId;
    const takenByOther = s.isHuman && !isMine;
    const btn = document.createElement('button');
    btn.className = `seat-pick ${isMine ? 'mine' : ''} ${takenByOther ? 'taken' : ''}`;
    btn.disabled = takenByOther;
    btn.style.setProperty('--seat', isBowling ? SEAT_CSS[s.seat] : TEAM_CSS[s.team]);
    const role = isBowling
      ? `Bowler ${s.seat + 1}`
      : `${s.team === TEAMS.BLUE ? 'Blue' : 'Red'} ${s.role === 'front' ? 'net' : 'baseline'}`;
    const who = isMine ? 'You' : (s.isHuman ? escapeHtml(s.name) : 'Computer · tap to take');
    btn.innerHTML = `<span class="seat-pick-role">${role}</span><span class="seat-pick-who">${who}</span>`;
    if (!isMine && !takenByOther) {
      btn.addEventListener('click', () => socket.send({ type: MSG.SELECT_SEAT, seat: s.seat }));
    }
    seatPickerGrid.appendChild(btn);
  }
}

// --- Touch swipe pad ---
let swipeStart = null;
racketPad.addEventListener('pointerdown', (e) => {
  audio.unlock();
  racketPad.setPointerCapture(e.pointerId);
  swipeStart = { x: e.clientX, y: e.clientY, t: performance.now() };
});

let swipeRaf = 0;
let swipePos = null;
racketPad.addEventListener('pointermove', (e) => {
  if (!swipeStart) return;
  swipePos = { dx: e.clientX - swipeStart.x, dy: e.clientY - swipeStart.y };
  if (swipeRaf) return;
  swipeRaf = requestAnimationFrame(() => {
    swipeRaf = 0;
    if (!swipeStart || !swipePos) return;
    const { dx, dy } = swipePos;
    activeVisual().style.transform = `translate(${clamp(dx * 0.25, -45, 45)}px, ${clamp(dy * 0.25, -45, 45)}px) rotate(${clamp(dx * 0.25, -35, 35)}deg)`;
  });
}, { passive: true });

function clearSwipeVisual() {
  swipeStart = null;
  swipePos = null;
  racketSvg.style.transform = '';
  bowlingBallSvg.style.transform = '';
}

racketPad.addEventListener('pointercancel', clearSwipeVisual);

racketPad.addEventListener('pointerup', (e) => {
  if (!swipeStart) return;
  const dx = e.clientX - swipeStart.x;
  const dy = e.clientY - swipeStart.y;
  const dt = Math.max(20, performance.now() - swipeStart.t);
  const dist = Math.hypot(dx, dy);
  clearSwipeVisual();

  if (activeGameId === GAMES.BOWLING.id) {
    if (dist < 18) {
      triggerSwing({ power: 0.78, aim: 0, spin: bowlHook });
      return;
    }
    const velocity = dist / dt;
    const power = clamp(0.42 + velocity * 0.44, 0.4, 1.0);
    const aim = clamp(dx / 180, -0.85, 0.85);
    const spin = bowlHook !== 0 ? bowlHook : clamp(dx / 220, -1, 1);
    triggerSwing({ power, aim, spin });
    return;
  }

  const isServeReady = currentState?.phase === PHASE.SERVE_READY && currentState?.serverSeat === mySeat;
  if (isServeReady) {
    triggerToss();
    return;
  }

  if (dist < 18) {
    triggerSwing({ power: 0.74, aim: 0, spin: 0.15, elevation: 'flat' });
    return;
  }

  const velocity = dist / dt;
  const power = clamp(0.35 + velocity * 0.42, 0.35, 1.0);
  const aim = clamp(dx / 150, -0.95, 0.95);
  const side = dx >= 0 ? 'forehand' : 'backhand';

  let elevation = 'flat';
  let spin = 0.2;
  if (dy < -95 && Math.abs(dy) > Math.abs(dx) * 1.35) {
    elevation = 'lob';
  } else if (dy > 95 && velocity > 0.85) {
    elevation = 'smash';
    spin = 0.5;
  } else if (dy < -30) {
    spin = 0.72;
  } else if (dy > 35) {
    spin = -0.65;
  }

  triggerSwing({ power, aim, spin, elevation, side });
});

// --- Keyboard ---
const keysHeld = new Set();
window.addEventListener('blur', () => keysHeld.clear());
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keysHeld.add(e.code);
  if (castModal.open || settingsModal.open) return;

  if (activeGameId === GAMES.BOWLING.id) {
    if (isMyBowlingTurn()) {
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
        e.preventDefault();
        nudgeBowlingLane(-0.08);
        return;
      }
      if (e.code === 'KeyD' || e.code === 'ArrowRight') {
        e.preventDefault();
        nudgeBowlingLane(0.08);
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        const power = keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight') ? 0.96 : 0.84;
        triggerSwing({ power, aim: 0, spin: bowlHook });
      }
    }
    return;
  }

  const inActiveTennis = currentState && (
    currentState.phase === PHASE.SERVE_READY ||
    currentState.phase === PHASE.SERVE_TOSS ||
    currentState.phase === PHASE.RALLY
  );
  if ((e.code === 'Space' || e.code === 'Enter') && inActiveTennis) {
    e.preventDefault();
    const aim = (keysHeld.has('KeyA') || keysHeld.has('ArrowLeft') ? -0.75 : 0) +
      (keysHeld.has('KeyD') || keysHeld.has('ArrowRight') ? 0.75 : 0);
    const elevation = keysHeld.has('KeyW') || keysHeld.has('ArrowUp') ? 'lob'
      : (keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight') ? 'smash' : 'flat');
    const spin = keysHeld.has('KeyS') || keysHeld.has('ArrowDown') ? -0.75 : 0.45;
    const power = keysHeld.has('ShiftLeft') || keysHeld.has('ShiftRight') ? 0.95 : 0.8;
    triggerSwing({ power, aim, spin, elevation });
  }
});
window.addEventListener('keyup', (e) => keysHeld.delete(e.code));

// --- UI listeners ---
btnEnableSensors.addEventListener('click', async () => {
  audio.unlock();
  await motion.enableSensors();
});

btnTapAction.addEventListener('click', () => {
  triggerSwing({ power: 0.82, aim: 0, spin: 0.25 });
});

btnCalibrate.addEventListener('click', () => {
  motion.calibrate();
  showShotFeedback('Motion recentered');
});

document.querySelectorAll('#ctrl-game-group .game-tile').forEach((btn) => {
  btn.addEventListener('click', () => socket.send({ type: MSG.SELECT_GAME, gameId: btn.dataset.game }));
});

document.querySelectorAll('#shot-mod-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    shotMod = btn.dataset.mod;
    setPressed('#shot-mod-group .seg-btn', (b) => b === btn);
  });
});

btnBowlLeft?.addEventListener('click', () => nudgeBowlingLane(-0.09));
btnBowlCenter?.addEventListener('click', () => {
  if (!isMyBowlingTurn()) return;
  bowlLaneX = 0;
  socket.send({ type: MSG.BOWL_AIM, laneX: 0, aimAngle: 0, spin: bowlHook });
});
btnBowlRight?.addEventListener('click', () => nudgeBowlingLane(0.09));

document.querySelectorAll('#bowling-hook-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    bowlHook = Number(btn.dataset.hook) || 0;
    setPressed('#bowling-hook-group .seg-btn', (b) => b === btn);
    if (isMyBowlingTurn()) {
      socket.send({ type: MSG.BOWL_AIM, laneX: bowlLaneX, spin: bowlHook });
    }
  });
});

inputPlayerName.addEventListener('change', () => {
  const val = inputPlayerName.value.trim();
  if (!val) return;
  myName = val;
  localStorage.setItem('pocketparty_name', val);
  socket.send({ type: MSG.UPDATE_PROFILE, name: val });
});
inputPlayerName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inputPlayerName.blur();
});

setPressed('#hand-group .seg-btn', (b) => b.dataset.hand === myHand);
document.querySelectorAll('#hand-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    myHand = btn.dataset.hand;
    localStorage.setItem('pocketparty_hand', myHand);
    motion.setHandedness(myHand);
    setPressed('#hand-group .seg-btn', (b) => b === btn);
    socket.send({ type: MSG.UPDATE_PROFILE, handedness: myHand });
  });
});

function bindConfig(selector, key, attr) {
  document.querySelectorAll(selector).forEach((btn) => {
    btn.addEventListener('click', () => socket.send({ type: MSG.UPDATE_CONFIG, config: { [key]: btn.dataset[attr] } }));
  });
}
bindConfig('#ctrl-mode-group .seg-btn', 'mode', 'mode');
bindConfig('#ctrl-format-group .seg-btn', 'format', 'format');
bindConfig('#ctrl-bowling-format-group .seg-btn', 'format', 'format');
bindConfig('#ctrl-diff-group .seg-btn', 'difficulty', 'diff');

btnCtrlStart.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.START_MATCH });
});

btnCtrlRematch.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.REMATCH });
});

btnCtrlLobby.addEventListener('click', () => socket.send({ type: MSG.RETURN_LOBBY }));

// --- Cast sheet ---
btnCastTv.addEventListener('click', () => {
  audio.unlock();
  updateCastUI(currentCastStatus());
  openSheet(castModal);
});

btnCloseCastModal.addEventListener('click', () => closeSheet(castModal));

btnCastGoogle.addEventListener('click', async () => {
  try {
    if (castBridge.capabilities.googleCast) {
      await castBridge.startGoogleCast();
    } else if (castBridge.capabilities.presentation) {
      await castBridge.startPresentationCast();
    } else {
      castBridge.openTVWindow();
      toast('This browser can’t cast. Opened the TV view in a new window instead.');
    }
    closeSheet(castModal);
  } catch (err) {
    if (err?.name !== 'AbortError') {
      toast(err?.message || 'Casting didn’t start. Open the TV link in the TV’s browser instead.', 'error');
    }
  }
});

const triggerAirplayPicker = async () => {
  audio.unlock();
  ensureAirPlayStreamReady();
  airplayPip.classList.remove('hidden');
  try {
    await castBridge.promptAirPlayOrRemotePlayback();
  } catch {
    toast('AirPlay feed is ready. Pick your TV from the AirPlay button in Safari.');
  }
  closeSheet(castModal);
};

btnCastAirplay.addEventListener('click', triggerAirplayPicker);
btnAirplayPickerInline.addEventListener('click', triggerAirplayPicker);
btnHidePip.addEventListener('click', () => airplayPip.classList.add('hidden'));

btnCastWindow.addEventListener('click', () => {
  castBridge.openTVWindow();
  closeSheet(castModal);
});

// --- Settings sheet ---
btnCtrlSettings.addEventListener('click', () => openSheet(settingsModal));
btnCloseSettings.addEventListener('click', () => closeSheet(settingsModal));
inputSensitivity.addEventListener('input', () => {
  const v = Number(inputSensitivity.value);
  sensVal.textContent = `${v.toFixed(2)}×`;
  motion.setSensitivity(v);
  localStorage.setItem('pocketparty_sens', String(v));
});
chkPhoneSound.addEventListener('change', () => {
  phoneSoundEnabled = chkPhoneSound.checked;
  localStorage.setItem('pocketparty_sound', phoneSoundEnabled ? 'on' : 'off');
});
btnModalLobby.addEventListener('click', () => {
  socket.send({ type: MSG.RETURN_LOBBY });
  closeSheet(settingsModal);
});

socket.connect();
