// 60 FPS 3D-Projected Motion Party Tennis Court Renderer on HTML5 Canvas.
// Works on Fullscreen TVs, Google Cast Receivers, AND offscreen AirPlay MediaStream capture!
import { COURT, PHASE, SHOT_TYPES, TEAMS, clamp } from '../../shared/protocol.js';

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

    // Smooth camera state
    this.cam = { x: 0, y: 10.6, z: 22.8, lookY: 0.4, lookZ: -2.0, fov: 54 };

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
    const colors = ['#f97316', '#38bdf8', '#facc15', '#fb7185', '#4ade80', '#c084fc', '#ffffff', '#60a5fa'];
    const skinTones = ['#fde68a', '#fed7aa', '#fdba74', '#d97706', '#92400e'];
    const list = [];
    // Back stadium stands behind Red baseline (z = -18.5 .. -22.5)
    for (let row = 0; row < 4; row++) {
      const z = -18.2 - row * 1.15;
      const y = 1.65 + row * 0.72;
      const count = 26;
      for (let i = 0; i < count; i++) {
        const x = -14.2 + (i / (count - 1)) * 28.4 + ((row % 2) * 0.45);
        list.push({
          x, y, z,
          shirt: colors[(i * 7 + row * 3) % colors.length],
          skin: skinTones[(i * 5 + row) % skinTones.length],
          phase: (i * 0.7 + row * 1.3) % (Math.PI * 2)
        });
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
    for (let i = 0; i < count; i++) {
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
    const dx = wx - this.cam.x;
    const dy = wy - this.cam.y;
    const dz = wz - this.cam.z;

    // Pitch camera slightly downward toward look target
    const lookDz = this.cam.lookZ - this.cam.z;
    const lookDy = this.cam.lookY - this.cam.y;
    const pitch = Math.atan2(lookDy, -lookDz); // Negative angle looking down

    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    // Camera basis: forward = (0, sinP, -cosP), up = (0, cosP, sinP)
    const forward = -dz * cosP + dy * sinP;
    const up = dy * cosP + dz * sinP;
    const right = dx;

    if (forward <= 0.35) return null;

    const focal = (H * 0.5) / Math.tan((this.cam.fov * Math.PI) / 360);
    const scale = focal / forward;
    return {
      x: W * 0.5 + right * scale,
      y: H * 0.47 - up * scale,
      scale,
      depth: forward
    };
  }

  render(dt = 0.016) {
    this.time += dt;
    this.crowdCheer = Math.max(0, this.crowdCheer - dt * 0.45);
    this._updateParticles(dt);

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const st = this.state;

    // Smooth dynamic camera tracking
    const targetCamX = st ? clamp(st.ball.x * 0.16, -1.8, 1.8) : Math.sin(this.time * 0.3) * 0.6;
    const isServe = st && (st.phase === PHASE.SERVE_READY || st.phase === PHASE.SERVE_TOSS);
    const targetCamZ = isServe ? 21.8 : 23.2;
    const targetCamY = isServe ? 9.9 : 10.7;
    const shake = st && st.cameraImpulse > 0 ? (Math.random() - 0.5) * st.cameraImpulse * 0.35 : 0;

    this.cam.x += (targetCamX - this.cam.x) * Math.min(1, dt * 4.5) + shake;
    this.cam.y += (targetCamY - this.cam.y) * Math.min(1, dt * 3.2) + shake * 0.5;
    this.cam.z += (targetCamZ - this.cam.z) * Math.min(1, dt * 3.2);

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
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, '#0284c7');
    sky.addColorStop(0.55, '#38bdf8');
    sky.addColorStop(1, '#bae6fd');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Soft sunny glow & stylized resort clouds
    const sunGrad = ctx.createRadialGradient(W * 0.82, H * 0.12, 10, W * 0.82, H * 0.12, W * 0.28);
    sunGrad.addColorStop(0, 'rgba(255, 253, 224, 0.72)');
    sunGrad.addColorStop(0.4, 'rgba(255, 250, 200, 0.22)');
    sunGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, W, H * 0.55);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    const clouds = [
      { bx: 0.15, by: 0.11, s: 1.0 },
      { bx: 0.48, by: 0.08, s: 1.25 },
      { bx: 0.74, by: 0.15, s: 0.9 }
    ];
    for (const cl of clouds) {
      const cx = ((cl.bx * W + this.time * 7 * cl.s) % (W + 240)) - 120;
      const cy = cl.by * H;
      const r = 24 * cl.s * (W / 1280);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx + r * 0.9, cy - r * 0.2, r * 1.15, 0, Math.PI * 2);
      ctx.arc(cx + r * 1.9, cy, r * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }

    // Horizon grass fill beneath stands
    ctx.fillStyle = '#15803d';
    ctx.fillRect(0, H * 0.34, W, H * 0.66);
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
        const standGrad = ctx.createLinearGradient(0, topLeft.y, 0, wallQuad[0].y);
        standGrad.addColorStop(0, '#cbd5e1');
        standGrad.addColorStop(1, '#64748b');
        ctx.fillStyle = standGrad;
        ctx.beginPath();
        ctx.moveTo(topLeft.x, topLeft.y);
        ctx.lineTo(topRight.x, topRight.y);
        ctx.lineTo(wallQuad[1].x, wallQuad[1].y);
        ctx.lineTo(wallQuad[0].x, wallQuad[0].y);
        ctx.closePath();
        ctx.fill();
      }

      // Draw cheering spectators
      const cheerAmp = 0.08 + this.crowdCheer * 0.34;
      const cheerSpeed = 4.5 + this.crowdCheer * 10;
      for (const s of this.spectators) {
        const hop = Math.abs(Math.sin(this.time * cheerSpeed + s.phase)) * cheerAmp;
        const p = this.project(s.x, s.y + hop, s.z, W, H);
        if (!p) continue;
        const r = Math.max(2.2, 0.28 * p.scale);
        // Torso
        ctx.fillStyle = s.shirt;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y + r * 0.85, r * 1.05, r * 1.15, 0, 0, Math.PI * 2);
        ctx.fill();
        // Head
        ctx.fillStyle = s.skin;
        ctx.beginPath();
        ctx.arc(p.x, p.y - r * 0.35, r * 0.72, 0, Math.PI * 2);
        ctx.fill();
      }

      // Court back banner wall
      const bannerGrad = ctx.createLinearGradient(0, wallQuad[0].y, 0, wallQuad[2].y);
      bannerGrad.addColorStop(0, '#1e3a8a');
      bannerGrad.addColorStop(1, '#172554');
      ctx.fillStyle = bannerGrad;
      ctx.beginPath();
      ctx.moveTo(wallQuad[0].x, wallQuad[0].y);
      ctx.lineTo(wallQuad[1].x, wallQuad[1].y);
      ctx.lineTo(wallQuad[2].x, wallQuad[2].y);
      ctx.lineTo(wallQuad[3].x, wallQuad[3].y);
      ctx.closePath();
      ctx.fill();

      // White top rail on banner
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = Math.max(2, W / 480);
      ctx.beginPath();
      ctx.moveTo(wallQuad[0].x, wallQuad[0].y);
      ctx.lineTo(wallQuad[1].x, wallQuad[1].y);
      ctx.stroke();

      // Banner branding text
      const midTop = this.project(0, 0.72, -17.45, W, H);
      if (midTop) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.font = `800 ${Math.round(Math.max(11, 0.45 * midTop.scale))}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POCKETPARTY  •  GRAND SLAM', midTop.x, midTop.y);
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
    const apronGrad = ctx.createLinearGradient(0, H * 0.35, 0, H);
    apronGrad.addColorStop(0, '#16a34a');
    apronGrad.addColorStop(1, '#15803d');
    this._drawQuad(ctx, outerPts, apronGrad);

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
    const courtGrad = ctx.createLinearGradient(0, H * 0.38, 0, H * 0.95);
    courtGrad.addColorStop(0, '#2563eb');
    courtGrad.addColorStop(0.55, '#1d4ed8');
    courtGrad.addColorStop(1, '#1e40af');
    this._drawQuad(ctx, courtPts, courtGrad);

    // Slightly brighter service boxes for classic tournament polish
    const srvPts = [
      this.project(-sW, 0.005, -sZ, W, H),
      this.project(sW, 0.005, -sZ, W, H),
      this.project(sW, 0.005, sZ, W, H),
      this.project(-sW, 0.005, sZ, W, H)
    ];
    this._drawQuad(ctx, srvPts, 'rgba(96, 165, 250, 0.14)');

    // 3. Crisp Chalk-White Court Lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
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
    for (let i = this.bounceMarks.length - 1; i >= 0; i--) {
      const m = this.bounceMarks[i];
      const age = this.time - m.born;
      if (age > 1.3) {
        this.bounceMarks.splice(i, 1);
        continue;
      }
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
    const segs = 28;
    const waveOffset = (u) => netWave > 0 ? Math.sin(this.time * 42 + u * 10) * netWave * 0.12 : 0;

    // Translucent net mesh fill
    ctx.fillStyle = 'rgba(15, 23, 42, 0.32)';
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const x = -postX + u * postX * 2;
      const h = COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * Math.pow((u - 0.5) * 2, 2);
      const p = this.project(x, h, waveOffset(u), W, H);
      if (!p) continue;
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    for (let i = segs; i >= 0; i--) {
      const u = i / segs;
      const x = -postX + u * postX * 2;
      const p = this.project(x, 0.03, waveOffset(u) * 0.3, W, H);
      if (p) ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fill();

    // Mesh grid lines
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.34)';
    ctx.lineWidth = 1;
    // Vertical mesh threads
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const x = -postX + u * postX * 2;
      const h = COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * Math.pow((u - 0.5) * 2, 2);
      const top = this.project(x, h, waveOffset(u), W, H);
      const bot = this.project(x, 0.03, waveOffset(u) * 0.3, W, H);
      if (top && bot) {
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bot.x, bot.y);
        ctx.stroke();
      }
    }
    // Horizontal mesh threads
    for (let r = 1; r <= 4; r++) {
      const frac = r / 5;
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        const x = -postX + u * postX * 2;
        const h = (COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * Math.pow((u - 0.5) * 2, 2)) * frac;
        const p = this.project(x, h, waveOffset(u) * frac, W, H);
        if (!p) continue;
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Crisp White Top Canvas Tape
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(3, 5.2 * (W / 1280));
    ctx.beginPath();
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const x = -postX + u * postX * 2;
      const h = COURT.NET_CENTER_HEIGHT + (COURT.NET_POST_HEIGHT - COURT.NET_CENTER_HEIGHT) * Math.pow((u - 0.5) * 2, 2);
      const p = this.project(x, h, waveOffset(u), W, H);
      if (!p) continue;
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // Center white strap
    const cTop = this.project(0, COURT.NET_CENTER_HEIGHT, waveOffset(0.5), W, H);
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

    // 1. Court Drop Shadow
    ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, 0.56 * s, 0.24 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. Active Human Ring Highlight (helps players spot their character instantly on TV!)
    if (p.isHuman) {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(2, 3 * (W / 1280));
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 0.78 * s, 0.32 * s, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 3. Animated Shoes / Feet
    const stride = speed > 0.4 ? Math.sin(this.time * 14 + p.seat) * 0.22 : 0;
    for (const side of [-1, 1]) {
      const fProj = this.project(p.x + side * 0.2, 0.12 + Math.max(0, side * stride * 0.4), p.z + side * stride * 0.35, W, H);
      if (!fProj) continue;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(fProj.x, fProj.y, 0.17 * fProj.scale, 0.11 * fProj.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1.2, 0.04 * fProj.scale);
      ctx.stroke();
    }

    // 4. Arcade-Style Tapered Jersey Torso
    const bodyW = 0.40 * torso.scale;
    const bodyH = 0.62 * torso.scale;
    const bodyGrad = ctx.createLinearGradient(torso.x - bodyW, torso.y - bodyH, torso.x + bodyW, torso.y + bodyH);
    bodyGrad.addColorStop(0, p.accent || p.color);
    bodyGrad.addColorStop(1, p.color);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(torso.x - bodyW * 0.72, torso.y - bodyH * 0.6);
    ctx.quadraticCurveTo(torso.x, torso.y - bodyH * 0.78, torso.x + bodyW * 0.72, torso.y - bodyH * 0.6);
    ctx.lineTo(torso.x + bodyW, torso.y + bodyH * 0.65);
    ctx.quadraticCurveTo(torso.x, torso.y + bodyH * 0.85, torso.x - bodyW, torso.y + bodyH * 0.65);
    ctx.closePath();
    ctx.fill();

    // Crisp white jersey trim & back number
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1.2, 0.045 * torso.scale);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `800 ${Math.max(9, Math.round(0.32 * torso.scale))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.seat + 1), torso.x, torso.y + bodyH * 0.08);

    // 5. Glossy Spherical Avatar Head + Sport Visor
    const headR = 0.34 * head.scale;
    const headGrad = ctx.createRadialGradient(
      head.x - headR * 0.3, head.y - headR * 0.35, headR * 0.1,
      head.x, head.y, headR
    );
    headGrad.addColorStop(0, '#fef3c7');
    headGrad.addColorStop(0.75, '#fcd34d');
    headGrad.addColorStop(1, '#d97706');
    ctx.fillStyle = headGrad;
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
      ctx.arc(head.x + headR * 0.32, head.y + headR * 0.06, headR * 0.11, 0, Math.PI * 2);
      ctx.fill();
      // Smile
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = Math.max(1, headR * 0.08);
      ctx.beginPath();
      ctx.arc(head.x, head.y + headR * 0.22, headR * 0.26, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
    }

    // 6. Articulated Floating Hand + 3D Tennis Racket (tracks live phone gyro & swing animation!)
    this._drawPlayerRacket(ctx, W, H, p, runBob);

    // 7. Clean Player Name Tag below feet
    const tagY = foot.y + Math.max(12, 0.42 * s);
    const label = p.isHuman ? p.name : `${p.name}`;
    ctx.font = `700 ${Math.max(10, Math.round(12 * (W / 1280)))}px system-ui, sans-serif`;
    const tw = ctx.measureText(label).width + 16;
    const th = Math.max(16, 20 * (W / 1280));
    ctx.fillStyle = p.isHuman ? 'rgba(15, 23, 42, 0.82)' : 'rgba(15, 23, 42, 0.52)';
    this._roundRect(ctx, foot.x - tw / 2, tagY - th / 2, tw, th, th / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, foot.x, tagY);

    // Server badge beside name if serving
    if (st && st.serverSeat === p.seat && st.phase !== PHASE.LOBBY) {
      ctx.fillStyle = '#eaff00';
      ctx.beginPath();
      ctx.arc(foot.x + tw / 2 + 8, tagY, Math.max(4, 5.5 * (W / 1280)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawPlayerRacket(ctx, W, H, p, runBob) {
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

    // Floating spherical hand
    ctx.fillStyle = '#fde68a';
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
        ctx.strokeStyle = 'rgba(234, 255, 0, 0.58)';
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
      const sw = b.sweetSpotWindow || 0;
      const ringR = Math.max(12, (0.55 - sw * 0.25) * bp.scale);
      ctx.strokeStyle = sw > 0.7 ? '#facc15' : 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = sw > 0.7 ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      if (sw > 0.7) {
        ctx.fillStyle = '#fef08a';
        ctx.font = `900 ${Math.max(14, Math.round(18 * (W / 1280)))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('SWING!', bp.x, bp.y - ringR - 10);
      }
    }

    // 3. Optic-Yellow Tennis Ball with Gloss & Curved Seam
    const r = Math.max(4.5, 0.145 * bp.scale);
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

    const ballGrad = ctx.createRadialGradient(bp.x - r * 0.3, bp.y - r * 0.3, r * 0.1, bp.x, bp.y, r);
    ballGrad.addColorStop(0, '#f7fee7');
    ballGrad.addColorStop(0.45, '#d9f99d');
    ballGrad.addColorStop(1, '#a3e635');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Subtle white tennis seam
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.arc(bp.x - r * 0.35, bp.y, r * 0.65, -0.8, 0.8);
    ctx.stroke();
  }

  _updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      if (!pt.confetti) pt.vy -= 9.8 * dt;
      else pt.vx += Math.sin(this.time * 6 + i) * dt * 1.4;
      pt.x += pt.vx * dt;
      pt.y = Math.max(0.02, pt.y + pt.vy * dt);
      pt.z += pt.vz * dt;
    }
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
    const scale = W / 1280;
    const pad = 22 * scale;

    // 1. Top-Left Glossy Score Bug
    if (st.phase !== PHASE.LOBBY) {
      const boxW = 308 * scale;
      const boxH = 92 * scale;

      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
      this._roundRect(ctx, pad, pad, boxW, boxH, 16 * scale);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 2 * scale;
      ctx.stroke();

      const drawRow = (teamIdx, yOff, label, color, games, pts, isServing) => {
        const ry = pad + yOff * scale;
        // Team color pill
        ctx.fillStyle = color;
        this._roundRect(ctx, pad + 12 * scale, ry, 8 * scale, 28 * scale, 4 * scale);
        ctx.fill();

        // Team label
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${Math.round(18 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, pad + 30 * scale, ry + 14 * scale);

        if (isServing) {
          ctx.fillStyle = '#eaff00';
          ctx.beginPath();
          ctx.arc(pad + 178 * scale, ry + 14 * scale, 5.5 * scale, 0, Math.PI * 2);
          ctx.fill();
        }

        // Games box
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        this._roundRect(ctx, pad + 196 * scale, ry, 42 * scale, 28 * scale, 7 * scale);
        ctx.fill();
        ctx.fillStyle = '#e2e8f0';
        ctx.font = `800 ${Math.round(18 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(games), pad + 217 * scale, ry + 14 * scale);

        // Current Point box
        ctx.fillStyle = '#ffffff';
        this._roundRect(ctx, pad + 246 * scale, ry, 50 * scale, 28 * scale, 7 * scale);
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = `900 ${Math.round(19 * scale)}px system-ui, sans-serif`;
        ctx.fillText(String(pts), pad + 271 * scale, ry + 14 * scale);
      };

      const serverTeam = st.players[st.serverSeat]?.team ?? 0;
      drawRow(0, 14, 'BLUE TEAM', '#3b82f6', st.games[0], st.scoreText.blue, serverTeam === TEAMS.BLUE);
      drawRow(1, 50, 'RED TEAM', '#ef4444', st.games[1], st.scoreText.red, serverTeam === TEAMS.RED);
      ctx.restore();

      // 2. Shot Speed Radar + Rally Pill (Top Right, positioned below .tv-toolbar)
      if (st.lastShotMph > 0 || st.rallyCount > 1) {
        const pillW = 190 * scale;
        const pillH = 66 * scale;
        const px = W - pad - pillW;
        const py = pad + 52 * scale;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.80)';
        this._roundRect(ctx, px, py, pillW, pillH, 14 * scale);
        ctx.fill();

        ctx.fillStyle = '#38bdf8';
        ctx.font = `800 ${Math.round(12 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText('RADAR', px + 14 * scale, py + 20 * scale);

        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${Math.round(24 * scale)}px system-ui, sans-serif`;
        ctx.fillText(`${st.lastShotMph} MPH`, px + 14 * scale, py + 47 * scale);

        if (st.rallyCount > 1) {
          ctx.fillStyle = '#facc15';
          ctx.font = `800 ${Math.round(13 * scale)}px system-ui, sans-serif`;
          ctx.textAlign = 'right';
          ctx.fillText(`RALLY ×${st.rallyCount}`, px + pillW - 14 * scale, py + 20 * scale);
        }
        ctx.restore();
      }
    }

    // 3. Subtle Room Code Badge (Bottom Right so friends can join even during AirPlay stream)
    if (this.roomCode) {
      const cw = 158 * scale;
      const ch = 36 * scale;
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.68)';
      this._roundRect(ctx, W - pad - cw, H - pad - ch, cw, ch, 18 * scale);
      ctx.fill();
      ctx.fillStyle = '#94a3b8';
      ctx.font = `700 ${Math.round(12 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('ROOM', W - pad - cw + 14 * scale, H - pad - ch / 2);
      ctx.fillStyle = '#facc15';
      ctx.font = `900 ${Math.round(17 * scale)}px ui-monospace, monospace`;
      ctx.textAlign = 'right';
      ctx.fillText(this.roomCode, W - pad - 14 * scale, H - pad - ch / 2);
      ctx.restore();
    }

    // 4. Serve Prompt Banner
    if (st.phase === PHASE.SERVE_READY) {
      const srv = st.players[st.serverSeat];
      if (srv && srv.isHuman) {
        const msg = `${srv.name.toUpperCase()} TO SERVE — FLICK UP TO TOSS!`;
        const bw = Math.min(W * 0.72, 540 * scale);
        const bh = 44 * scale;
        const bx = (W - bw) / 2;
        const by = H - 84 * scale;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        this._roundRect(ctx, bx, by, bw, bh, 22 * scale);
        ctx.fill();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${Math.round(16 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(msg, W / 2, by + bh / 2);
        ctx.restore();
      }
    }

    // 5. Dynamic Pop-in Center Callout Banner (ACE!, DEUCE!, OUT!, GAME SET MATCH!)
    if (st.callout) {
      const age = st.clock - st.callout.at;
      const pop = clamp(age / 0.16, 0.2, 1);
      const fade = age > 1.85 ? clamp(1 - (age - 1.85) / 0.55, 0, 1) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(W / 2, H * 0.30);
      ctx.scale(0.8 + 0.2 * pop, 0.8 + 0.2 * pop);

      ctx.font = `900 ${Math.round(44 * scale)}px system-ui, sans-serif`;
      const text = st.callout.text;
      const tw = ctx.measureText(text).width + 64 * scale;
      const th = 72 * scale;

      const bg = st.callout.kind === 'fault' || st.callout.kind === 'out'
        ? 'rgba(220, 38, 38, 0.92)'
        : (st.callout.kind === 'ace' || st.callout.kind === 'match_win'
          ? 'rgba(234, 179, 8, 0.95)'
          : 'rgba(37, 99, 235, 0.92)');

      ctx.fillStyle = bg;
      this._roundRect(ctx, -tw / 2, -th / 2, tw, th, 36 * scale);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4 * scale;
      ctx.stroke();

      ctx.fillStyle = st.callout.kind === 'ace' || st.callout.kind === 'match_win' ? '#0f172a' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 2 * scale);
      ctx.restore();
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
}
