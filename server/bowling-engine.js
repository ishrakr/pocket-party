// Authoritative 60Hz 3D Party Bowling Physics, Scoring & AI Engine.
import {
  BOWLING_FORMATS,
  BOWLING_LANE,
  BOWLING_PHASE,
  CPU_DIFFICULTIES,
  GAMES,
  SEAT_DEFS,
  clamp
} from '../shared/protocol.js';

const AI_BOWL_PROFILES = {
  [CPU_DIFFICULTIES.ROOKIE]: {
    aimSpread: 0.16,
    powerRange: [0.46, 0.72],
    spinSpread: 0.28,
    thinkTime: 0.95
  },
  [CPU_DIFFICULTIES.PRO]: {
    aimSpread: 0.075,
    powerRange: [0.64, 0.88],
    spinSpread: 0.16,
    thinkTime: 0.75
  },
  [CPU_DIFFICULTIES.CHAMPION]: {
    aimSpread: 0.025,
    powerRange: [0.76, 0.96],
    spinSpread: 0.08,
    thinkTime: 0.6
  }
};

function formatRollSymbol(val) {
  if (val === 10) return 'X';
  if (val === 0) return '-';
  return String(val);
}

/**
 * Compute authentic 10-pin bowling scores across arbitrary frame lengths (3, 5, or 10 frames).
 */
export function computeBowlingScore(rolls, totalFrames = 10) {
  const frames = [];
  let rollIdx = 0;
  let runningTotal = 0;
  let strikes = 0;
  let spares = 0;

  for (let f = 0; f < totalFrames; f++) {
    const isFinal = f === totalFrames - 1;
    if (!isFinal) {
      if (rollIdx >= rolls.length) {
        frames.push({ rolls: [], display: ['', ''], cumulative: null, complete: false });
        continue;
      }

      const r1 = rolls[rollIdx];
      if (r1 === 10) {
        strikes++;
        const hasBonus = rollIdx + 2 < rolls.length;
        if (hasBonus) {
          runningTotal += 10 + rolls[rollIdx + 1] + rolls[rollIdx + 2];
        }
        frames.push({
          rolls: [10],
          display: ['', 'X'],
          cumulative: hasBonus ? runningTotal : null,
          complete: hasBonus
        });
        rollIdx += 1;
      } else if (rollIdx + 1 >= rolls.length) {
        frames.push({
          rolls: [r1],
          display: [formatRollSymbol(r1), ''],
          cumulative: null,
          complete: false
        });
        rollIdx += 1;
      } else {
        const r2 = rolls[rollIdx + 1];
        const isSpare = r1 + r2 === 10;
        if (isSpare) {
          spares++;
          const hasBonus = rollIdx + 2 < rolls.length;
          if (hasBonus) {
            runningTotal += 10 + rolls[rollIdx + 2];
          }
          frames.push({
            rolls: [r1, r2],
            display: [formatRollSymbol(r1), '/'],
            cumulative: hasBonus ? runningTotal : null,
            complete: hasBonus
          });
        } else {
          runningTotal += r1 + r2;
          frames.push({
            rolls: [r1, r2],
            display: [formatRollSymbol(r1), formatRollSymbol(r2)],
            cumulative: runningTotal,
            complete: true
          });
        }
        rollIdx += 2;
      }
    } else {
      // Final frame: up to 3 rolls if strike on roll 1 or spare on rolls 1+2
      const rem = rolls.slice(rollIdx);
      const display = ['', '', ''];
      let complete = false;

      if (rem.length > 0) {
        const r1 = rem[0];
        if (r1 === 10) strikes++;
        display[0] = formatRollSymbol(r1);

        if (rem.length >= 2) {
          const r2 = rem[1];
          if (r1 === 10) {
            if (r2 === 10) strikes++;
            display[1] = formatRollSymbol(r2);
          } else if (r1 + r2 === 10) {
            spares++;
            display[1] = '/';
          } else {
            display[1] = formatRollSymbol(r2);
            runningTotal += r1 + r2;
            complete = true;
          }

          const needsThird = r1 === 10 || r1 + r2 === 10;
          if (needsThird && rem.length >= 3) {
            const r3 = rem[2];
            if (r3 === 10 && (r1 + r2 === 10 || r2 === 10)) {
              strikes++;
              display[2] = 'X';
            } else if (r1 === 10 && r2 < 10 && r2 + r3 === 10) {
              spares++;
              display[2] = '/';
            } else {
              display[2] = formatRollSymbol(r3);
            }
            runningTotal += r1 + r2 + r3;
            complete = true;
          }
        }
      }

      frames.push({
        rolls: rem.slice(0, 3),
        display,
        cumulative: complete ? runningTotal : null,
        complete
      });
    }
  }

  return {
    frames,
    total: runningTotal,
    strikes,
    spares
  };
}

export class BowlingEngine {
  constructor(options = {}) {
    this.gameId = GAMES.BOWLING.id;
    this.format = options.format || BOWLING_FORMATS.CLASSIC_5.id;
    this.difficulty = options.difficulty || CPU_DIFFICULTIES.PRO;
    this.onEvent = options.onEvent || (() => {});

    this.phase = BOWLING_PHASE.LOBBY;
    this.phaseTimer = 0;
    this.clock = 0;

    this.currentFrame = 0; // 0-based
    this.turnIdx = 0;
    this.currentRoll = 1; // 1, 2, or 3
    this.frameRolls = [];
    this.turnOrder = [0, 1];
    this.winnerSeat = -1;
    this.winnerSeats = [];
    this.lastCallout = null;
    this.lastShotMph = 0;
    this.cameraImpulse = 0;

    this.aimX = 0;
    this.aimAngle = 0;
    this.previewSpin = 0;
    this._aiThinkTimer = 0;
    this._rollKnockCount = 0;
    this._pinHitSoundCooldown = 0;

    this.ball = this._createBall();
    this.pins = this._createPinRack();
    this.players = SEAT_DEFS.map((def) => this._createPlayer(def));
    this._syncActivePlayers();
    this._setupLobbyPositions();
  }

  _createBall() {
    return {
      x: 0,
      y: BOWLING_LANE.BALL_RADIUS,
      z: 0.4,
      vx: 0,
      vy: 0,
      vz: 0,
      spin: 0,
      inPlay: false,
      inGutter: false,
      visible: true,
      rotAngle: 0
    };
  }

  _createPinRack() {
    const pins = [];
    let id = 1;
    for (let row = 0; row < 4; row++) {
      const count = row + 1;
      const z = BOWLING_LANE.HEADPIN_Z - row * BOWLING_LANE.PIN_SPACING_Z;
      for (let col = 0; col < count; col++) {
        const x = (col - (count - 1) / 2) * BOWLING_LANE.PIN_SPACING_X;
        pins.push({
          id: id++,
          x,
          z,
          vx: 0,
          vz: 0,
          standing: true,
          cleared: false,
          tilt: 0,
          tiltDirX: 0,
          tiltDirZ: -1
        });
      }
    }
    return pins;
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
      x: 0,
      z: 0.9,
      swingTimer: 0,
      swingDuration: 0.45,
      swingPower: 0,
      pose: { pitch: 0, roll: 0, yaw: 0 },
      rolls: [],
      strikeStreak: 0,
      maxMph: 0
    };
  }

  _totalFrames() {
    const entry = Object.values(BOWLING_FORMATS).find((f) => f.id === this.format);
    return entry ? entry.frames : 5;
  }

  _resetTransientState() {
    this.lastCallout = null;
    this.lastShotMph = 0;
    this.cameraImpulse = 0;
    this._pinHitSoundCooldown = 0;
    this._rollKnockCount = 0;
  }

  setConfig({ format, difficulty }) {
    if (format && Object.values(BOWLING_FORMATS).some((f) => f.id === format)) {
      this.format = format;
    }
    if (difficulty && Object.values(CPU_DIFFICULTIES).includes(difficulty)) {
      this.difficulty = difficulty;
    }
    this._syncActivePlayers();
    if (this.phase === BOWLING_PHASE.LOBBY) {
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
    this._syncActivePlayers();
  }

  _syncActivePlayers() {
    const humanSeats = this.players.filter((p) => p.isHuman).map((p) => p.seat);
    const activeSet = new Set(humanSeats);
    // Guarantee at least 2 bowlers (add CPU rival when 0 or 1 human)
    for (const fallbackSeat of [0, 1]) {
      if (activeSet.size >= 2) break;
      activeSet.add(fallbackSeat);
    }

    this.turnOrder = [...activeSet].sort((a, b) => a - b);
    for (const p of this.players) {
      p.active = activeSet.has(p.seat);
      if (!p.isHuman) {
        const diffLabel = this.difficulty === CPU_DIFFICULTIES.CHAMPION ? 'PRO+' : 'CPU';
        p.name = `${diffLabel} ${p.seat + 1}`;
      }
    }
  }

  _setupLobbyPositions() {
    this._syncActivePlayers();
    this.pins = this._createPinRack();
    this.ball = this._createBall();
    for (const p of this.players) {
      p.x = (p.seat - 1.5) * 0.48;
      p.z = 1.2;
      p.swingTimer = 0;
    }
  }

  startMatch() {
    this._syncActivePlayers();
    this._resetTransientState();
    this.currentFrame = 0;
    this.turnIdx = 0;
    this.winnerSeat = -1;
    this.winnerSeats = [];

    for (const p of this.players) {
      p.rolls = [];
      p.strikeStreak = 0;
      p.maxMph = 0;
      p.swingTimer = 0;
    }

    this._emit('match_start', { gameId: this.gameId, format: this.format });
    this._prepareTurn(true);
  }

  returnToLobby() {
    this.phase = BOWLING_PHASE.LOBBY;
    this.winnerSeat = -1;
    this.winnerSeats = [];
    this._resetTransientState();
    this._setupLobbyPositions();
  }

  _activeSeat() {
    return this.turnOrder[this.turnIdx] ?? 0;
  }

  _prepareTurn(resetPins = true, resetFrame = true) {
    this.phase = BOWLING_PHASE.AIMING;
    this.phaseTimer = 0;
    this._rollKnockCount = 0;

    if (resetFrame) {
      this.currentRoll = 1;
      this.frameRolls = [];
    }
    if (resetPins) {
      this.pins = this._createPinRack();
    } else {
      // Clear already fallen pins before Roll 2/3
      for (const pin of this.pins) {
        if (!pin.standing) pin.cleared = true;
      }
    }

    const seat = this._activeSeat();
    const bowler = this.players[seat];
    this.aimX = bowler?.handedness === 'left' ? -0.08 : 0.08;
    this.aimAngle = 0;
    this.previewSpin = bowler?.handedness === 'left' ? 0.25 : -0.25;

    this._snapBallToBowler();
    this._aiThinkTimer = AI_BOWL_PROFILES[this.difficulty].thinkTime;

    this._emit('turn_ready', {
      seat,
      frame: this.currentFrame + 1,
      roll: this.currentRoll
    });
  }

  _snapBallToBowler() {
    const seat = this._activeSeat();
    const bowler = this.players[seat];
    if (bowler) {
      bowler.x = this.aimX;
      bowler.z = 0.85;
    }
    this.ball = this._createBall();
    this.ball.x = this.aimX;
    this.ball.z = 0.25;
  }

  // --- Player Input Handlers ---

  handlePose(seat, pose) {
    const p = this.players[seat];
    if (!p || !pose) return;
    p.pose.pitch = clamp(Number(pose.pitch) || 0, -1.5, 1.5);
    p.pose.roll = clamp(Number(pose.roll) || 0, -1.5, 1.5);
    p.pose.yaw = clamp(Number(pose.yaw) || 0, -1.5, 1.5);

    if (this.phase === BOWLING_PHASE.AIMING && seat === this._activeSeat() && p.isHuman) {
      this.aimAngle = clamp(p.pose.roll * 0.2, -0.22, 0.22);
    }
  }

  handleMoveNudge(seat, nudgeX) {
    if (this.phase !== BOWLING_PHASE.AIMING || seat !== this._activeSeat()) return;
    this.aimX = clamp(this.aimX + clamp(Number(nudgeX) || 0, -1, 1) * 0.09, -0.42, 0.42);
    this._snapBallToBowler();
  }

  handleBowlAim(seat, { laneX, aimAngle, spin } = {}) {
    if (this.phase !== BOWLING_PHASE.AIMING || seat !== this._activeSeat()) return false;
    if (typeof laneX === 'number' && Number.isFinite(laneX)) {
      this.aimX = clamp(laneX, -0.42, 0.42);
    }
    if (typeof aimAngle === 'number' && Number.isFinite(aimAngle)) {
      this.aimAngle = clamp(aimAngle, -0.22, 0.22);
    }
    if (typeof spin === 'number' && Number.isFinite(spin)) {
      this.previewSpin = clamp(spin, -1, 1);
    }
    this._snapBallToBowler();
    return true;
  }

  handleSwing(seat, input = {}) {
    return this.handleBowlThrow(seat, {
      power: input.power,
      spin: input.spin,
      aimOffset: input.aim
    });
  }

  handleBowlThrow(seat, input = {}) {
    if (this.phase !== BOWLING_PHASE.AIMING) return false;
    if (seat !== this._activeSeat()) return false;

    const bowler = this.players[seat];
    if (!bowler || !bowler.active) return false;

    const power = clamp(Number(input.power ?? 0.78), 0.3, 1.0);
    const spin = clamp(Number(input.spin ?? this.previewSpin ?? 0), -1, 1);
    const aimOffset = clamp(Number(input.aimOffset ?? 0), -1, 1);
    const launchAngle = clamp(this.aimAngle + aimOffset * 0.14, -0.26, 0.26);

    const speed = 6.2 + power * 4.8; // ~14 to 24.6 mph
    this.ball.x = this.aimX;
    this.ball.y = BOWLING_LANE.BALL_RADIUS;
    this.ball.z = 0.05;
    this.ball.vx = Math.sin(launchAngle) * speed;
    this.ball.vy = 0;
    this.ball.vz = -Math.cos(launchAngle) * speed;
    this.ball.spin = spin;
    this.ball.inPlay = true;
    this.ball.inGutter = false;
    this.ball.visible = true;

    bowler.swingDuration = 0.45;
    bowler.swingTimer = 0.45;
    bowler.swingPower = power;

    const mph = Math.round(clamp(speed * 2.237, 10, 26));
    this.lastShotMph = mph;
    if (mph > bowler.maxMph) bowler.maxMph = mph;

    this.phase = BOWLING_PHASE.ROLLING;
    this.phaseTimer = 0;
    this._rollKnockCount = 0;

    this._emit('bowl_throw', {
      seat,
      frame: this.currentFrame + 1,
      roll: this.currentRoll,
      mph,
      spin,
      laneX: this.aimX,
      aimAngle: launchAngle
    });
    return true;
  }

  // --- Authoritative Fixed-Timestep Simulation ---

  tick(dt) {
    this.step(dt);
  }

  step(dt) {
    const clampedDt = Math.min(dt, 0.05);
    this.clock += clampedDt;
    this.phaseTimer += clampedDt;
    this.cameraImpulse = Math.max(0, this.cameraImpulse - clampedDt * 3.5);
    this._pinHitSoundCooldown = Math.max(0, this._pinHitSoundCooldown - clampedDt);

    for (const p of this.players) {
      if (p.swingTimer > 0) p.swingTimer = Math.max(0, p.swingTimer - clampedDt);
    }

    if (this.phase === BOWLING_PHASE.LOBBY || this.phase === BOWLING_PHASE.MATCH_OVER) {
      return;
    }

    if (this.phase === BOWLING_PHASE.AIMING) {
      const seat = this._activeSeat();
      const bowler = this.players[seat];
      if (bowler && !bowler.isHuman) {
        this._aiThinkTimer -= clampedDt;
        if (this._aiThinkTimer <= 0) {
          this._runAiBowl(bowler);
        }
      }
      return;
    }

    if (this.phase === BOWLING_PHASE.ROLLING) {
      const subSteps = 3;
      const subDt = clampedDt / subSteps;
      for (let s = 0; s < subSteps; s++) {
        this._stepBallAndPins(subDt);
      }

      // Transition to pin_settle once ball enters the pit or times out
      if (this.ball.z < BOWLING_LANE.HEADPIN_Z - 1.55 || this.phaseTimer > 4.2) {
        this.phase = BOWLING_PHASE.PIN_SETTLE;
        this.phaseTimer = 0;
        this.ball.inPlay = false;
      }
      return;
    }

    if (this.phase === BOWLING_PHASE.PIN_SETTLE) {
      this._stepPinsOnly(clampedDt);
      if (this.phaseTimer >= 1.35) {
        this._finalizeRoll();
      }
    }
  }

  _runAiBowl(bowler) {
    const prof = AI_BOWL_PROFILES[this.difficulty];
    // Target standing pins (if Roll 2, aim toward center of remaining standing pins)
    const standing = this.pins.filter((p) => p.standing);
    const avgPinX = standing.length
      ? standing.reduce((sum, p) => sum + p.x, 0) / standing.length
      : 0;

    // Slight pocket offset on full rack
    const pocketBias = standing.length === 10
      ? (bowler.handedness === 'left' ? -0.07 : 0.07)
      : 0;

    const targetX = clamp(avgPinX + pocketBias + (Math.random() - 0.5) * prof.aimSpread * 2, -0.42, 0.42);
    const spin = standing.length === 10
      ? clamp((bowler.handedness === 'left' ? 0.35 : -0.35) + (Math.random() - 0.5) * prof.spinSpread, -0.7, 0.7)
      : (Math.random() - 0.5) * prof.spinSpread;

    // Compensate starting laneX slightly for backend hook
    this.aimX = clamp(targetX - spin * 0.22, -0.42, 0.42);
    this.aimAngle = clamp((targetX - this.aimX) * 0.055, -0.14, 0.14);
    this.previewSpin = spin;
    const power = prof.powerRange[0] + Math.random() * (prof.powerRange[1] - prof.powerRange[0]);

    this.handleBowlThrow(bowler.seat, { power, spin, aimOffset: 0 });
  }

  _stepBallAndPins(dt) {
    const b = this.ball;
    if (b.inPlay) {
      if (!b.inGutter) {
        // Oil-to-dry lane hook: gentle early, sharp snap in dry backend (past 62% of lane)
        const progress = clamp(-b.z / BOWLING_LANE.LENGTH, 0, 1);
        const hookZone = progress > 0.60 ? 1.0 : 0.18;
        b.vx += b.spin * 2.15 * hookZone * dt;
      }

      // Light lane friction
      const drag = Math.exp(-0.028 * dt);
      b.vx *= drag;
      b.vz *= drag;

      b.x += b.vx * dt;
      b.z += b.vz * dt;
      b.rotAngle += Math.hypot(b.vx, b.vz) * dt / BOWLING_LANE.BALL_RADIUS;

      // Check gutter drop before pin deck
      if (!b.inGutter && Math.abs(b.x) > BOWLING_LANE.HALF_WIDTH && b.z > BOWLING_LANE.HEADPIN_Z + 0.35) {
        b.inGutter = true;
        b.spin = 0;
        b.vx = 0;
        b.x = Math.sign(b.x) * (BOWLING_LANE.HALF_WIDTH + BOWLING_LANE.GUTTER_WIDTH * 0.5);
        this._emit('gutter_ball', { seat: this._activeSeat() });
      }
    }

    // Ball-to-Pin collisions (disabled if ball dropped into gutter)
    if (b.inPlay && !b.inGutter) {
      const minDist = BOWLING_LANE.BALL_RADIUS + BOWLING_LANE.PIN_RADIUS;
      for (const pin of this.pins) {
        if (pin.cleared) continue;
        const dx = pin.x - b.x;
        const dz = pin.z - b.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.0001 && dist < minDist) {
          const nx = dx / dist;
          const nz = dz / dist;
          const ballSpeed = Math.hypot(b.vx, b.vz);
          // Transfer strong forward + radial scatter impulse to pin
          const impulse = Math.max(4.5, ballSpeed * 1.15);
          pin.vx += nx * impulse + b.vx * 0.28 + b.spin * 0.6;
          pin.vz += nz * impulse + b.vz * 0.25;
          this._knockPin(pin, pin.vx, pin.vz);

          // Slight ball deflection
          b.vx -= nx * 0.24;
          b.vz *= 0.965;
          this.cameraImpulse = Math.max(this.cameraImpulse, clamp(ballSpeed / 14, 0.25, 0.85));
        }
      }
    }

    this._stepPinsOnly(dt);
  }

  _stepPinsOnly(dt) {
    // Move falling pins and resolve Pin-to-Pin chain collisions!
    const pinMinDist = BOWLING_LANE.PIN_RADIUS * 2.35;
    for (let i = 0; i < this.pins.length; i++) {
      const p = this.pins[i];
      if (p.cleared || p.standing) continue;

      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.vx *= Math.exp(-1.9 * dt);
      p.vz *= Math.exp(-1.9 * dt);
      p.tilt = Math.min(1, p.tilt + dt * 3.8);

      const speed = Math.hypot(p.vx, p.vz);
      if (speed > 0.7) {
        for (let j = 0; j < this.pins.length; j++) {
          if (i === j) continue;
          const other = this.pins[j];
          if (other.cleared) continue;
          const dx = other.x - p.x;
          const dz = other.z - p.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.0001 && dist < pinMinDist) {
            const nx = dx / dist;
            const nz = dz / dist;
            // Ensure chain reaction scatters neighboring pins naturally
            const transfer = Math.max(2.6, speed * 0.78);
            other.vx += nx * transfer + (Math.random() - 0.5) * 0.55;
            other.vz += nz * transfer - 0.45;
            if (other.standing) {
              this._knockPin(other, other.vx, other.vz);
            }
            p.vx *= 0.65;
            p.vz *= 0.65;
          }
        }
      }
    }
  }

  _knockPin(pin, dirX, dirZ) {
    if (!pin.standing) return;
    pin.standing = false;
    this._rollKnockCount++;
    const mag = Math.hypot(dirX, dirZ) || 1;
    pin.tiltDirX = dirX / mag;
    pin.tiltDirZ = dirZ / mag;

    if (this._pinHitSoundCooldown <= 0) {
      this._pinHitSoundCooldown = 0.09;
      this._emit('pin_hit', {
        pinId: pin.id,
        intensity: clamp(mag / 9, 0.35, 1.0),
        x: pin.x,
        z: pin.z
      });
    }
  }

  _finalizeRoll() {
    const seat = this._activeSeat();
    const bowler = this.players[seat];
    const knocked = this._rollKnockCount;
    const totalFrames = this._totalFrames();
    const isFinalFrame = this.currentFrame === totalFrames - 1;

    bowler.rolls.push(knocked);
    this.frameRolls.push(knocked);

    const standingRemaining = this.pins.filter((p) => p.standing).length;
    const hadFullRack = this.currentRoll === 1 ||
      (isFinalFrame && this.currentRoll === 2 && this.frameRolls[0] === 10) ||
      (isFinalFrame && this.currentRoll === 3 && (this.frameRolls[1] === 10 || (this.frameRolls[0] < 10 && this.frameRolls[0] + this.frameRolls[1] === 10)));
    const isStrike = knocked === 10 && hadFullRack;
    const isSpare = (!isStrike && this.currentRoll === 2 && this.frameRolls[0] < 10 && this.frameRolls[0] + this.frameRolls[1] === 10) ||
      (!isStrike && isFinalFrame && this.currentRoll === 3 && this.frameRolls[0] === 10 && this.frameRolls[1] < 10 && this.frameRolls[1] + knocked === 10);

    if (isStrike) bowler.strikeStreak++;
    else if (this.currentRoll === 1) bowler.strikeStreak = 0;

    if (this.ball.inGutter && knocked === 0) {
      this._triggerCallout('GUTTER BALL!', 'fault');
    } else if (isStrike) {
      const label = bowler.strikeStreak >= 3 ? 'TURKEY! 🔥' : (bowler.strikeStreak === 2 ? 'DOUBLE STRIKE!' : 'STRIKE! ⚡');
      this._triggerCallout(label, 'ace');
      this.cameraImpulse = 1.0;
    } else if (isSpare) {
      this._triggerCallout('SPARE! ✨', 'winner');
    } else if (knocked === 0) {
      this._triggerCallout('MISS!', 'info');
    } else {
      this._triggerCallout(`${knocked} PIN${knocked === 1 ? '' : 'S'}!`, 'info');
    }

    this._emit('roll_over', {
      seat,
      frame: this.currentFrame + 1,
      roll: this.currentRoll,
      knocked,
      isStrike,
      isSpare,
      strikeStreak: bowler.strikeStreak
    });

    // Decide whether bowler rolls again in this frame or advances turn
    let frameComplete = false;
    let resetPinsForNextRoll = false;

    if (!isFinalFrame) {
      if (this.currentRoll === 1 && knocked < 10) {
        this.currentRoll = 2;
      } else {
        frameComplete = true;
      }
    } else {
      // Final frame bonus-roll logic
      if (this.currentRoll === 1) {
        this.currentRoll = 2;
        if (knocked === 10) resetPinsForNextRoll = true;
      } else if (this.currentRoll === 2) {
        const firstTwo = this.frameRolls[0] + this.frameRolls[1];
        if (this.frameRolls[0] === 10 || firstTwo === 10) {
          this.currentRoll = 3;
          if (standingRemaining === 0) resetPinsForNextRoll = true;
        } else {
          frameComplete = true;
        }
      } else {
        frameComplete = true;
      }
    }

    if (!frameComplete) {
      this._prepareTurn(resetPinsForNextRoll, false);
      return;
    }

    // Advance to next bowler or next frame
    this.turnIdx++;
    if (this.turnIdx >= this.turnOrder.length) {
      this.turnIdx = 0;
      this.currentFrame++;
    }

    if (this.currentFrame >= totalFrames) {
      this._finishMatch();
      return;
    }

    this._prepareTurn(true);
  }

  _finishMatch() {
    this.phase = BOWLING_PHASE.MATCH_OVER;
    this.phaseTimer = 0;
    const totalFrames = this._totalFrames();

    const standings = this.turnOrder
      .map((seat) => {
        const p = this.players[seat];
        const scored = computeBowlingScore(p.rolls, totalFrames);
        return {
          seat,
          name: p.name,
          color: p.color,
          total: scored.total,
          strikes: scored.strikes,
          spares: scored.spares,
          maxMph: p.maxMph
        };
      })
      .sort((a, b) => b.total - a.total);

    const bestScore = standings[0]?.total ?? 0;
    this.winnerSeats = standings.filter((s) => s.total === bestScore).map((s) => s.seat);
    this.winnerSeat = this.winnerSeats[0] ?? 0;

    const headline = this.winnerSeats.length > 1
      ? `TIE GAME — ${bestScore} PTS!`
      : `${standings[0].name.toUpperCase()} WINS! (${bestScore})`;
    this._triggerCallout(headline, 'match_win');

    this._emit('match_over', {
      gameId: this.gameId,
      winnerSeat: this.winnerSeat,
      winnerSeats: this.winnerSeats,
      standings
    });
  }

  _triggerCallout(text, kind) {
    this.lastCallout = { text, kind, at: this.clock };
  }

  _emit(type, payload) {
    this.onEvent({ type, ...payload, clock: this.clock });
  }

  getSnapshot() {
    const totalFrames = this._totalFrames();
    return {
      gameId: this.gameId,
      clock: Number(this.clock.toFixed(3)),
      phase: this.phase,
      format: this.format,
      totalFrames,
      difficulty: this.difficulty,
      currentFrame: Math.min(this.currentFrame + 1, totalFrames),
      currentRoll: this.currentRoll,
      activeSeat: this._activeSeat(),
      aimX: Number(this.aimX.toFixed(3)),
      aimAngle: Number(this.aimAngle.toFixed(3)),
      previewSpin: Number(this.previewSpin.toFixed(2)),
      lastShotMph: this.lastShotMph,
      winnerSeat: this.winnerSeat,
      winnerSeats: this.winnerSeats,
      cameraImpulse: Number(this.cameraImpulse.toFixed(3)),
      callout: this.lastCallout && (this.clock - this.lastCallout.at < 2.4) ? this.lastCallout : null,
      ball: {
        x: Number(this.ball.x.toFixed(3)),
        y: Number(this.ball.y.toFixed(3)),
        z: Number(this.ball.z.toFixed(3)),
        vx: Number(this.ball.vx.toFixed(2)),
        vy: Number(this.ball.vy.toFixed(2)),
        vz: Number(this.ball.vz.toFixed(2)),
        spin: Number(this.ball.spin.toFixed(2)),
        inPlay: this.ball.inPlay,
        inGutter: this.ball.inGutter,
        visible: this.ball.visible,
        rotAngle: Number(this.ball.rotAngle.toFixed(2))
      },
      pins: this.pins.map((pin) => ({
        id: pin.id,
        x: Number(pin.x.toFixed(3)),
        z: Number(pin.z.toFixed(3)),
        standing: pin.standing,
        cleared: pin.cleared,
        tilt: Number(pin.tilt.toFixed(2)),
        tiltDirX: Number(pin.tiltDirX.toFixed(2)),
        tiltDirZ: Number(pin.tiltDirZ.toFixed(2))
      })),
      players: this.players.map((p) => {
        const scored = computeBowlingScore(p.rolls, totalFrames);
        return {
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
          swingTimer: Number(p.swingTimer.toFixed(3)),
          swingDuration: p.swingDuration,
          swingPower: Number(p.swingPower.toFixed(2)),
          pose: p.pose,
          rolls: p.rolls,
          frames: scored.frames,
          totalScore: scored.total,
          strikes: scored.strikes,
          spares: scored.spares,
          maxMph: p.maxMph
        };
      })
    };
  }
}
