// Phone Motion Controller Runtime + AirPlay Live Court/Alley Streamer + Google Cast / Presentation Sender
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

// DOM refs
const connDot = document.getElementById('conn-dot');
const seatLabel = document.getElementById('seat-label');
const roomPill = document.getElementById('room-pill');
const sensorBanner = document.getElementById('sensor-banner');
const sensorBannerText = document.getElementById('sensor-banner-text');
const btnEnableSensors = document.getElementById('btn-enable-sensors');
const sensorModeLabel = document.getElementById('sensor-mode-label');

const ctrlLobbyView = document.getElementById('ctrl-lobby-view');
const ctrlPlayView = document.getElementById('ctrl-play-view');
const ctrlOverView = document.getElementById('ctrl-over-view');
const ctrlOverTitle = document.getElementById('ctrl-over-title');
const ctrlOverSub = document.getElementById('ctrl-over-sub');

const inputPlayerName = document.getElementById('input-player-name');
const seatPickerGrid = document.getElementById('seat-picker-grid');
const ctrlTennisConfigRow = document.getElementById('ctrl-tennis-config-row');
const ctrlBowlingConfigRow = document.getElementById('ctrl-bowling-config-row');
const selectMode = document.getElementById('select-mode');
const selectFormat = document.getElementById('select-format');
const selectBowlingFormat = document.getElementById('select-bowling-format');
const ctrlLobbyTip = document.getElementById('ctrl-lobby-tip');
const btnCtrlStart = document.getElementById('btn-ctrl-start');
const btnCtrlRematch = document.getElementById('btn-ctrl-rematch');
const btnCtrlLobby = document.getElementById('btn-ctrl-lobby');

const ctrlTennisStrip = document.getElementById('ctrl-tennis-strip');
const ctrlBowlingStrip = document.getElementById('ctrl-bowling-strip');
const ctrlBowlFrame = document.getElementById('ctrl-bowl-frame');
const ctrlBowlTurn = document.getElementById('ctrl-bowl-turn');
const ctrlBowlScore = document.getElementById('ctrl-bowl-score');
const ctrlGamesBlue = document.getElementById('ctrl-games-blue');
const ctrlPtsBlue = document.getElementById('ctrl-pts-blue');
const ctrlGamesRed = document.getElementById('ctrl-games-red');
const ctrlPtsRed = document.getElementById('ctrl-pts-red');
const ctrlRtt = document.getElementById('ctrl-rtt');
const ctrlPrompt = document.getElementById('ctrl-prompt');
const racketPad = document.getElementById('racket-pad');
const racketSvg = document.getElementById('racket-svg');
const bowlingBallSvg = document.getElementById('bowling-ball-svg');
const padHint = document.getElementById('pad-hint');
const shotFeedback = document.getElementById('shot-feedback');
const shotModGroup = document.getElementById('shot-mod-group');
const bowlingControlsGroup = document.getElementById('bowling-controls-group');
const btnBowlLeft = document.getElementById('btn-bowl-left');
const btnBowlCenter = document.getElementById('btn-bowl-center');
const btnBowlRight = document.getElementById('btn-bowl-right');
const swingMeterFill = document.getElementById('swing-meter-fill');
const btnTapAction = document.getElementById('btn-tap-action');
const btnCalibrate = document.getElementById('btn-calibrate');

// AirPlay / Cast DOM
const btnCastTv = document.getElementById('btn-cast-tv');
const castModal = document.getElementById('cast-modal');
const btnCloseCastModal = document.getElementById('btn-close-cast-modal');
const castStatusLine = document.getElementById('cast-status-line');
const castTvUrl = document.getElementById('cast-tv-url');
const btnCastGoogle = document.getElementById('btn-cast-google');
const btnCastAirplay = document.getElementById('btn-cast-airplay');
const btnCastWindow = document.getElementById('btn-cast-window');
const airplayPip = document.getElementById('airplay-pip');
const airplayVideo = document.getElementById('airplay-video');
const btnAirplayPickerInline = document.getElementById('btn-airplay-picker-inline');
const btnHidePip = document.getElementById('btn-hide-pip');

// Settings DOM
const btnCtrlSettings = document.getElementById('btn-ctrl-settings');
const settingsModal = document.getElementById('settings-modal');
const btnCloseSettings = document.getElementById('btn-close-settings');
const inputSensitivity = document.getElementById('input-sensitivity');
const sensVal = document.getElementById('sens-val');
const chkPhoneSound = document.getElementById('chk-phone-sound');
const btnModalLobby = document.getElementById('btn-modal-lobby');

// State
let activeGameId = GAMES.TENNIS.id;
let myClientId = null;
let mySeat = 0;
let hasJoinedOnce = false;
let myHand = localStorage.getItem('pocketparty_hand') || 'right';
let myName = localStorage.getItem('pocketparty_name') || '';
let shotMod = 'auto'; // 'auto' | 'topspin' | 'slice' | 'lob'
let bowlHook = 0;
let bowlLaneX = 0.08;
let currentRoom = null;
let currentState = null;
let phoneSoundEnabled = true;
let airplayRenderer = null;
let airplayRendererGameId = GAMES.TENNIS.id;
let airplayCanvas = null;
let feedbackTimer = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// Load server Cast App ID config
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

// Screen Wake Lock so phone never sleeps mid-match
if (navigator.wakeLock?.request) {
  navigator.wakeLock.request('screen').catch(() => {});
}

// --- IMU Motion Controller Setup ---
const motion = new PhoneMotionController({
  handedness: myHand,
  isServeReadyFn: () => activeGameId === GAMES.TENNIS.id && currentState?.phase === PHASE.SERVE_READY && currentState?.serverSeat === mySeat,
  onToss: () => triggerToss(),
  onSwing: (swing) => triggerSwing(swing),
  onPose: (pose) => {
    socket.send({ type: MSG.POSE, pose });
    const deg = clamp(pose.roll * 45, -45, 45);
    const tilt = clamp(pose.pitch * 18, -22, 22);
    const visual = activeGameId === GAMES.BOWLING.id ? bowlingBallSvg : racketSvg;
    visual.style.transform = `rotate(${deg}deg) translateY(${tilt}px)`;
  },
  onSensorState: (st) => {
    if (st.active) {
      sensorBanner.classList.add('hidden');
      sensorModeLabel.textContent = 'IMU MOTION ACTIVE 🟢';
    } else if (st.permission === 'denied' || st.permission === 'unavailable') {
      sensorBanner.classList.add('warn');
      const httpsHint = window.location.protocol !== 'https:' && window.location.hostname !== 'localhost'
        ? ' (Use HTTPS URL for mobile IMU sensors!)'
        : '';
      sensorBannerText.textContent = `Touch/Swipe Mode Active — ${st.reason || 'Sensors off'}${httpsHint}`;
      btnEnableSensors.textContent = 'Retry';
      sensorModeLabel.textContent = 'TOUCH SWIPE / KEYBOARD';
    }
  }
});

// Auto-hide sensor button on pure desktop without touch, keep it super prominent on mobile
const isLikelyMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
if (!isLikelyMobile && !PhoneMotionController.needsPermissionPrompt()) {
  sensorBannerText.textContent = '💻 Desktop Mode: Swipe the racket pad or press Space / WASD to play!';
  btnEnableSensors.textContent = 'Try IMU';
}

// Live G-force power meter animation
function animateMeter() {
  if (motion.sensorActive) {
    swingMeterFill.style.width = `${Math.round(motion.lastEnergy * 100)}%`;
  }
  requestAnimationFrame(animateMeter);
}
requestAnimationFrame(animateMeter);

// --- Core Swing / Toss Dispatchers ---
function triggerToss() {
  audio.unlock();
  if (phoneSoundEnabled) audio.playToss();
  motion.vibrate('toss');
  flashRacketPad();
  socket.send({ type: MSG.TOSS });
}

function triggerSwing(raw = {}) {
  audio.unlock();
  if (activeGameId === GAMES.BOWLING.id) {
    if (currentState?.phase !== BOWLING_PHASE.AIMING || currentState?.activeSeat !== mySeat) {
      return;
    }
    const spin = clamp(bowlHook !== 0 ? bowlHook : (raw.spin ?? 0), -1, 1);
    const power = clamp(raw.power ?? 0.82, 0.35, 1.0);
    const aimOffset = clamp(raw.aim ?? 0, -1, 1);
    socket.send({ type: MSG.BOWL_THROW, power, spin, aimOffset });
    if (phoneSoundEnabled) audio.playWhoosh(power);
    flashRacketPad();
    swingMeterFill.style.width = `${Math.round(power * 100)}%`;
    setTimeout(() => {
      if (!motion.sensorActive) swingMeterFill.style.width = '0%';
    }, 240);
    bowlingBallSvg.style.transform = 'translateY(-36px) scale(1.12)';
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
  flashRacketPad();
  swingMeterFill.style.width = `${Math.round(payload.power * 100)}%`;
  setTimeout(() => {
    if (!motion.sensorActive) swingMeterFill.style.width = '0%';
  }, 240);

  // Brief visual swing kick on SVG racket
  racketSvg.style.transform = `rotate(${payload.side === 'backhand' ? 42 : -42}deg) scale(1.12)`;
  setTimeout(() => { racketSvg.style.transform = ''; }, 180);
}

function nudgeBowlingLane(delta) {
  if (activeGameId !== GAMES.BOWLING.id || currentState?.phase !== BOWLING_PHASE.AIMING || currentState?.activeSeat !== mySeat) return;
  bowlLaneX = clamp(bowlLaneX + delta, -0.42, 0.42);
  socket.send({ type: MSG.BOWL_AIM, laneX: bowlLaneX, spin: bowlHook });
}

function flashRacketPad() {
  racketPad.classList.add('swing-flash');
  setTimeout(() => racketPad.classList.remove('swing-flash'), 170);
}

function showShotFeedback(text) {
  shotFeedback.textContent = text;
  shotFeedback.classList.remove('hidden');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => shotFeedback.classList.add('hidden'), 1800);
}

// --- AirPlay Offscreen Court/Alley Renderer -> Live Video Stream ---
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

  const audioTrack = audio.getMediaStreamTrack();
  castBridge.attachAirPlayStream(airplayVideo, airplayCanvas, audioTrack);
}

function updateCastUI(status) {
  const tvUrl = `${window.location.origin}/tv.html?room=${encodeURIComponent(roomCode)}`;
  castTvUrl.textContent = tvUrl;
  const codeLabel = roomCode || '----';

  if (status.active) {
    castStatusLine.textContent = `✅ Casting via ${status.deviceName || status.method} • Room ${codeLabel}`;
    castStatusLine.className = 'pill pill-green';
    btnCastTv.textContent = `📺 ${status.deviceName ? 'Casting' : 'Cast On'}`;
    btnCastTv.classList.replace('btn-primary', 'btn-green');
  } else {
    castStatusLine.textContent = `Ready to Cast • Room ${codeLabel}`;
    castStatusLine.className = 'pill pill-blue';
    btnCastTv.textContent = '📺 Cast / AirPlay';
    btnCastTv.classList.replace('btn-green', 'btn-primary');
  }
}

// --- Socket Handlers ---
socket.on('open', () => {
  connDot.style.background = '#22c55e';
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
  connDot.style.background = '#ef4444';
});

socket.on('rtt', (ms) => {
  ctrlRtt.textContent = `${ms}ms`;
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
    window.history.replaceState({}, '', url.toString());
  }

  updateCastUI({ active: Boolean(castBridge.activeMethod), method: castBridge.activeMethod, deviceName: castBridge.deviceName });

  // If user tapped "Cast to TV" or "AirPlay" from the landing hub, open Cast Sheet immediately!
  if (autoCastMode || autoAirplay) {
    castModal.classList.remove('hidden');
  }
});

socket.on(MSG.ERROR, ({ message }) => {
  alert(message);
});

socket.on(MSG.ROOM_STATE, ({ room }) => {
  currentRoom = room;
  activeGameId = room.gameId || GAMES.TENNIS.id;
  const isBowling = activeGameId === GAMES.BOWLING.id;
  ensureAirPlayRendererForGame(activeGameId);

  const mine = room.seats.find((s) => s.clientId === myClientId);
  if (mine) {
    mySeat = mine.seat;
    const roleTag = isBowling ? 'BOWLER' : (mine.team === TEAMS.BLUE ? 'BLUE' : 'RED');
    seatLabel.textContent = `P${mine.seat + 1} • ${roleTag}`;
    if (!inputPlayerName.value) inputPlayerName.value = mine.name;
  }

  document.querySelectorAll('#ctrl-game-group .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.game === activeGameId);
  });
  ctrlTennisConfigRow.classList.toggle('hidden', isBowling);
  ctrlBowlingConfigRow.classList.toggle('hidden', !isBowling);
  ctrlTennisStrip.classList.toggle('hidden', isBowling);
  ctrlBowlingStrip.classList.toggle('hidden', !isBowling);
  racketSvg.classList.toggle('hidden', isBowling);
  bowlingBallSvg.classList.toggle('hidden', !isBowling);
  shotModGroup.classList.toggle('hidden', isBowling);
  bowlingControlsGroup.classList.toggle('hidden', !isBowling);

  if (isBowling) {
    selectBowlingFormat.value = room.format;
    ctrlLobbyTip.textContent = 'Tip: Line up your shot, then swing forward or swipe up to roll toward the 1-3 pocket!';
    padHint.textContent = 'Swing forward OR swipe up to roll your bowling ball!';
  } else {
    selectMode.value = room.mode;
    selectFormat.value = room.format;
    ctrlLobbyTip.textContent = 'Tip: Hold your phone securely like a tennis racket! Flick up to toss serves, swing forward to strike.';
    padHint.textContent = 'Swing your phone OR swipe across this pad!';
  }

  document.querySelectorAll('#ctrl-diff-group .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.diff === room.difficulty);
  });

  renderSeatPicker(room);

  const inLobby = room.phase === PHASE.LOBBY;
  const isOver = room.phase === PHASE.MATCH_OVER;
  ctrlLobbyView.classList.toggle('hidden', !inLobby);
  ctrlPlayView.classList.toggle('hidden', inLobby || isOver);
  ctrlOverView.classList.toggle('hidden', !isOver);
});

socket.on(MSG.GAME_STATE, ({ state }) => {
  currentState = state;
  if (state.gameId && state.gameId !== activeGameId) {
    activeGameId = state.gameId;
    ensureAirPlayRendererForGame(activeGameId);
  }
  if (airplayRenderer) airplayRenderer.updateState(state);

  if (state.gameId === GAMES.BOWLING.id) {
    ctrlBowlFrame.textContent = `FRAME ${state.currentFrame}/${state.totalFrames}`;
    const me = state.players?.[mySeat];
    ctrlBowlScore.textContent = String(me?.totalScore ?? 0);
    const isMyTurn = state.activeSeat === mySeat;
    const activeBowler = state.players?.[state.activeSeat];
    ctrlBowlTurn.textContent = isMyTurn ? 'YOUR TURN!' : `${activeBowler?.name || 'CPU'}'s TURN`;
    bowlLaneX = state.aimX ?? bowlLaneX;
    racketPad.classList.toggle('serve-glow', isMyTurn && state.phase === BOWLING_PHASE.AIMING);

    if (state.phase === BOWLING_PHASE.AIMING) {
      ctrlPrompt.textContent = isMyTurn ? '🎳 AIM & SWING FORWARD TO BOWL!' : `👀 WATCH ${(activeBowler?.name || 'CPU').toUpperCase()}...`;
      btnTapAction.textContent = isMyTurn ? '🎳 Bowl Ball!' : '⏳ Wait...';
    } else if (state.phase === BOWLING_PHASE.ROLLING) {
      ctrlPrompt.textContent = '⚡ BALL ROLLING DOWN THE LANE!';
      btnTapAction.textContent = '🎳 Rolling...';
    } else if (state.phase === BOWLING_PHASE.PIN_SETTLE) {
      ctrlPrompt.textContent = state.callout?.text || '📌 COUNTING PINS...';
      btnTapAction.textContent = '⏳ Settling...';
    } else if (state.phase === BOWLING_PHASE.MATCH_OVER) {
      ctrlLobbyView.classList.add('hidden');
      ctrlPlayView.classList.add('hidden');
      ctrlOverView.classList.remove('hidden');
      const iWon = Array.isArray(state.winnerSeats) ? state.winnerSeats.includes(mySeat) : state.winnerSeat === mySeat;
      ctrlOverTitle.textContent = iWon ? '🏆 YOU WON THE MATCH!' : 'GOOD GAME!';
      ctrlOverSub.textContent = `Your Score: ${me?.totalScore ?? 0} pts (${state.totalFrames} Frames)`;
    }
    return;
  }

  ctrlGamesBlue.textContent = state.games[0];
  ctrlGamesRed.textContent = state.games[1];
  ctrlPtsBlue.textContent = state.scoreText.blue;
  ctrlPtsRed.textContent = state.scoreText.red;

  const isMyServe = state.serverSeat === mySeat;
  racketPad.classList.toggle('serve-glow', isMyServe && (state.phase === PHASE.SERVE_READY || state.phase === PHASE.SERVE_TOSS));

  if (state.phase === PHASE.SERVE_READY) {
    ctrlPrompt.textContent = isMyServe ? '⬆️ YOUR SERVE — FLICK UP TO TOSS!' : '👀 OPPONENT PREPARING SERVE...';
    btnTapAction.textContent = isMyServe ? '⬆️ Toss Ball' : '🎾 Swing';
  } else if (state.phase === PHASE.SERVE_TOSS) {
    ctrlPrompt.textContent = isMyServe
      ? (state.ball.sweetSpotWindow > 0.65 ? '⚡ GOLDEN APEX — SWING NOW!' : '🎯 WATCH THE TOSS — SWING!')
      : '👀 INCOMING SERVE — GET READY!';
    btnTapAction.textContent = '💥 SMASH SERVE!';
  } else if (state.phase === PHASE.RALLY) {
    ctrlPrompt.textContent = state.rallyCount > 1 ? `🔥 RALLY ×${state.rallyCount} — SWING TO STRIKE!` : '🎾 BALL IN PLAY — SWING!';
    btnTapAction.textContent = '🎾 Swing Racket';
  } else if (state.phase === PHASE.POINT_OVER || state.phase === PHASE.GAME_OVER) {
    ctrlPrompt.textContent = state.callout?.text || (state.phase === PHASE.GAME_OVER ? 'GAME OVER!' : 'POINT OVER');
    btnTapAction.textContent = '⏳ Next Point...';
  } else if (state.phase === PHASE.MATCH_OVER) {
    ctrlLobbyView.classList.add('hidden');
    ctrlPlayView.classList.add('hidden');
    ctrlOverView.classList.remove('hidden');
    const myTeam = mySeat % 2 === 0 ? TEAMS.BLUE : TEAMS.RED;
    const iWon = state.winnerTeam === myTeam;
    ctrlOverTitle.textContent = iWon ? '🎉 YOU WON THE MATCH!' : 'GOOD GAME!';
    ctrlOverSub.textContent = `Final Games: Blue ${state.games[0]} – ${state.games[1]} Red`;
  }
});

socket.on(MSG.GAME_EVENT, ({ event }) => {
  if (airplayRenderer) airplayRenderer.handleGameEvent(event);
  if (!event) return;
  if (event.type === 'ball_hit' && event.seat === mySeat) {
    if (phoneSoundEnabled) audio.playHit({ power: event.power, shotType: event.shotType, sweetSpot: event.sweetSpot });
    const label = event.shotType.replace('_', ' ').toUpperCase();
    showShotFeedback(`${event.mph} MPH • ${label}${event.sweetSpot ? ' ★' : ''}`);
  } else if (event.type === 'bowl_throw' && event.seat === mySeat) {
    if (phoneSoundEnabled) audio.playBowlRoll();
    showShotFeedback(`${event.mph} MPH • ROLL!`);
  } else if (event.type === 'roll_over' && event.seat === mySeat) {
    if (event.isStrike) showShotFeedback('⚡ STRIKE!');
    else if (event.isSpare) showShotFeedback('✨ SPARE!');
    else showShotFeedback(`${event.knocked} PIN${event.knocked === 1 ? '' : 'S'}!`);
  }
});

socket.on(MSG.HAPTIC, ({ pattern }) => {
  motion.vibrate(pattern);
});

function renderSeatPicker(room) {
  const isBowling = room.gameId === GAMES.BOWLING.id;
  const labels = isBowling
    ? ['Bowler 1', 'Bowler 2', 'Bowler 3', 'Bowler 4']
    : ['P1 • Blue Back', 'P2 • Red Back', 'P3 • Blue Net', 'P4 • Red Net'];
  seatPickerGrid.innerHTML = '';
  for (const s of room.seats) {
    const isMine = s.clientId === myClientId;
    const takenByOther = s.isHuman && !isMine;
    const btn = document.createElement('button');
    btn.className = `seat-pick-btn ${isMine ? 'mine' : ''} ${takenByOther ? 'taken' : ''}`;
    btn.disabled = takenByOther;
    btn.innerHTML = `
      <div style="font-weight:900; font-size:0.86rem; color:${isBowling ? s.color : (s.team === 0 ? '#60a5fa' : '#f87171')};">${labels[s.seat]}</div>
      <div style="font-size:0.78rem; color:#e2e8f0; margin-top:2px;">${isMine ? '✓ You' : (s.isHuman ? escapeHtml(s.name) : 'CPU (Tap to take)')}</div>
    `;
    btn.addEventListener('click', () => {
      socket.send({ type: MSG.SELECT_SEAT, seat: s.seat });
    });
    seatPickerGrid.appendChild(btn);
  }
}

// --- Touch Swipe-to-Swing Pad (Seamless fallback + companion to IMU!) ---
let swipeStart = null;
racketPad.addEventListener('pointerdown', (e) => {
  audio.unlock();
  racketPad.setPointerCapture(e.pointerId);
  swipeStart = { x: e.clientX, y: e.clientY, t: performance.now() };
});

racketPad.addEventListener('pointermove', (e) => {
  if (!swipeStart) return;
  const dx = e.clientX - swipeStart.x;
  const dy = e.clientY - swipeStart.y;
  const activeVisual = activeGameId === GAMES.BOWLING.id ? bowlingBallSvg : racketSvg;
  activeVisual.style.transform = `translate(${clamp(dx * 0.25, -45, 45)}px, ${clamp(dy * 0.25, -45, 45)}px) rotate(${clamp(dx * 0.25, -35, 35)}deg)`;
});

function clearSwipeVisual() {
  swipeStart = null;
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
    // Quick tap -> crisp flat drive
    triggerSwing({ power: 0.74, aim: 0, spin: 0.15, elevation: 'flat' });
    return;
  }

  const velocity = dist / dt; // px/ms
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
    spin = 0.72; // Swipe forward-up -> topspin
  } else if (dy > 35) {
    spin = -0.65; // Swipe down-across -> slice
  }

  triggerSwing({ power, aim, spin, elevation, side });
});

// --- Desktop Keyboard Controls ---
const keysHeld = new Set();
window.addEventListener('blur', () => keysHeld.clear());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    castModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keysHeld.add(e.code);

  const modalOpen = !castModal.classList.contains('hidden') || !settingsModal.classList.contains('hidden');
  if (modalOpen) return;

  if (activeGameId === GAMES.BOWLING.id) {
    if (currentState?.phase === BOWLING_PHASE.AIMING && currentState?.activeSeat === mySeat) {
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

// --- UI Event Listeners ---
btnEnableSensors.addEventListener('click', async () => {
  audio.unlock();
  await motion.enableSensors();
});

btnTapAction.addEventListener('click', () => {
  triggerSwing({ power: 0.82, aim: 0, spin: 0.25 });
});

btnCalibrate.addEventListener('click', () => {
  motion.calibrate();
  showShotFeedback('🎯 CONTROLLER CALIBRATED!');
});

document.querySelectorAll('#ctrl-game-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.send({ type: MSG.SELECT_GAME, gameId: btn.dataset.game });
  });
});

document.querySelectorAll('#shot-mod-group .mod-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    shotMod = btn.dataset.mod;
    document.querySelectorAll('#shot-mod-group .mod-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

btnBowlLeft?.addEventListener('click', () => nudgeBowlingLane(-0.09));
btnBowlCenter?.addEventListener('click', () => {
  if (activeGameId !== GAMES.BOWLING.id || currentState?.phase !== BOWLING_PHASE.AIMING || currentState?.activeSeat !== mySeat) return;
  bowlLaneX = 0;
  socket.send({ type: MSG.BOWL_AIM, laneX: 0, aimAngle: 0, spin: bowlHook });
});
btnBowlRight?.addEventListener('click', () => nudgeBowlingLane(0.09));

document.querySelectorAll('#bowling-hook-group .mod-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    bowlHook = Number(btn.dataset.hook) || 0;
    document.querySelectorAll('#bowling-hook-group .mod-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (activeGameId === GAMES.BOWLING.id && currentState?.phase === BOWLING_PHASE.AIMING && currentState?.activeSeat === mySeat) {
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

document.querySelectorAll('#hand-group .seg-btn').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.hand === myHand);
  btn.addEventListener('click', () => {
    myHand = btn.dataset.hand;
    localStorage.setItem('pocketparty_hand', myHand);
    motion.setHandedness(myHand);
    document.querySelectorAll('#hand-group .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    socket.send({ type: MSG.UPDATE_PROFILE, handedness: myHand });
  });
});

selectMode.addEventListener('change', () => {
  socket.send({ type: MSG.UPDATE_CONFIG, config: { mode: selectMode.value } });
});

selectFormat.addEventListener('change', () => {
  socket.send({ type: MSG.UPDATE_CONFIG, config: { format: selectFormat.value } });
});

selectBowlingFormat?.addEventListener('change', () => {
  socket.send({ type: MSG.UPDATE_CONFIG, config: { format: selectBowlingFormat.value } });
});

document.querySelectorAll('#ctrl-diff-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.send({ type: MSG.UPDATE_CONFIG, config: { difficulty: btn.dataset.diff } });
  });
});

btnCtrlStart.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.START_MATCH });
});

btnCtrlRematch.addEventListener('click', () => {
  audio.unlock();
  socket.send({ type: MSG.REMATCH });
});

btnCtrlLobby.addEventListener('click', () => {
  socket.send({ type: MSG.RETURN_LOBBY });
});

// --- Cast / AirPlay Sheet Interactions ---
btnCastTv.addEventListener('click', () => {
  audio.unlock();
  updateCastUI({ active: Boolean(castBridge.activeMethod), method: castBridge.activeMethod, deviceName: castBridge.deviceName });
  castModal.classList.remove('hidden');
});

btnCloseCastModal.addEventListener('click', () => castModal.classList.add('hidden'));
castModal.addEventListener('click', (e) => {
  if (e.target === castModal) castModal.classList.add('hidden');
});

btnCastGoogle.addEventListener('click', async () => {
  try {
    if (castBridge.capabilities.googleCast) {
      await castBridge.startGoogleCast();
    } else if (castBridge.capabilities.presentation) {
      await castBridge.startPresentationCast();
    } else {
      alert('Google Cast / Presentation API requires Chrome (Android/Desktop). Opening TV window instead — or open the TV URL on your Chromecast/Smart TV!');
      castBridge.openTVWindow();
    }
    castModal.classList.add('hidden');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      alert(err?.message || 'Could not start Cast session. You can also open the TV URL directly on your TV browser.');
    }
  }
});

const triggerAirplayPicker = async () => {
  audio.unlock();
  ensureAirPlayStreamReady();
  airplayPip.classList.remove('hidden');
  try {
    await castBridge.promptAirPlayOrRemotePlayback();
    castModal.classList.add('hidden');
  } catch (err) {
    castModal.classList.add('hidden');
    showShotFeedback('📡 AirPlay feed live! Use TV link or Safari AirPlay icon.');
  }
};

btnCastAirplay.addEventListener('click', triggerAirplayPicker);
btnAirplayPickerInline.addEventListener('click', triggerAirplayPicker);
btnHidePip.addEventListener('click', () => airplayPip.classList.add('hidden'));

btnCastWindow.addEventListener('click', () => {
  castBridge.openTVWindow();
  castModal.classList.add('hidden');
});

// --- Settings Sheet ---
btnCtrlSettings.addEventListener('click', () => settingsModal.classList.remove('hidden'));
btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.add('hidden');
});
inputSensitivity.addEventListener('input', () => {
  const v = Number(inputSensitivity.value);
  sensVal.textContent = `${v.toFixed(2)}×`;
  motion.setSensitivity(v);
});
chkPhoneSound.addEventListener('change', () => {
  phoneSoundEnabled = chkPhoneSound.checked;
});
btnModalLobby.addEventListener('click', () => {
  socket.send({ type: MSG.RETURN_LOBBY });
  settingsModal.classList.add('hidden');
});

socket.connect();
