// Authoritative 60Hz 3D Motion Party Tennis Physics, Rules, Scoring & AI Engine.
import {
  COURT,
  MATCH_MODES,
  MATCH_FORMATS,
  CPU_DIFFICULTIES,
  SHOT_TYPES,
  TEAMS,
  SEAT_DEFS,
  PHASE,
  formatScore,
  netHeightAt,
  clamp
} from '../shared/protocol.js';

const GRAVITY = 11.2; // Tuned for satisfying arcade tennis hang time & crisp bounce
const AIR_DRAG = 0.13;
const BOUNCE_RESTITUTION = 0.77;
const BOUNCE_FRICTION = 0.86;
const SWING_BUFFER_SEC = 0.28; // Generous early swing buffer over Wi-Fi

const AI_PROFILES = {
  [CPU_DIFFICULTIES.ROOKIE]: {
    speedMul: 0.72,
    reactionDelay: 0.20,
    accuracySpread: 1.45,
    powerRange: [0.38, 0.62],
    errorChance: 0.18,
    smashChance: 0.20,
    lobChance: 0.10
  },
  [CPU_DIFFICULTIES.PRO]: {
    speedMul: 0.90,
    reactionDelay: 0.11,
    accuracySpread: 0.82,
    powerRange: [0.54, 0.78],
    errorChance: 0.08,
    smashChance: 0.50,
    lobChance: 0.20
  },
  [CPU_DIFFICULTIES.CHAMPION]: {
    speedMul: 1.10,
    reactionDelay: 0.04,
    accuracySpread: 0.36,
    powerRange: [0.72, 0.96],
    errorChance: 0.02,
    smashChance: 0.85,
    lobChance: 0.28
  }
};

export class TennisEngine {
  constructor(options = {}) {
    this.mode = options.mode || MATCH_MODES.SINGLES;
    this.format = options.format || MATCH_FORMATS.ONE_GAME.id;
    this.difficulty = options.difficulty || CPU_DIFFICULTIES.PRO;
    this.onEvent = options.onEvent || (() => {});

    this.phase = PHASE.LOBBY;
    this.phaseTimer = 0;
    this.clock = 0;

    // Score & match state
    this.games = [0, 0]; // [blue, red]
    this.points = [0, 0]; // [blue, red]
    this.serverSeat = 0;
    this.faultCount = 0;
    this.isServeBall = false;
    this.rallyCount = 0;
    this.lastHitterSeat = -1;
    this.lastHitterTeam = -1;
    this.winnerTeam = -1;
    this._resetTransientState();

    // Match statistics
    this.stats = {
      aces: [0, 0],
      winners: [0, 0],
      sweetSpots: [0, 0],
      maxMph: [0, 0],
      longestRally: 0,
      totalRallies: 0
    };

    // Ball 3D state
    this.ball = this._createBall();
    this.predictedLanding = null; // { x, z, t, team }

    // 4 seat slots (Seats 0 & 1 active in Singles; all 4 active in Doubles)
    this.players = SEAT_DEFS.map((def) => this._createPlayer(def));
    this._setupLobbyPositions();
  }

  _createBall() {
    return {
      x: 1.7,
      y: 1.25,
      z: 11.4,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,       // -1 (heavy slice) to +1 (heavy topspin)
      sideSpin: 0,
      shotType: SHOT_TYPES.DRIVE,
      bounces: 0,
      lastBounce: null, // { x, z, inBounds, time }
      inPlay: false,
      visible: true,
      sweetSpotWindow: 0 // 0..1 glow during serve toss apex
    };
  }

  _createPlayer(def) {
    return {
      seat: def.seat,
      team: def.team,
      role: def.role,
      name: def.defaultName,
      color: def.color,
      accent: def.accent,
      visor: def.visor,
      isHuman: false,
      clientId: null,
      handedness: 'right',
      active: def.seat < 2,
      // World position & velocity
      x: 0,
      z: def.team === TEAMS.BLUE ? 11.4 : -11.4,
      vx: 0,
      vz: 0,
      nudgeX: 0,
      // Animation & racket pose
      swingTimer: 0,
      swingDuration: 0.34,
      swingSide: 'forehand', // 'forehand' | 'backhand' | 'serve' | 'smash'
      swingPower: 0,
      isLunge: false,
      pose: { pitch: 0, roll: 0, yaw: 0 }, // Live phone orientation
      // Buffering & AI
      pendingSwing: null,
      aiNextSwingTime: 0,
      aiServeTimer: 0,
      hitCooldown: 0
    };
  }

  setConfig({ mode, format, difficulty }) {
    if (mode && Object.values(MATCH_MODES).includes(mode)) {
      this.mode = mode;
    }
    if (format && Object.values(MATCH_FORMATS).some((f) => f.id === format)) {
      this.format = format;
    }
    if (difficulty && Object.values(CPU_DIFFICULTIES).includes(difficulty)) {
      this.difficulty = difficulty;
    }
    this._syncActivePlayers();
    if (this.phase === PHASE.LOBBY) {
      this._setupLobbyPositions();
    }
  }

  setSeatPlayer(seat, { isHuman, clientId, name, handedness, color }) {
    const p = this.players[seat];
    if (!p) return;
    p.isHuman = Boolean(isHuman);
    p.clientId = clientId || null;
    if (name) p.name = String(name).slice(0, 14);
    if (handedness === 'left' || handedness === 'right') p.handedness = handedness;
    if (color) p.color = color;
    // Automatically switch to doubles if a human takes seat 2 or 3
    if (isHuman && seat >= 2) {
      this.mode = MATCH_MODES.DOUBLES;
    }
    this._syncActivePlayers();
  }

  _syncActivePlayers() {
    const isDoubles = this.mode === MATCH_MODES.DOUBLES;
    for (const p of this.players) {
      p.active = isDoubles || p.seat < 2;
      if (!p.isHuman) {
        const diffLabel = this.difficulty === CPU_DIFFICULTIES.CHAMPION ? 'PRO+' :
          this.difficulty === CPU_DIFFICULTIES.ROOKIE ? 'CPU' : 'CPU';
        p.name = `${diffLabel} ${p.seat + 1}`;
      }
    }
  }

  _setupLobbyPositions() {
    this._syncActivePlayers();
    const positions = [
      { x: 1.6, z: 10.8 },
      { x: -1.6, z: -10.8 },
      { x: -2.2, z: 4.5 },
      { x: 2.2, z: -4.5 }
    ];
    for (let i = 0; i < 4; i++) {
      this.players[i].x = positions[i].x;
      this.players[i].z = positions[i].z;
      this.players[i].vx = 0;
      this.players[i].vz = 0;
      this.players[i].swingTimer = 0;
    }
    this.ball.visible = true;
    this.ball.inPlay = false;
    this.ball.x = 1.6;
    this.ball.y = 1.2;
    this.ball.z = 10.4;
    this.ball.vx = this.ball.vy = this.ball.vz = 0;
  }

  _resetTransientState() {
    this.lastCallout = null;
    this.lastShotMph = 0;
    this.netWave = 0; // Visual net ripple decay
    this.cameraImpulse = 0; // Screen punch on smashes / rocket serves
    this._isLetReplay = false;
    this._isSecondServePending = false;
  }

  startMatch() {
    this._syncActivePlayers();
    this.games = [0, 0];
    this.points = [0, 0];
    this.serverSeat = 0;
    this.winnerTeam = -1;
    this._resetTransientState();
    this.stats = {
      aces: [0, 0],
      winners: [0, 0],
      sweetSpots: [0, 0],
      maxMph: [0, 0],
      longestRally: 0,
      totalRallies: 0
    };
    this._emit('match_start', { mode: this.mode, format: this.format });
    this._prepareServe(false);
  }

  returnToLobby() {
    this.phase = PHASE.LOBBY;
    this.winnerTeam = -1;
    this._resetTransientState();
    this._setupLobbyPositions();
  }

  _gamesToWin() {
    const entry = Object.values(MATCH_FORMATS).find((f) => f.id === this.format);
    return entry ? entry.gamesToWin : 1;
  }

  _isDeuceCourt() {
    return (this.points[0] + this.points[1]) % 2 === 0;
  }

  _prepareServe(isSecondServe = false) {
    if (!isSecondServe) {
      this.faultCount = 0;
    }
    this.phase = PHASE.SERVE_READY;
    this.phaseTimer = 0;
    this.isServeBall = true;
    this.rallyCount = 0;
    this.lastHitterSeat = -1;
    this.lastHitterTeam = -1;
    this.predictedLanding = null;

    const deuce = this._isDeuceCourt();
    const server = this.players[this.serverSeat];
    const serverSideSign = server.team === TEAMS.BLUE ? 1 : -1;
    // Right side from server's perspective: Blue right is +X, Red right is -X
    const serveXSign = deuce ? serverSideSign : -serverSideSign;

    const serveX = serveXSign * (this.mode === MATCH_MODES.DOUBLES ? 2.2 : 1.55);
    const serveZ = serverSideSign * (COURT.HALF_LENGTH + 0.15);

    // Position all active players authentically for serve
    for (const p of this.players) {
      p.vx = 0;
      p.vz = 0;
      p.pendingSwing = null;
      p.swingTimer = 0;
      p.isLunge = false;
      p.hitCooldown = 0;
      p.aiServeTimer = 0.85 + Math.random() * 0.35;

      if (!p.active) continue;
      const pSide = p.team === TEAMS.BLUE ? 1 : -1;

      if (p.seat === this.serverSeat) {
        p.x = serveX;
        p.z = serveZ;
      } else if (p.team === server.team) {
        // Server's doubles partner stands at the net on the opposite half
        p.x = -serveXSign * 2.1;
        p.z = pSide * 3.8;
      } else {
        // Receiving team
        if (this.mode === MATCH_MODES.SINGLES) {
          p.x = -serveXSign * 2.1;
          p.z = pSide * (COURT.HALF_LENGTH + 0.25);
        } else if (p.role === 'back') {
          p.x = -serveXSign * 2.35;
          p.z = pSide * (COURT.HALF_LENGTH + 0.2);
        } else {
          // Receiving front player stands near service line on non-receiving side
          p.x = serveXSign * 2.1;
          p.z = pSide * 5.2;
        }
      }
    }

    this._snapBallToServer();
    this._emit('serve_ready', {
      serverSeat: this.serverSeat,
      serverTeam: server.team,
      secondServe: isSecondServe,
      deuceSide: deuce
    });
  }

  _snapBallToServer() {
    const server = this.players[this.serverSeat];
    const sideSign = server.team === TEAMS.BLUE ? 1 : -1;
    const handOffset = (server.handedness === 'right' ? -0.35 : 0.35) * sideSign;
    this.ball.x = server.x + handOffset;
    this.ball.y = 1.22;
    this.ball.z = server.z - sideSign * 0.35;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;
    this.ball.spin = 0;
    this.ball.sideSpin = 0;
    this.ball.bounces = 0;
    this.ball.inPlay = false;
    this.ball.visible = true;
    this.ball.sweetSpotWindow = 0;
  }

  // --- Player Input Handlers ---

  handlePose(seat, pose) {
    const p = this.players[seat];
    if (!p || !pose) return;
    p.pose.pitch = clamp(Number(pose.pitch) || 0, -1.5, 1.5);
    p.pose.roll = clamp(Number(pose.roll) || 0, -1.5, 1.5);
    p.pose.yaw = clamp(Number(pose.yaw) || 0, -1.5, 1.5);
  }

  handleMoveNudge(seat, nudgeX) {
    const p = this.players[seat];
    if (!p) return;
    p.nudgeX = clamp(Number(nudgeX) || 0, -1, 1);
  }

  handleToss(seat) {
    if (this.phase !== PHASE.SERVE_READY) return false;
    if (seat !== this.serverSeat) return false;
    this._launchServeToss();
    return true;
  }

  handleSwing(seat, input = {}) {
    const player = this.players[seat];
    if (!player || !player.active) return false;

    const power = clamp(Number(input.power ?? 0.72), 0.2, 1.0);
    const spin = clamp(Number(input.spin ?? 0), -1, 1);
    const aim = clamp(Number(input.aim ?? 0), -1, 1);
    const elevation = input.elevation || 'flat'; // 'flat' | 'lob' | 'smash' | 'toss'
    const side = input.side || 'auto'; // 'forehand' | 'backhand' | 'auto'

    // If in SERVE_READY and server flicks up / swings, toss the ball!
    if (this.phase === PHASE.SERVE_READY && seat === this.serverSeat) {
      this._launchServeToss();
      return true;
    }

    // Trigger immediate visual swing animation
    player.swingDuration = 0.34;
    player.swingTimer = player.swingDuration;
    player.swingPower = power;
    if (side === 'forehand' || side === 'backhand') {
      player.swingSide = side;
    } else {
      const relX = this.ball.x - player.x;
      const sideSign = player.team === TEAMS.BLUE ? 1 : -1;
      const isRightSide = relX * sideSign >= 0;
      player.swingSide = (player.handedness === 'right' ? isRightSide : !isRightSide) ? 'forehand' : 'backhand';
    }

    // Emit whoosh sound event even on whiff
    this._emit('swing_whoosh', { seat, power, side: player.swingSide });

    // Serve hit check
    if (this.phase === PHASE.SERVE_TOSS && seat === this.serverSeat) {
      if (this.ball.y >= 1.20) {
        this._executeServeHit(player, { power, spin, aim, elevation });
        return true;
      }
      return false;
    }

    // Rally hit check (with short forgiveness buffer if swung slightly early)
    if (this.phase === PHASE.RALLY) {
      const swingData = { power, spin, aim, elevation, side, expiresAt: this.clock + SWING_BUFFER_SEC };
      if (!this._tryExecuteRallyHit(player, swingData)) {
        player.pendingSwing = swingData;
      }
      return true;
    }

    return false;
  }

  _launchServeToss() {
    this.phase = PHASE.SERVE_TOSS;
    this.phaseTimer = 0;
    this._snapBallToServer();
    this.ball.vy = 6.50; // Reaches sweet-spot apex around y = 3.1m with comfortable hang time
    this.ball.inPlay = true;
    this._emit('serve_toss', { seat: this.serverSeat });
  }

  _executeServeHit(player, { power, spin, aim }) {
    const deuce = this._isDeuceCourt();
    const serverSide = player.team === TEAMS.BLUE ? 1 : -1;
    const targetSide = -serverSide;

    // Apex sweet spot timing quality (1.0 right at apex vy === 0, drops if too early/late)
    const apexDist = Math.abs(this.ball.vy);
    const heightBonus = this.ball.y >= 2.25 ? 1 : clamp((this.ball.y - 1.20) / 1.05, 0, 1);
    const sweetSpot = clamp((1 - apexDist / 3.9) * heightBonus, 0, 1);
    const isRocket = sweetSpot > 0.68 && power > 0.55;

    // Target diagonal service box
    // Blue serving deuce (+X) -> targets Red's right box: X in [-4.115, 0], Z in [-6.40, 0]
    const boxSign = deuce ? -serverSide : serverSide;
    const innerX = boxSign * 0.65;
    const outerX = boxSign * (COURT.SINGLES_HALF_WIDTH - 0.55);
    // Aim shifts left/right across the service box
    const aimFactor = clamp(0.5 + aim * 0.42 * serverSide, 0.08, 0.94);
    let targetX = innerX + (outerX - innerX) * aimFactor;

    // Depth inside service box (stronger / rocket serves push deeper near the service line)
    let depth = 4.2 + power * 1.55 + sweetSpot * 0.45;
    // Very poor timing + overpowered serve risks a realistic fault!
    if (sweetSpot < 0.25 && power > 0.85) {
      depth += 0.95; // Might sail just long -> FAULT!
    }
    const targetZ = targetSide * clamp(depth, 3.2, 6.85);

    const shotType = isRocket ? SHOT_TYPES.ROCKET_SERVE : SHOT_TYPES.SERVE;
    const speed = isRocket ? (37 + power * 6.5) : (26 + power * 8.5);
    const appliedSpin = isRocket ? 0.55 : clamp(spin * 0.6 + 0.25, -0.5, 0.8);

    this._launchBallToTarget(targetX, targetZ, speed, appliedSpin, shotType, 0.14);

    player.swingSide = 'serve';
    player.swingDuration = 0.42;
    player.swingTimer = 0.42;
    player.hitCooldown = 0.35;

    this.phase = PHASE.RALLY;
    this.isServeBall = true;
    this.lastHitterSeat = player.seat;
    this.lastHitterTeam = player.team;
    this.ball.bounces = 0;

    const mph = this._computeShotMph(isRocket ? 1.24 : 1.12);
    this.lastShotMph = mph;
    if (mph > this.stats.maxMph[player.team]) this.stats.maxMph[player.team] = mph;
    if (isRocket) {
      this.stats.sweetSpots[player.team]++;
      this.cameraImpulse = 1.0;
    }

    this._updatePredictedLanding();
    this._emit('ball_hit', {
      seat: player.seat,
      team: player.team,
      shotType,
      mph,
      sweetSpot: isRocket,
      power,
      isServe: true,
      x: this.ball.x,
      y: this.ball.y,
      z: this.ball.z
    });
  }

  _tryExecuteRallyHit(player, swingData) {
    if (player.hitCooldown > 0) return false;
    // Cannot hit your own team's shot back immediately
    if (this.lastHitterTeam === player.team) return false;

    const sideSign = player.team === TEAMS.BLUE ? 1 : -1;
    // Ball must be on or approaching this player's half of the court
    if (this.ball.z * sideSign < -0.5) return false;
    // If ball is moving away from us after crossing us? Allow slight behind-body recovery.
    const dx = this.ball.x - player.x;
    const dz = this.ball.z - player.z;
    const horizDist = Math.hypot(dx, dz);

    // Forgiving arcade strike envelope!
    const maxReach = 3.15;
    if (Math.abs(dx) > 2.75 || Math.abs(dz) > 2.85 || horizDist > maxReach) return false;
    if (this.ball.y > 3.9) return false;

    // Must bounce once on a serve before being returned!
    if (this.isServeBall && this.ball.bounces === 0) return false;

    // Determine contact quality & timing
    const isLunge = horizDist > 1.78;
    // Early swing = ball still in front of player (dz * sideSign < 0)
    // Late swing = ball past player (dz * sideSign > 0)
    const relativeZ = (this.ball.z - player.z) * sideSign;
    const timing = clamp(relativeZ / 1.85, -1, 1); // -1 early, 0 center sweet spot, +1 late
    const isSweetSpot = !isLunge && Math.abs(timing) < 0.28 && swingData.power > 0.55;

    // Forehand vs Backhand orientation
    const isRightOfPlayer = (this.ball.x - player.x) * sideSign >= 0;
    const isForehand = player.handedness === 'right' ? isRightOfPlayer : !isRightOfPlayer;

    // Classify shot type
    let shotType = SHOT_TYPES.DRIVE;
    const isVolley = this.ball.bounces === 0 && Math.abs(player.z) < 7.2;
    const isOverheadSmash = !isLunge && this.ball.y > 2.05 && (swingData.elevation === 'smash' || swingData.power > 0.78);

    if (isOverheadSmash) {
      shotType = SHOT_TYPES.SMASH;
    } else if (swingData.elevation === 'lob' || (isLunge && swingData.power < 0.55)) {
      shotType = SHOT_TYPES.LOB;
    } else if (isVolley) {
      shotType = SHOT_TYPES.VOLLEY;
    } else if (swingData.spin > 0.32) {
      shotType = SHOT_TYPES.TOPSPIN;
    } else if (swingData.spin < -0.32) {
      shotType = SHOT_TYPES.SLICE;
    }

    // Target calculation (swing timing -> directional steering!)
    const targetSide = -sideSign;
    const courtHalfW = this.mode === MATCH_MODES.DOUBLES ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH;

    // Timing direction: for a right-handed forehand on Blue (+Z), early pulls left (-X), late pushes right (+X).
    // For backhand, reversed! Plus explicit aim/gyro steering blends in smoothly.
    const forehandSign = (player.handedness === 'right' ? 1 : -1) * (isForehand ? 1 : -1) * sideSign;
    const timingSteer = timing * forehandSign * 0.78;
    const combinedSteer = clamp(timingSteer + swingData.aim * 0.55 * sideSign, -1.08, 1.08);

    let targetX = combinedSteer * (courtHalfW - 0.45);
    // Keep lunges safer toward middle
    if (isLunge) targetX *= 0.52;

    // Target depth based on shot type & power
    let targetDepth;
    let speed;
    let spin = swingData.spin;
    let minClearance = 0.22;

    if (shotType === SHOT_TYPES.SMASH) {
      targetDepth = 5.5 + swingData.power * 3.8;
      speed = 34 + swingData.power * 9.0;
      spin = 0.35;
      minClearance = 0.14;
      this.cameraImpulse = 0.95;
    } else if (shotType === SHOT_TYPES.LOB) {
      targetDepth = 9.4 + swingData.power * 1.9;
      speed = 13.5 + swingData.power * 3.2;
      spin = 0.25;
      minClearance = 3.25;
    } else if (shotType === SHOT_TYPES.VOLLEY) {
      targetDepth = 4.6 + swingData.power * 4.5;
      speed = 24 + swingData.power * 7.5;
      spin = -0.25;
      minClearance = 0.16;
    } else if (shotType === SHOT_TYPES.SLICE) {
      targetDepth = 6.2 + swingData.power * 3.8;
      speed = 18.5 + swingData.power * 5.8;
      spin = -0.78;
      minClearance = 0.18;
    } else if (shotType === SHOT_TYPES.TOPSPIN) {
      targetDepth = 7.6 + swingData.power * 3.5;
      speed = 24 + swingData.power * 8.5 + (isSweetSpot ? 3.2 : 0);
      spin = 0.85;
      minClearance = 0.30;
    } else {
      // Standard flat drive
      targetDepth = 7.2 + swingData.power * 3.7;
      speed = 22.5 + swingData.power * 8.0 + (isSweetSpot ? 3.0 : 0);
      spin = clamp(spin, -0.35, 0.45);
      minClearance = 0.22;
    }

    if (isLunge) {
      speed *= 0.74;
      targetDepth = clamp(targetDepth, 5.8, 9.2);
      minClearance = Math.max(minClearance, 0.75);
    }

    // Small realistic out-of-bounds risk ONLY on extreme overpower + wild timing
    if (!isLunge && swingData.power > 0.93 && Math.abs(timing) > 0.78) {
      targetDepth += 1.25;
      targetX *= 1.12;
    }

    const targetZ = targetSide * clamp(targetDepth, 3.0, COURT.HALF_LENGTH + 0.75);

    this._launchBallToTarget(targetX, targetZ, speed, spin, shotType, minClearance);

    player.swingSide = shotType === SHOT_TYPES.SMASH ? 'smash' : (isForehand ? 'forehand' : 'backhand');
    player.swingDuration = 0.36;
    player.swingTimer = 0.36;
    player.swingPower = swingData.power;
    player.isLunge = isLunge;
    player.pendingSwing = null;
    player.hitCooldown = 0.34;

    this.isServeBall = false;
    this.lastHitterSeat = player.seat;
    this.lastHitterTeam = player.team;
    this.ball.bounces = 0;
    this.rallyCount++;
    if (this.rallyCount > this.stats.longestRally) {
      this.stats.longestRally = this.rallyCount;
    }

    const mph = this._computeShotMph(shotType === SHOT_TYPES.SMASH ? 1.18 : 1.0);
    this.lastShotMph = mph;
    if (mph > this.stats.maxMph[player.team]) this.stats.maxMph[player.team] = mph;
    if (isSweetSpot || shotType === SHOT_TYPES.SMASH) {
      this.stats.sweetSpots[player.team]++;
    }

    this._updatePredictedLanding();
    this._emit('ball_hit', {
      seat: player.seat,
      team: player.team,
      shotType,
      mph,
      sweetSpot: isSweetSpot || shotType === SHOT_TYPES.SMASH,
      isLunge,
      power: swingData.power,
      isServe: false,
      rallyCount: this.rallyCount,
      x: this.ball.x,
      y: this.ball.y,
      z: this.ball.z
    });

    return true;
  }

  _launchBallToTarget(targetX, targetZ, speed, spin, shotType, minNetClearance) {
    const x0 = this.ball.x;
    const y0 = Math.max(this.ball.y, 0.38);
    const z0 = this.ball.z;

    const dx = targetX - x0;
    const dz = targetZ - z0;
    const horizDist = Math.hypot(dx, dz);

    // Effective vertical acceleration incorporating Magnus spin effect
    const magnusAccelY = -spin * 4.4; // Topspin (+spin) pulls down; Slice (-spin) lifts up
    const effAY = -GRAVITY + magnusAccelY;

    let T = clamp(horizDist / Math.max(speed, 8), 0.36, 1.95);
    if (shotType === SHOT_TYPES.LOB) {
      T = Math.max(T, 1.38);
    }

    const computeLaunch = (flightT) => {
      const effT = (1 - Math.exp(-AIR_DRAG * flightT)) / AIR_DRAG;
      const vx = dx / effT;
      const vz = dz / effT;
      const vy = (COURT.BALL_RADIUS - y0 - 0.5 * effAY * flightT * flightT) / flightT;
      return { vx, vy, vz };
    };

    let launch = computeLaunch(T);

    // Ensure non-mishit shots cleanly clear the net by adjusting flight arc if needed
    if (z0 * targetZ < 0) {
      const zFrac = Math.abs(z0) / Math.abs(targetZ - z0);
      const tNet = -Math.log(Math.max(0.05, 1 - zFrac * (1 - Math.exp(-AIR_DRAG * T)))) / AIR_DRAG;
      const xAtNet = x0 + launch.vx * ((1 - Math.exp(-AIR_DRAG * tNet)) / AIR_DRAG);
      const yAtNet = y0 + launch.vy * tNet + 0.5 * effAY * tNet * tNet;
      const reqHeight = netHeightAt(xAtNet) + minNetClearance;

      if (yAtNet < reqHeight) {
        // Increase flight time slightly to raise arc cleanly over the net
        const neededDeltaY = reqHeight - yAtNet;
        const extraVy = neededDeltaY / Math.max(tNet, 0.12);
        // Re-solve T so it still lands near targetZ while clearing net
        const bumpedT = clamp(T + extraVy * 0.065, T, 2.05);
        T = bumpedT;
        launch = computeLaunch(T);
        // Direct lift guard for high lobs
        if (shotType === SHOT_TYPES.LOB) {
          const yCheck = y0 + launch.vy * tNet + 0.5 * effAY * tNet * tNet;
          if (yCheck < reqHeight) {
            launch.vy += (reqHeight - yCheck) / Math.max(tNet, 0.15);
          }
        }
      }
    }

    this.ball.vx = launch.vx;
    this.ball.vy = launch.vy;
    this.ball.vz = launch.vz;
    this.ball.spin = spin;
    this.ball.sideSpin = (shotType === SHOT_TYPES.SLICE ? 0.35 : 0) * Math.sign(dx || 1);
    this.ball.shotType = shotType;
    this.ball.inPlay = true;
  }

  _computeShotMph(scale = 1.0) {
    const speedMs = Math.hypot(this.ball.vx, this.ball.vy * 0.4, this.ball.vz);
    return Math.round(clamp(speedMs * 2.237 * scale, 28, 138));
  }

  // --- Authoritative Fixed-Timestep Simulation ---

  step(dt) {
    const clampedDt = Math.min(dt, 0.05);
    this.clock += clampedDt;
    this.phaseTimer += clampedDt;
    this.netWave = Math.max(0, this.netWave - clampedDt * 2.4);
    this.cameraImpulse = Math.max(0, this.cameraImpulse - clampedDt * 3.5);

    for (const p of this.players) {
      if (p.swingTimer > 0) p.swingTimer = Math.max(0, p.swingTimer - clampedDt);
      if (p.hitCooldown > 0) p.hitCooldown = Math.max(0, p.hitCooldown - clampedDt);
      if (p.pendingSwing && this.clock > p.pendingSwing.expiresAt) {
        p.pendingSwing = null;
      }
    }

    if (this.phase === PHASE.LOBBY) {
      // Gentle idle animation in lobby
      return;
    }

    if (this.phase === PHASE.SERVE_READY) {
      this._snapBallToServer();
      const server = this.players[this.serverSeat];
      if (!server.isHuman) {
        server.aiServeTimer -= clampedDt;
        if (server.aiServeTimer <= 0) {
          this._launchServeToss();
        }
      }
      return;
    }

    if (this.phase === PHASE.SERVE_TOSS) {
      this.ball.y += this.ball.vy * clampedDt;
      this.ball.vy -= GRAVITY * clampedDt;

      // Sweet-spot visual glow peaks right near apex
      const apexProximity = clamp(1 - Math.abs(this.ball.vy) / 3.0, 0, 1);
      this.ball.sweetSpotWindow = this.ball.y > 2.2 ? apexProximity : 0;

      const server = this.players[this.serverSeat];
      if (!server.isHuman && this.ball.vy <= 0.45 && this.ball.y > 2.35) {
        const prof = AI_PROFILES[this.difficulty];
        const power = prof.powerRange[0] + Math.random() * (prof.powerRange[1] - prof.powerRange[0]);
        this.handleSwing(server.seat, {
          power,
          spin: 0.3,
          aim: (Math.random() - 0.5) * 1.1
        });
        return;
      }

      // If toss falls unhit, catch and reset cleanly (no fault)
      if (this.ball.y <= 0.4 && this.ball.vy < 0) {
        this.phase = PHASE.SERVE_READY;
        this._snapBallToServer();
      }
      return;
    }

    if (this.phase === PHASE.RALLY) {
      this._stepBall(clampedDt);
      this._stepPlayers(clampedDt);
      this._stepBufferedSwingsAndAI(clampedDt);
      return;
    }

    if (this.phase === PHASE.POINT_OVER) {
      this._stepBallCoast(clampedDt);
      if (this.phaseTimer >= 2.15) {
        if (this._isLetReplay) {
          this._isLetReplay = false;
          this._prepareServe(this.faultCount > 0);
          return;
        }
        if (this._isSecondServePending) {
          this._isSecondServePending = false;
          this._prepareServe(true);
          return;
        }
        this._prepareServe(false);
      }
      return;
    }

    if (this.phase === PHASE.GAME_OVER) {
      this._stepBallCoast(clampedDt);
      if (this.phaseTimer >= 3.0) {
        this._advanceServerForNextGame();
        this._prepareServe(false);
      }
      return;
    }

    if (this.phase === PHASE.MATCH_OVER) {
      this._stepBallCoast(clampedDt);
    }
  }

  _stepBall(dt) {
    const b = this.ball;
    const prevX = b.x;
    const prevZ = b.z;
    const prevY = b.y;

    // Air drag + Magnus effect
    const dragFactor = Math.exp(-AIR_DRAG * dt);
    b.vx *= dragFactor;
    b.vz *= dragFactor;
    b.vx += b.sideSpin * 2.2 * dt;

    const magnusAccelY = -b.spin * 4.4;
    b.vy += (-GRAVITY + magnusAccelY) * dt;

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // 1. Net crossing check
    if ((prevZ > 0 && b.z <= 0) || (prevZ < 0 && b.z >= 0)) {
      const frac = Math.abs(prevZ) / (Math.abs(prevZ - b.z) || 1);
      const yCross = prevY + (b.y - prevY) * frac;
      const xCross = prevX + (b.x - prevX) * frac;
      const nHeight = netHeightAt(xCross);

      if (Math.abs(xCross) <= COURT.NET_POST_X && yCross < nHeight) {
        this.netWave = 1.0;
        if (yCross >= nHeight - 0.16) {
          // Clipped the white top tape! Deflect slightly upward and slow down
          b.vx *= 0.65;
          b.vz *= 0.58;
          b.vy = Math.max(b.vy * 0.4, 2.3);
          b.y = nHeight + 0.04;
          this._emit('net_cord', { x: xCross, y: nHeight, isServe: this.isServeBall });
          if (this.isServeBall) {
            // Serve Let — replay serve!
            this._triggerCallout('LET! REPLAY SERVE', 'info');
            this.phase = PHASE.POINT_OVER;
            this.phaseTimer = 0.8; // Quick reset to same serve
            // Undo fault/point impact by keeping serve count intact via special flag
            this._isLetReplay = true;
            return;
          }
        } else {
          // Dead into the net!
          b.vz *= -0.18;
          b.vx *= 0.3;
          b.vy = Math.min(b.vy, 0.5);
          b.z = Math.sign(prevZ) * 0.08;
          this._emit('net_hit', { x: xCross, y: yCross });
          if (this.isServeBall) {
            this._handleServeFault('NET FAULT');
          } else {
            this._awardPoint(1 - this.lastHitterTeam, 'NET!', 'fault');
          }
          return;
        }
      }
    }

    // 2. Ground bounce check
    if (b.y <= COURT.BALL_RADIUS && b.vy < 0) {
      b.y = COURT.BALL_RADIUS;
      b.bounces++;

      // Spin affects post-bounce velocity (topspin kicks forward & higher, slice skids low)
      const kickFactor = 1 + b.spin * 0.16;
      b.vy = -b.vy * clamp(BOUNCE_RESTITUTION + b.spin * 0.08, 0.56, 0.88);
      b.vx *= BOUNCE_FRICTION;
      b.vz *= BOUNCE_FRICTION * kickFactor;
      b.spin *= 0.45;

      const inBounds = this._checkBounceInBounds(b.x, b.z);
      b.lastBounce = { x: b.x, z: b.z, inBounds, time: this.clock };

      this._emit('ball_bounce', {
        x: b.x,
        z: b.z,
        inBounds,
        bounceCount: b.bounces,
        isServe: this.isServeBall
      });

      if (b.bounces === 1) {
        if (!inBounds) {
          if (this.isServeBall) {
            this._handleServeFault('FAULT!');
          } else {
            this._awardPoint(1 - this.lastHitterTeam, 'OUT!', 'out');
          }
          return;
        }
        // Valid first bounce inside opponent's court; update landing prediction for chase
        this._updatePredictedLanding();
      } else if (b.bounces >= 2) {
        // Double bounce -> point for last hitter!
        const isAce = this.isServeBall && this.rallyCount === 0;
        if (isAce) {
          this.stats.aces[this.lastHitterTeam]++;
          this._awardPoint(this.lastHitterTeam, 'ACE!', 'ace');
        } else {
          this.stats.winners[this.lastHitterTeam]++;
          this._awardPoint(this.lastHitterTeam, this.rallyCount >= 6 ? 'GREAT WINNER!' : 'POINT!', 'winner');
        }
        return;
      }
    }

    // 3. Far out-of-stadium failsafe
    if (Math.abs(b.x) > COURT.OUTER_HALF_WIDTH + 3.5 || Math.abs(b.z) > COURT.OUTER_HALF_LENGTH + 3.5) {
      if (b.bounces === 0) {
        if (this.isServeBall) {
          this._handleServeFault('FAULT!');
        } else {
          this._awardPoint(1 - this.lastHitterTeam, 'OUT!', 'out');
        }
      } else {
        const isAce = this.isServeBall && this.rallyCount === 0;
        if (isAce) this.stats.aces[this.lastHitterTeam]++;
        else this.stats.winners[this.lastHitterTeam]++;
        this._awardPoint(this.lastHitterTeam, isAce ? 'ACE!' : 'WINNER!', isAce ? 'ace' : 'winner');
      }
    }
  }

  _stepBallCoast(dt) {
    const b = this.ball;
    if (!b.inPlay) return;
    b.vy -= GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.y <= COURT.BALL_RADIUS) {
      b.y = COURT.BALL_RADIUS;
      b.vy = -b.vy * 0.55;
      b.vx *= 0.8;
      b.vz *= 0.8;
      if (Math.abs(b.vy) < 0.3) {
        b.vy = 0;
        b.vx *= 0.9;
        b.vz *= 0.9;
      }
    }
  }

  _checkBounceInBounds(x, z) {
    // Must land on opponent's half of the court
    const targetSide = this.lastHitterTeam === TEAMS.BLUE ? -1 : 1;
    if (z * targetSide < -0.05) return false;

    const absZ = Math.abs(z);
    const absX = Math.abs(x);

    if (this.isServeBall) {
      // Must land in the diagonal service box!
      const deuce = this._isDeuceCourt();
      const serverSide = this.lastHitterTeam === TEAMS.BLUE ? 1 : -1;
      const expectedXSign = deuce ? -serverSide : serverSide;
      const lineTol = 0.09; // Generous line-chalk tolerance
      const inDepth = absZ <= COURT.SERVICE_LINE_Z + lineTol;
      const inBoxSide = (x * expectedXSign >= -lineTol) && (absX <= COURT.SINGLES_HALF_WIDTH + lineTol);
      return inDepth && inBoxSide;
    }

    const maxW = (this.mode === MATCH_MODES.DOUBLES ? COURT.DOUBLES_HALF_WIDTH : COURT.SINGLES_HALF_WIDTH) + 0.09;
    const maxL = COURT.HALF_LENGTH + 0.09;
    return absX <= maxW && absZ <= maxL;
  }

  _updatePredictedLanding() {
    // Forward-simulate ball lightly to find where it will cross player strike zones & bounce
    let x = this.ball.x;
    let y = this.ball.y;
    let z = this.ball.z;
    let vx = this.ball.vx;
    let vy = this.ball.vy;
    let vz = this.ball.vz;
    const magnusY = -this.ball.spin * 4.4;
    const dt = 0.02;
    let bouncePos = null;

    for (let i = 0; i < 140; i++) {
      const df = Math.exp(-AIR_DRAG * dt);
      vx *= df;
      vz *= df;
      vx += this.ball.sideSpin * 2.2 * dt;
      vy += (-GRAVITY + magnusY) * dt;
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      if (y <= COURT.BALL_RADIUS && vy < 0) {
        bouncePos = { x, z, t: (i + 1) * dt, team: z >= 0 ? TEAMS.BLUE : TEAMS.RED };
        break;
      }
    }
    this.predictedLanding = bouncePos;
  }

  _stepPlayers(dt) {
    // Automatic arcade tennis court positioning!
    // Players smoothly sprint toward the ball intercept on their side, while teammates hold formation.
    const ball = this.ball;
    const ballGoingToTeam = ball.vz > 0.2 ? TEAMS.BLUE : (ball.vz < -0.2 ? TEAMS.RED : -1);

    for (const p of this.players) {
      if (!p.active) continue;
      const sideSign = p.team === TEAMS.BLUE ? 1 : -1;
      const baseZ = p.role === 'front' ? sideSign * 4.6 : sideSign * 10.6;
      let targetX = 0;
      let targetZ = baseZ;

      const isDefendingTeam = ballGoingToTeam === p.team && this.lastHitterTeam !== p.team;

      if (isDefendingTeam) {
        // Compute ideal intercept spot along ball trajectory
        const pred = this.predictedLanding;
        if (this.mode === MATCH_MODES.SINGLES) {
          if (pred && pred.team === p.team) {
            targetX = clamp(pred.x, -COURT.DOUBLES_HALF_WIDTH - 1.2, COURT.DOUBLES_HALF_WIDTH + 1.2);
            // Position slightly behind bounce for comfortable groundstroke
            const preferredZ = pred.z + sideSign * (ball.shotType === SHOT_TYPES.LOB ? 1.6 : 1.15);
            targetZ = sideSign * clamp(Math.abs(preferredZ), 2.8, COURT.HALF_LENGTH + 2.1);
          } else {
            targetX = clamp(ball.x, -5.8, 5.8);
            targetZ = baseZ;
          }
        } else {
          // Doubles: Front player handles short/net balls & high volleys; Back player handles deep balls
          const predZAbs = pred ? Math.abs(pred.z) : Math.abs(ball.z);
          if (p.role === 'front') {
            if (pred && pred.team === p.team && predZAbs < 6.8) {
              targetX = clamp(pred.x, -COURT.DOUBLES_HALF_WIDTH, COURT.DOUBLES_HALF_WIDTH);
              targetZ = sideSign * clamp(predZAbs + 0.6, 2.2, 6.2);
            } else {
              // Shade across the net toward the ball to threaten a volley
              targetX = clamp(ball.x * 0.68, -3.6, 3.6);
              targetZ = sideSign * 4.3;
            }
          } else {
            // Back player covers deep groundstrokes and lobs
            if (pred && pred.team === p.team) {
              targetX = clamp(pred.x, -COURT.DOUBLES_HALF_WIDTH - 1.1, COURT.DOUBLES_HALF_WIDTH + 1.1);
              targetZ = sideSign * clamp(Math.max(predZAbs + 1.1, 7.6), 7.2, COURT.HALF_LENGTH + 2.2);
            } else {
              targetX = clamp(ball.x * 0.55, -3.4, 3.4);
              targetZ = baseZ;
            }
          }
        }
      } else {
        // Recover smoothly toward strategic court position
        if (this.mode === MATCH_MODES.SINGLES) {
          targetX = clamp(ball.x * 0.25, -1.6, 1.6);
          targetZ = sideSign * 10.4;
        } else {
          // Mirror partner horizontally to cover court width
          const partner = this.players.find((o) => o.active && o.team === p.team && o.seat !== p.seat);
          const homeX = p.role === 'front' ? (partner && partner.x > 0 ? -2.0 : 2.0) : (ball.x * 0.35);
          targetX = clamp(homeX, -3.5, 3.5);
          targetZ = baseZ;
        }
      }

      // Optional manual horizontal nudge from controller (Pro mode)
      if (p.isHuman && Math.abs(p.nudgeX) > 0.05) {
        targetX += p.nudgeX * sideSign * 2.4;
      }

      const maxSpeed = p.isHuman ? 9.8 : 8.4 * AI_PROFILES[this.difficulty].speedMul;
      const dx = targetX - p.x;
      const dz = targetZ - p.z;
      const dist = Math.hypot(dx, dz);

      if (dist > 0.06) {
        const moveDist = Math.min(dist, maxSpeed * dt);
        const nx = dx / dist;
        const nz = dz / dist;
        p.vx = nx * (moveDist / dt);
        p.vz = nz * (moveDist / dt);
        p.x += nx * moveDist;
        p.z += nz * moveDist;
      } else {
        p.vx *= 0.5;
        p.vz *= 0.5;
      }

      // Clamp to stadium floor & own side of net
      p.x = clamp(p.x, -COURT.OUTER_HALF_WIDTH + 1.0, COURT.OUTER_HALF_WIDTH - 1.0);
      if (p.team === TEAMS.BLUE) {
        p.z = clamp(p.z, 1.5, COURT.OUTER_HALF_LENGTH - 1.6);
      } else {
        p.z = clamp(p.z, -(COURT.OUTER_HALF_LENGTH - 1.6), -1.5);
      }
    }
  }

  _stepBufferedSwingsAndAI() {
    for (const p of this.players) {
      if (!p.active) continue;

      // 1. Human buffered early swing
      if (p.isHuman && p.pendingSwing) {
        this._tryExecuteRallyHit(p, p.pendingSwing);
        continue;
      }

      // 2. Smart CPU AI swing trigger
      if (!p.isHuman && this.lastHitterTeam !== p.team && p.hitCooldown <= 0) {
        if (this.isServeBall && this.ball.bounces === 0) continue;
        const sideSign = p.team === TEAMS.BLUE ? 1 : -1;
        if (this.ball.z * sideSign < 0.8) continue;

        const dx = this.ball.x - p.x;
        const dz = this.ball.z - p.z;
        const dist = Math.hypot(dx, dz);

        // Wait until ball enters a natural hitting sweet spot (in front of CPU)
        const inStrikeDepth = Math.abs(dz) < 1.35;
        const inReach = dist < 2.05 && this.ball.y < 3.1;

        if (inStrikeDepth && inReach) {
          const prof = AI_PROFILES[this.difficulty];
          // Occasional realistic rookie miss on fast wide shots
          if (this.lastShotMph > 98 && dist > 1.55 && Math.random() < prof.errorChance) {
            p.hitCooldown = 0.45;
            continue;
          }

          // Choose shot type & tactical target away from opponents
          const opponents = this.players.filter((o) => o.active && o.team !== p.team);
          const avgOppX = opponents.reduce((s, o) => s + o.x, 0) / Math.max(opponents.length, 1);
          // Aim away from opponent's average X
          const openSide = avgOppX >= 0 ? -1 : 1;
          const aim = clamp(openSide * (0.45 + Math.random() * 0.45) * sideSign + (Math.random() - 0.5) * prof.accuracySpread * 0.4, -0.95, 0.95);
          const power = prof.powerRange[0] + Math.random() * (prof.powerRange[1] - prof.powerRange[0]);

          let elevation = 'flat';
          let spin = (Math.random() - 0.35) * 0.9;
          if (this.ball.y > 2.15 && Math.random() < prof.smashChance) {
            elevation = 'smash';
          } else if (opponents.some((o) => Math.abs(o.z) < 6.0) && Math.random() < prof.lobChance) {
            elevation = 'lob';
          }

          this.handleSwing(p.seat, { power, spin, aim, elevation });
        }
      }
    }
  }

  _handleServeFault(label) {
    this.faultCount++;
    if (this.faultCount === 1) {
      this._triggerCallout(`${label} — 2ND SERVE`, 'fault');
      this._emit('fault', { faultCount: 1, serverSeat: this.serverSeat });
      // Brief pause then 2nd serve
      this.phase = PHASE.POINT_OVER;
      this.phaseTimer = 0.6;
      this._isSecondServePending = true;
    } else {
      const serverTeam = this.players[this.serverSeat].team;
      this._emit('fault', { faultCount: 2, serverSeat: this.serverSeat });
      this._awardPoint(1 - serverTeam, 'DOUBLE FAULT!', 'fault');
    }
  }

  _awardPoint(winnerTeam, calloutText, kind) {
    this.stats.totalRallies++;
    this.points[winnerTeam]++;

    const pB = this.points[TEAMS.BLUE];
    const pR = this.points[TEAMS.RED];
    const diff = Math.abs(pB - pR);
    const wonGame = (pB >= 4 || pR >= 4) && diff >= 2;

    if (wonGame) {
      this.games[winnerTeam]++;
      this.points = [0, 0];
      const gamesNeeded = this._gamesToWin();
      if (this.games[winnerTeam] >= gamesNeeded) {
        this.winnerTeam = winnerTeam;
        this.phase = PHASE.MATCH_OVER;
        this.phaseTimer = 0;
        const teamLabel = winnerTeam === TEAMS.BLUE ? 'BLUE TEAM' : 'RED TEAM';
        this._triggerCallout(`GAME, SET & MATCH — ${teamLabel}!`, 'match_win');
        this._emit('match_over', {
          winnerTeam,
          games: [...this.games],
          stats: this.stats
        });
        return;
      }

      this.phase = PHASE.GAME_OVER;
      this.phaseTimer = 0;
      const teamLabel = winnerTeam === TEAMS.BLUE ? 'BLUE' : 'RED';
      this._triggerCallout(`GAME ${teamLabel}!`, 'game_win');
      this._emit('game_over', { winnerTeam, games: [...this.games] });
      return;
    }

    // Check special tennis callouts (Deuce, Advantage, Game Point, Match Point)
    let subCallout = calloutText;
    const score = formatScore(this.points[0], this.points[1]);
    if (score.call) {
      subCallout = `${calloutText} • ${score.call}`;
    } else if (this._isMatchPoint() !== -1) {
      subCallout = `${calloutText} • MATCH POINT!`;
    } else if (this._isGamePoint() !== -1) {
      subCallout = `${calloutText} • GAME POINT!`;
    }

    this.phase = PHASE.POINT_OVER;
    this.phaseTimer = 0;
    this._triggerCallout(subCallout, kind);
    this._emit('point_over', {
      winnerTeam,
      callout: subCallout,
      kind,
      points: [...this.points],
      games: [...this.games]
    });
  }

  _isGamePoint() {
    const [b, r] = this.points;
    if (b >= 3 && b > r) return TEAMS.BLUE;
    if (r >= 3 && r > b) return TEAMS.RED;
    return -1;
  }

  _isMatchPoint() {
    const gp = this._isGamePoint();
    if (gp === -1) return -1;
    return this.games[gp] + 1 >= this._gamesToWin() ? gp : -1;
  }

  _advanceServerForNextGame() {
    if (this.mode === MATCH_MODES.SINGLES) {
      this.serverSeat = this.serverSeat === 0 ? 1 : 0;
    } else {
      // Standard doubles serve rotation alternating teams: 0 -> 1 -> 2 -> 3 -> 0
      this.serverSeat = (this.serverSeat + 1) % 4;
    }
  }

  _triggerCallout(text, kind) {
    this.lastCallout = { text, kind, at: this.clock };
  }

  _emit(type, payload) {
    this.onEvent({ type, ...payload, clock: this.clock });
  }

  tick(dt) {
    this.step(dt);
  }

  _isPlayerInStrikeZone(p) {
    if (this.phase !== PHASE.RALLY || !p.active || p.hitCooldown > 0) return false;
    if (this.lastHitterTeam === p.team) return false;
    if (this.isServeBall && this.ball.bounces === 0) return false;
    const sideSign = p.team === TEAMS.BLUE ? 1 : -1;
    if (this.ball.z * sideSign < -0.5) return false;
    const dx = this.ball.x - p.x;
    const dz = this.ball.z - p.z;
    return Math.abs(dx) <= 2.95 && Math.abs(dz) <= 3.15 && Math.hypot(dx, dz) <= 3.45 && this.ball.y <= 3.9;
  }

  getSnapshot() {
    const score = formatScore(this.points[0], this.points[1]);
    return {
      gameId: 'tennis',
      clock: Number(this.clock.toFixed(3)),
      phase: this.phase,
      mode: this.mode,
      format: this.format,
      difficulty: this.difficulty,
      games: this.games,
      points: this.points,
      scoreText: score,
      serverSeat: this.serverSeat,
      faultCount: this.faultCount,
      rallyCount: this.rallyCount,
      lastShotMph: this.lastShotMph,
      winnerTeam: this.winnerTeam,
      netWave: Number(this.netWave.toFixed(3)),
      cameraImpulse: Number(this.cameraImpulse.toFixed(3)),
      callout: this.lastCallout && (this.clock - this.lastCallout.at < 2.4) ? this.lastCallout : null,
      stats: this.stats,
      predictedLanding: this.predictedLanding ? {
        x: Number(this.predictedLanding.x.toFixed(2)),
        z: Number(this.predictedLanding.z.toFixed(2)),
        team: this.predictedLanding.team
      } : null,
      ball: {
        x: Number(this.ball.x.toFixed(3)),
        y: Number(this.ball.y.toFixed(3)),
        z: Number(this.ball.z.toFixed(3)),
        vx: Number(this.ball.vx.toFixed(2)),
        vy: Number(this.ball.vy.toFixed(2)),
        vz: Number(this.ball.vz.toFixed(2)),
        spin: Number(this.ball.spin.toFixed(2)),
        shotType: this.ball.shotType,
        bounces: this.ball.bounces,
        inPlay: this.ball.inPlay,
        visible: this.ball.visible,
        sweetSpotWindow: Number(this.ball.sweetSpotWindow.toFixed(2)),
        lastBounce: this.ball.lastBounce
      },
      players: this.players.map((p) => ({
        seat: p.seat,
        team: p.team,
        role: p.role,
        name: p.name,
        color: p.color,
        accent: p.accent,
        visor: p.visor,
        isHuman: p.isHuman,
        active: p.active,
        handedness: p.handedness,
        x: Number(p.x.toFixed(3)),
        z: Number(p.z.toFixed(3)),
        vx: Number(p.vx.toFixed(2)),
        vz: Number(p.vz.toFixed(2)),
        swingTimer: Number(p.swingTimer.toFixed(3)),
        swingDuration: p.swingDuration,
        swingSide: p.swingSide,
        swingPower: Number(p.swingPower.toFixed(2)),
        isLunge: p.isLunge,
        inStrikeZone: this._isPlayerInStrikeZone(p),
        pose: p.pose
      }))
    };
  }
}
