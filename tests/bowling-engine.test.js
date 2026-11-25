import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BowlingEngine, computeBowlingScore } from '../server/bowling-engine.js';
import { BOWLING_FORMATS, BOWLING_PHASE, GAMES } from '../shared/protocol.js';

function advance(engine, seconds, stepDt = 1 / 60) {
  const steps = Math.round(seconds / stepDt);
  for (let i = 0; i < steps; i++) {
    engine.tick(stepDt);
  }
}

describe('BowlingEngine scoring, physics, gutter detection, and AI', () => {
  it('computes authentic 10-pin bowling scores including spares, strikes, and 300 perfect game', () => {
    const perfect = computeBowlingScore(Array(12).fill(10), 10);
    assert.equal(perfect.total, 300);
    assert.equal(perfect.strikes, 12);
    assert.equal(perfect.spares, 0);

    const mixed = computeBowlingScore([10, 10, 10, 7, 3, 8, 1], 5);
    assert.equal(mixed.total, 104);
    assert.equal(mixed.strikes, 3);
    assert.equal(mixed.spares, 1);

    const sprint = computeBowlingScore([10, 10, 8, 2, 10], 3);
    assert.equal(sprint.total, 68);
    assert.equal(sprint.strikes, 3);
    assert.equal(sprint.spares, 1);
  });

  it('knocks down pins cleanly on a pocket throw and advances to next frame or roll', () => {
    const events = [];
    const engine = new BowlingEngine({
      format: BOWLING_FORMATS.QUICK_3.id,
      onEvent: (e) => events.push(e)
    });
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.setSeatPlayer(1, { isHuman: true, clientId: 'p2', name: 'Bob' });
    engine.startMatch();

    assert.equal(engine.gameId, GAMES.BOWLING.id);
    assert.equal(engine.phase, BOWLING_PHASE.AIMING);
    assert.equal(engine._activeSeat(), 0);

    // Direct 1-3 pocket shot at high speed
    engine.handleBowlAim(0, { laneX: 0.08, aimAngle: 0, spin: 0 });
    assert.equal(engine.handleBowlThrow(0, { power: 0.95, spin: 0 }), true);
    assert.equal(engine.phase, BOWLING_PHASE.ROLLING);

    // Simulate ball roll + pin settle
    advance(engine, 4.0);

    const rollOver = events.find((e) => e.type === 'roll_over');
    assert.ok(rollOver, 'expected roll_over event after ball reaches pins');
    assert.ok(rollOver.knocked >= 7, `expected strong pocket hit (>=7 pins), got ${rollOver.knocked}`);
    assert.equal(engine.phase, BOWLING_PHASE.AIMING);
  });

  it('detects gutter balls without knocking down any pins', () => {
    const events = [];
    const engine = new BowlingEngine({
      format: BOWLING_FORMATS.QUICK_3.id,
      onEvent: (e) => events.push(e)
    });
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'Alice' });
    engine.startMatch();

    engine.handleBowlAim(0, { laneX: 0.42, aimAngle: 0.22, spin: 0.6 });
    engine.handleBowlThrow(0, { power: 0.72, spin: 0.6 });
    advance(engine, 4.2);

    assert.ok(events.some((e) => e.type === 'gutter_ball'), 'expected gutter_ball event');
    const rollOver = events.find((e) => e.type === 'roll_over');
    assert.ok(rollOver);
    assert.equal(rollOver.knocked, 0);
  });

  it('simulates a complete CPU vs CPU 3-frame bowling match cleanly', () => {
    const engine = new BowlingEngine({ format: BOWLING_FORMATS.QUICK_3.id });
    engine.startMatch();

    let ticks = 0;
    while (engine.phase !== BOWLING_PHASE.MATCH_OVER && ticks < 60 * 180) {
      engine.tick(1 / 60);
      assert.ok(Number.isFinite(engine.ball.x) && Number.isFinite(engine.ball.z));
      ticks++;
    }

    assert.equal(engine.phase, BOWLING_PHASE.MATCH_OVER);
    assert.ok(engine.winnerSeat === 0 || engine.winnerSeat === 1);
    const snap = engine.getSnapshot();
    assert.equal(snap.gameId, GAMES.BOWLING.id);
    assert.equal(snap.players[0].frames.length, 3);
    assert.equal(snap.players[1].frames.length, 3);
  });
});
