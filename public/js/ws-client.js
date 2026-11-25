// Reconnecting WebSocket client with RTT ping sync and clean event handlers.
import { MSG } from '../../shared/protocol.js';

export class GameSocket {
  constructor(url = null) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url || `${proto}//${window.location.host}/ws`;
    this.ws = null;
    this.connected = false;
    this.rttMs = 0;
    this._listeners = new Map();
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._shouldReconnect = true;
    this._queue = [];
  }

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this._listeners.get(type)?.delete(fn);
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  connect() {
    this._shouldReconnect = true;
    this._open();
  }

  _open() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      for (const item of this._queue) ws.send(item);
      this._queue = [];
      this._emit('open');

      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        this.send({ type: MSG.PING, t: performance.now() });
      }, 4000);
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === MSG.PONG && typeof msg.t === 'number') {
        this.rttMs = Math.round(performance.now() - msg.t);
        this._emit('rtt', this.rttMs);
        return;
      }
      this._emit('message', msg);
      if (msg.type) this._emit(msg.type, msg);
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this._emit('close');
      if (this._shouldReconnect) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => this._open(), 1400);
      }
    });

    ws.addEventListener('error', () => {
      // Close event handles reconnect
    });
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else if (this._queue.length < 32) {
      this._queue.push(data);
    }
  }

  close() {
    this._shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    this.ws?.close();
  }
}
