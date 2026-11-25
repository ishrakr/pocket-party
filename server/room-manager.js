// Multiplayer Room Manager: coordinates TV/Cast displays, AirPlay streams, and 1-4 phone controllers.
import {
  MSG,
  PHASE,
  SEAT_DEFS,
  MATCH_MODES,
  MATCH_FORMATS,
  CPU_DIFFICULTIES
} from '../shared/protocol.js';
import { TennisEngine } from './tennis-engine.js';

// Easy-to-read uppercase room alphabet (omits O, 0, I, 1, L to avoid TV/phone typos)
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateRoomCode(existing) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!existing.has(code)) return code;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

export class GameRoom {
  constructor(code, onEmpty) {
    this.code = code;
    this.createdAt = Date.now();
    this.onEmpty = onEmpty;

    this.displays = new Set(); // TV / Chromecast Receiver / Presentation clients
    this.controllers = new Map(); // clientId -> { ws, seat, name, handedness, color, castMethod }
    this.hostClientId = null;
    this.castState = {
      active: false,
      method: null, // 'google_cast' | 'presentation' | 'airplay' | 'tv_browser'
      deviceName: null
    };

    this.engine = new TennisEngine({
      mode: MATCH_MODES.SINGLES,
      format: MATCH_FORMATS.ONE_GAME.id,
      difficulty: CPU_DIFFICULTIES.PRO,
      onEvent: (evt) => this._handleEngineEvent(evt)
    });

    this._lastTick = Date.now();
    this._broadcastCounter = 0;
    this._emptyTimer = null;

    // 60Hz authoritative simulation loop, 30Hz state broadcast
    this._loop = setInterval(() => this._tick(), 1000 / 60);
    this._loop.unref?.();
  }

  _tick() {
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.05);
    this._lastTick = now;

    this.engine.tick(dt);
    this._broadcastCounter++;

    // Broadcast live game state at 30Hz during match, 5Hz during lobby
    const stride = this.engine.phase === PHASE.LOBBY ? 12 : 2;
    if (this._broadcastCounter % stride === 0) {
      this.broadcastGameState();
    }
  }

  _handleEngineEvent(evt) {
    // Forward game event to all displays and controllers (for sound & animations)
    this._broadcastAll({ type: MSG.GAME_EVENT, event: evt });

    // Route targeted phone haptic rumble feedback!
    if (evt.type === 'ball_hit') {
      const controller = this._findControllerBySeat(evt.seat);
      if (controller) {
        const pattern = evt.shotType === 'smash' || evt.shotType === 'rocket_serve'
          ? 'smash'
          : (evt.sweetSpot ? 'sweet_spot' : 'hit');
        controller.ws.sendJSON({ type: MSG.HAPTIC, pattern, shotType: evt.shotType, mph: evt.mph });
      }
    } else if (evt.type === 'serve_toss') {
      const controller = this._findControllerBySeat(evt.seat);
      if (controller) {
        controller.ws.sendJSON({ type: MSG.HAPTIC, pattern: 'toss' });
      }
    } else if (evt.type === 'point_over' || evt.type === 'game_over' || evt.type === 'match_over') {
      for (const ctrl of this.controllers.values()) {
        const p = this.engine.players[ctrl.seat];
        const won = p && p.team === evt.winnerTeam;
        ctrl.ws.sendJSON({
          type: MSG.HAPTIC,
          pattern: evt.type === 'match_over' ? (won ? 'victory' : 'loss') : (won ? 'point_win' : 'point_loss')
        });
      }
    }
  }

  _findControllerBySeat(seat) {
    for (const ctrl of this.controllers.values()) {
      if (ctrl.seat === seat) return ctrl;
    }
    return null;
  }

  addDisplay(ws, meta = {}) {
    this._cancelEmptyTimer();
    ws._roomCode = this.code;
    ws._role = 'display';
    this.displays.add(ws);

    if (meta.castMethod) {
      this.castState = {
        active: true,
        method: meta.castMethod,
        deviceName: meta.deviceName || 'TV Display'
      };
    } else if (!this.castState.active) {
      this.castState = { active: true, method: 'tv_browser', deviceName: 'TV Screen' };
    }

    ws.sendJSON({
      type: MSG.WELCOME,
      role: 'display',
      roomCode: this.code,
      clientId: ws.id
    });
    this.broadcastRoomState();
    this.broadcastGameState();
  }

  addController(ws, meta = {}) {
    this._cancelEmptyTimer();
    const preferredSeat = typeof meta.preferredSeat === 'number' ? meta.preferredSeat : null;
    const seat = this._allocateSeat(preferredSeat);
    if (seat === -1) {
      ws.sendJSON({ type: MSG.ERROR, message: 'Room is full (4/4 players).' });
      return false;
    }

    ws._roomCode = this.code;
    ws._role = 'controller';

    const def = SEAT_DEFS[seat];
    const name = (meta.name && String(meta.name).trim().slice(0, 14)) || def.defaultName;
    const handedness = meta.handedness === 'left' ? 'left' : 'right';
    const color = meta.color || def.color;

    const record = {
      ws,
      clientId: ws.id,
      seat,
      name,
      handedness,
      color,
      joinedAt: Date.now()
    };
    this.controllers.set(ws.id, record);

    if (!this.hostClientId) {
      this.hostClientId = ws.id;
    }

    this.engine.setSeatPlayer(seat, {
      isHuman: true,
      clientId: ws.id,
      name,
      handedness,
      color
    });

    ws.sendJSON({
      type: MSG.WELCOME,
      role: 'controller',
      roomCode: this.code,
      clientId: ws.id,
      seat,
      isHost: this.hostClientId === ws.id
    });

    this.broadcastRoomState();
    this.broadcastGameState();
    return true;
  }

  _allocateSeat(preferredSeat) {
    const taken = new Set([...this.controllers.values()].map((c) => c.seat));
    if (preferredSeat !== null && preferredSeat >= 0 && preferredSeat < 4 && !taken.has(preferredSeat)) {
      return preferredSeat;
    }
    // Natural fill order: P1 (Blue Back), P2 (Red Back), P3 (Blue Front), P4 (Red Front)
    for (const s of [0, 1, 2, 3]) {
      if (!taken.has(s)) return s;
    }
    return -1;
  }

  removeClient(ws) {
    if (this.displays.has(ws)) {
      this.displays.delete(ws);
      if (this.displays.size === 0 && this.castState.method !== 'airplay') {
        this.castState.active = false;
      }
    }

    const ctrl = this.controllers.get(ws.id);
    if (ctrl) {
      this.controllers.delete(ws.id);
      this.engine.setSeatPlayer(ctrl.seat, { isHuman: false, clientId: null });
      if (this.hostClientId === ws.id) {
        const next = this.controllers.values().next().value;
        this.hostClientId = next ? next.clientId : null;
      }
    }

    this.broadcastRoomState();
    this.broadcastGameState();

    if (this.displays.size === 0 && this.controllers.size === 0) {
      this._scheduleEmptyCleanup();
    }
  }

  selectSeat(clientId, targetSeat) {
    const ctrl = this.controllers.get(clientId);
    if (!ctrl) return;
    if (typeof targetSeat !== 'number' || targetSeat < 0 || targetSeat > 3) return;
    if (this.engine.phase !== PHASE.LOBBY) return;

    // Ensure target seat is not occupied by another human
    for (const other of this.controllers.values()) {
      if (other.seat === targetSeat) return;
    }

    const oldSeat = ctrl.seat;
    this.engine.setSeatPlayer(oldSeat, { isHuman: false, clientId: null });
    ctrl.seat = targetSeat;
    const def = SEAT_DEFS[targetSeat];
    ctrl.color = def.color;
    this.engine.setSeatPlayer(targetSeat, {
      isHuman: true,
      clientId: ctrl.clientId,
      name: ctrl.name,
      handedness: ctrl.handedness,
      color: ctrl.color
    });

    this.broadcastRoomState();
    this.broadcastGameState();
  }

  updateProfile(clientId, { name, handedness, color }) {
    const ctrl = this.controllers.get(clientId);
    if (!ctrl) return;
    if (name && String(name).trim()) ctrl.name = String(name).trim().slice(0, 14);
    if (handedness === 'left' || handedness === 'right') ctrl.handedness = handedness;
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) ctrl.color = color;

    this.engine.setSeatPlayer(ctrl.seat, {
      isHuman: true,
      clientId: ctrl.clientId,
      name: ctrl.name,
      handedness: ctrl.handedness,
      color: ctrl.color
    });
    this.broadcastRoomState();
    this.broadcastGameState();
  }

  updateConfig(config) {
    if (this.engine.phase !== PHASE.LOBBY) return;
    // Don't switch back to singles if a human occupies seat 2 or 3
    if (config.mode === MATCH_MODES.SINGLES) {
      for (const c of this.controllers.values()) {
        if (c.seat >= 2) return;
      }
    }
    this.engine.setConfig(config);
    this.broadcastRoomState();
    this.broadcastGameState();
  }

  updateCastStatus(status) {
    this.castState = {
      active: Boolean(status.active),
      method: status.method || this.castState.method,
      deviceName: status.deviceName || null
    };
    this.broadcastRoomState();
  }

  handleMessage(ws, msg) {
    const ctrl = this.controllers.get(ws.id);

    switch (msg.type) {
      case MSG.UPDATE_CONFIG:
        this.updateConfig(msg.config || {});
        break;
      case MSG.SELECT_SEAT:
        this.selectSeat(ws.id, msg.seat);
        break;
      case MSG.UPDATE_PROFILE:
        this.updateProfile(ws.id, msg);
        break;
      case MSG.START_MATCH:
      case MSG.REMATCH:
        this.engine.startMatch();
        this.broadcastRoomState();
        this.broadcastGameState();
        break;
      case MSG.RETURN_LOBBY:
        this.engine.returnToLobby();
        this.broadcastRoomState();
        this.broadcastGameState();
        break;
      case MSG.TOSS:
        if (ctrl) this.engine.handleToss(ctrl.seat);
        break;
      case MSG.SWING:
        if (ctrl) this.engine.handleSwing(ctrl.seat, msg);
        break;
      case MSG.POSE:
        if (ctrl) this.engine.handlePose(ctrl.seat, msg.pose);
        break;
      case MSG.MOVE_NUDGE:
        if (ctrl) this.engine.handleMoveNudge(ctrl.seat, msg.nudgeX);
        break;
      case MSG.CAST_STATUS:
        this.updateCastStatus(msg);
        break;
      case MSG.PING:
        ws.sendJSON({ type: MSG.PONG, t: msg.t, serverTime: Date.now() });
        break;
    }
  }

  getRoomState() {
    const seats = SEAT_DEFS.map((def) => {
      const ctrl = this._findControllerBySeat(def.seat);
      const p = this.engine.players[def.seat];
      return {
        seat: def.seat,
        team: def.team,
        role: def.role,
        active: p.active,
        isHuman: Boolean(ctrl),
        isHost: Boolean(ctrl && ctrl.clientId === this.hostClientId),
        clientId: ctrl ? ctrl.clientId : null,
        name: p.name,
        color: p.color,
        handedness: p.handedness
      };
    });

    return {
      roomCode: this.code,
      phase: this.engine.phase,
      mode: this.engine.mode,
      format: this.engine.format,
      difficulty: this.engine.difficulty,
      displayCount: this.displays.size,
      playerCount: this.controllers.size,
      hostClientId: this.hostClientId,
      castState: this.castState,
      seats
    };
  }

  broadcastRoomState() {
    this._broadcastAll({ type: MSG.ROOM_STATE, room: this.getRoomState() });
  }

  broadcastGameState() {
    this._broadcastAll({ type: MSG.GAME_STATE, state: this.engine.getSnapshot() });
  }

  _broadcastAll(payload) {
    const text = JSON.stringify(payload);
    for (const d of this.displays) {
      d.send(text);
    }
    for (const c of this.controllers.values()) {
      c.ws.send(text);
    }
  }

  _scheduleEmptyCleanup() {
    this._cancelEmptyTimer();
    // Keep empty rooms alive briefly (90s) so casting phone -> TV handoff never loses the room!
    this._emptyTimer = setTimeout(() => {
      if (this.displays.size === 0 && this.controllers.size === 0) {
        this.destroy();
        this.onEmpty?.(this.code);
      }
    }, 90000);
    this._emptyTimer.unref?.();
  }

  _cancelEmptyTimer() {
    if (this._emptyTimer) {
      clearTimeout(this._emptyTimer);
      this._emptyTimer = null;
    }
  }

  destroy() {
    this._cancelEmptyTimer();
    clearInterval(this._loop);
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom(customCode = null) {
    let code = customCode ? String(customCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) : null;
    if (!code || this.rooms.has(code)) {
      code = generateRoomCode(this.rooms);
    }
    const room = new GameRoom(code, (emptyCode) => {
      this.rooms.delete(emptyCode);
    });
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase().trim()) || null;
  }

  getOrCreateRoom(code) {
    const existing = this.getRoom(code);
    if (existing) return existing;
    return this.createRoom(code);
  }

  handleConnection(ws) {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === MSG.PING) {
        ws.sendJSON({ type: MSG.PONG, t: msg.t, serverTime: Date.now() });
        return;
      }

      if (msg.type === MSG.CREATE_ROOM) {
        this._detachClient(ws);
        const room = this.createRoom(msg.roomCode);
        if (msg.role === 'display') {
          room.addDisplay(ws, msg);
        } else {
          room.addController(ws, msg);
        }
        return;
      }

      if (msg.type === MSG.JOIN_ROOM) {
        this._detachClient(ws);
        const code = String(msg.roomCode || '').toUpperCase().trim();
        let room = this.getRoom(code);
        if (!room && msg.createIfMissing) {
          room = this.createRoom(code || null);
        }
        if (!room) {
          ws.sendJSON({ type: MSG.ERROR, message: `Room "${code}" not found. Check the TV code!` });
          return;
        }
        if (msg.role === 'display') {
          room.addDisplay(ws, msg);
        } else {
          room.addController(ws, msg);
        }
        return;
      }

      if (msg.type === MSG.LEAVE_ROOM) {
        this._detachClient(ws);
        return;
      }

      const room = this.getRoom(ws._roomCode);
      if (room) {
        room.handleMessage(ws, msg);
      }
    });

    ws.on('close', () => {
      this._detachClient(ws);
    });
  }

  _detachClient(ws) {
    if (!ws._roomCode) return;
    const room = this.getRoom(ws._roomCode);
    ws._roomCode = null;
    if (room) {
      room.removeClient(ws);
    }
  }

  closeAll() {
    for (const room of this.rooms.values()) {
      room.destroy();
    }
    this.rooms.clear();
  }
}
