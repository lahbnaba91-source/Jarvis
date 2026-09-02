'use strict';

// Last-known-good cache for SWPC data. Survives an SWPC outage and a Codespace
// sleep, and every read carries its own age so nothing downstream can render a
// cached value as if it were live (guardrail §13.3).

const fs = require('fs');
const path = require('path');
const { SOURCES } = require('./sources');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'spaceweather');

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.json`);
}

function write(key, data, meta = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const record = {
    key,
    fetchedAt: new Date().toISOString(),
    url: (SOURCES[key] || {}).url || null,
    ...meta,
    data,
  };
  fs.writeFileSync(cachePath(key), JSON.stringify(record));
  return record;
}

// Always returns staleness alongside the payload — there is no way to read the
// cache without also learning how old it is.
function read(key, now = Date.now()) {
  const file = cachePath(key);
  if (!fs.existsSync(file)) {
    return { key, present: false, data: null, fetchedAt: null, ageMinutes: null, stale: true };
  }

  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ageMinutes = (now - Date.parse(record.fetchedAt)) / 60000;
  const limit = (SOURCES[key] || {}).staleAfterMinutes ?? 60;

  return {
    key,
    present: true,
    data: record.data,
    url: record.url,
    fetchedAt: record.fetchedAt,
    ageMinutes,
    staleAfterMinutes: limit,
    stale: ageMinutes > limit,
    lastError: record.lastError || null,
  };
}

function describeAge(ageMinutes) {
  if (ageMinutes === null) return 'never fetched';
  if (ageMinutes < 1) return 'live';
  if (ageMinutes < 60) return `cached ${Math.round(ageMinutes)}m ago`;
  if (ageMinutes < 1440) return `cached ${(ageMinutes / 60).toFixed(1)}h ago`;
  return `cached ${(ageMinutes / 1440).toFixed(1)}d ago`;
}

module.exports = { write, read, describeAge, cachePath, CACHE_DIR };
