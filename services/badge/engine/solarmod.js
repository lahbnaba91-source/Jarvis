'use strict';

// Solar modulation parameter by date (brief §7 solarmod.js, §12 open question).
//
// PARMA ships a daily table that ends 2023-05-03. Past that its own lookup returns
// zero and computes a dose from an unfounded default, so BADGE refuses it. That
// refusal was correct but it also meant no present-day flight could be dosed by
// any route — the top blocker for the product.
//
// This closes the gap with three tiers, each declaring its own provenance and
// uncertainty. It never silently guesses; a date it cannot source is refused.
//
//   1. parma-daily    to 2023-05-03   daily resolution, PARMA's bundled table
//   2. oulu-monthly   to 2025-12      Usoskin reconstruction, monthly resolution
//   3. nmdb-nowcast   to today        live Oulu neutron monitor + calibration
//
// PARMA's own W-index to force-field relation is Phi = 370 + 0.3 * W^1.45, so the
// inverse below converts a published Phi into the W-index the engine wants.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'solar');
const OULU_PHI_URL = 'https://cosmicrays.oulu.fi/phi/Phi_mon.txt';
const NMDB_URL =
  'https://www.nmdb.eu/nest/draw_graph.php?formchk=1&stations[]=OULU&tabchoice=revori' +
  '&dtype=corr_for_efficiency&tresolution=1440&force=1&yunits=0&date_choice=last&last_days=30&output=ascii';

// W-index lookup sentinel understood by the compiled driver.
const LOOKUP_BY_DATE = -9999;

// Oulu neutron monitor count rate -> modulation potential.
//
// Least-squares linear fit over 312 monthly pairs, 2000-01 to 2025-12, spanning
// Phi from 255 to 1281 MV: R^2 = 0.9878, in-sample RMSE 26.8 MV.
//
// A quadratic was tried and REJECTED. In sample it looked much better (RMSE 12.0
// vs 26.8, and it removed a +62 MV bias in the >=1000 MV band). Held out —
// trained pre-2021, tested on 2021-2025 — it was worse: RMSE 24.2 MV with a
// -16.2 MV bias, against the linear fit's 21.4 MV and -3.8 MV. The extra term was
// fitting noise, so the simpler model ships.
//
// The honest uncertainty is therefore the holdout figure, 21.4 MV, which
// propagated through PARMA at cruise is roughly 3% in dose.
const NMDB_CALIBRATION = {
  intercept: 4732.5,
  slope: -39.61,
  form: 'linear',
  r2: 0.9878,
  inSampleRmseMV: 26.8,
  holdoutRmseMV: 21.4,
  holdoutBiasMV: -3.8,
  holdoutPeriod: 'trained pre-2021, tested 2021-2025',
  samples: 312,
  fittedRange: '2000-01 to 2025-12',
  doseUncertaintyPct: 3,
  rejectedAlternative: 'quadratic — better in sample, worse on holdout',
};

function wIndexFromPhi(phiMV) {
  if (phiMV <= 370) return 0;
  return Math.pow((phiMV - 370) / 0.3, 1 / 1.45);
}

function phiFromWIndex(w) {
  return w >= 0 ? 370 + 0.3 * Math.pow(w, 1.45) : 370 - 0.3 * Math.pow(Math.abs(w), 1.45);
}

/* --------------------------------------------------------------- disk cache */

function cachePath(name) {
  return path.join(CACHE_DIR, name);
}

function readCache(name, maxAgeHours) {
  const file = cachePath(name);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ageHours = (Date.now() - Date.parse(record.fetchedAt)) / 3600000;
  return { ...record, ageHours, stale: maxAgeHours != null && ageHours > maxAgeHours };
}

function writeCache(name, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(name), JSON.stringify({ fetchedAt: new Date().toISOString(), data }));
}

async function fetchText(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- Oulu monthly */

// Rows are: YEAR  Jan..Dec  ANNUAL — 14 columns.
function parseOuluPhi(text) {
  const monthly = {};
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length !== 14 || !/^(19|20)\d\d$/.test(cols[0])) continue;
    for (let m = 1; m <= 12; m++) {
      const v = Number(cols[m]);
      if (Number.isFinite(v) && v > 0) monthly[`${cols[0]}-${String(m).padStart(2, '0')}`] = v;
    }
  }
  return monthly;
}

async function ouluPhi({ refresh = false } = {}) {
  const cached = readCache('oulu-phi.json', 24 * 30);
  if (cached && !refresh && !cached.stale) return cached.data;
  try {
    const monthly = parseOuluPhi(await fetchText(OULU_PHI_URL));
    if (Object.keys(monthly).length) {
      writeCache('oulu-phi.json', monthly);
      return monthly;
    }
  } catch (_) { /* fall through to whatever is cached */ }
  return cached ? cached.data : null;
}

/* ------------------------------------------------------------ NMDB nowcast */

function parseNmdb(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2})[^;]*;\s*([0-9.]+)/.exec(line);
    if (m) rows.push({ date: m[1], rate: Number(m[2]) });
  }
  return rows;
}

async function nmdbRecent({ refresh = false } = {}) {
  const cached = readCache('nmdb-recent.json', 12);
  if (cached && !refresh && !cached.stale) return cached.data;
  try {
    const rows = parseNmdb(await fetchText(NMDB_URL));
    if (rows.length) {
      writeCache('nmdb-recent.json', rows);
      return rows;
    }
  } catch (_) { /* fall through */ }
  return cached ? cached.data : null;
}

function phiFromCountRate(rate) {
  return NMDB_CALIBRATION.intercept + NMDB_CALIBRATION.slope * rate;
}

/* ------------------------------------------------------------------ resolve */

function parmaTableEnd() {
  // Imported lazily to avoid a require cycle with parma.js.
  return require('./parma').solarCoverage().lastDate;
}

// date: { year, month, day }
async function resolve(date, options = {}) {
  const iso = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  const tableEnd = parmaTableEnd();

  // Tier 1 — PARMA's own daily table.
  if (iso <= tableEnd) {
    return {
      wIndex: LOOKUP_BY_DATE,
      lookupByDate: true,
      ffpMV: null,
      source: 'parma-daily',
      confidence: 'high',
      resolution: 'daily',
      doseUncertaintyPct: null,
      note: `PARMA bundled daily force-field table (covers through ${tableEnd}).`,
    };
  }

  // Tier 2 — Usoskin monthly reconstruction published by Oulu.
  const monthly = await ouluPhi(options);
  const monthKey = `${date.year}-${String(date.month).padStart(2, '0')}`;
  if (monthly && monthly[monthKey]) {
    const phi = monthly[monthKey];
    return {
      wIndex: wIndexFromPhi(phi),
      lookupByDate: false,
      ffpMV: phi,
      source: 'oulu-monthly',
      confidence: 'medium',
      resolution: 'monthly',
      doseUncertaintyPct: null,
      note:
        'Usoskin modulation potential, monthly resolution, from cosmicrays.oulu.fi. ' +
        'Monthly averaging cannot represent a Forbush decrease or a GLE within the month.',
    };
  }

  // Tier 3 — nowcast from the live Oulu neutron monitor.
  const rows = await nmdbRecent(options);
  if (rows && rows.length) {
    const todayIso = new Date().toISOString().slice(0, 10);
    if (iso > todayIso) {
      const err = new Error(
        `${iso} is in the future. Solar modulation cannot be observed ahead of time; ` +
        'a forecast model is required and BADGE does not guess one.'
      );
      err.code = 'FUTURE_DATE';
      throw err;
    }
    // Average the most recent week to damp daily noise.
    const recent = rows.slice(-7);
    const rate = recent.reduce((a, r) => a + r.rate, 0) / recent.length;
    const phi = phiFromCountRate(rate);
    return {
      wIndex: wIndexFromPhi(phi),
      lookupByDate: false,
      ffpMV: phi,
      source: 'nmdb-nowcast',
      confidence: 'low',
      resolution: 'nowcast',
      countRate: rate,
      calibration: NMDB_CALIBRATION,
      doseUncertaintyPct: NMDB_CALIBRATION.doseUncertaintyPct,
      note:
        `Nowcast from the live Oulu neutron monitor (${recent.length}-day mean count rate ` +
        `${rate.toFixed(2)}), converted with a linear fit validated out of sample: ` +
        `holdout RMSE ${NMDB_CALIBRATION.holdoutRmseMV} MV over ${NMDB_CALIBRATION.samples} months. That is ` +
        `about ${NMDB_CALIBRATION.doseUncertaintyPct}% in dose. It is a present-day estimate, ` +
        'not the published reconstruction, and does not resolve short-lived events.',
    };
  }

  const err = new Error(
    `No solar modulation data available for ${iso}. PARMA's table covers through ${tableEnd}; ` +
    'the Oulu and NMDB sources were unreachable and nothing usable is cached.'
  );
  err.code = 'NO_SOLAR_DATA';
  throw err;
}

module.exports = {
  resolve, wIndexFromPhi, phiFromWIndex, phiFromCountRate,
  ouluPhi, nmdbRecent, parseOuluPhi, parseNmdb,
  LOOKUP_BY_DATE, NMDB_CALIBRATION,
};
