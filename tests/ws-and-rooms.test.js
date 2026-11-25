import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server/index.js';
import { MSG, MATCH_MODES, PHASE, GAMES, BOWLING_PHASE } from '../shared/protocol.js';

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        inbox.push(msg);
      }
    });

    ws.waitFor = (pred, timeoutMs = 3000) => {
      const existingIdx = inbox.findIndex(pred);
      if (existingIdx !== -1) {
        return Promise.resolve(inbox.splice(existingIdx, 1)[0]);
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('Timed out waiting for WS message')), timeoutMs);
        waiters.push({ pred, resolve: res, timer });
      });
    };

    ws.sendJSON = (obj) => ws.send(JSON.stringify(obj));

    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (err) => reject(err));
  });
}

describe('HTTP/HTTPS Server, RFC 6455 WebSockets & 4-Player Multiplayer Rooms', () => {
  let server;
  let httpPort;
  let httpsPort;

  after(async () => {
    if (server) await server.stop();
  });

  it('starts HTTP + auto-generated HTTPS server and serves API and static routes', async () => {
    server = createAppServer({ port: 0, httpsPort: 0, https: true });
    const ports = await server.start();
    httpPort = ports.httpPort;
    httpsPort = ports.httpsPort;

    assert.ok(httpPort > 0);
    assert.ok(httpsPort > 0);

    const cfgRes = await fetch(`http://127.0.0.1:${httpPort}/api/config`);
    assert.equal(cfgRes.status, 200);
    const cfg = await cfgRes.json();
    assert.equal(cfg.httpsEnabled, true);

    const healthRes = await fetch(`http://127.0.0.1:${httpPort}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.app, 'PocketParty');

    const proxyCfgRes = await fetch(`http://127.0.0.1:${httpPort}/api/config`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'pocketparty.example.com'
      }
    });
    assert.equal(proxyCfgRes.status, 200);
    const proxyCfg = await proxyCfgRes.json();
    assert.equal(proxyCfg.joinBaseUrl, 'https://pocketparty.example.com');
    assert.equal(proxyCfg.isPublicDeployment, true);
    assert.equal(proxyCfg.secure, true);

    const routes = ['/', '/tv', '/receiver', '/controller', '/play', '/demo', '/css/styles.css', '/shared/protocol.js', '/js/court-renderer.js', '/js/bowling-renderer.js', '/js/tv-app.js', '/js/controller-app.js', '/js/landing-app.js', '/js/cast-bridge.js', '/js/motion-controller.js', '/js/qr.js', '/js/audio.js', '/js/ws-client.js'];
    for (const r of routes) {
      const res = await fetch(`http://127.0.0.1:${httpPort}${r}`);
      assert.equal(res.status, 200, `Expected 200 OK for ${r}`);
      if (r.endsWith('.js')) {
        const src = await res.text();
        // Verify every static ES import specifier in browser JS resolves to HTTP 200
        for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
          const resolved = new URL(match[1], `http://127.0.0.1:${httpPort}${r}`).pathname;
          const depRes = await fetch(`http://127.0.0.1:${httpPort}${resolved}`);
          assert.equal(depRes.status, 200, `Import "${match[1]}" from ${r} -> ${resolved} failed with ${depRes.status}`);
        }
      }
    }
  });

  it('connects TV display + 4 phone controllers, handles Cast status, seat swap, match start, toss/swing & haptics', async () => {
    const wsUrl = `ws://127.0.0.1:${httpPort}/ws`;

    // 1. TV Display creates a room
    const tv = await openWs(wsUrl);
    tv.sendJSON({ type: MSG.CREATE_ROOM, role: 'display', castMethod: 'google_cast', deviceName: 'Living Room TV' });
    const tvWelcome = await tv.waitFor((m) => m.type === MSG.WELCOME);
    assert.equal(tvWelcome.role, 'display');
    const code = tvWelcome.roomCode;
    assert.equal(code.length, 4);

    // 2. Four phone controllers join the room
    const phones = [];
    for (let i = 0; i < 4; i++) {
      const p = await openWs(wsUrl);
      p.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code, name: `Phone${i + 1}`, handedness: i === 1 ? 'left' : 'right' });
      const w = await p.waitFor((m) => m.type === MSG.WELCOME);
      assert.equal(w.seat, i);
      assert.equal(w.isHost, i === 0);
      phones.push(p);
    }

    // 5th phone should be rejected cleanly (room full)
    const extra = await openWs(wsUrl);
    extra.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code });
    const errMsg = await extra.waitFor((m) => m.type === MSG.ERROR);
    assert.match(errMsg.message, /full/i);
    extra.close();

    // Room should automatically be in Doubles mode with 4 human players
    const roomRes = await fetch(`http://127.0.0.1:${httpPort}/api/rooms/${code}`);
    const roomInfo = await roomRes.json();
    assert.equal(roomInfo.room.mode, MATCH_MODES.DOUBLES);
    assert.equal(roomInfo.room.playerCount, 4);
    assert.equal(roomInfo.room.castState.method, 'google_cast');

    // 3. Ping / Pong latency check
    phones[0].sendJSON({ type: MSG.PING, t: 12345 });
    const pong = await phones[0].waitFor((m) => m.type === MSG.PONG);
    assert.equal(pong.t, 12345);

    // 4. Start match from Phone 1, verify TV receives SERVE_READY, Phone 1 tosses & gets HAPTIC
    phones[0].sendJSON({ type: MSG.START_MATCH });
    const readyState = await tv.waitFor((m) => m.type === MSG.GAME_STATE && m.state.phase === PHASE.SERVE_READY);
    assert.equal(readyState.state.serverSeat, 0);

    phones[0].sendJSON({ type: MSG.TOSS });
    const haptic = await phones[0].waitFor((m) => m.type === MSG.HAPTIC && m.pattern === 'toss');
    assert.equal(haptic.pattern, 'toss');

    // 5. Wait until TV has observed all 4 players, then disconnect Phone 1 -> Host transfers to Phone 2!
    await tv.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.playerCount === 4);
    phones[0].close();
    const updatedRoom = await tv.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.playerCount === 3 && !m.room.seats[0].isHuman);
    assert.equal(updatedRoom.room.seats[0].isHuman, false);
    assert.equal(updatedRoom.room.seats[1].isHost, true);

    tv.close();
    phones.slice(1).forEach((p) => p.close());
  });

  it('broadcasts ROOM_STATE with MATCH_OVER to controllers when a match finishes and preserves preferredSeat on reconnect', async () => {
    const wsUrl = `ws://127.0.0.1:${httpPort}/ws`;

    const tv = await openWs(wsUrl);
    tv.sendJSON({ type: MSG.CREATE_ROOM, role: 'display' });
    const tvWelcome = await tv.waitFor((m) => m.type === MSG.WELCOME);
    const code = tvWelcome.roomCode;

    const p1 = await openWs(wsUrl);
    p1.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code, name: 'P1' });
    const w1 = await p1.waitFor((m) => m.type === MSG.WELCOME);
    assert.equal(w1.seat, 0);

    const p2 = await openWs(wsUrl);
    p2.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code, name: 'P2' });
    const w2 = await p2.waitFor((m) => m.type === MSG.WELCOME);
    assert.equal(w2.seat, 1);

    // Start match and finish it on the authoritative room engine
    p1.sendJSON({ type: MSG.START_MATCH });
    await p1.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.phase === PHASE.SERVE_READY);

    const room = server.roomManager.getRoom(code);
    for (let i = 0; i < 4; i++) {
      room.engine._awardPoint(0, 'ACE!', 'ace');
    }

    const overRoomMsg = await p1.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.phase === PHASE.MATCH_OVER);
    assert.equal(overRoomMsg.room.phase, PHASE.MATCH_OVER);
    const victoryHaptic = await p1.waitFor((m) => m.type === MSG.HAPTIC && m.pattern === 'victory');
    assert.equal(victoryHaptic.pattern, 'victory');

    // Vacate seat 0, then disconnect P2 and reconnect with preferredSeat: 1
    p1.close();
    await tv.waitFor((m) => m.type === MSG.ROOM_STATE && !m.room.seats[0].isHuman);

    p2.close();
    await tv.waitFor((m) => m.type === MSG.ROOM_STATE && !m.room.seats[1].isHuman);

    const p2Reconnect = await openWs(wsUrl);
    p2Reconnect.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code, preferredSeat: 1, name: 'P2' });
    const w2Reconnect = await p2Reconnect.waitFor((m) => m.type === MSG.WELCOME);
    assert.equal(w2Reconnect.seat, 1);

    tv.close();
    p2Reconnect.close();
  });

  it('switches room game to Party Bowling via SELECT_GAME, accepts aim/throw, and broadcasts game state', async () => {
    const wsUrl = `ws://127.0.0.1:${httpPort}/ws`;

    const tv = await openWs(wsUrl);
    tv.sendJSON({ type: MSG.CREATE_ROOM, role: 'display' });
    const tvWelcome = await tv.waitFor((m) => m.type === MSG.WELCOME);
    const code = tvWelcome.roomCode;

    const p1 = await openWs(wsUrl);
    p1.sendJSON({ type: MSG.JOIN_ROOM, role: 'controller', roomCode: code, name: 'Bowler1' });
    await p1.waitFor((m) => m.type === MSG.WELCOME);

    p1.sendJSON({ type: MSG.SELECT_GAME, gameId: GAMES.BOWLING.id });
    const bowlRoom = await tv.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.gameId === GAMES.BOWLING.id);
    assert.equal(bowlRoom.room.gameId, GAMES.BOWLING.id);

    p1.sendJSON({ type: MSG.UPDATE_CONFIG, config: { format: 'quick_3' } });
    const cfgRoom = await tv.waitFor((m) => m.type === MSG.ROOM_STATE && m.room.format === 'quick_3');
    assert.equal(cfgRoom.room.format, 'quick_3');

    p1.sendJSON({ type: MSG.START_MATCH });
    const aimingState = await tv.waitFor((m) => m.type === MSG.GAME_STATE && m.state.gameId === GAMES.BOWLING.id && m.state.phase === BOWLING_PHASE.AIMING);
    assert.equal(aimingState.state.activeSeat, 0);

    p1.sendJSON({ type: MSG.BOWL_AIM, laneX: -0.15, aimAngle: 0.04, spin: 0.25 });
    const aimedState = await tv.waitFor((m) => m.type === MSG.GAME_STATE && Math.abs(m.state.aimX - (-0.15)) < 0.01);
    assert.ok(Math.abs(aimedState.state.aimX - (-0.15)) < 0.01);

    p1.sendJSON({ type: MSG.BOWL_THROW, power: 0.9, spin: 0 });
    const rollingState = await tv.waitFor((m) => m.type === MSG.GAME_STATE && m.state.phase === BOWLING_PHASE.ROLLING);
    assert.equal(rollingState.state.phase, BOWLING_PHASE.ROLLING);
    const tossHaptic = await p1.waitFor((m) => m.type === MSG.HAPTIC && m.pattern === 'toss');
    assert.equal(tossHaptic.pattern, 'toss');

    tv.close();
    p1.close();
  });
});
