import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateQRMatrix } from '../public/js/qr.js';
import { SwingDetector } from '../public/js/motion-controller.js';
import { CourtRenderer } from '../public/js/court-renderer.js';
import { TennisEngine } from '../server/tennis-engine.js';

describe('ISO 18004 QR Code Generator', () => {
  it('generates valid QR matrices with finder patterns, timing strips, and dark module across versions 1..6', () => {
    const samples = [
      'http://x.co/A1',                                               // v1
      'http://192.168.1.42:3000/play?room=W7K2',                      // v3
      'https://192.168.1.142:3443/controller.html?room=ACE9&airplay=1' // v4
    ];

    for (const text of samples) {
      const qr = generateQRMatrix(text);
      const n = qr.size;
      assert.equal(qr.modules.length, n);
      assert.equal(qr.modules[0].length, n);

      // Verify top-left, top-right, and bottom-left 7x7 finder outer border & 3x3 center
      const checkFinder = (r0, c0) => {
        for (let r = 0; r < 7; r++) {
          for (let c = 0; c < 7; c++) {
            const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
            const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
            assert.equal(qr.modules[r0 + r][c0 + c], onBorder || inCenter);
          }
        }
      };
      checkFinder(0, 0);
      checkFinder(0, n - 7);
      checkFinder(n - 7, 0);

      // Verify fixed dark module at (n - 8, 8)
      assert.equal(qr.modules[n - 8][8], true);

      // Verify alternating timing pattern on row 6 and col 6
      for (let i = 8; i < n - 8; i++) {
        assert.equal(qr.modules[6][i], i % 2 === 0);
        assert.equal(qr.modules[i][6], i % 2 === 0);
      }
    }
  });
});

describe('IMU SwingDetector classification and debouncing', () => {
  it('detects upward flick as serve toss when isServeReady is true', () => {
    const det = new SwingDetector({ handedness: 'right' });
    const res = det.processSample({
      t: 1000, ax: 1, ay: 13.5, az: 2, hasLinear: true, gx: 0, gy: 0, gz: 0, isServeReady: true
    });
    assert.ok(res);
    assert.equal(res.kind, 'toss');
  });

  it('classifies forehand vs backhand, topspin vs slice, lob vs smash, and enforces cooldown', () => {
    const det = new SwingDetector({ handedness: 'right', cooldownMs: 250, peakWindowMs: 50 });

    // 1. Right-handed forehand topspin whip (-ax, positive wrist roll +gy)
    assert.equal(det.processSample({ t: 1000, ax: -14, ay: 3, az: 4, hasLinear: true, gx: 0, gy: 240, gz: -180 }), null);
    assert.equal(det.processSample({ t: 1020, ax: -24, ay: 5, az: 6, hasLinear: true, gx: 0, gy: 320, gz: -260 }), null);
    const fh = det.processSample({ t: 1060, ax: -10, ay: 2, az: 2, hasLinear: true, gx: 0, gy: 120, gz: -90 });
    assert.ok(fh);
    assert.equal(fh.kind, 'swing');
    assert.equal(fh.side, 'forehand');
    assert.ok(fh.spin > 0.4, `expected topspin > 0.4, got ${fh.spin}`);
    assert.ok(fh.power > 0.55);

    // Follow-through inside 250ms cooldown MUST NOT double-trigger!
    assert.equal(det.processSample({ t: 1120, ax: 22, ay: 0, az: 0, hasLinear: true, gx: 0, gy: 0, gz: 200 }), null);
    assert.equal(det.processSample({ t: 1200, ax: 22, ay: 0, az: 0, hasLinear: true, gx: 0, gy: 0, gz: 200 }), null);

    // 2. After cooldown, upward scoop -> Lob
    det.processSample({ t: 1500, ax: 3, ay: 18, az: 2, hasLinear: true, gx: 150, gy: 0, gz: 0 });
    const lob = det.processSample({ t: 1560, ax: 2, ay: 14, az: 1, hasLinear: true, gx: 120, gy: 0, gz: 0 });
    assert.ok(lob);
    assert.equal(lob.elevation, 'lob');

    // 3. After cooldown, sharp downward chop -> Smash
    det.processSample({ t: 2000, ax: -5, ay: -22, az: 6, hasLinear: true, gx: -360, gy: 80, gz: 0 });
    const smash = det.processSample({ t: 2060, ax: -4, ay: -18, az: 4, hasLinear: true, gx: -280, gy: 60, gz: 0 });
    assert.ok(smash);
    assert.equal(smash.elevation, 'smash');
  });

  it('filters static gravity when device lacks linear acceleration', () => {
    const det = new SwingDetector({ handedness: 'left' });
    // Holding phone completely still with 9.81 m/s^2 gravity on Z should NEVER trigger a swing!
    for (let t = 0; t < 2000; t += 20) {
      const res = det.processSample({ t, ax: 0, ay: 0, az: 9.81, hasLinear: false, gx: 0, gy: 0, gz: 0 });
      assert.equal(res, null);
    }
  });
});

describe('CourtRenderer 3D projection and canvas render pass', () => {
  it('renders full stadium, players, net, ball trail, and HUD without errors', () => {
    let drawCalls = 0;
    const noopGrad = { addColorStop() {} };
    const mockCtx = new Proxy({
      measureText: (t) => ({ width: String(t).length * 10 }),
      createLinearGradient: () => noopGrad,
      createRadialGradient: () => noopGrad
    }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => { drawCalls++; };
      }
    });
    const mockCanvas = { width: 1280, height: 720, getContext: () => mockCtx };

    const engine = new TennisEngine();
    engine.setSeatPlayer(0, { isHuman: true, clientId: 'p1', name: 'P1' });
    engine.startMatch();
    engine.handleToss(0);
    for (let i = 0; i < 33; i++) engine.tick(1 / 60);
    engine.handleSwing(0, { power: 0.9, spin: 0.5, aim: 0 });
    for (let i = 0; i < 15; i++) engine.tick(1 / 60);

    const renderer = new CourtRenderer(mockCanvas, { showEmbeddedHud: true });
    renderer.setRoomCode('ACE7');
    renderer.updateState(engine.getSnapshot());
    renderer.handleGameEvent({ type: 'ball_hit', x: 0, y: 1.5, z: 5, shotType: 'smash', sweetSpot: true });
    renderer.render(1 / 60);

    assert.ok(drawCalls > 150, `Expected substantial 3D stadium + actor draw calls, got ${drawCalls}`);

    // Verify full 3D tennis court frames cleanly inside 1280x720 viewport
    const center = renderer.project(0, 0, 0, 1280, 720);
    const farBase = renderer.project(0, 0, -11.885, 1280, 720);
    const nearLeft = renderer.project(-5.485, 0, 11.885, 1280, 720);
    const nearRight = renderer.project(5.485, 0, 11.885, 1280, 720);
    assert.ok(center && center.x > 500 && center.x < 780 && center.y > 280 && center.y < 460, `center=${JSON.stringify(center)}`);
    assert.ok(farBase && farBase.y > 160 && farBase.y < center.y, `farBase=${JSON.stringify(farBase)}`);
    assert.ok(nearLeft && nearLeft.x > 100 && nearLeft.x < 640 && nearLeft.y > center.y && nearLeft.y < 700, `nearLeft=${JSON.stringify(nearLeft)}`);
    assert.ok(nearRight && nearRight.x > 640 && nearRight.x < 1180 && nearRight.y > center.y && nearRight.y < 700, `nearRight=${JSON.stringify(nearRight)}`);
  });
});
