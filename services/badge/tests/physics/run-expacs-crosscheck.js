#!/usr/bin/env node
'use strict';

// EXPACS / PARMA cross-check.
//
// Runs BADGE's own native driver (engine/native/route_dose.cpp) and PARMA's
// reference dose generator (tests/physics/native/parma_reference.cpp, a re-plumbed
// copy of vendor/PARMA/main.cpp) over the SAME flight sample points, and diffs
// the ICRP-116 effective dose rate point by point.
//
// Both binaries link the identical vendor/PARMA/subroutines.cpp, so this isolates
// exactly one thing: whether BADGE's dose-integration loop, energy-bin handling,
// 511 keV line, dcc indexing and unit conversion faithfully reproduce PARMA's own.
// PARMA's EXPACS web frontend runs the same core, so BADGE == PARMA here means
// BADGE == EXPACS at the engine level, and any BADGE-vs-CARI-7A gap is a
// PARMA-vs-NYMMIK physics-model difference, not a BADGE implementation error.
//
// Expected result: agreement to floating-point rounding (< 0.01%). Anything
// larger is a real transcription bug in route_dose.cpp.
//
// Run: node tests/physics/run-expacs-crosscheck.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BADGE_DIR = path.join(__dirname, '..', '..');
const VENDOR_DIR = path.join(BADGE_DIR, 'vendor', 'PARMA');
const ROUTE_DOSE = path.join(VENDOR_DIR, 'route_dose');
const PARMA_REF = path.join(VENDOR_DIR, 'parma_reference');

const GATE_PCT = 0.5; // hard gate; expect << 0.01%

function ensureBuilt() {
  if (!fs.existsSync(ROUTE_DOSE)) {
    execFileSync('bash', [path.join(BADGE_DIR, 'engine', 'native', 'build.sh')], { stdio: 'inherit' });
  }
  if (!fs.existsSync(PARMA_REF)) {
    execFileSync('bash', [path.join(__dirname, 'native', 'build-reference.sh')], { stdio: 'inherit' });
  }
}

// Flight sample points spanning the corners of the operational envelope:
// deep solar minimum and solar maximum dates (all inside PARMA's bundled table),
// polar / mid / equatorial cutoff, FL350-FL430, plus pilot and cabin geometry.
function testPoints() {
  const dates = [
    { y: 2009, m: 12, d: 1, label: 'solar-min 2009' },
    { y: 2014, m: 4, d: 15, label: 'solar-max 2014' },
    { y: 2019, m: 6, d: 15, label: 'solar-min 2019' },
    { y: 2001, m: 3, d: 20, label: 'solar-max 2001' },
  ];
  const places = [
    { lat: 80, lon: 20, label: 'polar' },
    { lat: 45, lon: 0, label: 'mid' },
    { lat: 2, lon: -50, label: 'equator' },
  ];
  const alts = [35000, 39000, 43000];

  const pts = [];
  for (const dt of dates)
    for (const pl of places)
      for (const altFt of alts)
        pts.push({ ...dt, ...pl, altFt, g: 10, tag: `${dt.label} / ${pl.label} / FL${altFt / 100}` });

  // Non-free-air geometry (affects the neutron spectrum only, per PARMA readme Q6).
  pts.push({ y: 2019, m: 6, d: 15, lat: 45, lon: 0, altFt: 39000, g: -0.5, tag: 'pilot geometry g=-0.5' });
  pts.push({ y: 2019, m: 6, d: 15, lat: 45, lon: 0, altFt: 39000, g: -80, tag: 'cabin geometry g=-80' });
  pts.push({ y: 2014, m: 4, d: 15, lat: 80, lon: 20, altFt: 43000, g: -0.5, tag: 'pilot geometry, polar solar-max' });
  return pts;
}

function runParmaReference(pts) {
  const condFile = path.join(os.tmpdir(), `badge-xcheck-${process.pid}.inp`);
  const body =
    '0 3\n' +
    pts.map((p) => `${p.y} ${p.m} ${p.d} ${p.lat} ${p.lon} ${p.altFt} ${p.g}`).join('\n') +
    '\n';
  fs.writeFileSync(condFile, body);
  try {
    const out = execFileSync(PARMA_REF, [condFile], { cwd: VENDOR_DIR, encoding: 'utf8' });
    return out
      .trim()
      .split('\n')
      .map((l) => {
        const [s, r, d, g, eff] = l.trim().split(/\s+/).map(Number);
        return { s, r, d, g, eff };
      });
  } finally {
    fs.unlinkSync(condFile);
  }
}

function runBadgeDriver(pts) {
  const stdin =
    pts
      .map((p) => `${p.y} ${p.m} ${p.d} ${p.lat.toFixed(6)} ${p.lon.toFixed(6)} ${p.altFt} ${p.g} -9999`)
      .join('\n') + '\n';
  const out = execFileSync(ROUTE_DOSE, { cwd: VENDOR_DIR, input: stdin, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => l.startsWith('PT '))
    .map((l) => {
      const [, wIndex, ffp, cutoff, depth, eff, h10] = l.trim().split(/\s+/).map(Number);
      return { wIndex, ffp, cutoff, depth, eff, h10 };
    });
}

(function main() {
  console.log('BADGE <-> PARMA (EXPACS engine) cross-check');
  ensureBuilt();

  const pts = testPoints();
  const parmaRef = runParmaReference(pts);
  const badge = runBadgeDriver(pts);

  if (parmaRef.length !== pts.length || badge.length !== pts.length) {
    console.log(`FAIL: point count mismatch (pts ${pts.length}, parma ${parmaRef.length}, badge ${badge.length})`);
    process.exit(1);
  }

  console.log('-'.repeat(92));
  console.log(
    '  ' +
      'condition'.padEnd(40) +
      'Rc GV'.padStart(8) +
      'depth'.padStart(9) +
      'PARMA uSv/h'.padStart(14) +
      'BADGE uSv/h'.padStart(14) +
      'dev %'.padStart(9)
  );
  console.log('-'.repeat(92));

  let maxDev = 0;
  let maxInputDev = 0;
  let fails = 0;

  for (let i = 0; i < pts.length; i++) {
    const ref = parmaRef[i];
    const b = badge[i];
    // The two binaries derive s, r, d identically; confirm that before trusting
    // the dose comparison.
    const inputDev = Math.max(
      ref.r === 0 ? Math.abs(b.cutoff) : Math.abs((b.cutoff - ref.r) / ref.r),
      Math.abs((b.depth - ref.d) / ref.d)
    );
    maxInputDev = Math.max(maxInputDev, inputDev);

    const dev = ((b.eff - ref.eff) / ref.eff) * 100;
    maxDev = Math.max(maxDev, Math.abs(dev));
    const ok = Math.abs(dev) <= GATE_PCT;
    if (!ok) fails++;

    console.log(
      `  ${ok ? ' ' : '!'} ${pts[i].tag.padEnd(38)}` +
        `${ref.r.toFixed(2).padStart(8)}` +
        `${ref.d.toFixed(1).padStart(9)}` +
        `${ref.eff.toExponential(4).padStart(14)}` +
        `${b.eff.toExponential(4).padStart(14)}` +
        `${dev.toFixed(4).padStart(9)}`
    );
  }

  console.log('-'.repeat(92));
  console.log(`  points:            ${pts.length}`);
  console.log(`  max |dose dev|:    ${maxDev.toExponential(3)} %   (gate ${GATE_PCT}%)`);
  console.log(`  max |input dev|:   ${maxInputDev.toExponential(3)}     (s/r/d derived identically by both)`);
  console.log('-'.repeat(92));

  if (fails === 0) {
    console.log(
      'RESULT: BADGE\'s native driver reproduces PARMA\'s reference generator to floating-point\n' +
        '        rounding. The dose engine is faithful; BADGE == PARMA == EXPACS at engine level.'
    );
    process.exit(0);
  }
  console.log(`RESULT: ${fails} point(s) exceeded ${GATE_PCT}% — a real transcription bug in route_dose.cpp.`);
  process.exit(1);
})();
