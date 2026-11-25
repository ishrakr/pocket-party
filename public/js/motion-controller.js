// Phone IMU Motion Racket Controller + Calibration + Haptics + Touch/Keyboard Fallback.
// Pure swing classifier is exported so it can be deterministically unit-tested in Node.js!
import { clamp } from '../../shared/protocol.js';

export class SwingDetector {
  constructor(options = {}) {
    this.handedness = options.handedness || 'right';
    this.sensitivity = options.sensitivity ?? 1.0; // 0.6 (firm) .. 1.4 (light)
    this.cooldownMs = options.cooldownMs ?? 270;
    this.peakWindowMs = options.peakWindowMs ?? 55;

    this.lastTriggerAt = -1000;
    this.gravity = { x: 0, y: 0, z: 9.81 }; // Low-pass gravity estimate for devices lacking linear accel
    this._activePeak = null;
  }

  setHandedness(hand) {
    this.handedness = hand === 'left' ? 'left' : 'right';
  }

  setSensitivity(s) {
    this.sensitivity = clamp(Number(s) || 1.0, 0.55, 1.5);
  }

  /**
   * Process one IMU sample `{ t, ax, ay, az, hasLinear, gx, gy, gz, isServeReady }`.
   * - ax, ay, az: acceleration in m/s^2 (phone frame: +x right, +y top of phone, +z out of screen)
   * - gx, gy, gz: rotationRate in deg/s (alpha/z-yaw, beta/x-pitch, gamma/y-roll)
   * Returns a swing object `{ kind: 'toss'|'swing', power, spin, aim, elevation, side, peakMag }` or null.
   */
  processSample(sample) {
    const t = sample.t ?? 0;
    let ax = sample.ax || 0;
    let ay = sample.ay || 0;
    let az = sample.az || 0;

    // If device only gives accelerationIncludingGravity, subtract low-pass gravity estimate
    if (!sample.hasLinear) {
      const alpha = 0.82;
      this.gravity.x = alpha * this.gravity.x + (1 - alpha) * ax;
      this.gravity.y = alpha * this.gravity.y + (1 - alpha) * ay;
      this.gravity.z = alpha * this.gravity.z + (1 - alpha) * az;
      ax -= this.gravity.x;
      ay -= this.gravity.y;
      az -= this.gravity.z;
    }

    const gx = sample.gx || 0; // Pitch rate (beta) deg/s
    const gy = sample.gy || 0; // Roll rate (gamma) deg/s
    const gz = sample.gz || 0; // Yaw rate (alpha) deg/s

    const linMag = Math.hypot(ax, ay, az);
    const rotMag = Math.hypot(gx, gy, gz);
    // Combined swing energy (handles both fast wrist flicks and full-arm swings!)
    const energy = linMag + rotMag * 0.032;

    const triggerThreshold = 12.2 / this.sensitivity;
    const tossThreshold = 8.4 / this.sensitivity;

    // Inside cooldown after last trigger?
    if (t - this.lastTriggerAt < this.cooldownMs) {
      return null;
    }

    // Serve Toss Detection: quick upward flick while waiting to serve
    if (sample.isServeReady && !this._activePeak) {
      const upwardLift = ay + Math.max(0, az) * 0.45;
      if (upwardLift > tossThreshold && linMag > tossThreshold * 0.95) {
        this.lastTriggerAt = t;
        return {
          kind: 'toss',
          power: clamp(upwardLift / 18, 0.4, 1.0),
          peakMag: upwardLift
        };
      }
    }

    // Start peak accumulation window when threshold crossed
    if (!this._activePeak) {
      if (energy >= triggerThreshold) {
        this._activePeak = {
          startT: t,
          bestEnergy: energy,
          ax, ay, az,
          gx, gy, gz,
          linMag, rotMag
        };
      }
      return null;
    }

    // Track strongest sample during the short peak capture window (~55ms)
    if (energy > this._activePeak.bestEnergy) {
      this._activePeak.bestEnergy = energy;
      this._activePeak.ax = ax;
      this._activePeak.ay = ay;
      this._activePeak.az = az;
      this._activePeak.gx = gx;
      this._activePeak.gy = gy;
      this._activePeak.gz = gz;
      this._activePeak.linMag = linMag;
      this._activePeak.rotMag = rotMag;
    }

    if (t - this._activePeak.startT < this.peakWindowMs) {
      return null;
    }

    // Finalize swing classification from captured peak!
    const pk = this._activePeak;
    this._activePeak = null;
    this.lastTriggerAt = t;

    const power = clamp((pk.bestEnergy - triggerThreshold * 0.55) / (30 / this.sensitivity), 0.25, 1.0);

    // Forehand vs Backhand from lateral swing impulse + yaw rotation & handedness
    const lateralSignal = pk.ax + pk.gz * 0.025;
    const rightHandForehand = lateralSignal <= 0; // Right-hander swinging right->left yields -ax / -gz
    const side = this.handedness === 'right'
      ? (rightHandForehand ? 'forehand' : 'backhand')
      : (rightHandForehand ? 'backhand' : 'forehand');

    // Elevation: Upward scoop = Lob, Sharp downward chop = Smash
    let elevation = 'flat';
    if (pk.ay > 11.5 && pk.ay > Math.abs(pk.ax) * 0.9) {
      elevation = 'lob';
    } else if (pk.ay < -10.5 || (pk.gx < -240 && power > 0.68)) {
      elevation = 'smash';
    }

    // Wrist roll -> Topspin (+1) vs Slice (-1)
    const rollSign = this.handedness === 'right' ? 1 : -1;
    const spin = clamp(((pk.gy * rollSign) / 380) + (pk.ay * 0.022), -1, 1);

    // Aim steering from swing trajectory angle
    const aim = clamp((pk.ax * 0.032) + (pk.gz * 0.0012), -0.95, 0.95);

    return {
      kind: 'swing',
      power: Number(power.toFixed(2)),
      spin: Number(spin.toFixed(2)),
      aim: Number(aim.toFixed(2)),
      elevation,
      side,
      peakMag: Number(pk.bestEnergy.toFixed(1))
    };
  }
}

export class PhoneMotionController {
  constructor(options = {}) {
    this.detector = new SwingDetector({
      handedness: options.handedness || 'right',
      sensitivity: options.sensitivity ?? 1.0
    });
    this.onSwing = options.onSwing || (() => {});
    this.onToss = options.onToss || (() => {});
    this.onPose = options.onPose || (() => {});
    this.onSensorState = options.onSensorState || (() => {});
    this.isServeReadyFn = options.isServeReadyFn || (() => false);

    this.sensorActive = false;
    this.permissionState = 'prompt'; // 'prompt' | 'granted' | 'denied' | 'unavailable'
    this.calibration = { alpha: 0, beta: 0, gamma: 0 };
    this.lastRawOrientation = { alpha: 0, beta: 0, gamma: 0 };
    this.lastPoseSent = 0;
    this.lastEnergy = 0;

    this._boundMotion = (e) => this._onDeviceMotion(e);
    this._boundOrientation = (e) => this._onDeviceOrientation(e);
  }

  static isSensorSupported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  static needsPermissionPrompt() {
    return typeof window !== 'undefined' &&
      typeof window.DeviceMotionEvent !== 'undefined' &&
      typeof window.DeviceMotionEvent.requestPermission === 'function';
  }

  async enableSensors() {
    if (!PhoneMotionController.isSensorSupported()) {
      this.permissionState = 'unavailable';
      this.onSensorState({ active: false, permission: 'unavailable', reason: 'No motion sensor API in this browser' });
      return false;
    }

    try {
      if (typeof window.DeviceMotionEvent.requestPermission === 'function') {
        const res = await window.DeviceMotionEvent.requestPermission();
        if (res !== 'granted') {
          this.permissionState = 'denied';
          this.onSensorState({ active: false, permission: 'denied', reason: 'Motion sensor permission denied' });
          return false;
        }
      }
      if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
        try {
          await window.DeviceOrientationEvent.requestPermission();
        } catch { /* Orientation optional if motion granted */ }
      }
    } catch (err) {
      this.permissionState = 'denied';
      this.onSensorState({
        active: false,
        permission: 'denied',
        reason: err?.message || 'HTTPS is required for motion sensors on mobile Safari/Chrome.'
      });
      return false;
    }

    window.addEventListener('devicemotion', this._boundMotion, { passive: true });
    window.addEventListener('deviceorientation', this._boundOrientation, { passive: true });

    this.sensorActive = true;
    this.permissionState = 'granted';
    this.onSensorState({ active: true, permission: 'granted' });
    return true;
  }

  disableSensors() {
    window.removeEventListener('devicemotion', this._boundMotion);
    window.removeEventListener('deviceorientation', this._boundOrientation);
    this.sensorActive = false;
    this.onSensorState({ active: false, permission: this.permissionState });
  }

  calibrate() {
    this.calibration = { ...this.lastRawOrientation };
    this.vibrate('toss');
  }

  setHandedness(h) {
    this.detector.setHandedness(h);
  }

  setSensitivity(s) {
    this.detector.setSensitivity(s);
  }

  _onDeviceMotion(evt) {
    const lin = evt.acceleration;
    const grav = evt.accelerationIncludingGravity;
    const hasLinear = Boolean(lin && (lin.x !== null || lin.y !== null || lin.z !== null));
    const acc = hasLinear ? lin : grav;
    if (!acc) return;

    const rot = evt.rotationRate || {};
    const sample = {
      t: performance.now(),
      ax: acc.x || 0,
      ay: acc.y || 0,
      az: acc.z || 0,
      hasLinear,
      gx: rot.beta || 0,
      gy: rot.gamma || 0,
      gz: rot.alpha || 0,
      isServeReady: Boolean(this.isServeReadyFn())
    };

    const rawMag = Math.hypot(sample.ax, sample.ay, sample.az);
    this.lastEnergy = clamp(rawMag / 28, 0, 1);

    const result = this.detector.processSample(sample);
    if (!result) return;

    if (result.kind === 'toss') {
      this.onToss(result);
    } else if (result.kind === 'swing') {
      this.onSwing(result);
    }
  }

  _onDeviceOrientation(evt) {
    if (evt.beta === null && evt.gamma === null) return;
    this.lastRawOrientation = {
      alpha: evt.alpha || 0,
      beta: evt.beta || 0,
      gamma: evt.gamma || 0
    };

    const now = performance.now();
    if (now - this.lastPoseSent < 50) return; // 20Hz live racket tilt
    this.lastPoseSent = now;

    const dPitch = ((this.lastRawOrientation.beta - this.calibration.beta) * Math.PI) / 180;
    const dRoll = ((this.lastRawOrientation.gamma - this.calibration.gamma) * Math.PI) / 180;
    let dYawDeg = this.lastRawOrientation.alpha - this.calibration.alpha;
    if (dYawDeg > 180) dYawDeg -= 360;
    if (dYawDeg < -180) dYawDeg += 360;
    const dYaw = (dYawDeg * Math.PI) / 180;

    this.onPose({
      pitch: Number(clamp(dPitch, -1.4, 1.4).toFixed(2)),
      roll: Number(clamp(dRoll, -1.4, 1.4).toFixed(2)),
      yaw: Number(clamp(dYaw, -1.4, 1.4).toFixed(2))
    });
  }

  vibrate(patternName) {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    const patterns = {
      toss: [14],
      hit: [28],
      sweet_spot: [22, 22, 42],
      smash: [35, 25, 80],
      point_win: [30, 30, 50],
      point_loss: [65],
      victory: [45, 35, 45, 35, 110],
      loss: [90, 40, 90]
    };
    const p = patterns[patternName];
    if (p) {
      try { navigator.vibrate(p); } catch { /* ignore */ }
    }
  }
}
