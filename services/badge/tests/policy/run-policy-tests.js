#!/usr/bin/env node
'use strict';

// P4 tests: SPE overlay + limits/advisor.

const fs = require('fs');
const os = require('os');
const path = require('path');

const spe = require('../../engine/spe');
const limits = require('../../policy/limits');
const { status } = require('../../policy/advisor');
const store = require('../../ledger/store');
const { computeFlightDose } = require('../../engine/dose');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
console.log('\nBADGE policy + SPE tests (P4)\n');

// --- proton physics ----------------------------------------------------------
// 0.445 GV is the textbook rigidity of a 100 MeV proton.
check('rigidity->energy: 0.445 GV is a 100 MeV proton',
  near(spe.energyFromRigidity(0.4446), 100, 1), spe.energyFromRigidity(0.4446).toFixed(1));
check('rigidity->energy: 1 GV is ~433 MeV',
  near(spe.energyFromRigidity(1.0), 433, 3), spe.energyFromRigidity(1.0).toFixed(1));
check('higher cutoff demands higher energy',
  spe.energyFromRigidity(13.6) > spe.energyFromRigidity(0.26));

// Reaching sea level takes ~GeV protons — why only GLEs show on ground monitors.
check('sea-level penetration needs GeV-class protons',
  spe.energyToPenetrateDepth(1033) > 1000, spe.energyToPenetrateDepth(1033).toFixed(0));
check('cruise depth threshold is several hundred MeV',
  spe.energyToPenetrateDepth(166) > 300 && spe.energyToPenetrateDepth(166) < 900,
  spe.energyToPenetrateDepth(166).toFixed(0));
check('deeper atmosphere raises the threshold',
  spe.energyToPenetrateDepth(300) > spe.energyToPenetrateDepth(150));

// --- spectrum ----------------------------------------------------------------
check('integral flux falls with energy',
  spe.integralFluxAbove(100, 1000, 20) < spe.integralFluxAbove(10, 1000, 20));
check('flux at/below the anchor returns the measured value',
  spe.integralFluxAbove(10, 1000, 20) === 1000);
check('zero flux stays zero', spe.integralFluxAbove(500, 0, 0) === 0);

// --- gating ------------------------------------------------------------------
const storm = { flux10MeV: 1200, flux100MeV: 30 };
const polar = spe.doseRateAtPoint({ cutoffRigidityGV: 0.26, depthGcm2: 166 }, storm);
const equator = spe.doseRateAtPoint({ cutoffRigidityGV: 13.6, depthGcm2: 166 }, storm);

check('polar cruise is gated by the atmosphere, not the field', polar.gatedBy === 'atmosphere');
check('equatorial cruise is gated by the geomagnetic field', equator.gatedBy === 'geomagnetic');
// §4.3: events produce essentially no increase in the mid-latitude band.
check('polar dose rate hugely exceeds equatorial',
  polar.doseRateUSvPerHr > equator.doseRateUSvPerHr * 50,
  `${polar.doseRateUSvPerHr.toFixed(2)} vs ${equator.doseRateUSvPerHr.toFixed(3)}`);
check('lower altitude reduces the accessible flux',
  spe.doseRateAtPoint({ cutoffRigidityGV: 0.26, depthGcm2: 300 }, storm).doseRateUSvPerHr <
  polar.doseRateUSvPerHr);

// --- overlay behaviour -------------------------------------------------------
const track = [
  { tHours: 0, cutoffRigidityGV: 0.26, depthGcm2: 166 },
  { tHours: 5, cutoffRigidityGV: 0.26, depthGcm2: 166 },
  { tHours: 10, cutoffRigidityGV: 0.26, depthGcm2: 166 },
];

const uncovered = spe.overlay(track, { covered: false, note: 'no archived data' });
check('uncovered window yields null, never zero', uncovered.speMSv === null);
check('uncovered window is marked not applied', uncovered.applied === false);
check('uncovered window explains itself', typeof uncovered.reason === 'string');

const quietWindow = spe.overlay(track, {
  covered: true, protonEventActive: false, aviationHighEnergyActive: false,
  peak10MeV: 0.3, peak100MeV: 0.2,
});
check('quiet window yields a confident zero', quietWindow.speMSv === 0 && quietWindow.confidence === 'high');

const stormWindow = spe.overlay(track, {
  covered: true, protonEventActive: true, aviationHighEnergyActive: true,
  peak10MeV: 1200, peak100MeV: 30, minutesAboveEventThreshold: 240,
});
check('active event produces a positive SPE dose', stormWindow.speMSv > 0);
check('SPE dose is emitted at low confidence', stormWindow.confidence === 'low');
check('SPE carries its method version', stormWindow.method === 'empirical-overlay-v1');
check('SPE carries an explicit uncertainty band',
  stormWindow.speMSvLow < stormWindow.speMSv && stormWindow.speMSvHigh > stormWindow.speMSv);
check('band is the documented factor', stormWindow.uncertaintyFactor === spe.UNCERTAINTY_FACTOR);
check('SPE reports which gate dominated', stormWindow.gating.pointsGatedByAtmosphere === 3);
check('SPE carries a caveat about the fluence-to-dose step',
  /fluence-to-dose/.test(stormWindow.caveat));

// --- the guardrail: SPE never merges into GCR --------------------------------
const flight = await computeFlightDose({
  origin: 'OMDB', destination: 'KLAX',
  date: { year: 2023, month: 2, day: 8 }, cruiseAltitudeFt: 43000,
});
check('GCR and SPE are separate fields on the result',
  'gcrMSv' in flight.dose && 'speMSv' in flight.dose);
check('no combined "total dose" field exists to be misread',
  !('totalMSv' in flight.dose), Object.keys(flight.dose).join(','));
check('SPE has its own confidence, independent of GCR',
  flight.dose.gcrConfidence !== undefined && 'speConfidence' in flight.dose);
check('flight carries the UTC window SPE was attributed against',
  !!flight.window.departUtc && !!flight.window.arriveUtc);

// --- limit policies ----------------------------------------------------------
const faa = limits.getPolicy('faa-ac120-61b');
check('FAA policy is 20 mSv/yr over 5 years', faa.annualLimitMSv === 20 && faa.averagingWindowYears === 5);
check('FAA policy has the 50 mSv single-year ceiling', faa.singleYearCeilingMSv === 50);
check('FAA pregnancy limit is 0.5 mSv/month', faa.pregnancy.monthlyMaxMSv === 0.5);
// The AC states a monthly rate only; a term total would be putting words in its mouth.
check('FAA policy does not invent a pregnancy term total', faa.pregnancy.totalMSv === null);
check('FAA policy quotes its source text', /5-year average effective dose of 20 mSv/.test(faa.quotes.occupational));

const eu = limits.getPolicy('eu-bss-2013-59');
check('EU policy carries the 1 mSv aircrew assessment threshold',
  eu.aircrewAssessmentThresholdMSv === 1);
check('EU single-year ceiling requires authorisation',
  eu.singleYearCeilingRequiresAuthorisation === true);

check('every policy is marked verifyBeforeUse',
  Object.values(limits.POLICIES).every((p) => p.verifyBeforeUse === true));
check('every policy cites a source',
  Object.values(limits.POLICIES).every((p) => typeof p.source === 'string' && p.source.length > 10));
let threw = false;
try { limits.getPolicy('made-up-policy'); } catch { threw = true; }
check('unknown policy id throws rather than defaulting silently', threw);

// --- advisor -----------------------------------------------------------------
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badge-policy-')), 'ledger.db');
const db = store.open(dbPath);

check('empty ledger reports empty, not zeroes', status(db).empty === true);

const specs = [
  { origin: 'OMDB', destination: 'KLAX', date: { year: 2023, month: 1, day: 10 }, cruiseAltitudeFt: 43000 },
  { origin: 'OMDB', destination: 'KLAX', date: { year: 2023, month: 2, day: 10 }, cruiseAltitudeFt: 43000 },
  { origin: 'LAX', destination: 'ICN', date: { year: 2022, month: 6, day: 10 }, cruiseAltitudeFt: 39000 },
];
const rows = [];
for (const s of specs) rows.push(store.append(db, await computeFlightDose(s), { spec: s }));

const st = status(db, { now: '2023-03-01T00:00:00Z' });
check('YTD counts only the current year', st.flightsLogged === 3 && st.ytdGcrMSv > 0);
check('YTD excludes the prior-year flight',
  near(st.ytdGcrMSv, rows[0].gcr_msv + rows[1].gcr_msv, 1e-9));
check('window average spreads across the averaging window',
  st.windowAverageGcrMSv < st.ytdGcrMSv);
check('projection extrapolates the year', st.projectedYearEndGcrMSv > st.ytdGcrMSv);
check('breach risk is low at these doses', st.breachRisk === 'low');
check('days-to-threshold is reported', typeof st.daysToThreshold === 'number');
check('top contributors are ranked by dose',
  st.topContributors[0].gcrMSv >= st.topContributors[1].gcrMSv);
check('GCR and SPE totals stay separate in status',
  'ytdGcrMSv' in st && 'ytdSpeMSv' in st && !('ytdTotalMSv' in st));
check('status names its policy and source', !!st.policyId && !!st.policySource);
check('status carries the not-medical-advice line', /not medical advice/.test(st.disclaimer));

// Superseded entries must drop out of the totals.
const correctedSpec = { ...specs[0], cruiseAltitudeFt: 31000 };
store.append(db, await computeFlightDose(correctedSpec), { spec: correctedSpec, supersedes: rows[0].id });
const after = status(db, { now: '2023-03-01T00:00:00Z' });
check('correction replaces rather than adds to the total',
  after.flightsLogged === 3 && after.ytdGcrMSv < st.ytdGcrMSv,
  `${after.ytdGcrMSv.toFixed(4)} vs ${st.ytdGcrMSv.toFixed(4)}`);

// Breach banding.
const heavy = status(db, { now: '2023-03-01T00:00:00Z', policyId: 'faa-ac120-61b' });
check('policy is switchable', status(db, { policyId: 'eu-bss-2013-59' }).policyId === 'eu-bss-2013-59');
check('switching policy changes the reported source',
  status(db, { policyId: 'eu-bss-2013-59' }).policySource !== heavy.policySource);
db.close();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
