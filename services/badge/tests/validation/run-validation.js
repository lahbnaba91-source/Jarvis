#!/usr/bin/env node
'use strict';

// ISO 20785-4 style validation harness: BADGE (PARMA 4.10) against published
// CARI-7A reference values. The reference set, its conditions and its known
// methodological differences all live in reference-routes.json.
//
// This harness reports. It does not tune. If BADGE disagrees with the oracle,
// that is the finding — never a reason to adjust the model until it agrees.

const fs = require('fs');
const path = require('path');
const { computeFlightDose } = require('../../engine/dose');

const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'reference-routes.json'), 'utf8'));

// Independent-code agreement bands. Aviation dose model intercomparisons typically
// sit inside ±20%; anything past ±30% is a real disagreement worth chasing.
const PASS_PCT = 20;
const WARN_PCT = 30;

function parseDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day };
}

function pad(s, n) {
  return String(s).padEnd(n);
}
function padL(s, n) {
  return String(s).padStart(n);
}

async function main() {
  const date = parseDate(REF.conditions.dateUtc);
  const rows = [];

  for (const route of REF.routes) {
    const result = await computeFlightDose({
      origin: route.origin,
      destination: route.destination,
      date,
      cruiseAltitudeFt: REF.conditions.cruiseAltitudeFt,
      cruiseSpeedKmh: route.cruiseSpeedKmh,
      climbRateFtPerMin: route.climbRateFtPerMin,
      rampSpeedFactor: REF.conditions.rampSpeedFactor,
    });

    const badgeUSv = result.dose.gcrMSv * 1000;
    const badgeH10USv = result.dose.gcrH10MSv * 1000;
    const devPct = ((badgeUSv - route.referenceEffectiveUSv) / route.referenceEffectiveUSv) * 100;
    const devH10Pct = ((badgeH10USv - route.referenceH10USv) / route.referenceH10USv) * 100;
    const durDevPct =
      ((result.durationHours - route.referenceDurationHours) / route.referenceDurationHours) * 100;

    // Rate comparison removes the flight-duration difference, isolating the physics.
    const badgeRate = badgeUSv / result.durationHours;
    const refRate = route.referenceEffectiveUSv / route.referenceDurationHours;
    const rateDevPct = ((badgeRate - refRate) / refRate) * 100;

    const status =
      Math.abs(devPct) <= PASS_PCT ? 'PASS' : Math.abs(devPct) <= WARN_PCT ? 'WARN' : 'FAIL';

    rows.push({
      id: route.id,
      polar: route.polar,
      badgeUSv,
      badgeH10USv,
      refUSv: route.referenceEffectiveUSv,
      refH10USv: route.referenceH10USv,
      devPct,
      devH10Pct,
      badgeHours: result.durationHours,
      refHours: route.referenceDurationHours,
      durDevPct,
      badgeRate,
      refRate,
      rateDevPct,
      status,
      maxLatitude: result.maxLatitude,
      wIndex: result.solarParams.wIndex,
      forceFieldMV: result.solarParams.forceFieldMV,
    });
  }

  console.log('');
  console.log(`BADGE validation — ${REF.referenceSet}`);
  console.log(`Oracle:  ${REF.oracle}`);
  console.log(`Source:  ${REF.sourceUrl}`);
  console.log(
    `Conditions: ${REF.conditions.dateUtc}, FL${REF.conditions.cruiseAltitudeFt / 100}, ${REF.conditions.shielding}`
  );
  console.log(`Bands:   PASS <= ${PASS_PCT}%  |  WARN <= ${WARN_PCT}%  |  FAIL > ${WARN_PCT}%`);
  console.log('');
  console.log(
    `${pad('ROUTE', 11)} ${padL('BADGE µSv', 10)} ${padL('CARI µSv', 9)} ${padL('DEV%', 7)} ` +
      `${padL('BADGE h', 8)} ${padL('CARI h', 7)} ${padL('DUR%', 7)} ${padL('RATE DEV%', 10)}  STATUS`
  );
  console.log('-'.repeat(88));

  for (const r of rows) {
    console.log(
      `${pad(r.id, 11)} ${padL(r.badgeUSv.toFixed(2), 10)} ${padL(r.refUSv.toFixed(2), 9)} ` +
        `${padL(r.devPct.toFixed(1), 7)} ${padL(r.badgeHours.toFixed(2), 8)} ${padL(r.refHours.toFixed(2), 7)} ` +
        `${padL(r.durDevPct.toFixed(1), 7)} ${padL(r.rateDevPct.toFixed(1), 10)}  ${r.status}`
    );
  }

  const pass = rows.filter((r) => r.status === 'PASS').length;
  const warn = rows.filter((r) => r.status === 'WARN').length;
  const fail = rows.filter((r) => r.status === 'FAIL').length;

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanAbs = (xs) => mean(xs.map(Math.abs));

  console.log('-'.repeat(88));
  console.log('');
  console.log(`Routes:            ${rows.length}   (target in brief §11: ~20)`);
  console.log(`PASS / WARN / FAIL: ${pass} / ${warn} / ${fail}`);
  console.log(`Mean deviation (total dose):      ${mean(rows.map((r) => r.devPct)).toFixed(1)}%`);
  console.log(`Mean |deviation| (total dose):    ${meanAbs(rows.map((r) => r.devPct)).toFixed(1)}%`);
  console.log(`Mean deviation (dose rate):       ${mean(rows.map((r) => r.rateDevPct)).toFixed(1)}%`);
  console.log(`Mean |deviation| (dose rate):     ${meanAbs(rows.map((r) => r.rateDevPct)).toFixed(1)}%`);
  console.log(`Mean |deviation| (flight time):   ${meanAbs(rows.map((r) => r.durDevPct)).toFixed(1)}%`);
  console.log(`Mean deviation (H*(10)):          ${mean(rows.map((r) => r.devH10Pct)).toFixed(1)}%`);
  console.log('');

  const polar = rows.filter((r) => r.polar);
  const nonPolar = rows.filter((r) => !r.polar);
  console.log(`Polar routes (${polar.length}):     mean dev ${mean(polar.map((r) => r.devPct)).toFixed(1)}%, rate dev ${mean(polar.map((r) => r.rateDevPct)).toFixed(1)}%`);
  console.log(`Non-polar routes (${nonPolar.length}): mean dev ${mean(nonPolar.map((r) => r.devPct)).toFixed(1)}%, rate dev ${mean(nonPolar.map((r) => r.rateDevPct)).toFixed(1)}%`);
  console.log('');
  console.log('Known methodological differences (not model error):');
  for (const d of REF.knownDifferences) console.log(`  - ${d}`);
  console.log('');

  const outPath = path.join(__dirname, 'last-run.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        referenceSet: REF.referenceSet,
        bands: { passPct: PASS_PCT, warnPct: WARN_PCT },
        summary: { routes: rows.length, pass, warn, fail },
        rows,
      },
      null,
      2
    )
  );
  console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
  console.log('');

  process.exit(fail > 0 ? 1 : 0);
}

main();
