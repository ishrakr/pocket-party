// Zero-dependency RFC 6455 WebSocket server for Node.js HTTP/HTTPS servers.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketClient extends EventEmitter {
  constructor(socket, request) {
    super();
    this.id = crypto.randomUUID();
    this.socket = socket;
    this.request = request;
    this.readyState = 1; // OPEN
    this.isAlive = true;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose(1006, ''));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._handleClose(1006, err.message);
    });
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  send(data) {
    if (this.readyState !== 1) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const opcode = Buffer.isBuffer(data) ? 0x02 : 0x01;
    return this._writeFrame(opcode, payload);
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== 1) return;
    this._writeFrame(0x09, payload);
  }

  pong(payload = Buffer.alloc(0)) {
    if (this.readyState !== 1) return;
    this._writeFrame(0x0a, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._writeFrame(0x08, payload);
    this.socket.end();
    this._handleClose(code, reason);
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      return false;
    }
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    // Cap buffered unread data to prevent memory abuse (2 MB)
    if (this._buffer.length > 2 * 1024 * 1024) {
      this.close(1009, 'Message too large');
      return;
    }

    while (this._buffer.length >= 2) {
      const byte1 = this._buffer[0];
      const byte2 = this._buffer[1];
      const fin = (byte1 & 0x80) !== 0;
      const opcode = byte1 & 0x0f;
      const masked = (byte2 & 0x80) !== 0;
      let payloadLen = byte2 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        if (bigLen > 1024n * 1024n) {
          this.close(1009, 'Frame too large');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this._buffer.length < offset + maskLen + payloadLen) return;

      let maskKey = null;
      if (masked) {
        maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      this._buffer = this._buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    this.isAlive = true;

    // Control frames (ping, pong, close)
    if (opcode === 0x08) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      if (this.readyState === 1) {
        this.close(code, reason);
      } else {
        this._handleClose(code, reason);
      }
      return;
    }
    if (opcode === 0x09) {
      this.pong(payload);
      return;
    }
    if (opcode === 0x0a) {
      this.emit('pong', payload);
      return;
    }

    // Data frames (text, binary, continuation)
    if (opcode === 0x01 || opcode === 0x02) {
      if (fin) {
        this._dispatchMessage(opcode, payload);
      } else {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
      }
    } else if (opcode === 0x00 && this._fragmentOpcode !== null) {
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments);
        const op = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = null;
        this._dispatchMessage(op, full);
      }
    }
  }

  _dispatchMessage(opcode, payload) {
    if (opcode === 0x01) {
      this.emit('message', payload.toString('utf8'));
    } else {
      this.emit('message', payload);
    }
  }

  _handleClose(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

export class WebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.path = options.path || '/ws';
    this.clients = new Set();
    this._heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          client.socket.destroy();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 25000);
    this._heartbeatInterval.unref?.();
  }

  attach(httpServer) {
    httpServer.on('upgrade', (req, socket) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      const upgrade = (req.headers.upgrade || '').toLowerCase();
      if (!key || upgrade !== 'websocket') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n');

      socket.write(responseHeaders);
      const client = new WebSocketClient(socket, req);
      this.clients.add(client);
      client.on('close', () => {
        this.clients.delete(client);
      });
      this.emit('connection', client, req);
    });
  }

  close() {
    clearInterval(this._heartbeatInterval);
    for (const client of this.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.clients.clear();
  }
}
