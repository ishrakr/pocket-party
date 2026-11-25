import { clamp } from '../../shared/protocol.js';

export const HUD = {
  courtNight: '#0F2350',
  panel: 'rgba(15, 35, 80, 0.88)',
  court: '#1F4396',
  courtRaised: '#2A53AE',
  chalk: '#F4F7FB',
  chalkDim: '#A9B7D6',
  ball: '#DCF542',
  ballInk: '#1A2600',
  apron: '#2E7D5B',
  teamBlue: '#5B9BFF',
  teamRed: '#FF5D4F',
  fault: '#E5483B',
  panelRadius: 6,
  chipRadius: 3,
  pad: 22
};

const fonts = new Map();

export function setFont(ctx, weight, px, stretch = 'normal') {
  const size = Math.max(1, Math.round(px));
  const key = size * 1000 + weight;
  let font = fonts.get(key);
  if (!font) {
    if (fonts.size >= 256) fonts.clear();
    font = `${weight} ${size}px Archivo, "Helvetica Neue", Arial, sans-serif`;
    fonts.set(key, font);
  }
  ctx.font = font;
  // Older Cast/WebKit versions may not implement Canvas fontStretch.
  try { if ('fontStretch' in ctx) ctx.fontStretch = stretch; } catch { /* normal width fallback */ }
}

export function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fillPanel(ctx, x, y, w, h, s, color = HUD.panel) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, HUD.panelRadius * s);
  ctx.fill();
}

export function drawRoomCode(ctx, W, H, s, code) {
  if (!code) return;
  const x = W - (HUD.pad + 116) * s;
  const y = H - (HUD.pad + 34) * s;
  ctx.save();
  fillPanel(ctx, x, y, 116 * s, 34 * s, s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  setFont(ctx, 700, 14 * s, 'semi-condensed');
  ctx.fillStyle = HUD.chalkDim;
  ctx.fillText('Join', x + 12 * s, y + 17 * s);
  setFont(ctx, 900, 19 * s, 'condensed');
  ctx.fillStyle = HUD.ball;
  ctx.textAlign = 'right';
  ctx.fillText(code, x + 104 * s, y + 17 * s, 56 * s);
  ctx.restore();
}

export function drawPrompt(ctx, W, H, s, text) {
  ctx.save();
  setFont(ctx, 700, 17 * s, 'semi-condensed');
  const width = Math.min(560 * s, Math.max(246 * s, ctx.measureText(text).width + 38 * s));
  const x = (W - width) / 2;
  const y = H - 70 * s;
  fillPanel(ctx, x, y, width, 42 * s, s);
  ctx.fillStyle = HUD.ball;
  ctx.fillRect(x + 8 * s, y + 8 * s, 3 * s, 26 * s);
  ctx.fillStyle = HUD.chalk;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 22 * s, y + 21 * s, width - 36 * s);
  ctx.restore();
}

export function drawRadar(ctx, W, s, mph, rally = 0) {
  const hasSpeed = mph > 0;
  const hasRally = rally > 1;
  if (!hasSpeed && !hasRally) return;
  const width = (hasSpeed && hasRally ? 136 : hasSpeed ? 82 : 66) * s;
  const x = W - HUD.pad * s - width;
  const y = HUD.pad * s;
  ctx.save();
  fillPanel(ctx, x, y, width, 51 * s, s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const drawMetric = (cx, label, value) => {
    setFont(ctx, 750, 10 * s, 'condensed');
    ctx.fillStyle = HUD.chalkDim;
    ctx.fillText(label, cx, y + 12 * s);
    setFont(ctx, 850, 23 * s, 'condensed');
    ctx.fillStyle = HUD.chalk;
    ctx.fillText(String(value), cx, y + 32 * s);
  };
  if (hasSpeed) drawMetric(x + (hasRally ? 38 * s : width / 2), 'SPEED / MPH', mph);
  if (hasRally) drawMetric(x + (hasSpeed ? 106 * s : width / 2), 'RALLY', rally);
  if (hasSpeed && hasRally) {
    ctx.fillStyle = 'rgba(169, 183, 214, 0.25)';
    ctx.fillRect(x + 76 * s, y + 10 * s, s, 31 * s);
  }
  ctx.restore();
}

export function drawCallout(ctx, W, H, s, callout, clock) {
  if (!callout) return;
  const age = clock - callout.at;
  const fade = clamp(1 - Math.max(0, age - 1.85) / 0.55, 0, 1);
  if (!fade) return;
  const pop = 0.8 + 0.2 * clamp(age / 0.16, 0.2, 1);
  const celebration = callout.kind === 'ace' || callout.kind === 'strike' || callout.kind === 'match_win';
  const error = callout.kind === 'fault' || callout.kind === 'out';
  // Some server messages include decorative emoji; the ribbon is type only.
  const text = callout.text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').trim();

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.translate(W / 2, H * 0.27);
  ctx.scale(pop, pop);
  setFont(ctx, 900, 39 * s, 'expanded');
  const w = Math.min(940 * s, Math.max(136 * s, ctx.measureText(text).width + 48 * s));
  fillPanel(ctx, -w / 2, -27 * s, w, 54 * s, s, celebration ? HUD.ball : error ? HUD.fault : HUD.court);
  ctx.fillStyle = celebration ? HUD.ballInk : HUD.chalk;
  ctx.fillRect(-w / 2 + 8 * s, -16 * s, 2 * s, 32 * s);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, 0, s, w - 38 * s);
  ctx.restore();
}

// Reuse pitch/focal math across projected vertices. Compare the live camera
// scalars so project() also works outside render() and after direct changes.
export class Perspective {
  constructor(centerY, near) {
    this.centerY = centerY;
    this.near = near;
  }

  update(cam, W, H) {
    if (this.W !== W || this.H !== H) {
      this.W = W;
      this.H = H;
      this.midX = W * 0.5;
      this.midY = H * this.centerY;
    }
    if (this.y !== cam.y || this.z !== cam.z || this.lookY !== cam.lookY || this.lookZ !== cam.lookZ) {
      this.y = cam.y;
      this.z = cam.z;
      this.lookY = cam.lookY;
      this.lookZ = cam.lookZ;
      const pitch = Math.atan2(cam.lookY - cam.y, -(cam.lookZ - cam.z));
      this.cosP = Math.cos(pitch);
      this.sinP = Math.sin(pitch);
    }
    if (this.fov !== cam.fov || this.focalH !== H) {
      this.fov = cam.fov;
      this.focalH = H;
      this.focal = (H * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    }
  }

  project(cam, wx, wy, wz, W, H) {
    this.update(cam, W, H);
    const dy = wy - this.y;
    const dz = wz - this.z;
    const depth = -dz * this.cosP + dy * this.sinP;
    if (depth <= this.near) return null;
    const scale = this.focal / depth;
    const up = dy * this.cosP + dz * this.sinP;
    return { x: this.midX + (wx - cam.x) * scale, y: this.midY - up * scale, scale, depth };
  }
}
