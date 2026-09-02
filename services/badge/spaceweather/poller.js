#!/usr/bin/env node
'use strict';

// SWPC ingest. Fetches each endpoint, writes last-known-good to the cache,
// appends proton readings to the permanent archive, and evaluates alert crossings.
//
//   node spaceweather/poller.js --once        one pass and exit
//   node spaceweather/poller.js               poll forever (default 5 min)
//   node spaceweather/poller.js --interval=10 poll every 10 minutes
//
// Per brief §10.3 this cannot live in Codespaces in production — Codespaces sleeps.
// Railway (or any always-on host) runs it for real.

const { SOURCES } = require('./sources');
const cache = require('./cache');
const archive = require('./archive');
const { classify } = require('./classify');
const alerts = require('./alerts');

const DEFAULT_INTERVAL_MINUTES = 5;
const FETCH_TIMEOUT_MS = 30000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// A failed fetch must never blank the cache — the whole point of last-known-good
// is that an SWPC outage degrades to stale data, not to no data.
async function pollOnce({ includeSevenDay = false, quiet = false } = {}) {
  const keys = ['scales', 'protons', 'xrays', 'alerts', 'kindex'];
  if (includeSevenDay) keys.push('protons7Day');

  const results = {};
  for (const key of keys) {
    try {
      const data = await fetchJson(SOURCES[key].url);
      cache.write(key, data);
      results[key] = { ok: true, records: Array.isArray(data) ? data.length : 1 };
    } catch (err) {
      const existing = cache.read(key);
      results[key] = {
        ok: false,
        error: err.message,
        servingCached: existing.present,
        cachedAgeMinutes: existing.ageMinutes,
      };
    }
  }

  // Grow the permanent archive from whichever proton feed we got.
  let archived = { appended: 0, total: archive.stats().samples };
  const protonsCached = cache.read(includeSevenDay ? 'protons7Day' : 'protons');
  if (protonsCached.present) archived = archive.append(protonsCached.data);

  const current = classify({
    protons: cache.read('protons').data,
    kindex: cache.read('kindex').data,
    scales: cache.read('scales').data,
  });
  const { alerts: fired } = alerts.evaluate(current);

  if (!quiet) {
    const stamp = new Date().toISOString();
    const failures = Object.entries(results).filter(([, r]) => !r.ok);
    console.log(
      `[${stamp}] ${current.sScale} | >=10MeV ${fmt(current.protons10MeV)} pfu | ` +
      `>=100MeV ${fmt(current.protons100MeV)} pfu | risk ${current.aviationRisk.score}/100 | ` +
      `archive ${archived.total} (+${archived.appended})` +
      (failures.length ? ` | FAILED: ${failures.map(([k]) => k).join(',')}` : '')
    );
    for (const a of fired) console.log(`  ALERT [${a.severity}] ${a.type}: ${a.message}`);
  }

  return { results, current, alerts: fired, archived };
}

function fmt(v) {
  return v === null || v === undefined ? 'n/a' : v < 0.01 ? v.toExponential(2) : v.toFixed(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const intervalFlag = argv.find((a) => a.startsWith('--interval='));
  const minutes = intervalFlag ? Number(intervalFlag.split('=')[1]) : DEFAULT_INTERVAL_MINUTES;

  // First run seeds the archive from the 7-day feed so there is immediate history.
  const seed = archive.stats().samples === 0;
  if (seed) console.log('Archive empty — seeding from the 7-day proton feed.');

  await pollOnce({ includeSevenDay: seed });
  if (once) return;

  console.log(`Polling every ${minutes} minute(s). Ctrl-C to stop.`);
  setInterval(() => {
    pollOnce().catch((err) => console.error(`[poll error] ${err.message}`));
  }, minutes * 60000);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { pollOnce, fetchJson };
