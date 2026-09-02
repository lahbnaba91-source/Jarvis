#!/usr/bin/env node
'use strict';

// BADGE server: the JSON API and the static dashboard on one origin, one port,
// no build step (brief §9.1, §10.1).

const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('./api/routes');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = process.env.BADGE_DB || undefined;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // Contain path traversal: the resolved file must stay inside public/.
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (api.handle(req, res, { dbPath: DB_PATH })) return;
  serveStatic(req, res);
});

if (require.main === module) {
  // 0.0.0.0, not loopback — Codespaces cannot forward a loopback-only listener.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`BADGE on ${PORT} (bound 0.0.0.0)`);
    if (DB_PATH) console.log(`Ledger: ${DB_PATH}`);
    const cs = process.env.CODESPACE_NAME;
    if (cs) {
      const domain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
      console.log(`Forwarded URL: https://${cs}-${PORT}.${domain}`);
    }
  });
}

module.exports = { server, PORT };
