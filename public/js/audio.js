// Web Audio API Synthesizer for Arcade Motion Tennis Sound Effects.
// Zero external audio dependencies; supports optional MediaStreamDestination output for AirPlay streaming!

export class TennisAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.streamDest = null;
    this.muted = false;
    this.noiseBuffer = null;
  }

  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.72;
      this.masterGain.connect(this.ctx.destination);
      this._buildNoiseBuffer();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : 0.72, this.ctx.currentTime, 0.02);
    }
  }

  // Returns an audio MediaStreamTrack that mirrors match audio (for AirPlay video+audio stream)
  getMediaStreamTrack() {
    if (!this.unlock()) return null;
    if (!this.streamDest && typeof this.ctx.createMediaStreamDestination === 'function') {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.masterGain.connect(this.streamDest);
    }
    return this.streamDest?.stream?.getAudioTracks?.()[0] || null;
  }

  _buildNoiseBuffer() {
    const length = this.ctx.sampleRate * 1.2;
    const buf = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;
  }

  playWhoosh(power = 0.7) {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.6;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.exponentialRampToValueAtTime(900 + power * 700, t + 0.09);
    filter.frequency.exponentialRampToValueAtTime(180, t + 0.22);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(0.14 * power, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(t);
    src.stop(t + 0.24);
  }

  playHit({ power = 0.75, shotType = 'drive', sweetSpot = false } = {}) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const isPower = shotType === 'smash' || shotType === 'rocket_serve';

    // 1. Crisp tennis string thwack (resonant body pop)
    const osc = this.ctx.createOscillator();
    osc.type = isPower ? 'sawtooth' : 'triangle';
    const baseFreq = isPower ? 210 : (shotType === 'lob' ? 320 : 250 + power * 70);
    osc.frequency.setValueAtTime(baseFreq, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + (isPower ? 0.14 : 0.09));

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(isPower ? 0.55 : 0.36 * (0.6 + power * 0.4), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (isPower ? 0.16 : 0.11));

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.18);

    // 2. String transient snap (noise burst)
    if (this.noiseBuffer) {
      const nSrc = this.ctx.createBufferSource();
      nSrc.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(isPower ? 2100 : 1450, t);
      bp.Q.value = 1.2;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(isPower ? 0.42 : 0.22, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
      nSrc.connect(bp);
      bp.connect(ng);
      ng.connect(this.masterGain);
      nSrc.start(t);
      nSrc.stop(t + 0.08);
    }

    // 3. Sweet spot / Power Smash sparkle chime!
    if (sweetSpot || isPower) {
      const notes = isPower ? [523.25, 783.99, 1046.5] : [659.25, 987.77];
      notes.forEach((freq, idx) => {
        const chime = this.ctx.createOscillator();
        chime.type = 'sine';
        chime.frequency.setValueAtTime(freq, t + idx * 0.025);
        const cg = this.ctx.createGain();
        cg.gain.setValueAtTime(0.12, t + idx * 0.025);
        cg.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.025 + 0.22);
        chime.connect(cg);
        cg.connect(this.masterGain);
        chime.start(t + idx * 0.025);
        chime.stop(t + idx * 0.025 + 0.24);
      });
    }
  }

  playBounce(inBounds = true) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(inBounds ? 185 : 140, t);
    osc.frequency.exponentialRampToValueAtTime(62, t + 0.065);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.075);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  playToss() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(360, t);
    osc.frequency.exponentialRampToValueAtTime(620, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  playNetHit() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(52, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.26, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.20);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  playFault() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    [349.23, 277.18].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + i * 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.18, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.18);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.2);
    });
  }

  playCrowdCheer(intensity = 0.7) {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const dur = 0.9 + intensity * 0.6;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(950, t);
    filter.frequency.linearRampToValueAtTime(1450, t + dur * 0.35);
    filter.frequency.linearRampToValueAtTime(800, t + dur);
    filter.Q.value = 0.9;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.14 * intensity, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.masterGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  playBowlRoll() {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(220, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + 0.45);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.24, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);

    src.connect(lp);
    lp.connect(g);
    g.connect(this.masterGain);
    src.start(t);
    src.stop(t + 0.5);
  }

  playPinCrash(intensity = 0.8) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const hits = [0, 0.028, 0.065];
    hits.forEach((delay, idx) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(720 + idx * 180, t + delay);
      osc.frequency.exponentialRampToValueAtTime(190, t + delay + 0.09);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.22 * intensity, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.10);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(t + delay);
      osc.stop(t + delay + 0.11);
    });

    if (this.noiseBuffer) {
      const nSrc = this.ctx.createBufferSource();
      nSrc.buffer = this.noiseBuffer;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1700, t);
      bp.Q.value = 0.8;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.32 * intensity, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      nSrc.connect(bp);
      bp.connect(ng);
      ng.connect(this.masterGain);
      nSrc.start(t);
      nSrc.stop(t + 0.18);
    }
  }

  playGutter() {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(195, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + 0.22);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  playFanfare(type = 'point') {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const melody = type === 'match'
      ? [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5]
      : type === 'game'
        ? [523.25, 659.25, 783.99, 1046.5]
        : [587.33, 880.0];

    const step = type === 'match' ? 0.11 : 0.09;
    melody.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      const start = t + idx * step;
      osc.frequency.setValueAtTime(freq, start);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.16, start);
      g.gain.exponentialRampToValueAtTime(0.001, start + (idx === melody.length - 1 ? 0.45 : 0.16));
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + 0.48);
    });
    this.playCrowdCheer(type === 'match' ? 1.0 : 0.6);
  }
}
