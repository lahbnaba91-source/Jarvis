#!/usr/bin/env node
'use strict';

// P3 space weather tests. Offline: every test runs against fixtures or the local
// archive, so the suite never depends on SWPC being reachable.

const classify = require('../../spaceweather/classify');
const alerts = require('../../spaceweather/alerts');
const archive = require('../../spaceweather/archive');
const spaceweather = require('../../spaceweather');
const cache = require('../../spaceweather/cache');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('\nBADGE space weather tests (P3)\n');

// --- S-scale banding ---------------------------------------------------------
check('S0 below event threshold', classify.sScaleFromPfu(0.26) === 'S0');
check('S1 at 10 pfu', classify.sScaleFromPfu(10) === 'S1');
check('S2 at 100 pfu', classify.sScaleFromPfu(150) === 'S2');
check('S3 at 1000 pfu', classify.sScaleFromPfu(1000) === 'S3');
check('S4 at 10k pfu', classify.sScaleFromPfu(20000) === 'S4');
check('S5 at 100k pfu', classify.sScaleFromPfu(120000) === 'S5');
check('null flux yields null scale', classify.sScaleFromPfu(null) === null);

// --- risk score calibration --------------------------------------------------
// The failure this guards against: scoring the permanent GCR background as risk.
const quiet = classify.aviationRiskScore({ pfu10MeV: 0.26, pfu100MeV: 0.21, kp: 2 });
check('quiet background scores zero', quiet.score === 0, `got ${quiet.score}`);

const scores = [
  classify.aviationRiskScore({ pfu10MeV: 12, pfu100MeV: 1.2, kp: 4 }).score,
  classify.aviationRiskScore({ pfu10MeV: 150, pfu100MeV: 5, kp: 5 }).score,
  classify.aviationRiskScore({ pfu10MeV: 1200, pfu100MeV: 30, kp: 6 }).score,
  classify.aviationRiskScore({ pfu10MeV: 100000, pfu100MeV: 200, kp: 9 }).score,
];
check('risk rises monotonically with storm severity',
  scores.every((s, i) => i === 0 || s > scores[i - 1]), scores.join(','));
check('risk caps at 100', scores[scores.length - 1] === 100);

// >=100 MeV must outweigh >=10 MeV: it is what reaches cruise altitude.
const highOnly = classify.aviationRiskScore({ pfu10MeV: 1, pfu100MeV: 50, kp: 2 }).score;
const lowOnly = classify.aviationRiskScore({ pfu10MeV: 900, pfu100MeV: 0.2, kp: 2 }).score;
check('>=100 MeV weighted above >=10 MeV', highOnly > lowOnly, `high=${highOnly} low=${lowOnly}`);

check('risk carries a method version', quiet.method === 'aviation-risk-v1');
check('risk carries its inputs', quiet.inputs && 'pfu100MeV' in quiet.inputs);

// --- real archived quiet week scores zero throughout -------------------------
const archived = archive.readArchive();
if (archived.length) {
  const worst = Math.max(...archived.map((r) =>
    classify.aviationRiskScore({ pfu10MeV: r.p10, pfu100MeV: r.p100, kp: 2 }).score));
  check('no false positive across the archived quiet period', worst === 0, `worst=${worst}`);
} else {
  console.log('  SKIP  archived quiet period (archive empty — run the poller once)');
}

// --- proton feed parsing -----------------------------------------------------
const feed = [
  { time_tag: '2026-09-01T00:00:00Z', satellite: 18, flux: 0.2, energy: '>=10 MeV' },
  { time_tag: '2026-09-01T00:00:00Z', satellite: 18, flux: 0.1, energy: '>=100 MeV' },
  { time_tag: '2026-09-01T01:00:00Z', satellite: 18, flux: 55, energy: '>=10 MeV' },
  { time_tag: '2026-09-01T01:00:00Z', satellite: 18, flux: 3, energy: '>=100 MeV' },
  { time_tag: '2026-09-01T01:00:00Z', satellite: 18, flux: 900, energy: '>=1 MeV' },
];
const latest = classify.latestProtonFlux(feed);
check('latest reading wins per channel', latest['>=10 MeV'].fluxPfu === 55);
check('all integral channels parsed', Object.keys(latest).length === 3);

const classified = classify.classify({ protons: feed, kindex: [{ Kp: 4 }], scales: null });
check('derives S-scale when NOAA scales absent', classified.sScale === 'S1' &&
  classified.sScaleSource === 'derived-from-flux');
check('flags an active proton event', classified.protonEventActive === true);
check('flags high-energy activity', classified.aviationHighEnergyActive === true);

const withNoaa = classify.classify({ protons: feed, kindex: [], scales: { '0': { S: { Scale: '2' } } } });
check('prefers NOAA published S-scale', withNoaa.sScale === 'S2' && withNoaa.sScaleSource === 'noaa-scales');

// --- forecast ----------------------------------------------------------------
const fc = classify.forecastFromScales({
  '0': { S: { Scale: '0' } },
  '1': { DateStamp: '2026-09-02', S: { Scale: null, Prob: '1' }, R: { Scale: null }, G: { Scale: '0' } },
  '2': { DateStamp: '2026-09-03', S: { Scale: '1', Prob: '15' }, R: { Scale: '1' }, G: { Scale: '1' } },
  '3': { DateStamp: '2026-09-04', S: { Scale: '0', Prob: '1' }, R: { Scale: '0' }, G: { Scale: '0' } },
});
check('three forecast days extracted', fc.length === 3);
check('forecast excludes the current-conditions key', !fc.some((f) => f.dateUtc === undefined));
check('forecast carries S probability', fc[1].sProbabilityPct === 15);

// --- alerts fire on transitions only ----------------------------------------
const quietState = { sScale: 'S0', protonEventActive: false, aviationHighEnergyActive: false,
  protons10MeV: 0.2, protons100MeV: 0.2, aviationRisk: { score: 0 } };
const stormState = { sScale: 'S3', protonEventActive: true, aviationHighEnergyActive: true,
  protons10MeV: 1200, protons100MeV: 30, aviationRisk: { score: 79 } };

const onset = alerts.detect(stormState, quietState);
check('escalation alerts on storm onset', onset.some((a) => a.type === 's-scale-escalation'));
check('proton event start alerts', onset.some((a) => a.type === 'proton-event-start'));
check('high-energy event alerts', onset.some((a) => a.type === 'high-energy-proton-event'));
check('steady storm does not re-alert', alerts.detect(stormState, stormState).length === 0);
check('easing alerts on recovery', alerts.detect(quietState, stormState)
  .some((a) => a.type === 's-scale-easing'));
check('first observation sets baseline without alerting', alerts.detect(stormState, null).length === 0);

// --- archive -----------------------------------------------------------------
const rows = archive.rowsFromProtonFeed(feed);
check('archive rows pair both channels by timestamp',
  rows.length === 2 && rows[1].p10 === 55 && rows[1].p100 === 3);
check('archive ignores channels it does not track', !('p1' in rows[0]));

const uncovered = archive.eventsInWindow('1990-01-01T00:00:00Z', '1990-01-02T00:00:00Z');
check('window with no archived data reports uncovered', uncovered.covered === false);
check('uncovered window explains the 7-day SWPC limit', /NCEI|7 days/.test(uncovered.note));
check('uncovered window never invents a verdict',
  uncovered.protonEventActive === null && uncovered.peak10MeV === null);

// --- payload always carries staleness ---------------------------------------
const sw = spaceweather.getSpaceWeather();
check('payload declares staleness', typeof sw.stale === 'boolean');
check('payload carries a human staleness string', typeof sw.staleness === 'string');
check('every feed reports its own age', Object.values(sw.sources)
  .every((s) => 'stale' in s && 'staleness' in s));
check('payload disclaims the modeled risk score', /not an official NOAA product/.test(sw.disclaimer));

const flightWindow = spaceweather.spaceWeatherForFlight('2026-08-27T00:00:00Z', '2026-08-27T12:00:00Z');
check('flight attribution returns evidence only, no dose',
  !JSON.stringify(flightWindow).includes('MSv') && /not modeled until P4/.test(flightWindow.note));

// --- cache staleness math ----------------------------------------------------
const fresh = cache.read('protons', Date.now());
if (fresh.present) {
  const aged = cache.read('protons', Date.parse(fresh.fetchedAt) + 10 * 60000);
  check('cache computes age from fetch time', Math.round(aged.ageMinutes) === 10);
  check('cache marks protons stale past 30 minutes',
    cache.read('protons', Date.parse(fresh.fetchedAt) + 45 * 60000).stale === true);
  check('cache reports fresh data as not stale', aged.stale === false);
} else {
  console.log('  SKIP  cache staleness (no cached protons — run the poller once)');
}
check('missing cache entry reads as stale, not empty-and-fine',
  cache.read('does-not-exist').stale === true && cache.read('does-not-exist').present === false);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
