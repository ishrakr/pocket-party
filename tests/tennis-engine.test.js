import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TennisEngine } from '../server/tennis-engine.js';
import { PHASE, SHOT_TYPES, MATCH_MODES, MATCH_FORMATS, TEAMS, formatScore } from '../shared/protocol.js';

function advance(engine, seconds, stepDt = 1 / 60) {
  const steps = Math.round(seconds / stepDt);
  for (let i = 0; i < steps; i++) {
    engine.tick(stepDt);
  }
}

describe('TennisEngine physics, serves, scoring, and AI', () => {
  it('tosses ball and resets cleanly without fault if server does not swing', () => {
    const engine = new TennisEngine();
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.startMatch();
    assert.equal(engine.phase, PHASE.SERVE_READY);

    assert.equal(engine.handleToss(0), true);
    assert.equal(engine.phase, PHASE.SERVE_TOSS);

    // Let ball rise and fall unhit
    advance(engine, 1.5);
    assert.equal(engine.phase, PHASE.SERVE_READY);
    assert.equal(engine.faultCount, 0);
  });

  it('executes a Rocket Serve at golden apex that clears the net and bounces inside the diagonal service box', () => {
    const events = [];
    const engine = new TennisEngine({ onEvent: (e) => events.push(e) });
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.setSeatPlayer(1, { isHuman: true, clientId: 'p2', name: 'Bob' });
    engine.startMatch();

    engine.handleToss(0);
    // Advance right to apex (~0.55s)
    advance(engine, 0.55);
    assert.ok(engine.ball.y > 2.5, `expected ball near apex, got y=${engine.ball.y}`);
    assert.ok(engine.ball.sweetSpotWindow > 0.7, `expected sweetSpotWindow > 0.7, got ${engine.ball.sweetSpotWindow}`);

    const hit = engine.handleSwing(0, { power: 0.9, spin: 0.4, aim: 0 });
    assert.equal(hit, true);
    assert.equal(engine.phase, PHASE.RALLY);
    assert.equal(engine.ball.shotType, SHOT_TYPES.ROCKET_SERVE);

    // Simulate until first bounce
    advance(engine, 0.9);
    const bounce = events.find((e) => e.type === 'ball_bounce');
    assert.ok(bounce, 'expected serve ball to bounce on court');
    assert.equal(bounce.inBounds, true, `serve should land in diagonal service box, bounced at (${bounce.x}, ${bounce.z})`);
  });

  it('supports human rally exchange with lob and smash shots', () => {
    const events = [];
    const engine = new TennisEngine({ onEvent: (e) => events.push(e) });
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1' });
    engine.setSeatPlayer(1, { isHuman: true, clientId: 'p2' });
    engine.startMatch();

    // P1 serves
    engine.handleToss(0);
    advance(engine, 0.55);
    engine.handleSwing(0, { power: 0.7, spin: 0.2, aim: 0 });

    // Advance until serve bounces on Red's side and reaches P2
    let p2Returned = false;
    for (let i = 0; i < 160; i++) {
      engine.tick(1 / 60);
      const b = engine.ball;
      const p2 = engine.players[1];
      if (b.bounces === 1 && Math.hypot(b.x - p2.x, b.z - p2.z) < 2.2) {
        engine.handleSwing(1, { power: 0.65, spin: 0.2, aim: 0, elevation: 'lob' });
        p2Returned = true;
        break;
      }
    }
    assert.equal(p2Returned, true, 'P2 should return the serve');
    assert.equal(engine.ball.shotType, SHOT_TYPES.LOB);
    assert.equal(engine.rallyCount, 1);

    // Verify ball clears high over the net
    let maxY = 0;
    for (let i = 0; i < 90; i++) {
      engine.tick(1 / 60);
      if (engine.ball.y > maxY) maxY = engine.ball.y;
    }
    assert.ok(maxY > 3.2, `expected high lob apex > 3.2m, got ${maxY.toFixed(2)}m`);
  });

  it('enforces Deuce, Advantage, Game Win, and Best-of-3 Match Win rules', () => {
    const engine = new TennisEngine({ format: MATCH_FORMATS.BEST_OF_3.id });
    engine.startMatch();

    // Reach 40-40 (Deuce)
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    engine._awardPoint(TEAMS.RED, 'P', 'winner');
    engine._awardPoint(TEAMS.RED, 'P', 'winner');
    engine._awardPoint(TEAMS.RED, 'P', 'winner');

    let sc = formatScore(engine.points[0], engine.points[1]);
    assert.equal(sc.call, 'DEUCE');
    assert.equal(sc.blue, '40');
    assert.equal(sc.red, '40');

    // Advantage Blue
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    sc = formatScore(engine.points[0], engine.points[1]);
    assert.equal(sc.blue, 'AD');
    assert.equal(sc.call, 'ADVANTAGE BLUE');

    // Back to Deuce
    engine._awardPoint(TEAMS.RED, 'P', 'winner');
    sc = formatScore(engine.points[0], engine.points[1]);
    assert.equal(sc.call, 'DEUCE');

    // Blue wins Game 1 (2 straight points)
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    assert.equal(engine.phase, PHASE.GAME_OVER);
    assert.deepEqual(engine.games, [1, 0]);

    // Advance past game-over pause -> server rotates to seat 1
    advance(engine, 3.2);
    assert.equal(engine.serverSeat, 1);

    // Blue wins Game 2 -> Match Over!
    for (let i = 0; i < 4; i++) engine._awardPoint(TEAMS.BLUE, 'P', 'winner');
    assert.equal(engine.phase, PHASE.MATCH_OVER);
    assert.equal(engine.winnerTeam, TEAMS.BLUE);
    assert.deepEqual(engine.games, [2, 0]);
  });

  it('auto-enables Doubles mode when a human takes Seat 2 or 3 and simulates a complete AI Doubles match cleanly', () => {
    const engine = new TennisEngine({ mode: MATCH_MODES.SINGLES, format: MATCH_FORMATS.ONE_GAME.id });
    engine.setSeatPlayer(2, { isHuman: true, clientId: 'p3', name: 'P3' });
    assert.equal(engine.mode, MATCH_MODES.DOUBLES);

    // Switch all 4 seats to CPU to stress-test full autonomous simulation
    engine.setSeatPlayer(2, { isHuman: false, clientId: null });
    engine.startMatch();

    let ticks = 0;
    while (engine.phase !== PHASE.MATCH_OVER && ticks < 60 * 240) {
      engine.tick(1 / 60);
      assert.ok(Number.isFinite(engine.ball.x) && Number.isFinite(engine.ball.y) && Number.isFinite(engine.ball.z));
      ticks++;
    }
    assert.equal(engine.phase, PHASE.MATCH_OVER, 'CPU vs CPU doubles match should complete cleanly');
    assert.ok(engine.winnerTeam === TEAMS.BLUE || engine.winnerTeam === TEAMS.RED);
  });

  it('resets transient flags, callouts, and shot speed on returnToLobby and startMatch', () => {
    const engine = new TennisEngine();
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.startMatch();

    engine.handleToss(0);
    advance(engine, 0.55);
    engine.handleSwing(0, { power: 0.9, spin: 0.4, aim: 0 });
    assert.ok(engine.lastShotMph > 0);

    engine._handleServeFault('FAULT!');
    assert.equal(engine._isSecondServePending, true);
    assert.ok(engine.lastCallout !== null);

    engine.returnToLobby();
    assert.equal(engine.phase, PHASE.LOBBY);
    assert.equal(engine._isLetReplay, false);
    assert.equal(engine._isSecondServePending, false);
    assert.equal(engine.lastCallout, null);
    assert.equal(engine.lastShotMph, 0);
    assert.equal(engine.netWave, 0);
    assert.equal(engine.cameraImpulse, 0);

    engine._isLetReplay = true;
    engine._isSecondServePending = true;
    engine.lastShotMph = 120;
    engine.lastCallout = { text: 'STALE', kind: 'info', at: 99 };
    engine.startMatch();
    assert.equal(engine.phase, PHASE.SERVE_READY);
    assert.equal(engine._isLetReplay, false);
    assert.equal(engine._isSecondServePending, false);
    assert.equal(engine.lastCallout, null);
    assert.equal(engine.lastShotMph, 0);
  });

  it('replays serve on net-cord Let without adding a fault', () => {
    const events = [];
    const engine = new TennisEngine({ onEvent: (e) => events.push(e) });
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.setSeatPlayer(1, { isHuman: true, clientId: 'p2', name: 'Bob' });
    engine.startMatch();

    engine.phase = PHASE.RALLY;
    engine.isServeBall = true;
    engine.lastHitterSeat = 0;
    engine.lastHitterTeam = TEAMS.BLUE;
    engine.faultCount = 0;
    engine.ball.inPlay = true;
    engine.ball.x = 0.2;
    engine.ball.y = 0.85;
    engine.ball.z = 0.08;
    engine.ball.vx = 0;
    engine.ball.vy = 0.5;
    engine.ball.vz = -20;
    engine.ball.spin = 0;

    engine.tick(1 / 60);
    assert.ok(events.some((e) => e.type === 'net_cord'), 'expected net_cord event');
    assert.equal(engine.phase, PHASE.POINT_OVER);
    assert.equal(engine._isLetReplay, true);
    assert.equal(engine.faultCount, 0);

    advance(engine, 1.5);
    assert.equal(engine.phase, PHASE.SERVE_READY);
    assert.equal(engine.faultCount, 0);
    assert.equal(engine.serverSeat, 0);
    assert.equal(engine._isLetReplay, false);
  });
});
