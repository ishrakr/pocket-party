// Main HTTP / HTTPS + WebSocket Server for PocketParty
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from './ws-server.js';
import { RoomManager } from './room-manager.js';
import { ensureSelfSignedCert, getLanIPs } from './certs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SHARED_DIR = path.join(ROOT_DIR, 'shared');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

export function createAppServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const httpsPort = Number(options.httpsPort ?? process.env.HTTPS_PORT ?? 3443);
  const enableHttps = Boolean(options.https ?? (process.argv.includes('--https') || process.env.HTTPS === 'true'));
  const castAppId = options.castAppId ?? process.env.CAST_APP_ID ?? '';
  const publicUrl = (options.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');

  const roomManager = new RoomManager();
  const wss = new WebSocketServer({ path: '/ws' });
  wss.on('connection', (ws) => roomManager.handleConnection(ws));

  const requestHandler = (req, res) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const isSecure = Boolean(req.socket.encrypted || forwardedProto === 'https');
    const proto = isSecure ? 'https' : 'http';
    const hostHeader = (forwardedHost || req.headers.host || '').split(',')[0].trim();

    const parsedUrl = new URL(req.url || '/', `${proto}://${hostHeader || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Security & CORS headers (helpful for Google Cast Receiver & local network access)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint for cloud deployment platforms (Render, Railway, Fly, Docker)
    if ((pathname === '/health' || pathname === '/healthz') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(JSON.stringify({
        status: 'ok',
        app: 'PocketParty',
        uptime: Math.round(process.uptime()),
        activeRooms: roomManager.rooms.size
      }));
      return;
    }

    // API: Server config & LAN/Public addresses (used to build scannable phone QR codes)
    if (pathname === '/api/config' && req.method === 'GET') {
      const lanIPs = getLanIPs();
      const activePort = req.socket.encrypted ? httpsPort : port;
      const hostnameOnly = hostHeader.replace(/:\d+$/, '').toLowerCase();
      const isLocalHost = !hostnameOnly || hostnameOnly === 'localhost' || hostnameOnly === '127.0.0.1' || hostnameOnly === '::1' || hostnameOnly === '[::1]';
      const isPublicDeployment = Boolean(publicUrl || !isLocalHost);
      const preferredLan = lanIPs[0] || null;

      let joinBaseUrl;
      if (publicUrl) {
        joinBaseUrl = publicUrl;
      } else if (!isLocalHost) {
        joinBaseUrl = `${proto}://${hostHeader}`;
      } else if (preferredLan) {
        joinBaseUrl = `${proto}://${preferredLan}:${activePort}`;
      } else {
        joinBaseUrl = `${proto}://${hostHeader || `localhost:${activePort}`}`;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        castAppId,
        httpsEnabled: enableHttps,
        secure: isSecure,
        isPublicDeployment,
        httpPort: port,
        httpsPort: enableHttps ? httpsPort : null,
        lanIPs,
        joinBaseUrl,
        activeRooms: roomManager.rooms.size
      }));
      return;
    }

    // API: Create room via REST (convenient before opening Cast/Presentation/AirPlay!)
    if (pathname === '/api/rooms' && req.method === 'POST') {
      const room = roomManager.createRoom();
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ roomCode: room.code }));
      return;
    }

    // API: Check if room exists
    if (pathname.startsWith('/api/rooms/') && req.method === 'GET') {
      const code = pathname.slice('/api/rooms/'.length);
      const room = roomManager.getRoom(code);
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ exists: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ exists: true, room: room.getRoomState() }));
      return;
    }

    // Clean friendly URL aliases
    let relPath = pathname;
    if (relPath === '/' || relPath === '') relPath = '/index.html';
    else if (relPath === '/tv') relPath = '/tv.html';
    else if (relPath === '/receiver') relPath = '/receiver.html';
    else if (relPath === '/controller' || relPath === '/play') relPath = '/controller.html';
    else if (relPath === '/demo') relPath = '/demo.html';

    // Serve shared ES modules (/shared/*) or static assets (/public/*)
    let baseDir = PUBLIC_DIR;
    if (relPath.startsWith('/shared/')) {
      baseDir = SHARED_DIR;
      relPath = relPath.slice('/shared'.length);
    }

    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = path.join(baseDir, safePath);

    if (!fullPath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(fullPath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(content);
    });
  };

  const httpServer = http.createServer(requestHandler);
  wss.attach(httpServer);

  let httpsServer = null;
  if (enableHttps) {
    const certs = ensureSelfSignedCert(path.join(ROOT_DIR, '.certs'));
    httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, requestHandler);
    wss.attach(httpsServer);
  }

  return {
    httpServer,
    httpsServer,
    wss,
    roomManager,
    async start() {
      await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
      if (httpsServer) {
        await new Promise((resolve) => httpsServer.listen(httpsPort, '0.0.0.0', resolve));
      }
      return {
        httpPort: httpServer.address().port,
        httpsPort: httpsServer ? httpsServer.address().port : null
      };
    },
    async stop() {
      wss.close();
      roomManager.closeAll();
      await new Promise((resolve) => httpServer.close(resolve));
      if (httpsServer) {
        await new Promise((resolve) => httpsServer.close(resolve));
      }
    }
  };
}

// Start directly when executed as main entry point
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const enableHttps = process.argv.includes('--https') || process.env.HTTPS === 'true';
  const app = createAppServer({ https: enableHttps });
  app.start().then(({ httpPort, httpsPort }) => {
    const lanIPs = getLanIPs();
    console.log('\n🎾 PocketParty Server Ready!');
    console.log(`   Local HTTP:   http://localhost:${httpPort}`);
    for (const ip of lanIPs) {
      console.log(`   LAN HTTP:     http://${ip}:${httpPort}`);
    }
    if (httpsPort) {
      console.log(`   Local HTTPS:  https://localhost:${httpsPort}`);
      for (const ip of lanIPs) {
        console.log(`   LAN HTTPS:    https://${ip}:${httpsPort}  <-- Open on iPhone/Android for Motion Sensors!`);
      }
    } else {
      console.log('\n💡 Tip: Run "npm run start:https" for HTTPS over LAN Wi-Fi (required by iOS/Android motion sensors).');
    }
    console.log('');
  });

  const shutdown = () => {
    app.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
