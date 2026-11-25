// Shared protocol, court dimensions, physics constants, and message types
// Imported by both the Node.js authoritative server and browser clients.

export const CAST_NAMESPACE = 'urn:x-cast:com.pocketparty.tennis';

export const COURT = {
  // Standard tennis court dimensions in meters (origin at court center on ground)
  // X: left (-) to right (+), Y: up (+), Z: far baseline (-) to near baseline (+)
  HALF_LENGTH: 11.885,
  SINGLES_HALF_WIDTH: 4.115,
  DOUBLES_HALF_WIDTH: 5.485,
  SERVICE_LINE_Z: 6.40,
  NET_CENTER_HEIGHT: 0.914,
  NET_POST_HEIGHT: 1.07,
  NET_POST_X: 6.1,
  OUTER_HALF_WIDTH: 9.2,
  OUTER_HALF_LENGTH: 17.5,
  BALL_RADIUS: 0.034
};

export const MATCH_MODES = {
  SINGLES: 'singles', // 1v1 (up to 2 humans, rest CPU)
  DOUBLES: 'doubles'  // 2v2 (up to 4 humans, rest CPU)
};

export const MATCH_FORMATS = {
  ONE_GAME: { id: 'one_game', label: '1 Game (Quick Match)', gamesToWin: 1 },
  BEST_OF_3: { id: 'best_of_3', label: 'Best of 3 Games', gamesToWin: 2 },
  BEST_OF_5: { id: 'best_of_5', label: 'Best of 5 Games', gamesToWin: 3 }
};

export const CPU_DIFFICULTIES = {
  ROOKIE: 'rookie',
  PRO: 'pro',
  CHAMPION: 'champion'
};

export const SHOT_TYPES = {
  DRIVE: 'drive',
  TOPSPIN: 'topspin',
  SLICE: 'slice',
  LOB: 'lob',
  SMASH: 'smash',
  SERVE: 'serve',
  ROCKET_SERVE: 'rocket_serve',
  VOLLEY: 'volley'
};

export const TEAMS = {
  BLUE: 0, // Near side (+Z) — classic player perspective
  RED: 1   // Far side (-Z)
};

export const SEAT_DEFS = [
  // Seat 0: Blue Back (Near Baseline)
  { seat: 0, team: TEAMS.BLUE, role: 'back', defaultName: 'Player 1', color: '#2563eb', accent: '#60a5fa', visor: '#ffffff' },
  // Seat 1: Red Back (Far Baseline)
  { seat: 1, team: TEAMS.RED, role: 'back', defaultName: 'Player 2', color: '#dc2626', accent: '#f87171', visor: '#fef08a' },
  // Seat 2: Blue Front (Near Net in Doubles)
  { seat: 2, team: TEAMS.BLUE, role: 'front', defaultName: 'Player 3', color: '#0891b2', accent: '#22d3ee', visor: '#ffffff' },
  // Seat 3: Red Front (Far Net in Doubles)
  { seat: 3, team: TEAMS.RED, role: 'front', defaultName: 'Player 4', color: '#ea580c', accent: '#fb923c', visor: '#fef08a' }
];

export const PHASE = {
  LOBBY: 'lobby',
  SERVE_READY: 'serve_ready',
  SERVE_TOSS: 'serve_toss',
  RALLY: 'rally',
  POINT_OVER: 'point_over',
  GAME_OVER: 'game_over',
  MATCH_OVER: 'match_over'
};

export const MSG = {
  // Client -> Server
  CREATE_ROOM: 'create_room',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  UPDATE_CONFIG: 'update_config',
  SELECT_SEAT: 'select_seat',
  UPDATE_PROFILE: 'update_profile',
  START_MATCH: 'start_match',
  REMATCH: 'rematch',
  RETURN_LOBBY: 'return_lobby',
  SWING: 'swing',
  TOSS: 'toss',
  POSE: 'pose',
  MOVE_NUDGE: 'move_nudge',
  PING: 'ping',
  CAST_STATUS: 'cast_status',

  // Server -> Client
  WELCOME: 'welcome',
  ROOM_STATE: 'room_state',
  GAME_STATE: 'game_state',
  GAME_EVENT: 'game_event',
  HAPTIC: 'haptic',
  PONG: 'pong',
  ERROR: 'error'
};

export const POINT_LABELS = ['0', '15', '30', '40', 'AD'];

export function formatScore(pointsBlue, pointsRed) {
  if (pointsBlue >= 3 && pointsRed >= 3) {
    if (pointsBlue === pointsRed) return { blue: '40', red: '40', call: 'DEUCE' };
    if (pointsBlue > pointsRed) return { blue: 'AD', red: '40', call: 'ADVANTAGE BLUE' };
    return { blue: '40', red: 'AD', call: 'ADVANTAGE RED' };
  }
  return {
    blue: POINT_LABELS[Math.min(pointsBlue, 3)],
    red: POINT_LABELS[Math.min(pointsRed, 3)],
    call: null
  };
}

export function netHeightAt(x) {
  const ratio = Math.min(1, Math.abs(x) / COURT.NET_POST_X);
  return COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * (ratio * ratio);
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
