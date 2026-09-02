#!/usr/bin/env node
'use strict';

// P7 tests: ADS-B decode, coverage accounting, and the recorded-track dose path.
// Offline — network access is never required to run the suite.

const adsb = require('../../telemetry/adsb');
const coverage = require('../../telemetry/coverage');
const { computeTrackDose } = require('../../engine/track-dose');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\nBADGE telemetry tests (P7)\n');

// --- state vector decode -----------------------------------------------------
// A real OpenSky state vector, captured live 2026-09-02.
const raw = ['39de4b', 'TVF44UJ ', 'France', 1788336075, 1788336075, 7.3849, 45.1431,
  11894.82, false, 254.6, 124.88, 0.33, null, 12367.26, '1000', false, 0];
const sv = adsb.decodeStateVector(raw);

check('decodes icao24 and trims the callsign', sv.icao24 === '39de4b' && sv.callsign === 'TVF44UJ');
check('decodes position', sv.latitude === 45.1431 && sv.longitude === 7.3849);
check('converts barometric altitude to feet',
  Math.round(sv.baroAltitudeFt) === 39025, String(Math.round(sv.baroAltitudeFt)));
check('converts geometric altitude to feet',
  Math.round(sv.geoAltitudeFt) === 40575, String(Math.round(sv.geoAltitudeFt)));
// §6.2: geometric altitude is a quality signal, never a correction.
check('records baro/geom divergence rather than averaging them',
  Math.round(sv.baroGeomDivergenceFt) === 1550 &&
  Math.round(sv.baroAltitudeFt) === 39025, 'baro must be untouched');
check('handles a missing geometric altitude', (() => {
  const partial = adsb.decodeStateVector(['abc123', 'X ', 'US', 1, 1, 0, 0, 10000, false, 0, 0, 0, null, null, null, false, 0]);
  return partial.geoAltitudeFt === null && partial.baroGeomDivergenceFt === null;
})());

// --- track decode ------------------------------------------------------------
const trackBody = {
  icao24: '407b8f', callsign: 'BAW548 ', startTime: 1000, endTime: 1240,
  path: [
    [1000, 51.0, -0.5, 11887.2, 90, false],
    [1120, 51.5, -1.5, 11887.2, 90, false],
    [1240, 52.0, -2.5, 0, 90, true],
  ],
};
const decoded = adsb.decodeTrackPath(trackBody);
check('track decode trims the callsign', decoded.callsign === 'BAW548');
check('track altitudes convert to feet', Math.round(decoded.samples[0].altFt) === 39000);
check('track samples are tagged as barometric',
  decoded.samples.every((s) => s.altSource === 'baro'));
check('on-ground samples are dropped from the dose track',
  adsb.toDoseTrack(decoded.samples).length === 2);

// --- coverage ----------------------------------------------------------------
const contiguous = [];
for (let i = 0; i < 30; i++) contiguous.push({ t: i * 60, lat: 50 + i * 0.1, lon: -10 - i * 0.2, altFt: 39000, altSource: 'baro' });
const clean = coverage.prepare(contiguous);
check('a contiguous track is fully covered', clean.coveredFraction === 1);
check('a contiguous track gets no interpolation', clean.interpolatedSamples === 0);
check('a contiguous track reports no gaps', clean.gaps.length === 0);

const gapped = [
  ...contiguous,
  ...Array.from({ length: 30 }, (_, i) => ({
    t: 30 * 60 + 2400 + i * 60, lat: 55 + i * 0.1, lon: -20 - i * 0.2, altFt: 39000, altSource: 'baro',
  })),
];
const filled = coverage.prepare(gapped);
check('an oceanic gap is detected', filled.gaps.length === 1);
check('the gap is filled with interpolated samples', filled.interpolatedSamples > 0);
// §13.7: interpolation is never counted as recorded data.
check('interpolated time is excluded from coveredFraction',
  filled.coveredFraction < 1 && filled.coveredFraction > 0.5,
  filled.coveredFraction.toFixed(3));
check('every filled sample is tagged as interpolated',
  filled.samples.filter((s) => s.interpolated).every((s) => s.altSource === 'interpolated'));
check('recorded samples keep their original source',
  filled.samples.filter((s) => !s.interpolated).every((s) => s.altSource === 'baro'));
check('the source breakdown separates real from reconstructed',
  filled.sourceBreakdown.baro === 60 && filled.sourceBreakdown.interpolated > 0);
check('interpolation holds the last known flight level',
  filled.samples.filter((s) => s.interpolated).every((s) => s.altFt === 39000));

// --- recorded-track dose -----------------------------------------------------
const t0 = Math.floor(Date.UTC(2023, 2, 15, 0, 0, 0) / 1000);
const cleanTrack = Array.from({ length: 90 }, (_, i) => ({
  t: t0 + i * 60, lat: 55 + i * 0.12, lon: -30 - i * 0.25, altFt: 39000,
  altSource: 'baro', baroGeomDivergenceFt: 520,
}));
const doseClean = computeTrackDose(cleanTrack, { callsign: 'TEST1' });

check('a recorded track produces a dose', doseClean.dose.gcrMSv > 0);
check('full coverage keeps ADS-B high confidence',
  doseClean.dose.gcrConfidence === 'high' && doseClean.telemetry.source === 'adsb-baro');
check('altitude source is recorded as barometric', doseClean.telemetry.altSource === 'baro');
check('normal baro/geom divergence flags nominal', doseClean.telemetry.qualityFlag === 'nominal');
check('the UTC window comes from the track itself',
  doseClean.window.departUtc === new Date(t0 * 1000).toISOString());
check('GCR and SPE stay separate on the track path',
  'gcrMSv' in doseClean.dose && 'speMSv' in doseClean.dose && !('totalMSv' in doseClean.dose));

const gappyTrack = [
  ...cleanTrack.slice(0, 40),
  ...cleanTrack.slice(40).map((s) => ({ ...s, t: s.t + 3000 })),
];
const doseGappy = computeTrackDose(gappyTrack, { callsign: 'TEST2' });
check('partial coverage downgrades confidence',
  doseGappy.dose.gcrConfidence !== 'high', doseGappy.dose.gcrConfidence);
check('partial coverage relabels the source as merged',
  doseGappy.telemetry.source === 'merged');
check('the uncertainty basis names the interpolated share',
  /interpolated/.test(doseGappy.dose.uncertaintyBasis), doseGappy.dose.uncertaintyBasis);
check('coveredFraction is reported below 1', doseGappy.telemetry.coveredFraction < 1);

const wideDivergence = computeTrackDose(
  cleanTrack.map((s) => ({ ...s, baroGeomDivergenceFt: 1900 })), { callsign: 'TEST3' });
check('divergence beyond the published range is flagged',
  wideDivergence.telemetry.qualityFlag === 'baro-geom-divergence-above-published-range');

let tooShort = false;
try { computeTrackDose([{ t: 0, lat: 0, lon: 0, altFt: 39000 }]); } catch { tooShort = true; }
check('a one-point track is refused rather than guessed', tooShort);

// The failure that actually blocks this phase in practice.
let solarRefused = false;
try {
  const now = Math.floor(Date.now() / 1000);
  computeTrackDose([
    { t: now, lat: 55, lon: -30, altFt: 39000, altSource: 'baro' },
    { t: now + 600, lat: 56, lon: -31, altFt: 39000, altSource: 'baro' },
  ]);
} catch (err) { solarRefused = /No solar modulation data/.test(err.message); }
check("a present-day track is refused, not guessed (solar data ends 2023-05-03)", solarRefused);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
