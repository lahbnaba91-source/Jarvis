#!/usr/bin/env node
'use strict';

// Altitude-resolved validation. The FL430 point set proves BADGE agrees with
// CARI-7A at one altitude; this proves whether it agrees across the band, which
// matters because altitude dominates the entire error budget (brief §3.3).
//
// Reference values are the published CARI-7A dose-rate polynomials, filtered to
// those that reproduce their own paper's independently reported FL430 figure.
//
// Reports. Does not tune.

const fs = require('fs');
const path = require('path');
const { computeFlightDose } = require('../../engine/dose');

const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'altitude-reference.json'), 'utf8'));

const PASS_PCT = 20;
const WARN_PCT = 30;

const evalPoly = (coeffs, z) =>
  Object.entries(coeffs).reduce((s, [p, c]) => s + c * Math.pow(z, Number(p)), 0);

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanAbs = (xs) => mean(xs.map(Math.abs));

async function main() {
  const [year, month, day] = REF.conditions.dateUtc.split('-').map(Number);
  const rows = [];

  for (const route of REF.routes) {
    for (const fl of REF.flightLevels) {
      const result = await computeFlightDose({
        origin: route.origin,
        destination: route.destination,
        date: { year, month, day },
        cruiseAltitudeFt: fl * 100,
        cruiseSpeedKmh: route.cruiseSpeedKmh,
        climbRateFtPerMin: route.climbRateFtPerMin,
      });

      const badgeRate = result.meanDoseRateUSvPerHr;
      const refRate = evalPoly(route.coefficients, fl);
      rows.push({
        route: route.id,
        polar: route.polar,
        fl,
        badgeRate,
        refRate,
        devPct: ((badgeRate - refRate) / refRate) * 100,
        maxLatitude: result.maxLatitude,
      });
    }
  }

  console.log('');
  console.log(`BADGE altitude validation — ${REF.referenceSet}`);
  console.log(`Oracle:  ${REF.oracle}`);
  console.log(`Source:  ${REF.sourceUrl} (Table 4)`);
  console.log(`Points:  ${REF.routes.length} routes x ${REF.flightLevels.length} flight levels = ${rows.length}`);
  console.log(`Note:    ${REF.validation.method}`);
  console.log('');

  // Deviation by flight level — the axis under test.
  console.log('  FL     n    mean dev%   |dev|%    worst');
  console.log('  ' + '-'.repeat(46));
  for (const fl of REF.flightLevels) {
    const at = rows.filter((r) => r.fl === fl);
    const devs = at.map((r) => r.devPct);
    const worst = at.reduce((w, r) => (Math.abs(r.devPct) > Math.abs(w.devPct) ? r : w), at[0]);
    console.log(
      `  ${padL(fl, 4)} ${padL(at.length, 5)} ${padL(mean(devs).toFixed(1), 11)} ${padL(meanAbs(devs).toFixed(1), 8)}    ${worst.route} ${worst.devPct.toFixed(0)}%`
    );
  }

  console.log('');
  console.log('  ROUTE        mean dev%   |dev|%   FL280      FL440');
  console.log('  ' + '-'.repeat(54));
  for (const route of REF.routes) {
    const at = rows.filter((r) => r.route === route.id);
    const devs = at.map((r) => r.devPct);
    const lo = at.find((r) => r.fl === 280);
    const hi = at.find((r) => r.fl === 440);
    console.log(
      `  ${pad(route.id, 12)} ${padL(mean(devs).toFixed(1), 9)} ${padL(meanAbs(devs).toFixed(1), 8)}   ` +
      `${padL(lo ? lo.devPct.toFixed(0) + '%' : '—', 7)}    ${padL(hi ? hi.devPct.toFixed(0) + '%' : '—', 7)}`
    );
  }

  const all = rows.map((r) => r.devPct);
  const polar = rows.filter((r) => r.polar).map((r) => r.devPct);
  const nonPolar = rows.filter((r) => !r.polar).map((r) => r.devPct);
  const within = (p) => rows.filter((r) => Math.abs(r.devPct) <= p).length;

  console.log('');
  console.log(`  overall mean deviation    ${mean(all).toFixed(1)}%`);
  console.log(`  overall mean |deviation|  ${meanAbs(all).toFixed(1)}%`);
  console.log(`  polar routes              ${mean(polar).toFixed(1)}%`);
  console.log(`  non-polar routes          ${mean(nonPolar).toFixed(1)}%`);
  console.log(`  within ±${PASS_PCT}%                ${within(PASS_PCT)} / ${rows.length}`);
  console.log(`  within ±${WARN_PCT}%                ${within(WARN_PCT)} / ${rows.length}`);
  console.log('');

  // Does the disagreement grow with altitude? That would indicate the altitude
  // dependence itself is wrong, not just an offset.
  const byFl = REF.flightLevels.map((fl) => ({
    fl, dev: mean(rows.filter((r) => r.fl === fl).map((x) => x.devPct)),
  }));
  const slope = (() => {
    const mx = mean(byFl.map((b) => b.fl)), my = mean(byFl.map((b) => b.dev));
    const num = byFl.reduce((s, b) => s + (b.fl - mx) * (b.dev - my), 0);
    const den = byFl.reduce((s, b) => s + (b.fl - mx) ** 2, 0);
    return num / den;
  })();
  console.log(`  deviation trend with altitude: ${(slope * 100).toFixed(2)}% per 100 FL`);
  console.log(`    ${Math.abs(slope * 100) < 3
    ? 'Flat — the altitude dependence agrees; the disagreement is an offset, not a slope error.'
    : 'Sloped — the altitude dependence itself disagrees with the oracle. Worth chasing.'}`);
  console.log('');

  fs.writeFileSync(
    path.join(__dirname, 'last-altitude-run.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), referenceSet: REF.referenceSet, rows }, null, 2)
  );

  const failures = rows.length - within(WARN_PCT);
  process.exit(failures > rows.length * 0.25 ? 1 : 0);
}

main();
