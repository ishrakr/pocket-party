// 60 FPS 3D-Projected Party Bowling Alley Renderer on HTML5 Canvas.
// Shares the same interface as CourtRenderer so TV displays & AirPlay streams swap cleanly.
import { BOWLING_LANE, BOWLING_PHASE, clamp } from '../../shared/protocol.js';
import { HUD, Perspective, drawCallout, drawPrompt, drawRadar, drawRoomCode, fillPanel, roundRect, setFont } from './hud-theme.js';

const MAX_PARTICLES = 112;
const loungeRail = '#6382AF';
// In the aim view, float the preview ball just beyond the foul line to keep
// it readable above the lower-third. The simulated roll still starts at z=0.
const AIM_BALL_Z = -0.65;

export class BowlingRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showEmbeddedHud = options.showEmbeddedHud ?? true;
    this.roomCode = '';

    this.state = null;
    this.time = 0;
    this.cam = { x: 0, y: 2.35, z: 4.3, lookY: 0.42, lookZ: -12.0, fov: 50 };
    this._view = new Perspective(0.5, 0.3);
    this._palette = {};
    this._ballGradients = new Map();

    this.ballTrail = [];
    this.particles = [];
    this._raf = null;
    this._lastFrame = performance.now();
  }

  setRoomCode(code) {
    this.roomCode = code || '';
  }

  updateState(newState) {
    this.state = newState;
    if (newState?.ball?.inPlay) {
      this.ballTrail.push({
        x: newState.ball.x,
        y: newState.ball.y,
        z: newState.ball.z
      });
      if (this.ballTrail.length > 22) this.ballTrail.shift();
    } else if (newState?.phase === BOWLING_PHASE.AIMING || newState?.phase === BOWLING_PHASE.LOBBY) {
      this.ballTrail.length = 0;
    }
  }

  handleGameEvent(evt) {
    if (!evt) return;
    if (evt.type === 'pin_hit') {
      this._spawnBurst(evt.x || 0, 0.25, evt.z || BOWLING_LANE.HEADPIN_Z, 12, '#fef08a', 4.4);
    } else if (evt.type === 'roll_over' && (evt.isStrike || evt.isSpare)) {
      this._spawnBurst(0, 0.6, BOWLING_LANE.HEADPIN_Z, evt.isStrike ? 32 : 20, evt.isStrike ? '#facc15' : '#38bdf8', 5.8);
    } else if (evt.type === 'match_over') {
      this.particles.length = Math.min(this.particles.length, MAX_PARTICLES - 65);
      for (let i = 0; i < 65; i++) {
        this.particles.push({
          x: (Math.random() - 0.5) * 3.5,
          y: 2.2 + Math.random() * 2.5,
          z: -6 - Math.random() * 12,
          vx: (Math.random() - 0.5) * 2.4,
          vy: -0.9 - Math.random() * 1.1,
          vz: (Math.random() - 0.5) * 2.4,
          color: ['#facc15', '#38bdf8', '#fb7185', '#4ade80', '#ffffff'][i % 5],
          size: 0.08,
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
      const elev = (Math.random() - 0.1) * Math.PI * 0.6;
      const sp = speed * (0.4 + Math.random() * 0.7);
      this.particles.push({
        x, y, z,
        vx: Math.cos(a) * Math.cos(elev) * sp,
        vy: Math.sin(elev) * sp + 1.2,
        vz: Math.sin(a) * Math.cos(elev) * sp,
        color,
        size: 0.045 + Math.random() * 0.04,
        life: 0.42 + Math.random() * 0.25,
        maxLife: 0.67,
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

  project(wx, wy, wz, W, H) {
    return this._view.project(this.cam, wx, wy, wz, W, H);
  }

  render(dt = 0.016) {
    this.time += dt;
    this._updateParticles(dt);

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const st = this.state;

    // Dynamic Alley Camera: glides closer as ball approaches the pins
    let targetCamX = 0;
    let targetCamY = 2.35;
    let targetCamZ = 4.3;
    let targetLookZ = -12.0;

    if (st && (st.phase === BOWLING_PHASE.ROLLING || st.phase === BOWLING_PHASE.PIN_SETTLE)) {
      const bz = st.ball?.z ?? 0;
      targetCamX = clamp((st.ball?.x ?? 0) * 0.35, -0.35, 0.35);
      targetCamZ = clamp(bz + 5.6, -11.2, 4.3);
      targetCamY = clamp(2.35 - Math.max(0, -bz) * 0.032, 1.55, 2.35);
      targetLookZ = -18.5;
    } else if (!st || st.phase === BOWLING_PHASE.LOBBY) {
      targetCamX = Math.sin(this.time * 0.4) * 0.28;
    }

    const shake = st && st.cameraImpulse > 0 ? (Math.random() - 0.5) * st.cameraImpulse * 0.09 : 0;
    this.cam.x += (targetCamX - this.cam.x) * Math.min(1, dt * 4.5) + shake;
    this.cam.y += (targetCamY - this.cam.y) * Math.min(1, dt * 3.5) + shake * 0.5;
    this.cam.z += (targetCamZ - this.cam.z) * Math.min(1, dt * 3.5);
    this.cam.lookZ += (targetLookZ - this.cam.lookZ) * Math.min(1, dt * 3.5);
    this._view.update(this.cam, W, H);

    this._drawAlleyBackdrop(ctx, W, H);
    this._drawLaneAndMarkings(ctx, W, H, st);

    // Depth-sorted actors: pins, ball, bowler
    const drawQueue = [];
    if (st?.pins) {
      for (const pin of st.pins) {
        if (pin.cleared) continue;
        drawQueue.push({ z: pin.z, draw: () => this._drawPin(ctx, W, H, pin) });
      }
    }
    if (st?.ball?.visible) {
      drawQueue.push({ z: st.ball.z, draw: () => this._drawBall(ctx, W, H, st) });
    }
    if (st?.players) {
      if (st.phase === BOWLING_PHASE.LOBBY) {
        for (const p of st.players) {
          if (!p.active) continue;
          drawQueue.push({ z: p.z, draw: () => this._drawBowler(ctx, W, H, p) });
        }
      } else if (st.phase === BOWLING_PHASE.ROLLING) {
        // Stage the follow-through beside the approach, never in the ball's path.
        const bowler = st.players[st.activeSeat];
        if (bowler?.swingTimer > 0) drawQueue.push({ z: bowler.z, draw: () => this._drawBowler(ctx, W, H, bowler, bowler.x < 0 ? -0.98 : 0.98) });
      }
    }

    drawQueue.sort((a, b) => a.z - b.z);
    for (const item of drawQueue) item.draw();

    this._drawParticles(ctx, W, H);

    if (this.showEmbeddedHud && st) {
      this._drawBroadcastHud(ctx, W, H, st);
    }
  }

  _drawAlleyBackdrop(ctx, W, H) {
    if (this._palette.W !== W || this._palette.H !== H) {
      const lounge = ctx.createLinearGradient(0, 0, 0, H);
      lounge.addColorStop(0, '#101B34');
      lounge.addColorStop(0.46, '#243B64');
      lounge.addColorStop(1, '#0B1428');
      const maple = ctx.createLinearGradient(0, H * 0.39, 0, H);
      maple.addColorStop(0, '#E2B77A');
      maple.addColorStop(0.43, '#D6A771');
      maple.addColorStop(1, '#C8925A');
      const sheen = ctx.createLinearGradient(0, H * 0.46, 0, H);
      sheen.addColorStop(0, 'rgba(255, 237, 201, 0.06)');
      sheen.addColorStop(0.4, 'rgba(255, 237, 201, 0.16)');
      sheen.addColorStop(1, 'rgba(255, 237, 201, 0.03)');
      this._palette = { W, H, lounge, maple, sheen, dash: [7 * W / 1280, 6 * W / 1280] };
    }
    ctx.fillStyle = this._palette.lounge;
    ctx.fillRect(0, 0, W, H);

    // Blue acoustic panels along the lane, with quiet horizontal light strips.
    for (const side of [-1, 1]) {
      const near = Math.min(2.2, this.cam.z - 0.9);
      this._drawQuad(ctx, [
        this.project(side * 2.8, 3.6, -20, W, H), this.project(side * 2.8, 3.6, near, W, H),
        this.project(side * 2.8, 0, near, W, H), this.project(side * 2.8, 0, -20, W, H)
      ], '#142540');
      const farRail = this.project(side * 2.79, 1.44, -20, W, H);
      const nearRail = this.project(side * 2.79, 1.44, near, W, H);
      if (farRail && nearRail) {
        ctx.strokeStyle = '#314E76';
        ctx.lineWidth = Math.max(1, 2 * W / 1280);
        ctx.beginPath();
        ctx.moveTo(farRail.x, farRail.y);
        ctx.lineTo(nearRail.x, nearRail.y);
        ctx.stroke();
      }
    }

    // Pinsetter mask and a row of recessed ceiling lights give the lane a back wall.
    this._drawQuad(ctx, [
      this.project(-2.7, 1.10, -20, W, H), this.project(2.7, 1.10, -20, W, H),
      this.project(2.7, 0, -20, W, H), this.project(-2.7, 0, -20, W, H)
    ], '#0C162B');
    for (let lightZ = -18; lightZ <= -4; lightZ += 7) {
      if (lightZ + 0.7 >= this.cam.z - 0.9) continue;
      this._drawQuad(ctx, [
        this.project(-0.95, 3.59, lightZ, W, H), this.project(0.95, 3.59, lightZ, W, H),
        this.project(0.95, 3.59, lightZ + 0.7, W, H), this.project(-0.95, 3.59, lightZ + 0.7, W, H)
      ], '#456186');
    }

    // Overhead lane marquee; maxWidth keeps the text inset at any camera distance.
    const pL = this.project(-1.5, 2.2, -19.8, W, H);
    const pR = this.project(1.5, 2.2, -19.8, W, H);
    const pBR = this.project(1.5, 1.25, -19.8, W, H);
    const pBL = this.project(-1.5, 1.25, -19.8, W, H);
    if (pL && pR && pBR && pBL) {
      this._drawQuad(ctx, [pL, pR, pBR, pBL], HUD.courtNight);
      ctx.strokeStyle = loungeRail;
      ctx.lineWidth = Math.max(1, 1.5 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(pL.x, pL.y);
      ctx.lineTo(pR.x, pR.y);
      ctx.stroke();

      const mid = this.project(0, 1.72, -19.75, W, H);
      if (mid) {
        ctx.save();
        ctx.fillStyle = HUD.chalk;
        setFont(ctx, 850, 0.36 * mid.scale, 'expanded');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('STRIKE ZONE', mid.x, mid.y, (pR.x - pL.x) * 0.8);
        ctx.restore();
      }
    }
  }

  _drawLaneAndMarkings(ctx, W, H, st) {
    const hw = BOWLING_LANE.HALF_WIDTH;
    const gw = BOWLING_LANE.GUTTER_WIDTH;
    const farZ = -19.7;
    // Keep projected foreground vertices ahead of the camera as it tracks the roll.
    const nearZ = Math.min(2.2, this.cam.z - 0.9);

    // Neighboring dark alley floor surround
    const floorPts = [
      this.project(-2.8, -0.04, farZ, W, H),
      this.project(2.8, -0.04, farZ, W, H),
      this.project(2.8, -0.04, nearZ, W, H),
      this.project(-2.8, -0.04, nearZ, W, H)
    ];
    this._drawQuad(ctx, floorPts, '#101B30');

    // Left & Right Gutters
    for (const sign of [-1, 1]) {
      const gxIn = sign * hw;
      const gxOut = sign * (hw + gw);
      const pts = [
        this.project(Math.min(gxIn, gxOut), -0.03, farZ, W, H),
        this.project(Math.max(gxIn, gxOut), -0.03, farZ, W, H),
        this.project(Math.max(gxIn, gxOut), -0.03, nearZ, W, H),
        this.project(Math.min(gxIn, gxOut), -0.03, nearZ, W, H)
      ];
      this._drawQuad(ctx, pts, '#080F20');
    }

    // Glowing neon gutter bumper rails
    for (const railX of [-(hw + gw), hw + gw]) {
      const r1 = this.project(railX, 0.04, farZ, W, H);
      const r2 = this.project(railX, 0.04, nearZ, W, H);
      if (r1 && r2) {
        ctx.strokeStyle = loungeRail;
        ctx.lineWidth = Math.max(1, 2 * (W / 1280));
        ctx.beginPath();
        ctx.moveTo(r1.x, r1.y);
        ctx.lineTo(r2.x, r2.y);
        ctx.stroke();
      }
    }

    // Polished Maple Lane Surface
    const lanePts = [
      this.project(-hw, 0, farZ, W, H),
      this.project(hw, 0, farZ, W, H),
      this.project(hw, 0, nearZ, W, H),
      this.project(-hw, 0, nearZ, W, H)
    ];
    this._drawQuad(ctx, lanePts, this._palette.maple);
    this._drawQuad(ctx, [
      this.project(-0.28, 0, farZ, W, H), this.project(-0.06, 0, farZ, W, H),
      this.project(-0.06, 0, nearZ, W, H), this.project(-0.28, 0, nearZ, W, H)
    ], this._palette.sheen);

    // Subtle maple wood plank seams
    ctx.strokeStyle = 'rgba(101, 54, 34, 0.19)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -7; i <= 7; i++) {
      const px = (i / 8) * hw;
      const a = this.project(px, 0.004, farZ, W, H);
      const b = this.project(px, 0.004, nearZ, W, H);
      if (a && b) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.stroke();

    // Dark pin deck zone at far end
    const deckPts = [
      this.project(-hw, 0.005, farZ, W, H),
      this.project(hw, 0.005, farZ, W, H),
      this.project(hw, 0.005, BOWLING_LANE.HEADPIN_Z + 0.35, W, H),
      this.project(-hw, 0.005, BOWLING_LANE.HEADPIN_Z + 0.35, W, H)
    ];
    this._drawQuad(ctx, deckPts, 'rgba(15, 23, 42, 0.22)');

    // Foul Line at z = 0
    const fl1 = nearZ >= 0 ? this.project(-hw, 0.008, 0, W, H) : null;
    const fl2 = nearZ >= 0 ? this.project(hw, 0.008, 0, W, H) : null;
    if (fl1 && fl2) {
      ctx.strokeStyle = HUD.courtNight;
      ctx.lineWidth = Math.max(3, 5 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(fl1.x, fl1.y);
      ctx.lineTo(fl2.x, fl2.y);
      ctx.stroke();
    }

    // 7 Rangefinder Arrows at z = -4.6
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.beginPath();
    for (let i = -3; i <= 3; i++) {
      const ax = i * 0.13;
      const az = -4.6 + Math.abs(i) * 0.22;
      if (az > nearZ) continue;
      const tip = this.project(ax, 0.008, az - 0.26, W, H);
      const left = this.project(ax - 0.032, 0.008, az, W, H);
      const right = this.project(ax + 0.032, 0.008, az, W, H);
      if (tip && left && right) {
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(left.x, left.y);
        ctx.closePath();
      }
    }
    ctx.fill();

    // Live Aim & Hook Trajectory Preview during AIMING
    if (st?.phase === BOWLING_PHASE.AIMING) {
      const startX = st.aimX ?? 0;
      const angle = st.aimAngle ?? 0;
      const spin = st.previewSpin ?? 0;
      let sx = startX;
      let svx = Math.sin(angle) * 8.5;
      const svz = -Math.cos(angle) * 8.5;
      let sz = 0;
      let hasPoint = false;
      ctx.save();
      ctx.beginPath();
      const simDt = 0.06;
      for (let i = 0; i < 40; i++) {
        if (sz <= AIM_BALL_Z) {
          const proj = this.project(sx, 0.025, sz, W, H);
          if (proj) {
            if (hasPoint) ctx.lineTo(proj.x, proj.y);
            else ctx.moveTo(proj.x, proj.y);
            hasPoint = true;
          }
        }
        if (sz <= BOWLING_LANE.HEADPIN_Z || Math.abs(sx) >= hw + gw) break;
        const progress = clamp(-sz / BOWLING_LANE.LENGTH, 0, 1);
        const hookZone = progress > 0.60 ? 1.0 : 0.18;
        svx += spin * 2.15 * hookZone * simDt;
        const nextX = sx + svx * simDt;
        const edge = hw + gw;
        const step = Math.abs(nextX) > edge ? (Math.sign(nextX) * edge - sx) / (nextX - sx) : 1;
        sx = clamp(sx + (nextX - sx) * step, -edge, edge);
        sz = Math.max(BOWLING_LANE.HEADPIN_Z, sz + svz * simDt * step);
      }
      ctx.lineCap = 'round';
      ctx.setLineDash(this._palette.dash);
      ctx.strokeStyle = 'rgba(26, 38, 0, 0.68)';
      ctx.lineWidth = Math.max(3, 5 * W / 1280);
      ctx.stroke();
      ctx.strokeStyle = HUD.ball;
      ctx.lineWidth = Math.max(2, 2.8 * W / 1280);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawPin(ctx, W, H, pin) {
    const base = this.project(pin.x, 0, pin.z, W, H);
    if (!base) return;
    const s = base.scale;

    ctx.save();
    ctx.translate(base.x, base.y);
    if (!pin.standing && pin.tilt > 0) {
      const leanAngle = pin.tilt * Math.PI * 0.48 * Math.sign(pin.tiltDirX || 0.4);
      ctx.rotate(leanAngle);
    }

    const h = BOWLING_LANE.PIN_HEIGHT * s;
    const w = BOWLING_LANE.PIN_RADIUS * 1.9 * s;

    // Ground shadow
    ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.85, w * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();

    // Bowling pin body silhouette
    ctx.fillStyle = '#f8fafc';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = Math.max(1, 0.015 * s);
    ctx.beginPath();
    ctx.moveTo(-w * 0.48, 0);
    ctx.quadraticCurveTo(-w * 0.72, -h * 0.35, -w * 0.32, -h * 0.68);
    ctx.quadraticCurveTo(-w * 0.44, -h * 0.92, 0, -h);
    ctx.quadraticCurveTo(w * 0.44, -h * 0.92, w * 0.32, -h * 0.68);
    ctx.quadraticCurveTo(w * 0.72, -h * 0.35, w * 0.48, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Classic Twin Red Neck Stripes
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-w * 0.34, -h * 0.72, w * 0.68, Math.max(1.5, h * 0.065));
    ctx.fillRect(-w * 0.36, -h * 0.60, w * 0.72, Math.max(1.5, h * 0.055));

    ctx.restore();
  }

  _drawBall(ctx, W, H, st) {
    const b = st.ball;

    // Motion Trail
    if (this.ballTrail.length > 1 && b.inPlay) {
      for (let i = 1; i < this.ballTrail.length; i++) {
        const a = this.project(this.ballTrail[i - 1].x, this.ballTrail[i - 1].y, this.ballTrail[i - 1].z, W, H);
        const c = this.project(this.ballTrail[i].x, this.ballTrail[i].y, this.ballTrail[i].z, W, H);
        if (!a || !c) continue;
        const frac = i / this.ballTrail.length;
        ctx.strokeStyle = b.inGutter ? '#ef4444' : '#38bdf8';
        ctx.globalAlpha = frac * 0.55;
        ctx.lineWidth = Math.max(2, BOWLING_LANE.BALL_RADIUS * 1.4 * c.scale * frac);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const z = st.phase === BOWLING_PHASE.AIMING ? AIM_BALL_Z : b.z;
    const bp = this.project(b.x, b.y, z, W, H);
    const sh = this.project(b.x, 0.005, z, W, H);
    if (!bp) return;

    const r = Math.max(5, BOWLING_LANE.BALL_RADIUS * bp.scale);
    if (sh) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.42)';
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, r * 1.05, r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const bowler = st.players?.[st.activeSeat];
    const baseColor = bowler?.color || '#2563eb';
    const accentColor = bowler?.accent || '#60a5fa';
    const seat = bowler?.seat ?? 0;
    let ink = this._ballGradients.get(seat);
    if (!ink || ink.baseColor !== baseColor || ink.accentColor !== accentColor) {
      const gradient = ctx.createRadialGradient(-0.3, -0.35, 0.1, 0, 0, 1);
      gradient.addColorStop(0, accentColor);
      gradient.addColorStop(0.55, baseColor);
      gradient.addColorStop(1, '#0F1B31');
      ink = { baseColor, accentColor, gradient };
      this._ballGradients.set(seat, ink);
    }

    ctx.save();
    ctx.translate(bp.x, bp.y);
    ctx.scale(r, r);
    ctx.fillStyle = ink.gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();

    // Rolling spin highlight ring
    ctx.rotate(b.rotAngle || 0);
    ctx.fillStyle = 'rgba(8, 15, 32, 0.70)';
    ctx.beginPath();
    ctx.arc(0.28, -0.26, 0.15, 0, Math.PI * 2);
    ctx.moveTo(0.58, -0.1);
    ctx.arc(0.45, -0.1, 0.13, 0, Math.PI * 2);
    ctx.moveTo(0.46, 0.15);
    ctx.arc(0.29, 0.15, 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawBowler(ctx, W, H, p, x = p.x) {
    const foot = this.project(x, 0, p.z, W, H);
    const torso = this.project(x, 0.95, p.z, W, H);
    const head = this.project(x, 1.54, p.z, W, H);
    if (!foot || !torso || !head) return;

    const s = foot.scale;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, 0.32 * s, 0.14 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const bodyW = 0.25 * torso.scale;
    const bodyH = 0.44 * torso.scale;
    ctx.fillStyle = p.color;
    roundRect(ctx, torso.x - bodyW, torso.y - bodyH * 0.65, bodyW * 2, bodyH * 1.35, bodyW * 0.26);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    setFont(ctx, 800, Math.max(9, 0.24 * torso.scale));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.seat + 1), torso.x, torso.y);

    const headR = 0.22 * head.scale;
    ctx.fillStyle = '#D9A67E';
    ctx.beginPath();
    ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(head.x, head.y - headR * 0.15, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
  }

  _updateParticles(dt) {
    let count = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) continue;
      if (!pt.confetti) pt.vy -= 9.8 * dt;
      else pt.vx += Math.sin(this.time * 6 + i) * dt * 0.9;
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
      ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
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
    if (st.phase !== BOWLING_PHASE.LOBBY) {
      this._drawScoreboard(ctx, s, st);
      drawRadar(ctx, W, s, st.lastShotMph);
    }
    drawRoomCode(ctx, W, H, s, this.roomCode);
    if (st.phase === BOWLING_PHASE.AIMING) {
      const active = st.players?.[st.activeSeat];
      if (active?.isHuman) drawPrompt(ctx, W, H, s, `${active.name} to bowl — swing forward to roll`);
    }
    drawCallout(ctx, W, H, s, st.callout, st.clock);
  }

  _drawScoreboard(ctx, s, st) {
    const x = HUD.pad * s;
    const y = HUD.pad * s;
    const w = 248 * s;
    let count = 0;
    for (const p of st.players) if (p.active) count++;
    ctx.save();
    fillPanel(ctx, x, y, w, (36 + count * 28) * s, s);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    setFont(ctx, 800, 12 * s, 'condensed');
    ctx.fillStyle = HUD.chalk;
    ctx.fillText(`FRAME ${st.currentFrame}/${st.totalFrames}`, x + 12 * s, y + 15 * s);
    ctx.fillStyle = HUD.chalkDim;
    ctx.fillText(`BALL ${st.currentRoll}`, x + 89 * s, y + 15 * s);
    ctx.textAlign = 'center';
    ctx.fillText('TOTAL', x + 216 * s, y + 15 * s);
    ctx.fillStyle = 'rgba(169, 183, 214, 0.25)';
    ctx.fillRect(x + 12 * s, y + 27 * s, w - 24 * s, s);

    let row = 0;
    for (const p of st.players) {
      if (!p.active) continue;
      const ry = y + (32 + row++ * 28) * s;
      if (p.seat === st.activeSeat && st.phase !== BOWLING_PHASE.MATCH_OVER) {
        ctx.fillStyle = HUD.ball;
        ctx.fillRect(x + 3 * s, ry + 2 * s, 3 * s, 20 * s);
      }
      ctx.fillStyle = p.color;
      roundRect(ctx, x + 12 * s, ry + 7 * s, 9 * s, 10 * s, 2 * s);
      ctx.fill();
      ctx.fillStyle = HUD.chalk;
      ctx.textAlign = 'left';
      setFont(ctx, 750, 15 * s, 'semi-condensed');
      ctx.fillText(p.name, x + 28 * s, ry + 12 * s, 106 * s);
      ctx.textAlign = 'center';
      setFont(ctx, 800, 14 * s, 'condensed');
      ctx.fillStyle = HUD.chalkDim;
      const marks = p.frames?.[st.currentFrame - 1]?.display;
      for (let i = 0; i < 3; i++) {
        if (marks?.[i]) ctx.fillText(marks[i], x + (145 + i * 14) * s, ry + 12 * s);
      }
      ctx.fillStyle = HUD.chalk;
      roundRect(ctx, x + 194 * s, ry, 44 * s, 24 * s, HUD.chipRadius * s);
      ctx.fill();
      ctx.fillStyle = HUD.courtNight;
      setFont(ctx, 850, 17 * s, 'condensed');
      ctx.fillText(String(p.totalScore ?? 0), x + 216 * s, ry + 12 * s);
    }
    ctx.restore();
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

}
