// 60 FPS 3D-Projected Motion Party Tennis Court Renderer on HTML5 Canvas.
// Works on Fullscreen TVs, Google Cast Receivers, AND offscreen AirPlay MediaStream capture!
import { COURT, PHASE, SHOT_TYPES, TEAMS, clamp } from '../../shared/protocol.js';
import { HUD, Perspective, drawCallout, drawPrompt, drawRadar, drawRoomCode, fillPanel, roundRect, setFont } from './hud-theme.js';

const TENNIS_FORMAT = { one_game: 'QUICK MATCH', best_of_3: 'BEST OF 3', best_of_5: 'BEST OF 5' };
const TEAM_ROWS = [
  { label: 'BLU', color: HUD.teamBlue, points: 'blue' },
  { label: 'RED', color: HUD.teamRed, points: 'red' }
];
const MAX_PARTICLES = 128;
const NET_POINTS = Array.from({ length: 29 }, (_, i) => {
  const u = i / 28;
  return {
    u,
    x: -COURT.NET_POST_X + u * COURT.NET_POST_X * 2,
    height: COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * ((u - 0.5) * 2) ** 2
  };
});

const TRAIL_COLORS = {
  [SHOT_TYPES.DRIVE]: ['#fef08a', '#facc15'],
  [SHOT_TYPES.TOPSPIN]: ['#fed7aa', '#f97316'],
  [SHOT_TYPES.SLICE]: ['#cffafe', '#06b6d4'],
  [SHOT_TYPES.LOB]: ['#e9d5ff', '#a855f7'],
  [SHOT_TYPES.SMASH]: ['#fecaca', '#ef4444'],
  [SHOT_TYPES.ROCKET_SERVE]: ['#fde047', '#ef4444'],
  [SHOT_TYPES.SERVE]: ['#fef9c3', '#eab308'],
  [SHOT_TYPES.VOLLEY]: ['#bbf7d0', '#22c55e']
};

export class CourtRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showEmbeddedHud = options.showEmbeddedHud ?? true;
    this.roomCode = '';

    this.state = null;
    this.prevState = null;
    this.stateReceivedAt = performance.now();
    this.time = 0;

    // Low over-the-shoulder Wii Sports Tennis POV camera behind the near baseline
    this.cam = { x: 0, y: 4.8, z: 19.0, lookY: 0.85, lookZ: -2.2, fov: 50 };
    this._view = new Perspective(0.38, 0.35);
    this._palette = {};

    // Visual effects pools
    this.ballTrail = [];
    this.particles = [];
    this.bounceMarks = [];
    this.crowdCheer = 0;
    this.spectators = this._generateSpectators();

    this._raf = null;
    this._lastFrame = performance.now();
  }

  _generateSpectators() {
    const colors = ['#CA8F71', '#7AA3C9', '#D4B57D', '#BA7F86', '#6C9D92', '#898BAD', '#CED6DD', '#5979A1'];
    const skinTones = ['#EED0AD', '#D6A782', '#B98366', '#95624C', '#764C3C'];
    this.shirtGroups = new Map(colors.map((color) => [color, []]));
    this.headGroups = new Map(skinTones.map((color) => [color, []]));
    const list = [];
    // Back stadium stands behind Red baseline (z = -18.5 .. -22.5)
    for (let row = 0; row < 4; row++) {
      const z = -18.2 - row * 1.15;
      const y = 1.65 + row * 0.72;
      const count = 26;
      for (let i = 0; i < count; i++) {
        const x = -14.2 + (i / (count - 1)) * 28.4 + ((row % 2) * 0.45);
        const spectator = {
          x, y, z,
          screen: null,
          phase: (i * 0.7 + row * 1.3) % (Math.PI * 2)
        };
        list.push(spectator);
        this.shirtGroups.get(colors[(i * 7 + row * 3) % colors.length]).push(spectator);
        this.headGroups.get(skinTones[(i * 3 + row * 2) % skinTones.length]).push(spectator);
      }
    }
    return list;
  }

  setRoomCode(code) {
    this.roomCode = code || '';
  }

  updateState(newState) {
    this.prevState = this.state;
    this.state = newState;
    this.stateReceivedAt = performance.now();

    if (newState?.ball?.inPlay) {
      this.ballTrail.push({
        x: newState.ball.x,
        y: newState.ball.y,
        z: newState.ball.z,
        shotType: newState.ball.shotType,
        t: this.time
      });
      if (this.ballTrail.length > 20) this.ballTrail.shift();
    } else if (newState?.phase === PHASE.SERVE_READY || newState?.phase === PHASE.LOBBY) {
      this.ballTrail.length = 0;
      this.bounceMarks.length = 0;
    }
  }

  handleGameEvent(evt) {
    if (!evt) return;
    if (evt.type === 'ball_hit') {
      const isPower = evt.shotType === SHOT_TYPES.SMASH || evt.shotType === SHOT_TYPES.ROCKET_SERVE;
      const count = isPower ? 26 : (evt.sweetSpot ? 16 : 9);
      const color = isPower ? '#f97316' : (evt.sweetSpot ? '#facc15' : '#fef08a');
      this._spawnBurst(evt.x, evt.y, evt.z, count, color, isPower ? 6.5 : 3.6);
      if (isPower) this.crowdCheer = Math.max(this.crowdCheer, 0.8);
    } else if (evt.type === 'ball_bounce') {
      this._spawnBurst(evt.x, 0.06, evt.z, 8, evt.inBounds ? '#ffffff' : '#f87171', 2.4);
      this.bounceMarks.push({ x: evt.x, z: evt.z, inBounds: evt.inBounds, born: this.time });
      if (this.bounceMarks.length > 6) this.bounceMarks.shift();
    } else if (evt.type === 'point_over' || evt.type === 'game_over') {
      this.crowdCheer = 1.0;
    } else if (evt.type === 'match_over') {
      this.crowdCheer = 1.5;
      // Victory stadium confetti!
      this.particles.length = Math.min(this.particles.length, MAX_PARTICLES - 65);
      for (let i = 0; i < 65; i++) {
        this.particles.push({
          x: (Math.random() - 0.5) * 14,
          y: 4 + Math.random() * 5,
          z: (Math.random() - 0.5) * 14,
          vx: (Math.random() - 0.5) * 3.5,
          vy: -1.2 - Math.random() * 1.5,
          vz: (Math.random() - 0.5) * 3.5,
          color: ['#facc15', '#38bdf8', '#fb7185', '#4ade80', '#ffffff'][i % 5],
          size: 0.16,
          life: 3.4,
          maxLife: 3.4,
          confetti: true
        });
      }
    }
  }

  _spawnBurst(x, y, z, count, color, speed) {
    const budget = Math.min(count, MAX_PARTICLES - this.particles.length);
    for (let i = 0; i < budget; i++) {
      const a = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.2) * Math.PI * 0.7;
      const sp = speed * (0.4 + Math.random() * 0.7);
      this.particles.push({
        x, y, z,
        vx: Math.cos(a) * Math.cos(elev) * sp,
        vy: Math.sin(elev) * sp + 1.5,
        vz: Math.sin(a) * Math.cos(elev) * sp,
        color,
        size: 0.08 + Math.random() * 0.07,
        life: 0.45 + Math.random() * 0.25,
        maxLife: 0.7,
        confetti: false
      });
    }
  }

  start() {
    if (this._raf) return;
    this._lastFrame = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - this._lastFrame) / 1000, 0.05);
      this._lastFrame = now;
      this.render(dt);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  // 3D -> 2D Perspective Projection
  project(wx, wy, wz, W, H) {
    return this._view.project(this.cam, wx, wy, wz, W, H);
  }

  render(dt = 0.016) {
    this.time += dt;
    this.crowdCheer = Math.max(0, this.crowdCheer - dt * 0.45);
    this._updateParticles(dt);

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const st = this.state;

    // Steady Wii Sports Tennis over-the-shoulder POV camera behind the baseline
    const isServe = st && (st.phase === PHASE.SERVE_READY || st.phase === PHASE.SERVE_TOSS);
    const server = isServe ? st.players?.[st.serverSeat] : null;
    const isNearServe = Boolean(isServe && server?.team === TEAMS.BLUE);
    const targetCamX = isNearServe
      ? clamp((server?.x ?? 0) * 0.35, -1.6, 1.6)
      : (st ? clamp(st.ball.x * 0.08, -0.75, 0.75) : Math.sin(this.time * 0.25) * 0.45);
    const targetCamZ = isNearServe ? 18.0 : 19.0;
    const targetCamY = isNearServe ? 4.3 : 4.8;
    const shake = st && st.cameraImpulse > 0 ? (Math.random() - 0.5) * st.cameraImpulse * 0.22 : 0;

    this.cam.x += (targetCamX - this.cam.x) * Math.min(1, dt * 4.0) + shake;
    this.cam.y += (targetCamY - this.cam.y) * Math.min(1, dt * 3.4) + shake * 0.45;
    this.cam.z += (targetCamZ - this.cam.z) * Math.min(1, dt * 3.4);
    this._view.update(this.cam, W, H);

    // 1. Vibrant Stadium Sky
    this._drawSkyAndStadiumBackdrop(ctx, W, H);

    // 2. Animated Stadium Bleachers & Crowd
    this._drawStadiumStands(ctx, W, H);

    // 3. 3D Court Apron, Surface, Lines & Bounce Marks
    this._drawCourt(ctx, W, H, st);

    // 4. Depth-Sorted Actors: Far Players -> Net -> Near Players -> Ball & Trails -> Particles
    const drawQueue = [];
    const players = st?.players || [];
    for (const p of players) {
      if (!p.active) continue;
      drawQueue.push({ z: p.z, draw: () => this._drawPlayer(ctx, W, H, p, st) });
    }
    drawQueue.push({ z: 0, draw: () => this._drawNet(ctx, W, H, st?.netWave || 0) });
    if (st?.ball?.visible) {
      // Draw ball shadow on court first, then ball in depth order
      this._drawBallShadowAndTarget(ctx, W, H, st);
      drawQueue.push({ z: st.ball.z, draw: () => this._drawBallAndTrail(ctx, W, H, st) });
    }

    // Sort far (-Z) to near (+Z)
    drawQueue.sort((a, b) => a.z - b.z);
    for (const item of drawQueue) item.draw();

    // 5. Foreground Particles (sparks, dust, victory confetti)
    this._drawParticles(ctx, W, H);

    // 6. Broadcast HUD Overlay (drawn directly into canvas so AirPlay video stream gets it too!)
    if (this.showEmbeddedHud && st) {
      this._drawBroadcastHud(ctx, W, H, st);
    }
  }

  _drawSkyAndStadiumBackdrop(ctx, W, H) {
    if (this._palette.W !== W || this._palette.H !== H) {
      const sky = ctx.createLinearGradient(0, 0, W * 0.12, H * 0.34);
      sky.addColorStop(0, '#6FA8DC');
      sky.addColorStop(1, '#BFD9EE');
      const apron = ctx.createLinearGradient(0, H * 0.30, 0, H);
      apron.addColorStop(0, HUD.apron);
      apron.addColorStop(1, '#276B4E');
      const court = ctx.createLinearGradient(0, H * 0.34, 0, H * 0.88);
      court.addColorStop(0, '#2A55B0');
      court.addColorStop(1, HUD.court);
      this._palette = { W, H, sky, apron, court };
    }
    ctx.fillStyle = this._palette.sky;
    ctx.fillRect(0, 0, W, H * 0.33);
    ctx.fillStyle = '#2A7254';
    ctx.fillRect(0, H * 0.31, W, H * 0.69);
  }

  _drawStadiumStands(ctx, W, H) {
    // Tiered bleachers behind far court
    const wallQuad = [
      this.project(-16, 1.4, -17.5, W, H),
      this.project(16, 1.4, -17.5, W, H),
      this.project(16, 0, -17.5, W, H),
      this.project(-16, 0, -17.5, W, H)
    ];
    if (wallQuad.every(Boolean)) {
      // Bleacher backdrop slope
      const topLeft = this.project(-16, 4.9, -23.2, W, H);
      const topRight = this.project(16, 4.9, -23.2, W, H);
      if (topLeft && topRight) {
        this._drawQuad(ctx, [topLeft, topRight, wallQuad[1], wallQuad[0]], '#66758A');
        ctx.strokeStyle = '#8896A6';
        ctx.lineWidth = Math.max(1, W / 640);
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const z = -17.9 - i * 1.15;
          const y = 1.38 + i * 0.72;
          const l = this.project(-16, y, z, W, H);
          const r = this.project(16, y, z, W, H);
          if (!l || !r) continue;
          ctx.moveTo(l.x, l.y);
          ctx.lineTo(r.x, r.y);
        }
        ctx.stroke();
      }

      // Draw cheering spectators
      const cheerAmp = this.crowdCheer * 0.34;
      const cheerSpeed = 4.5 + this.crowdCheer * 10;
      for (const s of this.spectators) {
        const hop = cheerAmp > 0 ? Math.abs(Math.sin(this.time * cheerSpeed + s.phase)) * cheerAmp : 0;
        s.screen = this.project(s.x, s.y + hop, s.z, W, H);
      }
      for (const [color, group] of this.shirtGroups) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const { screen: p } of group) {
          if (!p) continue;
          const r = Math.max(1.2, 0.25 * p.scale);
          ctx.moveTo(p.x + r, p.y + r);
          ctx.ellipse(p.x, p.y + r, r, r * 1.2, 0, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      for (const [color, group] of this.headGroups) {
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const { screen: p } of group) {
          if (!p) continue;
          const r = Math.max(1.2, 0.25 * p.scale);
          ctx.moveTo(p.x + r * 0.65, p.y - r * 0.28);
          ctx.arc(p.x, p.y - r * 0.28, r * 0.65, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // Court back banner wall
      this._drawQuad(ctx, wallQuad, HUD.courtNight);

      // White top rail on banner
      ctx.strokeStyle = '#BCC8D6';
      ctx.lineWidth = Math.max(1, W / 720);
      ctx.beginPath();
      ctx.moveTo(wallQuad[0].x, wallQuad[0].y);
      ctx.lineTo(wallQuad[1].x, wallQuad[1].y);
      ctx.stroke();

      // Banner branding text
      const midTop = this.project(0, 0.72, -17.45, W, H);
      if (midTop) {
        ctx.save();
        ctx.fillStyle = HUD.chalk;
        setFont(ctx, 850, Math.max(8, 0.57 * midTop.scale), 'expanded');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POCKETPARTY', midTop.x, midTop.y);
        ctx.restore();
      }
    }
  }

  _drawQuad(ctx, pts, fillStyle) {
    if (!pts.every(Boolean)) return;
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }

  _drawCourtLine(ctx, x1, z1, x2, z2, W, H, width = 3) {
    const p1 = this.project(x1, 0.01, z1, W, H);
    const p2 = this.project(x2, 0.01, z2, W, H);
    if (!p1 || !p2) return;
    ctx.lineWidth = Math.max(1.5, width * (W / 1280));
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  _drawCourt(ctx, W, H, st) {
    const oW = COURT.OUTER_HALF_WIDTH + 4.5;
    const oL = COURT.OUTER_HALF_LENGTH;

    // 1. Lush emerald outer court surround
    const outerPts = [
      this.project(-oW, 0, -oL, W, H),
      this.project(oW, 0, -oL, W, H),
      this.project(oW, 0, oL, W, H),
      this.project(-oW, 0, oL, W, H)
    ];
    this._drawQuad(ctx, outerPts, this._palette.apron);

    // 2. Vibrant Royal Blue inner playing court
    const dW = COURT.DOUBLES_HALF_WIDTH;
    const sW = COURT.SINGLES_HALF_WIDTH;
    const hL = COURT.HALF_LENGTH;
    const sZ = COURT.SERVICE_LINE_Z;

    const courtPts = [
      this.project(-dW, 0, -hL, W, H),
      this.project(dW, 0, -hL, W, H),
      this.project(dW, 0, hL, W, H),
      this.project(-dW, 0, hL, W, H)
    ];
    this._drawQuad(ctx, courtPts, this._palette.court);

    // Slightly brighter service boxes for classic tournament polish
    const srvPts = [
      this.project(-sW, 0.005, -sZ, W, H),
      this.project(sW, 0.005, -sZ, W, H),
      this.project(sW, 0.005, sZ, W, H),
      this.project(-sW, 0.005, sZ, W, H)
    ];
    this._drawQuad(ctx, srvPts, 'rgba(91, 155, 255, 0.07)');

    // 3. Crisp Chalk-White Court Lines
    ctx.strokeStyle = HUD.chalk;
    ctx.lineCap = 'square';
    // Baselines
    this._drawCourtLine(ctx, -dW, -hL, dW, -hL, W, H, 3.2);
    this._drawCourtLine(ctx, -dW, hL, dW, hL, W, H, 4.4);
    // Doubles sidelines
    this._drawCourtLine(ctx, -dW, -hL, -dW, hL, W, H, 3.4);
    this._drawCourtLine(ctx, dW, -hL, dW, hL, W, H, 3.4);
    // Singles sidelines
    this._drawCourtLine(ctx, -sW, -hL, -sW, hL, W, H, 3.0);
    this._drawCourtLine(ctx, sW, -hL, sW, hL, W, H, 3.0);
    // Service lines & center service T
    this._drawCourtLine(ctx, -sW, -sZ, sW, -sZ, W, H, 2.8);
    this._drawCourtLine(ctx, -sW, sZ, sW, sZ, W, H, 3.2);
    this._drawCourtLine(ctx, 0, -sZ, 0, sZ, W, H, 2.8);
    // Center baseline ticks
    this._drawCourtLine(ctx, 0, -hL, 0, -hL + 0.35, W, H, 2.5);
    this._drawCourtLine(ctx, 0, hL, 0, hL - 0.35, W, H, 3.5);

    // 4. Recent bounce impact ring decals
    let marks = 0;
    for (const m of this.bounceMarks) {
      const age = this.time - m.born;
      if (age > 1.3) continue;
      this.bounceMarks[marks++] = m;
      const p = this.project(m.x, 0.02, m.z, W, H);
      if (!p) continue;
      const alpha = 1 - age / 1.3;
      const rad = (0.16 + age * 0.55) * p.scale;
      ctx.strokeStyle = m.inBounds ? `rgba(255, 255, 255, ${alpha * 0.85})` : `rgba(248, 113, 113, ${alpha * 0.9})`;
      ctx.lineWidth = Math.max(1.5, 2.4 * (W / 1280));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rad, rad * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.bounceMarks.length = marks;

    // 5. Net ground shadow
    const nsL = this.project(-COURT.NET_POST_X, 0.01, 0.35, W, H);
    const nsR = this.project(COURT.NET_POST_X, 0.01, 0.35, W, H);
    if (nsL && nsR) {
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.28)';
      ctx.lineWidth = Math.max(4, 9 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(nsL.x, nsL.y);
      ctx.lineTo(nsR.x, nsR.y);
      ctx.stroke();
    }
  }

  _drawNet(ctx, W, H, netWave) {
    const postX = COURT.NET_POST_X;
    const wave = netWave * 0.12;
    const sample = NET_POINTS.map(({ u, x, height }) => {
      const z = wave > 0 ? Math.sin(this.time * 42 + u * 10) * wave : 0;
      return { x, height, z, top: this.project(x, height, z, W, H), bottom: this.project(x, 0.03, z * 0.3, W, H) };
    });

    // Translucent net mesh fill
    ctx.fillStyle = 'rgba(15, 35, 80, 0.43)';
    ctx.beginPath();
    for (const { top } of sample) {
      if (top) ctx.lineTo(top.x, top.y);
    }
    for (let i = sample.length - 1; i >= 0; i--) {
      const { bottom } = sample[i];
      if (bottom) ctx.lineTo(bottom.x, bottom.y);
    }
    ctx.closePath();
    ctx.fill();

    // Mesh grid lines
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Vertical mesh threads
    for (const { top, bottom } of sample) {
      if (top && bottom) {
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bottom.x, bottom.y);
      }
    }
    // Horizontal mesh threads
    for (let r = 1; r <= 4; r++) {
      const frac = r / 5;
      let started = false;
      for (const { x, height, z } of sample) {
        const p = this.project(x, height * frac, z * frac, W, H);
        if (!p) continue;
        if (!started) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        started = true;
      }
    }
    ctx.stroke();

    // Crisp White Top Canvas Tape
    ctx.strokeStyle = HUD.chalk;
    ctx.lineWidth = Math.max(2, 4 * (W / 1280));
    ctx.beginPath();
    for (const { top } of sample) {
      if (top) ctx.lineTo(top.x, top.y);
    }
    ctx.stroke();

    // Center white strap
    const cTop = sample[14].top;
    const cBot = this.project(0, 0.02, 0, W, H);
    if (cTop && cBot) {
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = Math.max(2, 3.2 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(cTop.x, cTop.y);
      ctx.lineTo(cBot.x, cBot.y);
      ctx.stroke();
    }

    // Metallic Side Posts
    for (const sx of [-postX, postX]) {
      const pTop = this.project(sx, COURT.NET_POST_HEIGHT + 0.08, 0, W, H);
      const pBot = this.project(sx, 0, 0, W, H);
      if (!pTop || !pBot) continue;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = Math.max(4, 7 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(pBot.x, pBot.y);
      ctx.lineTo(pTop.x, pTop.y);
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.arc(pTop.x, pTop.y, Math.max(3, 4.5 * (W / 1280)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawPlayer(ctx, W, H, p, st) {
    const speed = Math.hypot(p.vx || 0, p.vz || 0);
    const runBob = speed > 0.4 ? Math.abs(Math.sin(this.time * 14 + p.seat)) * 0.14 : Math.sin(this.time * 3 + p.seat) * 0.03;

    const foot = this.project(p.x, 0, p.z, W, H);
    const torso = this.project(p.x, 1.02 + runBob, p.z, W, H);
    const head = this.project(p.x, 1.66 + runBob, p.z, W, H);
    if (!foot || !torso || !head) return;

    const s = foot.scale;
    const isNear = p.team === TEAMS.BLUE;
    // Keep incoming balls clearly visible through your own near-side avatar in low POV
    const translucentPov = isNear && st?.ball?.inPlay && st.ball.z < p.z;
    if (translucentPov) {
      ctx.save();
      ctx.globalAlpha = 0.84;
    }

    // 1. Court Drop Shadow
    ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, 0.56 * s, 0.24 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // 1b. Glowing Strike-Zone Cue Ring when incoming ball is in hittable range!
    if (p.isHuman && p.inStrikeZone) {
      const pulse = 0.92 + Math.sin(this.time * 18) * 0.08;
      ctx.save();
      ctx.strokeStyle = HUD.ball;
      ctx.lineWidth = Math.max(2.5, 3.6 * (W / 1280));
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 0.92 * s * pulse, 0.38 * s * pulse, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Animated legs and shoes
    const stride = speed > 0.4 ? Math.sin(this.time * 14 + p.seat) * 0.22 : 0;
    for (const side of [-1, 1]) {
      const fProj = this.project(p.x + side * 0.2, 0.12 + Math.max(0, side * stride * 0.4), p.z + side * stride * 0.35, W, H);
      if (!fProj) continue;
      ctx.strokeStyle = HUD.courtNight;
      ctx.lineWidth = Math.max(1, 0.18 * fProj.scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(torso.x + side * 0.18 * torso.scale, torso.y + 0.3 * torso.scale);
      ctx.lineTo(fProj.x, fProj.y);
      ctx.stroke();
      ctx.fillStyle = HUD.chalk;
      ctx.beginPath();
      ctx.ellipse(fProj.x, fProj.y, 0.17 * fProj.scale, 0.11 * fProj.scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Tapered jersey, with seat color and contrast yoke
    const bodyW = 0.34 * torso.scale;
    const bodyH = 0.62 * torso.scale;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(torso.x - bodyW * 0.72, torso.y - bodyH * 0.6);
    ctx.quadraticCurveTo(torso.x, torso.y - bodyH * 0.78, torso.x + bodyW * 0.72, torso.y - bodyH * 0.6);
    ctx.lineTo(torso.x + bodyW, torso.y + bodyH * 0.65);
    ctx.quadraticCurveTo(torso.x, torso.y + bodyH * 0.85, torso.x - bodyW, torso.y + bodyH * 0.65);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = p.accent || p.color;
    ctx.fillRect(torso.x - bodyW * 0.72, torso.y - bodyH * 0.38, bodyW * 1.44, bodyH * 0.12);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    setFont(ctx, 800, Math.max(9, 0.32 * torso.scale));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.seat + 1), torso.x, torso.y + bodyH * 0.08);

    // Head and sport visor
    const headR = 0.26 * head.scale;
    ctx.fillStyle = '#D9A67E';
    ctx.beginPath();
    ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
    ctx.fill();

    // Hair / Visor cap
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(head.x, head.y - headR * 0.12, headR * 1.03, Math.PI * 1.08, Math.PI * 1.92);
    ctx.fill();

    // White athletic headband / visor brim
    ctx.fillStyle = p.visor || '#ffffff';
    ctx.fillRect(head.x - headR * 0.95, head.y - headR * 0.34, headR * 1.9, headR * 0.24);

    // Expressive eyes on far-side players facing the camera
    if (!isNear) {
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(head.x - headR * 0.32, head.y + headR * 0.06, headR * 0.11, 0, Math.PI * 2);
      ctx.moveTo(head.x + headR * 0.43, head.y + headR * 0.06);
      ctx.arc(head.x + headR * 0.32, head.y + headR * 0.06, headR * 0.11, 0, Math.PI * 2);
      ctx.fill();
    }

    // 6. Articulated Floating Hand + 3D Tennis Racket (tracks live phone gyro & swing animation!)
    this._drawPlayerRacket(ctx, W, H, p, runBob, torso);
    if (translucentPov) ctx.restore();

    // 7. Clean Player Name Tag below feet
    const ui = W / 1280;
    const serving = st && st.serverSeat === p.seat && st.phase !== PHASE.LOBBY;
    const label = p.name;
    ctx.save();
    setFont(ctx, 750, 13 * ui, 'semi-condensed');
    const space = (serving ? 27 : 14) * ui;
    const tw = Math.min(152 * ui, ctx.measureText(label).width + space);
    const th = 18 * ui;
    // Keep near-baseline name tags out of the prompt's bottom-center region.
    const tightToPrompt = st?.phase === PHASE.SERVE_READY && st.players[st.serverSeat]?.isHuman &&
      this.showEmbeddedHud && foot.y + Math.max(12 * ui, 0.42 * s) + th / 2 >= H - 70 * ui;
    const tagY = tightToPrompt ? foot.y - 10 * ui : foot.y + Math.max(12 * ui, 0.42 * s);
    const centerX = tightToPrompt ? foot.x + (foot.x < W / 2 ? -1 : 1) * (0.50 * s + tw / 2) : foot.x;
    const tagX = centerX - tw / 2;
    ctx.fillStyle = p.isHuman ? HUD.panel : 'rgba(15, 35, 80, 0.73)';
    roundRect(ctx, tagX, tagY - th / 2, tw, th, HUD.chipRadius * ui);
    ctx.fill();
    ctx.fillStyle = p.isHuman ? HUD.chalk : HUD.chalkDim;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, centerX - (serving ? 6 * ui : 0), tagY, tw - space);
    if (p.isHuman) {
      ctx.fillStyle = p.accent || p.color;
      ctx.fillRect(tagX + 3 * ui, tagY + th / 2 - 1.5 * ui, tw - 6 * ui, 1.5 * ui);
    }

    // Server badge beside name if serving
    if (serving) {
      ctx.fillStyle = HUD.ball;
      ctx.beginPath();
      ctx.arc(tagX + tw - 8 * ui, tagY, 2.6 * ui, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawPlayerRacket(ctx, W, H, p, runBob, torso) {
    const isNear = p.team === TEAMS.BLUE;
    const sideSign = isNear ? 1 : -1;
    const handDir = (p.handedness === 'right' ? 1 : -1) * sideSign;

    // Swing progress 0..1
    const isSwinging = p.swingTimer > 0 && p.swingDuration > 0;
    const swingProgress = isSwinging ? 1 - p.swingTimer / p.swingDuration : 0;

    // Live phone orientation gently moves the racket in ready stance!
    const poseRoll = p.pose?.roll || 0;
    const posePitch = p.pose?.pitch || 0;

    let handX = p.x + handDir * 0.55 + poseRoll * 0.25 * sideSign;
    let handY = 1.10 + runBob + posePitch * 0.22;
    let handZ = p.z - sideSign * 0.35;
    let racketAngle = handDir * 0.45 + poseRoll * 0.65;

    if (isSwinging) {
      const sweep = Math.sin(swingProgress * Math.PI);
      if (p.swingSide === 'serve' || p.swingSide === 'smash') {
        handY = 1.65 + Math.sin(swingProgress * Math.PI) * 0.85 - swingProgress * 0.55;
        handZ = p.z - sideSign * (0.2 + sweep * 0.85);
        racketAngle = -handDir * (1.2 - swingProgress * 2.4);
      } else {
        const dirMul = p.swingSide === 'forehand' ? 1 : -1;
        const arc = (swingProgress - 0.45) * 2.5;
        handX = p.x + handDir * dirMul * (0.75 - swingProgress * 1.35);
        handY = 1.05 + sweep * 0.35;
        handZ = p.z - sideSign * (0.35 + sweep * 0.65);
        racketAngle = handDir * dirMul * (-0.9 + arc * 1.4);
      }
    }

    const handProj = this.project(handX, handY, handZ, W, H);
    if (!handProj) return;

    const rScale = handProj.scale;

    // Glowing Swing Arc Motion Ribbon during active swing!
    if (isSwinging && swingProgress < 0.78) {
      ctx.save();
      ctx.translate(handProj.x, handProj.y);
      ctx.strokeStyle = p.swingPower > 0.78 ? 'rgba(250, 204, 21, 0.72)' : 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = Math.max(3, 0.28 * rScale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, 0.75 * rScale, racketAngle - 1.1, racketAngle + 0.15);
      ctx.stroke();
      ctx.restore();
    }

    // Connect the grip to the shoulder through a bent forearm.
    ctx.strokeStyle = '#D9A67E';
    ctx.lineWidth = Math.max(1.2, 0.14 * rScale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(torso.x + handDir * 0.23 * torso.scale, torso.y - 0.26 * torso.scale);
    ctx.quadraticCurveTo(torso.x + handDir * 0.42 * torso.scale, torso.y + 0.22 * torso.scale, handProj.x, handProj.y);
    ctx.stroke();
    ctx.fillStyle = '#D9A67E';
    ctx.beginPath();
    ctx.arc(handProj.x, handProj.y, 0.15 * rScale, 0, Math.PI * 2);
    ctx.fill();

    // Tennis Racket (handle, throat, oval frame + string mesh)
    ctx.save();
    ctx.translate(handProj.x, handProj.y);
    ctx.rotate(racketAngle);

    // Grip & shaft
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = Math.max(2, 0.08 * rScale);
    ctx.beginPath();
    ctx.moveTo(0, 0.06 * rScale);
    ctx.lineTo(0, -0.44 * rScale);
    ctx.stroke();

    // Racket head strings fill
    const headCy = -0.74 * rScale;
    const rx = 0.24 * rScale;
    const ry = 0.34 * rScale;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
    ctx.beginPath();
    ctx.ellipse(0, headCy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Racket string crosshatch
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = Math.max(0.8, 0.02 * rScale);
    for (let sx = -0.14; sx <= 0.14; sx += 0.07) {
      ctx.beginPath();
      ctx.moveTo(sx * rScale, headCy - ry * 0.8);
      ctx.lineTo(sx * rScale, headCy + ry * 0.8);
      ctx.stroke();
    }
    for (let sy = -0.22; sy <= 0.22; sy += 0.11) {
      ctx.beginPath();
      ctx.moveTo(-rx * 0.85, headCy + sy * rScale);
      ctx.lineTo(rx * 0.85, headCy + sy * rScale);
      ctx.stroke();
    }

    // Outer racket frame rim
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(2.2, 0.075 * rScale);
    ctx.beginPath();
    ctx.ellipse(0, headCy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  _drawBallShadowAndTarget(ctx, W, H, st) {
    const b = st.ball;

    // 1. Predicted landing target ring on court (super helpful depth aid!)
    if (st.phase === PHASE.RALLY && st.predictedLanding) {
      const lp = this.project(st.predictedLanding.x, 0.02, st.predictedLanding.z, W, H);
      if (lp) {
        const pulse = 0.85 + Math.sin(this.time * 12) * 0.15;
        const rad = 0.42 * lp.scale * pulse;
        ctx.strokeStyle = 'rgba(220, 245, 66, 0.75)';
        ctx.lineWidth = Math.max(1.5, 2.2 * (W / 1280));
        ctx.beginPath();
        ctx.ellipse(lp.x, lp.y, rad, rad * 0.46, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 2. Direct Ground Shadow straight beneath ball
    const sh = this.project(b.x, 0.02, b.z, W, H);
    if (sh) {
      const heightFade = clamp(1 - b.y / 8.5, 0.25, 1);
      const rad = Math.max(3, (0.19 + b.y * 0.02) * sh.scale);
      ctx.fillStyle = `rgba(15, 23, 42, ${0.46 * heightFade})`;
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, rad, rad * 0.46, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawBallAndTrail(ctx, W, H, st) {
    const b = st.ball;

    // 1. Glowing Motion Ribbon Trail
    if (this.ballTrail.length > 1 && b.inPlay) {
      const palette = TRAIL_COLORS[b.shotType] || TRAIL_COLORS[SHOT_TYPES.DRIVE];
      for (let i = 1; i < this.ballTrail.length; i++) {
        const a = this.project(this.ballTrail[i - 1].x, this.ballTrail[i - 1].y, this.ballTrail[i - 1].z, W, H);
        const c = this.project(this.ballTrail[i].x, this.ballTrail[i].y, this.ballTrail[i].z, W, H);
        if (!a || !c) continue;
        const frac = i / this.ballTrail.length;
        ctx.strokeStyle = frac > 0.65 ? palette[0] : palette[1];
        ctx.globalAlpha = frac * 0.72;
        ctx.lineWidth = Math.max(1.5, 0.20 * c.scale * frac);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 2. Serve Toss Sweet-Spot Timing Ring!
    const bp = this.project(b.x, b.y, b.z, W, H);
    if (!bp) return;

    if (st.phase === PHASE.SERVE_TOSS) {
      const s = W / 1280;
      const sw = b.sweetSpotWindow || 0;
      const ringR = Math.max(12, (0.55 - sw * 0.25) * bp.scale);
      ctx.strokeStyle = sw > 0.7 ? HUD.ball : 'rgba(220, 245, 66, 0.6)';
      ctx.lineWidth = Math.max(1, (sw > 0.7 ? 3 : 2) * s);
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      if (sw > 0.7) {
        const x = bp.x;
        const y = bp.y - ringR - 17 * s;
        ctx.save();
        fillPanel(ctx, x - 30 * s, y - 10 * s, 60 * s, 20 * s, s, HUD.ball);
        ctx.fillStyle = HUD.ballInk;
        setFont(ctx, 900, 15 * s, 'condensed');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('SWING', x, y);
        ctx.restore();
      }
    }

    // 2b. Incoming Rally Strike-Zone Timing Halo when any human player can hit the ball!
    const anyHumanInStrikeZone = st.phase === PHASE.RALLY && st.players?.some((p) => p.active && p.isHuman && p.inStrikeZone);
    if (anyHumanInStrikeZone) {
      const s = W / 1280;
      const pulse = 0.85 + Math.sin(this.time * 20) * 0.15;
      const haloR = Math.max(14, 0.34 * bp.scale * pulse);
      ctx.strokeStyle = HUD.ball;
      ctx.lineWidth = Math.max(2, 3 * s);
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, haloR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 3. Optic-Yellow Tennis Ball with Crisp Rim & Curved Seam
    const r = Math.max(5.5, 0.17 * bp.scale);
    const isBlazing = b.shotType === SHOT_TYPES.SMASH || b.shotType === SHOT_TYPES.ROCKET_SERVE;
    if (isBlazing && b.inPlay) {
      const glow = ctx.createRadialGradient(bp.x, bp.y, r * 0.5, bp.x, bp.y, r * 2.8);
      glow.addColorStop(0, 'rgba(250, 204, 21, 0.85)');
      glow.addColorStop(0.5, 'rgba(239, 68, 68, 0.45)');
      glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, r * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = HUD.ball;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.42)';
    ctx.lineWidth = Math.max(1, r * 0.14);
    ctx.stroke();

    // Subtle white tennis seam
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.arc(bp.x - r * 0.35, bp.y, r * 0.65, -0.8, 0.8);
    ctx.stroke();
  }

  _updateParticles(dt) {
    let count = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) continue;
      if (!pt.confetti) pt.vy -= 9.8 * dt;
      else pt.vx += Math.sin(this.time * 6 + i) * dt * 1.4;
      pt.x += pt.vx * dt;
      pt.y = Math.max(0.02, pt.y + pt.vy * dt);
      pt.z += pt.vz * dt;
      this.particles[count++] = pt;
    }
    this.particles.length = count;
  }

  _drawParticles(ctx, W, H) {
    for (const pt of this.particles) {
      const p = this.project(pt.x, pt.y, pt.z, W, H);
      if (!p) continue;
      const alpha = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pt.color;
      const sz = Math.max(2, pt.size * p.scale);
      if (pt.confetti) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(this.time * 5 + pt.x);
        ctx.fillRect(-sz, -sz * 0.5, sz * 2, sz);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawBroadcastHud(ctx, W, H, st) {
    const s = W / 1280;
    if (st.phase !== PHASE.LOBBY) {
      this._drawScoreBug(ctx, s, st);
      drawRadar(ctx, W, s, st.lastShotMph, st.rallyCount);
    }
    drawRoomCode(ctx, W, H, s, this.roomCode);
    if (st.phase === PHASE.SERVE_READY) {
      const srv = st.players[st.serverSeat];
      if (srv?.isHuman) drawPrompt(ctx, W, H, s, `${srv.name} to serve — flick up to toss`);
    }
    drawCallout(ctx, W, H, s, st.callout, st.clock);
  }

  _drawScoreBug(ctx, s, st) {
    const x = HUD.pad * s;
    const y = HUD.pad * s;
    const w = 158 * s;
    const context = TENNIS_FORMAT[st.format];
    ctx.save();
    fillPanel(ctx, x, y, w, (context ? 103 : 83) * s, s);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = HUD.chalkDim;
    setFont(ctx, 750, 10 * s, 'condensed');
    ctx.fillText('GAMES', x + 94 * s, y + 12 * s);
    ctx.fillText('PTS', x + 132 * s, y + 12 * s);

    const serverTeam = st.players[st.serverSeat]?.team;
    for (let i = 0; i < TEAM_ROWS.length; i++) {
      const row = TEAM_ROWS[i];
      const ry = y + (21 + i * 29) * s;
      ctx.fillStyle = row.color;
      ctx.fillRect(x + 8 * s, ry + 5 * s, 3 * s, 16 * s);
      ctx.fillStyle = HUD.chalk;
      ctx.textAlign = 'left';
      setFont(ctx, 850, 17 * s, 'condensed');
      ctx.fillText(row.label, x + 18 * s, ry + 13 * s);
      if (serverTeam === i) {
        ctx.fillStyle = HUD.ball;
        ctx.beginPath();
        ctx.arc(x + 65 * s, ry + 13 * s, 3.5 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = HUD.court;
      roundRect(ctx, x + 78 * s, ry, 32 * s, 26 * s, HUD.chipRadius * s);
      ctx.fill();
      ctx.fillStyle = HUD.chalk;
      roundRect(ctx, x + 114 * s, ry, 36 * s, 26 * s, HUD.chipRadius * s);
      ctx.fill();
      ctx.textAlign = 'center';
      setFont(ctx, 850, 19 * s, 'condensed');
      ctx.fillText(String(st.games[i]), x + 94 * s, ry + 13 * s);
      ctx.fillStyle = HUD.courtNight;
      ctx.fillText(st.scoreText[row.points], x + 132 * s, ry + 13 * s);
    }
    if (context) {
      ctx.fillStyle = 'rgba(169, 183, 214, 0.25)';
      ctx.fillRect(x + 8 * s, y + 82 * s, w - 16 * s, s);
      ctx.fillStyle = HUD.chalkDim;
      ctx.textAlign = 'left';
      setFont(ctx, 750, 11 * s, 'semi-condensed');
      ctx.fillText(context, x + 8 * s, y + 92 * s);
      ctx.textAlign = 'right';
      ctx.fillText(st.mode === 'doubles' ? '2V2' : '1V1', x + w - 8 * s, y + 92 * s);
    }
    ctx.restore();
  }
}
