// Sky Radar server: serves the page and relays live aircraft data.
// The public ADS-B feeds don't allow direct calls from a web page, so the page
// asks this server (/api/aircraft) and the server asks the feeds.
// Zero dependencies — Node 18+ only.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UA = 'SkyRadar/1.0 (personal radar page)';

// Tried in order; the first one that answers wins. SKYRADAR_FEEDS overrides for testing.
const FEEDS = process.env.SKYRADAR_FEEDS ? JSON.parse(process.env.SKYRADAR_FEEDS) : [
  { name: 'adsb.lol',       url: 'https://api.adsb.lol/v2/point/{lat}/{lon}/{r}' },
  { name: 'airplanes.live', url: 'https://api.airplanes.live/v2/point/{lat}/{lon}/{r}' },
  { name: 'adsb.fi',        url: 'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}' },
];

const cache = new Map();          // key -> {at, body}
const CACHE_MS = 4000;
let preferred = 0;                // index of the last feed that worked

async function fetchFeed(f, lat, lon, r) {
  const url = f.url.replace('{lat}', lat).replace('{lon}', lon).replace('{r}', r);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 7000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const ac = Array.isArray(j.ac) ? j.ac : Array.isArray(j.aircraft) ? j.aircraft : null;
    if (!ac) throw new Error('unexpected payload');
    return ac;
  } finally { clearTimeout(t); }
}

async function aircraft(lat, lon, r) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${r}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  const errors = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const idx = (preferred + i) % FEEDS.length, f = FEEDS[idx];
    try {
      const ac = await fetchFeed(f, lat.toFixed(4), lon.toFixed(4), r);
      preferred = idx;
      const body = JSON.stringify({ source: f.name, now: Date.now(), ac });
      cache.set(key, { at: Date.now(), body });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return body;
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  const err = new Error('all feeds failed'); err.detail = errors; throw err;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };

function serveFile(res, rel) {
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || path.basename(file) === 'server.js' || file.includes(`${path.sep}node_modules${path.sep}`)) {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/aircraft') {
    const lat = +u.searchParams.get('lat'), lon = +u.searchParams.get('lon');
    const r = Math.max(1, Math.min(250, Math.round(+u.searchParams.get('r') || 40)));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"lat and lon are required"}');
    }
    try {
      const body = await aircraft(lat, lon, r);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(body);
    } catch (e) {
      console.error('[sky-radar]', e.message, e.detail);
      res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ error: 'Flight feeds unavailable', detail: e.detail }));
    }
    return;
  }
  if (u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveFile(res, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
});

server.listen(PORT, () => console.log(`Sky Radar on port ${PORT}`));
