'use strict';

// Subprocess wrapper around the vendored PARMA 4.10 dose engine (JAEA / T. Sato).
// Non-commercial use; cite Sato 2015 (PLOS ONE 10(12):e0144679) and Sato 2016 (11(8):e0160390).

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'PARMA');
const BINARY = path.join(VENDOR_DIR, 'route_dose');
const FFP_DAILY_TABLE = path.join(VENDOR_DIR, 'input', 'FFPtable.day');

const MODEL_VERSION = 'PARMA-4.10';

// PARMA's local geometry parameter. 10.0 = free air, no surrounding mass.
// Negative values model aircraft mass (|g| in 100-tonne units) and affect the
// neutron spectrum only. See PARMA readme Q6 and §12 (aircraft shielding).
const G_FREE_AIR = 10.0;

let coverageCache = null;

// PARMA ships Usoskin-derived daily force-field data that ends mid-2023; past that
// getHPcpp returns 0 and computes a dose from an unfounded default. Callers must
// never present those numbers, so we read the table and report the real cutoff.
function solarCoverage() {
  if (coverageCache) return coverageCache;

  const lines = fs.readFileSync(FFP_DAILY_TABLE, 'utf8').split('\n').filter((l) => l.trim());
  const header = lines[0].trim().split(/\s+/).map(Number);
  const startYear = header[0];
  const endYear = header[1];
  const yearCount = endYear - startYear + 1;

  let latest = null;
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/).map(Number);
    if (cols.length < 2 + yearCount) continue;
    const month = cols[0];
    const day = cols[1];
    for (let i = 0; i < yearCount; i++) {
      const value = cols[2 + i];
      if (value > -99) {
        const year = startYear + i;
        const stamp = year * 10000 + month * 100 + day;
        if (!latest || stamp > latest.stamp) latest = { stamp, year, month, day };
      }
    }
  }

  coverageCache = {
    startYear,
    endYear,
    lastDate: latest
      ? `${latest.year}-${String(latest.month).padStart(2, '0')}-${String(latest.day).padStart(2, '0')}`
      : null,
  };
  return coverageCache;
}

function ensureBinary() {
  if (!fs.existsSync(BINARY)) {
    throw new Error(
      `PARMA driver not built. Run: services/badge/engine/native/build.sh`
    );
  }
}

// points: [{ year, month, day, lat, lon, altFt, g? }]
// returns: [{ wIndex, forceFieldMV, cutoffRigidityGV, depthGcm2, effUSvPerHr, h10USvPerHr }]
function doseRates(points, options = {}) {
  ensureBinary();
  if (!points.length) return [];

  const g = options.g === undefined ? G_FREE_AIR : options.g;
  const stdin = points
    .map((p) => `${p.year} ${p.month} ${p.day} ${p.lat.toFixed(6)} ${p.lon.toFixed(6)} ${Math.round(p.altFt)} ${p.g === undefined ? g : p.g}`)
    .join('\n');

  const stdout = execFileSync(BINARY, {
    cwd: VENDOR_DIR,
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const records = stdout
    .split('\n')
    .filter((l) => l.startsWith('PT '))
    .map((l) => {
      const [, wIndex, forceFieldMV, cutoff, depth, eff, h10] = l.trim().split(/\s+/).map(Number);
      return {
        wIndex,
        forceFieldMV,
        cutoffRigidityGV: cutoff,
        depthGcm2: depth,
        effUSvPerHr: eff,
        h10USvPerHr: h10,
      };
    });

  if (records.length !== points.length) {
    throw new Error(`PARMA returned ${records.length} records for ${points.length} points`);
  }

  const blind = records.findIndex((r) => r.wIndex === 0);
  if (blind !== -1) {
    const cov = solarCoverage();
    const p = points[blind];
    throw new Error(
      `No solar modulation data for ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}. ` +
        `PARMA's bundled force-field table covers ${cov.startYear} through ${cov.lastDate}. ` +
        `Dates past that need a forecast solar parameter (see brief §12) and are refused rather than guessed.`
    );
  }

  return records;
}

module.exports = { doseRates, solarCoverage, MODEL_VERSION, G_FREE_AIR, VENDOR_DIR };
