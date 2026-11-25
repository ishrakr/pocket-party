// 60 FPS 3D-Projected Party Bowling Alley Renderer on HTML5 Canvas.
// Shares the same interface as CourtRenderer so TV displays & AirPlay streams swap cleanly.
import { BOWLING_LANE, BOWLING_PHASE, clamp } from '../../shared/protocol.js';

export class BowlingRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showEmbeddedHud = options.showEmbeddedHud ?? true;
    this.roomCode = '';

    this.state = null;
    this.time = 0;
    this.cam = { x: 0, y: 2.35, z: 4.3, lookY: 0.42, lookZ: -12.0, fov: 50 };

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
    for (let i = 0; i < count; i++) {
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
    const dx = wx - this.cam.x;
    const dy = wy - this.cam.y;
    const dz = wz - this.cam.z;

    const lookDz = this.cam.lookZ - this.cam.z;
    const lookDy = this.cam.lookY - this.cam.y;
    const pitch = Math.atan2(lookDy, -lookDz);

    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    const forward = -dz * cosP + dy * sinP;
    const up = dy * cosP + dz * sinP;
    const right = dx;

    if (forward <= 0.3) return null;

    const focal = (H * 0.5) / Math.tan((this.cam.fov * Math.PI) / 360);
    const scale = focal / forward;
    return {
      x: W * 0.5 + right * scale,
      y: H * 0.50 - up * scale,
      scale,
      depth: forward
    };
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
      } else {
        const activeBowler = st.players[st.activeSeat];
        if (activeBowler) {
          drawQueue.push({ z: activeBowler.z, draw: () => this._drawBowler(ctx, W, H, activeBowler) });
        }
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
    // Vibrant neon bowling lounge gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0f172a');
    bg.addColorStop(0.45, '#1e1b4b');
    bg.addColorStop(1, '#090d16');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle cosmic spotlight glow above pin deck
    const deckPos = this.project(0, 1.8, BOWLING_LANE.HEADPIN_Z, W, H);
    if (deckPos) {
      const glow = ctx.createRadialGradient(deckPos.x, deckPos.y, 10, deckPos.x, deckPos.y, W * 0.36);
      glow.addColorStop(0, 'rgba(56, 189, 248, 0.32)');
      glow.addColorStop(0.5, 'rgba(168, 85, 247, 0.14)');
      glow.addColorStop(1, 'rgba(15, 23, 42, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
    }

    // Overhead neon marquee above pin deck
    const pL = this.project(-1.5, 2.2, -19.8, W, H);
    const pR = this.project(1.5, 2.2, -19.8, W, H);
    const pBR = this.project(1.5, 1.25, -19.8, W, H);
    const pBL = this.project(-1.5, 1.25, -19.8, W, H);
    if (pL && pR && pBR && pBL) {
      this._drawQuad(ctx, [pL, pR, pBR, pBL], '#0f172a');
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(2, 3 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(pL.x, pL.y);
      ctx.lineTo(pR.x, pR.y);
      ctx.lineTo(pBR.x, pBR.y);
      ctx.lineTo(pBL.x, pBL.y);
      ctx.closePath();
      ctx.stroke();

      const mid = this.project(0, 1.72, -19.75, W, H);
      if (mid) {
        ctx.fillStyle = '#facc15';
        ctx.font = `900 ${Math.round(Math.max(10, 0.34 * mid.scale))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('POCKETPARTY  •  STRIKE ZONE', mid.x, mid.y);
      }
    }
  }

  _drawLaneAndMarkings(ctx, W, H, st) {
    const hw = BOWLING_LANE.HALF_WIDTH;
    const gw = BOWLING_LANE.GUTTER_WIDTH;
    const farZ = -19.7;
    const nearZ = 2.2;

    // Neighboring dark alley floor surround
    const floorPts = [
      this.project(-2.8, -0.04, farZ, W, H),
      this.project(2.8, -0.04, farZ, W, H),
      this.project(2.8, -0.04, nearZ, W, H),
      this.project(-2.8, -0.04, nearZ, W, H)
    ];
    this._drawQuad(ctx, floorPts, '#111827');

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
      this._drawQuad(ctx, pts, '#020617');
    }

    // Glowing neon gutter bumper rails
    for (const railX of [-(hw + gw), hw + gw]) {
      const r1 = this.project(railX, 0.04, farZ, W, H);
      const r2 = this.project(railX, 0.04, nearZ, W, H);
      if (r1 && r2) {
        ctx.strokeStyle = railX < 0 ? '#38bdf8' : '#ec4899';
        ctx.lineWidth = Math.max(2, 4 * (W / 1280));
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
    const laneGrad = ctx.createLinearGradient(0, H * 0.35, 0, H);
    laneGrad.addColorStop(0, '#f59e0b');
    laneGrad.addColorStop(0.55, '#fbbf24');
    laneGrad.addColorStop(1, '#d97706');
    this._drawQuad(ctx, lanePts, laneGrad);

    // Subtle maple wood plank seams
    ctx.strokeStyle = 'rgba(120, 53, 15, 0.22)';
    ctx.lineWidth = 1;
    for (let i = -4; i <= 4; i++) {
      const px = (i / 5) * hw;
      const a = this.project(px, 0.004, farZ, W, H);
      const b = this.project(px, 0.004, nearZ, W, H);
      if (a && b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Dark pin deck zone at far end
    const deckPts = [
      this.project(-hw, 0.005, farZ, W, H),
      this.project(hw, 0.005, farZ, W, H),
      this.project(hw, 0.005, BOWLING_LANE.HEADPIN_Z + 0.35, W, H),
      this.project(-hw, 0.005, BOWLING_LANE.HEADPIN_Z + 0.35, W, H)
    ];
    this._drawQuad(ctx, deckPts, 'rgba(15, 23, 42, 0.22)');

    // Foul Line at z = 0
    const fl1 = this.project(-hw, 0.008, 0, W, H);
    const fl2 = this.project(hw, 0.008, 0, W, H);
    if (fl1 && fl2) {
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = Math.max(3, 5 * (W / 1280));
      ctx.beginPath();
      ctx.moveTo(fl1.x, fl1.y);
      ctx.lineTo(fl2.x, fl2.y);
      ctx.stroke();
    }

    // 7 Rangefinder Arrows at z = -4.6
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    for (let i = -3; i <= 3; i++) {
      const ax = i * 0.13;
      const az = -4.6 + Math.abs(i) * 0.22;
      const tip = this.project(ax, 0.008, az - 0.26, W, H);
      const left = this.project(ax - 0.032, 0.008, az, W, H);
      const right = this.project(ax + 0.032, 0.008, az, W, H);
      if (tip && left && right) {
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(left.x, left.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Live Aim & Hook Trajectory Preview during AIMING
    if (st?.phase === BOWLING_PHASE.AIMING) {
      const startX = st.aimX ?? 0;
      const angle = st.aimAngle ?? 0;
      const spin = st.previewSpin ?? 0;
      const pts = [];
      let sx = startX;
      let svx = Math.sin(angle) * 8.5;
      const svz = -Math.cos(angle) * 8.5;
      let sz = 0;
      const simDt = 0.06;
      for (let i = 0; i < 36; i++) {
        const progress = clamp(-sz / BOWLING_LANE.LENGTH, 0, 1);
        const hookZone = progress > 0.60 ? 1.0 : 0.18;
        svx += spin * 2.15 * hookZone * simDt;
        sx += svx * simDt;
        sz += svz * simDt;
        const proj = this.project(sx, 0.025, sz, W, H);
        if (proj) pts.push(proj);
        if (sz < BOWLING_LANE.HEADPIN_Z) break;
      }
      if (pts.length > 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
        ctx.lineWidth = Math.max(2, 3.5 * (W / 1280));
        ctx.setLineDash([8 * (W / 1280), 8 * (W / 1280)]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
      }
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

    const bp = this.project(b.x, b.y, b.z, W, H);
    const sh = this.project(b.x, 0.005, b.z, W, H);
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

    const grad = ctx.createRadialGradient(bp.x - r * 0.3, bp.y - r * 0.35, r * 0.1, bp.x, bp.y, r);
    grad.addColorStop(0, accentColor);
    grad.addColorStop(0.55, baseColor);
    grad.addColorStop(1, '#0f172a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Rolling spin highlight ring
    ctx.save();
    ctx.translate(bp.x, bp.y);
    ctx.rotate(b.rotAngle || 0);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    ctx.arc(r * 0.32, -r * 0.18, Math.max(1.5, r * 0.14), 0, Math.PI * 2);
    ctx.arc(r * 0.45, r * 0.08, Math.max(1.5, r * 0.12), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawBowler(ctx, W, H, p) {
    const foot = this.project(p.x, 0, p.z, W, H);
    const torso = this.project(p.x, 0.95, p.z, W, H);
    const head = this.project(p.x, 1.54, p.z, W, H);
    if (!foot || !torso || !head) return;

    const s = foot.scale;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, 0.32 * s, 0.14 * s, 0, 0, Math.PI * 2);
    ctx.fill();

    const bodyW = 0.25 * torso.scale;
    const bodyH = 0.44 * torso.scale;
    ctx.fillStyle = p.color;
    this._roundRect(ctx, torso.x - bodyW, torso.y - bodyH * 0.65, bodyW * 2, bodyH * 1.35, bodyW * 0.5);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `800 ${Math.max(9, Math.round(0.24 * torso.scale))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.seat + 1), torso.x, torso.y);

    const headR = 0.22 * head.scale;
    ctx.fillStyle = '#fcd34d';
    ctx.beginPath();
    ctx.arc(head.x, head.y, headR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(head.x, head.y - headR * 0.15, headR * 1.02, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fill();
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
      else pt.vx += Math.sin(this.time * 6 + i) * dt * 0.9;
      pt.x += pt.vx * dt;
      pt.y = Math.max(0.02, pt.y + pt.vy * dt);
      pt.z += pt.vz * dt;
    }
  }

  _drawParticles(ctx, W, H) {
    for (const pt of this.particles) {
      const p = this.project(pt.x, pt.y, pt.z, W, H);
      if (!p) continue;
      ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
      ctx.fillStyle = pt.color;
      const sz = Math.max(2, pt.size * p.scale);
      ctx.beginPath();
      ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawBroadcastHud(ctx, W, H, st) {
    const scale = W / 1280;
    const pad = 22 * scale;

    if (st.phase !== BOWLING_PHASE.LOBBY) {
      // 1. Top-Left Bowling Scoreboard
      const activePlayers = (st.players || []).filter((p) => p.active);
      const boxW = 340 * scale;
      const rowH = 32 * scale;
      const boxH = (26 + activePlayers.length * 32) * scale;

      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
      this._roundRect(ctx, pad, pad, boxW, boxH, 16 * scale);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 2 * scale;
      ctx.stroke();

      ctx.fillStyle = '#38bdf8';
      ctx.font = `800 ${Math.round(11 * scale)}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`FRAME ${st.currentFrame} / ${st.totalFrames}  •  BALL ${st.currentRoll}`, pad + 14 * scale, pad + 14 * scale);

      activePlayers.forEach((p, idx) => {
        const ry = pad + (28 + idx * 32) * scale;
        const isTurn = p.seat === st.activeSeat;
        if (isTurn) {
          ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
          this._roundRect(ctx, pad + 6 * scale, ry - 2 * scale, boxW - 12 * scale, rowH - 4 * scale, 8 * scale);
          ctx.fill();
        }
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(pad + 20 * scale, ry + 12 * scale, 6 * scale, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = isTurn ? '#facc15' : '#ffffff';
        ctx.font = `800 ${Math.round(15 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(p.name, pad + 34 * scale, ry + 12 * scale);

        const lastFrame = p.frames?.[st.currentFrame - 1];
        const rollStr = lastFrame ? lastFrame.display.filter(Boolean).join(' ') : '';
        if (rollStr) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = `800 ${Math.round(13 * scale)}px ui-monospace, monospace`;
          ctx.textAlign = 'right';
          ctx.fillText(rollStr, pad + boxW - 64 * scale, ry + 12 * scale);
        }

        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${Math.round(17 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText(String(p.totalScore ?? 0), pad + boxW - 14 * scale, ry + 12 * scale);
      });
      ctx.restore();

      // 2. Top-Right Ball Speed Radar (safely positioned below .tv-toolbar)
      if (st.lastShotMph > 0) {
        const pillW = 180 * scale;
        const pillH = 62 * scale;
        const px = W - pad - pillW;
        const py = pad + 52 * scale;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        this._roundRect(ctx, px, py, pillW, pillH, 14 * scale);
        ctx.fill();

        ctx.fillStyle = '#38bdf8';
        ctx.font = `800 ${Math.round(12 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText('BALL SPEED', px + 14 * scale, py + 20 * scale);

        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${Math.round(23 * scale)}px system-ui, sans-serif`;
        ctx.fillText(`${st.lastShotMph} MPH`, px + 14 * scale, py + 45 * scale);
        ctx.restore();
      }
    }

    // 3. Room Code Badge (Bottom Right)
    if (this.roomCode) {
      const cw = 158 * scale;
      const ch = 36 * scale;
      ctx.save();
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
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

    // 4. Active Human Bowler Prompt
    if (st.phase === BOWLING_PHASE.AIMING) {
      const active = st.players?.[st.activeSeat];
      if (active?.isHuman) {
        const msg = `${active.name.toUpperCase()} TO BOWL — SWING FORWARD TO ROLL!`;
        const bw = Math.min(W * 0.74, 560 * scale);
        const bh = 44 * scale;
        ctx.save();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
        this._roundRect(ctx, (W - bw) / 2, H - 84 * scale, bw, bh, 22 * scale);
        ctx.fill();
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${Math.round(16 * scale)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(msg, W / 2, H - 84 * scale + bh / 2);
        ctx.restore();
      }
    }

    // 5. Strike / Spare / Match Callout Banner
    if (st.callout) {
      const age = st.clock - st.callout.at;
      const pop = clamp(age / 0.16, 0.2, 1);
      const fade = age > 1.85 ? clamp(1 - (age - 1.85) / 0.55, 0, 1) : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(W / 2, H * 0.30);
      ctx.scale(0.8 + 0.2 * pop, 0.8 + 0.2 * pop);

      ctx.font = `900 ${Math.round(44 * scale)}px system-ui, sans-serif`;
      const tw = ctx.measureText(st.callout.text).width + 64 * scale;
      const th = 72 * scale;
      const bg = st.callout.kind === 'fault'
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
      ctx.fillText(st.callout.text, 0, 2 * scale);
      ctx.restore();
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
