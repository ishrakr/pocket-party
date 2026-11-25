// Generates a local self-signed TLS certificate (with LAN IP SANs) via openssl
// so mobile browsers (iOS Safari / Android Chrome) allow DeviceMotionEvent & Cast APIs over LAN Wi-Fi.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function getLanIPs() {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) {
        ips.push(info.address);
      }
    }
  }
  return ips;
}

export function ensureSelfSignedCert(certDir) {
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');
  const metaPath = path.join(certDir, 'sans.json');

  const lanIPs = getLanIPs();
  const sanSignature = JSON.stringify(lanIPs.slice().sort());

  let reuse = false;
  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    try {
      const prev = fs.readFileSync(metaPath, 'utf8');
      if (prev === sanSignature) reuse = true;
    } catch {
      reuse = false;
    }
  }

  if (!reuse) {
    const sanEntries = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs.map((ip) => `IP:${ip}`)];
    const confPath = path.join(certDir, 'openssl.cnf');
    const conf = [
      '[req]',
      'default_bits = 2048',
      'prompt = no',
      'default_md = sha256',
      'x509_extensions = v3_req',
      'distinguished_name = dn',
      '',
      '[dn]',
      'CN = PocketParty Local',
      '',
      '[v3_req]',
      'basicConstraints = CA:FALSE',
      'keyUsage = digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = ${sanEntries.join(', ')}`
    ].join('\n');

    fs.writeFileSync(confPath, conf, 'utf8');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-nodes',
      '-days', '365',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-config', confPath
    ], { stdio: 'pipe' });
    fs.writeFileSync(metaPath, sanSignature, 'utf8');
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    keyPath,
    certPath
  };
}
