'use strict';

// Local proton-flux archive, appended to on every poll.
//
// Why this exists: SWPC's JSON feeds only reach back 7 days, so retrospective SPE
// attribution for a flight older than that has nothing to attribute against. From
// the moment BADGE starts polling it accumulates its own permanent record.
// Deeper history (pre-BADGE) needs an NCEI GOES import — scoped, not built.

const fs = require('fs');
const path = require('path');
const {
  PROTON_EVENT_THRESHOLD_10MEV_PFU,
  AVIATION_THRESHOLD_100MEV_PFU,
} = require('./sources');

const ARCHIVE_PATH = path.join(__dirname, '..', 'data', 'spaceweather', 'proton-archive.jsonl');

// One row per time_tag: the two channels that matter for aviation dose.
function rowsFromProtonFeed(records) {
  const byTime = new Map();
  for (const r of records || []) {
    if (r.energy !== '>=10 MeV' && r.energy !== '>=100 MeV') continue;
    const row = byTime.get(r.time_tag) || { t: r.time_tag, satellite: r.satellite };
    if (r.energy === '>=10 MeV') row.p10 = r.flux;
    else row.p100 = r.flux;
    byTime.set(r.time_tag, row);
  }
  return [...byTime.values()]
    .filter((r) => r.p10 !== undefined || r.p100 !== undefined)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function existingTimestamps() {
  if (!fs.existsSync(ARCHIVE_PATH)) return new Set();
  const seen = new Set();
  for (const line of fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { seen.add(JSON.parse(line).t); } catch { /* skip malformed line */ }
  }
  return seen;
}

function append(records) {
  const rows = rowsFromProtonFeed(records);
  const seen = existingTimestamps();
  const fresh = rows.filter((r) => !seen.has(r.t));
  if (!fresh.length) return { appended: 0, total: seen.size };

  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  fs.appendFileSync(ARCHIVE_PATH, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { appended: fresh.length, total: seen.size + fresh.length };
}

function readArchive() {
  if (!fs.existsSync(ARCHIVE_PATH)) return [];
  return fs
    .readFileSync(ARCHIVE_PATH, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// Retrospective attribution: was a proton event running during this flight window?
// Returns the evidence only. It deliberately does NOT estimate a dose — the SPE
// overlay is P4, and GCR and SPE never merge (guardrail §13.4).
function eventsInWindow(startUtc, endUtc) {
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  const rows = readArchive().filter((r) => {
    const t = Date.parse(r.t);
    return t >= start && t <= end;
  });

  if (!rows.length) {
    return {
      covered: false,
      samples: 0,
      note: 'No archived proton data covers this window. SWPC JSON reaches back 7 days; ' +
            'earlier flights need an NCEI GOES import, which is not built.',
      peak10MeV: null,
      peak100MeV: null,
      protonEventActive: null,
      aviationHighEnergyActive: null,
    };
  }

  const peak10 = Math.max(...rows.map((r) => r.p10 ?? 0));
  const peak100 = Math.max(...rows.map((r) => r.p100 ?? 0));

  return {
    covered: true,
    samples: rows.length,
    windowStartUtc: startUtc,
    windowEndUtc: endUtc,
    peak10MeV: peak10,
    peak100MeV: peak100,
    protonEventActive: peak10 >= PROTON_EVENT_THRESHOLD_10MEV_PFU,
    aviationHighEnergyActive: peak100 >= AVIATION_THRESHOLD_100MEV_PFU,
    minutesAboveEventThreshold: rows.filter((r) => (r.p10 ?? 0) >= PROTON_EVENT_THRESHOLD_10MEV_PFU).length,
  };
}

function stats() {
  const rows = readArchive();
  if (!rows.length) return { samples: 0, earliest: null, latest: null };
  return { samples: rows.length, earliest: rows[0].t, latest: rows[rows.length - 1].t };
}

module.exports = { append, readArchive, eventsInWindow, stats, rowsFromProtonFeed, ARCHIVE_PATH };
