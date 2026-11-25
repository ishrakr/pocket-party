// Unified Web Casting Bridge:
// 1. Google Cast Web Sender SDK (with custom Web Receiver + urn:x-cast:com.pocketparty.tennis)
// 2. W3C Presentation API (Chromecast / wireless & wired second displays)
// 3. Apple AirPlay & W3C Remote Playback (live Canvas-to-Video MediaStream cast from phone!)
// 4. Universal Second-Screen / TV Window fallback
import { CAST_NAMESPACE } from '../../shared/protocol.js';

export class CastBridge {
  constructor(options = {}) {
    this.roomCode = options.roomCode || '';
    this.castAppId = options.castAppId || localStorage.getItem('pocketparty_app_id') || '';
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onMessage = options.onMessage || (() => {});

    this.activeMethod = null; // 'google_cast' | 'presentation' | 'airplay' | 'window'
    this.deviceName = null;
    this.castSession = null;
    this.presentationConnection = null;
    this.airplayVideo = null;
    this.airplayCanvas = null;
    this.airplayStream = null;
    this.tvWindow = null;

    this.capabilities = {
      googleCast: false,
      presentation: typeof window !== 'undefined' && 'PresentationRequest' in window,
      airplay: false,
      remotePlayback: false
    };

    this._detectAirPlayAndRemote();
  }

  setRoomCode(code) {
    this.roomCode = code;
    if (this.castSession) {
      this._sendGoogleCastJoin();
    }
    if (this.presentationConnection && this.presentationConnection.state === 'connected') {
      this.presentationConnection.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode: this.roomCode }));
    }
  }

  setCastAppId(appId) {
    this.castAppId = (appId || '').trim();
    if (this.castAppId) {
      localStorage.setItem('pocketparty_app_id', this.castAppId);
      this.initGoogleCast();
    } else {
      localStorage.removeItem('pocketparty_app_id');
    }
  }

  _detectAirPlayAndRemote() {
    if (typeof document === 'undefined') return;
    const probe = document.createElement('video');
    this.capabilities.airplay =
      typeof window.WebKitPlaybackTargetAvailabilityEvent !== 'undefined' ||
      typeof probe.webkitShowPlaybackTargetPicker === 'function';
    this.capabilities.remotePlayback = 'remote' in probe && typeof probe.remote?.prompt === 'function';
  }

  // --- 1. Google Cast Web Sender SDK ---
  initGoogleCast() {
    if (!this.castAppId) return Promise.resolve(false);

    return new Promise((resolve) => {
      const configure = () => {
        if (!window.cast?.framework || !window.chrome?.cast) {
          resolve(false);
          return;
        }
        try {
          const ctx = window.cast.framework.CastContext.getInstance();
          ctx.setOptions({
            receiverApplicationId: this.castAppId,
            autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
          });
          ctx.addEventListener(
            window.cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            (evt) => this._onGoogleCastSessionState(evt)
          );
          this.capabilities.googleCast = true;
          this._emitStatus();
          resolve(true);
        } catch {
          resolve(false);
        }
      };

      if (window.cast?.framework) {
        configure();
        return;
      }

      window.__onGCastApiAvailable = (isAvailable) => {
        if (isAvailable) configure();
        else resolve(false);
      };

      if (!document.querySelector('script[data-cast-sdk]')) {
        const script = document.createElement('script');
        script.dataset.castSdk = '1';
        script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
        script.async = true;
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
      }

      // Timeout gracefully if offline or blocked
      setTimeout(() => resolve(this.capabilities.googleCast), 3500);
    });
  }

  _onGoogleCastSessionState(evt) {
    const fw = window.cast?.framework;
    if (!fw) return;
    if (evt.sessionState === fw.SessionState.SESSION_STARTED || evt.sessionState === fw.SessionState.SESSION_RESUMED) {
      this.castSession = fw.CastContext.getInstance().getCurrentSession();
      this.activeMethod = 'google_cast';
      this.deviceName = this.castSession?.getCastDevice()?.friendlyName || 'Chromecast';
      this._sendGoogleCastJoin();
      this.castSession?.addMessageListener(CAST_NAMESPACE, (_ns, raw) => {
        try { this.onMessage(JSON.parse(raw)); } catch { /* ignore */ }
      });
      this._emitStatus();
    } else if (evt.sessionState === fw.SessionState.SESSION_ENDED) {
      this.castSession = null;
      if (this.activeMethod === 'google_cast') {
        this.activeMethod = null;
        this.deviceName = null;
      }
      this._emitStatus();
    }
  }

  _sendGoogleCastJoin() {
    if (!this.castSession || !this.roomCode) return;
    const payload = {
      type: 'JOIN_ROOM',
      roomCode: this.roomCode,
      serverOrigin: window.location.origin
    };
    this.castSession.sendMessage(CAST_NAMESPACE, payload).catch(() => {});
  }

  sendCastChannelMessage(payload) {
    if (this.castSession) {
      this.castSession.sendMessage(CAST_NAMESPACE, payload).catch(() => {});
    }
    if (this.presentationConnection && this.presentationConnection.state === 'connected') {
      try {
        this.presentationConnection.send(JSON.stringify(payload));
      } catch { /* ignore */ }
    }
  }

  async startGoogleCast() {
    if (!this.capabilities.googleCast) {
      throw new Error('Google Cast SDK is not configured with a Cast App ID. Falling back to Presentation API.');
    }
    const ctx = window.cast.framework.CastContext.getInstance();
    await ctx.requestSession();
    return { method: 'google_cast', deviceName: this.deviceName || 'Chromecast' };
  }

  // --- 2. W3C Presentation API (Chromecast & Secondary Displays without App ID) ---
  async startPresentationCast() {
    if (!('PresentationRequest' in window)) {
      throw new Error('Presentation API not supported in this browser.');
    }
    const tvUrl = `${window.location.origin}/tv.html?room=${encodeURIComponent(this.roomCode)}&cast=presentation`;
    const request = new PresentationRequest([tvUrl]);
    const connection = await request.start();
    this.presentationConnection = connection;
    this.activeMethod = 'presentation';
    this.deviceName = 'Cast / Secondary Display';

    connection.addEventListener('connect', () => {
      connection.send(JSON.stringify({ type: 'JOIN_ROOM', roomCode: this.roomCode }));
      this._emitStatus();
    });
    connection.addEventListener('message', (evt) => {
      try { this.onMessage(JSON.parse(evt.data)); } catch { /* ignore */ }
    });
    connection.addEventListener('close', () => {
      if (this.activeMethod === 'presentation') {
        this.activeMethod = null;
        this.deviceName = null;
        this._emitStatus();
      }
    });
    connection.addEventListener('terminate', () => {
      if (this.activeMethod === 'presentation') {
        this.activeMethod = null;
        this.deviceName = null;
        this._emitStatus();
      }
    });

    this._emitStatus();
    return { method: 'presentation', deviceName: this.deviceName };
  }

  // --- 3. Apple AirPlay & W3C Remote Playback (Live 3D Court Canvas -> Video Stream) ---
  attachAirPlayStream(videoEl, sourceCanvas, audioTrack = null) {
    this.airplayVideo = videoEl;
    this.airplayCanvas = sourceCanvas;

    videoEl.setAttribute('x-webkit-airplay', 'allow');
    videoEl.setAttribute('playsinline', '');
    videoEl.playsInline = true;
    videoEl.muted = true; // Required for autoplay prior to wireless handoff; audio routes when unmuted

    if (typeof sourceCanvas.captureStream === 'function') {
      const stream = sourceCanvas.captureStream(30);
      if (audioTrack) {
        try { stream.addTrack(audioTrack); } catch { /* ignore */ }
      }
      this.airplayStream = stream;
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
    }

    // Listen for Safari wireless AirPlay target status changes
    videoEl.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      const wireless = Boolean(videoEl.webkitCurrentPlaybackTargetIsWireless);
      if (wireless) {
        this.activeMethod = 'airplay';
        this.deviceName = 'AirPlay TV';
      } else if (this.activeMethod === 'airplay') {
        this.activeMethod = null;
        this.deviceName = null;
      }
      this._emitStatus();
    });

    // Listen for W3C Remote Playback connection events
    if (videoEl.remote) {
      videoEl.remote.addEventListener('connect', () => {
        this.activeMethod = 'airplay';
        this.deviceName = 'Wireless Display';
        this._emitStatus();
      });
      videoEl.remote.addEventListener('disconnect', () => {
        if (this.activeMethod === 'airplay') {
          this.activeMethod = null;
          this.deviceName = null;
          this._emitStatus();
        }
      });
    }
  }

  async promptAirPlayOrRemotePlayback() {
    const videoEl = this.airplayVideo;
    if (!videoEl) {
      throw new Error('AirPlay stream video element is not initialized.');
    }
    videoEl.play().catch(() => {});

    // Safari iOS / macOS native AirPlay Picker
    if (typeof videoEl.webkitShowPlaybackTargetPicker === 'function') {
      videoEl.webkitShowPlaybackTargetPicker();
      this.activeMethod = 'airplay';
      this.deviceName = 'AirPlay Target';
      this._emitStatus();
      return { method: 'airplay', deviceName: 'AirPlay' };
    }

    // W3C Remote Playback API (Chrome Android / Desktop / Cast video sink)
    if (videoEl.remote && typeof videoEl.remote.prompt === 'function') {
      await videoEl.remote.prompt();
      this.activeMethod = 'airplay';
      this.deviceName = 'Remote Playback TV';
      this._emitStatus();
      return { method: 'airplay', deviceName: 'Remote Playback TV' };
    }

    throw new Error('AirPlay / Remote Playback picker is not available in this browser.');
  }

  // --- 4. Universal Smart Cast (auto-picks best available native protocol!) ---
  async smartCast() {
    if (this.capabilities.googleCast) {
      return this.startGoogleCast();
    }
    if (this.capabilities.presentation) {
      try {
        return await this.startPresentationCast();
      } catch (err) {
        // User cancelled or no presentation receiver discovered; let caller decide fallback
        if (err && err.name === 'AbortError') throw err;
      }
    }
    if ((this.capabilities.airplay || this.capabilities.remotePlayback) && this.airplayVideo) {
      return this.promptAirPlayOrRemotePlayback();
    }
    return this.openTVWindow();
  }

  openTVWindow() {
    const tvUrl = `${window.location.origin}/tv.html?room=${encodeURIComponent(this.roomCode)}`;
    const win = window.open(tvUrl, 'pocketparty_tv', 'width=1280,height=740');
    if (win) {
      this.tvWindow = win;
      this.activeMethod = 'window';
      this.deviceName = 'TV Screen Window';
      this._emitStatus();
      return { method: 'window', deviceName: 'TV Screen Window', url: tvUrl };
    }
    return { method: 'link', deviceName: 'TV URL', url: tvUrl };
  }

  stopCasting() {
    if (this.castSession) {
      this.castSession.endSession(true);
      this.castSession = null;
    }
    if (this.presentationConnection) {
      this.presentationConnection.terminate();
      this.presentationConnection = null;
    }
    if (this.tvWindow && !this.tvWindow.closed) {
      this.tvWindow.close();
      this.tvWindow = null;
    }
    this.activeMethod = null;
    this.deviceName = null;
    this._emitStatus();
  }

  _emitStatus() {
    this.onStatusChange({
      active: Boolean(this.activeMethod),
      method: this.activeMethod,
      deviceName: this.deviceName,
      capabilities: { ...this.capabilities }
    });
  }
}
