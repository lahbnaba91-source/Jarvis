#!/usr/bin/env node
'use strict';

// BADGE CLI.
//   dose   — compute a flight's dose, write nothing
//   log    — compute and append to the ledger
//   ledger — list recorded flights
//   verify — check hash-chain integrity
//   export — json | csv | research

const { computeFlightDose } = require('./engine/dose');
const parma = require('./engine/parma');
const store = require('./ledger/store');
const spaceweather = require('./spaceweather');
const { verify } = require('./ledger/verify');
const { exportLedger } = require('./ledger/export');

const USAGE = `
BADGE — modeled cosmic radiation dose ledger for aircrew (GCR only)

  node cli.js dose   <origin> <dest> <YYYY-MM-DD> <FL390>   compute, write nothing
  node cli.js log    <origin> <dest> <YYYY-MM-DD> <FL390>   compute and record
  node cli.js ledger [--limit=20] [--from=DATE] [--to=DATE] list recorded flights
  node cli.js verify                                        check chain integrity
  node cli.js export [--format=json|csv|research]           export the ledger
  node cli.js spaceweather                                  current conditions

Options
  --json              full structured result (dose / log)
  --speed=<kmh>       cruise speed (default 907)
  --g=<value>         PARMA geometry parameter (10 = free air; negative models
                      aircraft mass in 100-tonne units)
  --supersedes=<id>   record this entry as a correction to an earlier one
  --db=<path>         alternate ledger file

Omitting the subcommand is treated as "dose", so the P1 form still works:
  node cli.js LAX ICN 2023-01-14 FL390
`;

const SUBCOMMANDS = new Set(['dose', 'log', 'ledger', 'verify', 'export', 'spaceweather', 'help']);

function parseAltitude(token) {
  const t = String(token).toUpperCase();
  const fl = t.startsWith('FL') ? Number(t.slice(2)) * 100 : Number(t);
  if (!Number.isFinite(fl) || fl <= 0) throw new Error(`Bad altitude "${token}" (use FL390 or 39000)`);
  return fl;
}

function parseDate(token) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(token));
  if (!m) throw new Error(`Bad date "${token}" (use YYYY-MM-DD)`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function buildSpec(args, flag) {
  const spec = {
    origin: args[0],
    destination: args[1],
    date: parseDate(args[2]),
    cruiseAltitudeFt: parseAltitude(args[3]),
  };
  if (flag('speed')) spec.cruiseSpeedKmh = Number(flag('speed'));
  if (flag('g')) spec.g = Number(flag('g'));
  return spec;
}

function printResult(result) {
  const d = result.dose;
  console.log('');
  console.log(`  ${result.route}   ${result.dateUtc}   FL${Math.round(result.cruiseAltitudeFt / 100)}`);
  console.log(`  ${result.durationHours.toFixed(2)} h   ${Math.round(result.distanceKm)} km   max lat ${result.maxLatitude.toFixed(1)}°`);
  console.log('');
  console.log(`  GCR effective dose   ${d.gcrMSv.toFixed(4)} mSv   (${(d.gcrMSv * 1000).toFixed(1)} µSv)`);
  console.log(`  GCR H*(10)           ${d.gcrH10MSv.toFixed(4)} mSv`);
  console.log(`  SPE                  not modeled (P4) — never merged into the GCR figure`);
  console.log('');
  console.log(`  peak rate            ${result.peakDoseRateUSvPerHr.toFixed(2)} µSv/h`);
  console.log(`  mean rate            ${result.meanDoseRateUSvPerHr.toFixed(2)} µSv/h`);
  console.log(`  model                ${d.gcrModel} — ${d.gcrQuantity}`);
  console.log(`  solar                W-index ${result.solarParams.wIndex.toFixed(1)}, force field ${result.solarParams.forceFieldMV.toFixed(0)} MV`);
  console.log(`  telemetry            ${result.telemetry.source} (confidence: ${d.gcrConfidence}), covered ${(result.telemetry.coveredFraction * 100).toFixed(0)}%`);
  console.log(`  shielding            ${result.geometry.note}`);
  console.log(`  uncertainty          ${d.uncertaintyBasis}`);
}

function fmtFlux(v) {
  return v === null || v === undefined ? 'n/a' : v < 0.01 ? v.toExponential(2) : v.toFixed(3);
}

function disclaimer() {
  console.log('');
  console.log('  Modeled estimate, not a dosimeter reading and not medical advice.');
  console.log('  Discuss health implications with your AME.');
  console.log('');
}

function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const rest = argv.filter((a) => !a.startsWith('--'));
  const flag = (name) => {
    const hit = flags.find((f) => f.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : undefined;
  };

  let command = rest[0];
  let args = rest.slice(1);
  if (!SUBCOMMANDS.has(command)) {
    command = 'dose';
    args = rest;
  }

  if (command === 'help' || (command === 'dose' && args.length < 4)) {
    console.log(USAGE.trim());
    const cov = parma.solarCoverage();
    console.log(`\nSolar data coverage: ${cov.startYear} through ${cov.lastDate}.`);
    process.exit(args.length ? 1 : 0);
  }

  const dbPath = flag('db') || store.DEFAULT_DB;

  if (command === 'dose') {
    const result = computeFlightDose(buildSpec(args, flag));
    if (flags.includes('--json')) return console.log(JSON.stringify(result, null, 2));
    printResult(result);
    console.log(`  ledger               not recorded (use "log" to record)`);
    return disclaimer();
  }

  if (command === 'log') {
    if (args.length < 4) throw new Error('log needs: <origin> <dest> <YYYY-MM-DD> <FL390>');
    const spec = buildSpec(args, flag);
    const result = computeFlightDose(spec);
    const db = store.open(dbPath);
    const row = store.append(db, result, { spec, supersedes: flag('supersedes') });
    const integrity = verify(db);

    if (flags.includes('--json')) return console.log(JSON.stringify({ entry: row, integrity }, null, 2));
    printResult(result);
    console.log('');
    console.log(`  recorded             ${row.id}  (seq ${row.seq}${row.supersedes ? `, supersedes ${row.supersedes}` : ''})`);
    console.log(`  ledger hash          ${row.entry_hash}`);
    console.log(`  chain                ${integrity.intact ? 'intact' : 'BROKEN at ' + integrity.brokenAt}, ${integrity.entries} entries`);
    return disclaimer();
  }

  if (command === 'ledger') {
    const db = store.open(dbPath);
    const rows = store.list(db, {
      limit: Number(flag('limit') || 20),
      from: flag('from'),
      to: flag('to'),
    });
    const superseded = store.supersededIds(db);

    if (flags.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) {
      console.log('\n  ledger is empty — record a flight with "log"\n');
      return;
    }

    console.log('');
    console.log(`  ${'DATE'.padEnd(12)}${'ROUTE'.padEnd(12)}${'mSv'.padStart(9)}  ${'FL'.padStart(4)}  ${'COVER'.padStart(6)}  CONF / SOURCE`);
    console.log('  ' + '-'.repeat(74));
    for (const r of rows) {
      const flags2 = [];
      if (superseded.has(r.id)) flags2.push('SUPERSEDED');
      if (r.entry_type === 'correction') flags2.push(`corrects ${r.supersedes}`);
      // Guardrail §13.7: partial coverage is always visible.
      const cover = `${Math.round(r.covered_fraction * 100)}%`;
      console.log(
        `  ${r.date_utc.padEnd(12)}${r.route.padEnd(12)}${r.gcr_msv.toFixed(4).padStart(9)}  ` +
          `${String(Math.round(r.cruise_altitude_ft / 100)).padStart(4)}  ${cover.padStart(6)}  ` +
          `${r.gcr_confidence} / ${r.telemetry_source}${flags2.length ? '  [' + flags2.join(', ') + ']' : ''}`
      );
    }

    const active = rows.filter((r) => !superseded.has(r.id));
    const total = active.reduce((a, r) => a + r.gcr_msv, 0);
    console.log('  ' + '-'.repeat(74));
    console.log(`  ${active.length} active entries shown, GCR total ${total.toFixed(4)} mSv (SPE tracked separately, none modeled yet)`);
    return disclaimer();
  }

  if (command === 'verify') {
    const db = store.open(dbPath);
    const result = verify(db);
    if (flags.includes('--json')) return console.log(JSON.stringify(result, null, 2));
    console.log('');
    console.log(`  chain      ${result.intact ? 'INTACT' : 'BROKEN'}`);
    console.log(`  entries    ${result.entries}`);
    console.log(`  head       ${result.headHash}`);
    if (!result.intact) {
      console.log(`  broken at  ${result.brokenAt}`);
      for (const issue of result.issues) {
        console.log(`    seq ${issue.seq} (${issue.id}):`);
        for (const p of issue.problems) console.log(`      - ${p}`);
      }
    }
    console.log('');
    process.exit(result.intact ? 0 : 1);
  }


  if (command === 'spaceweather') {
    const sw = spaceweather.getSpaceWeather();
    if (flags.includes('--json')) return console.log(JSON.stringify(sw, null, 2));

    if (!sw.available) {
      console.log('\n  No space weather data cached yet.');
      console.log('  Run: node spaceweather/poller.js --once\n');
      return;
    }

    const c = sw.current;
    console.log('');
    // Guardrail §13.3: cached values never render without their staleness.
    console.log(`  ${sw.stale ? 'STALE' : 'LIVE '}  ${sw.staleness}   (updated ${sw.lastUpdated})`);
    console.log('');
    console.log(`  S-scale              ${c.sScale}  (${c.sScaleSource})`);
    console.log(`  >=10 MeV protons     ${fmtFlux(c.protons10MeV)} pfu   event threshold 10 pfu`);
    console.log(`  >=100 MeV protons    ${fmtFlux(c.protons100MeV)} pfu   aviation threshold 1 pfu`);
    console.log(`  Kp                   ${c.kp === null ? 'n/a' : c.kp}`);
    console.log('');
    const bar = '#'.repeat(Math.round(c.aviationRisk.score / 5)).padEnd(20, '.');
    console.log(`  aviation risk        ${String(c.aviationRisk.score).padStart(3)}/100  [${bar}]`);
    console.log(`                       ${c.aviationRisk.method} — BADGE-modeled, not a NOAA product`);
    console.log(`  proton event         ${c.protonEventActive ? 'ACTIVE' : 'none'}`);
    console.log(`  high-energy (>=100)  ${c.aviationHighEnergyActive ? 'ACTIVE' : 'none'}`);

    if (sw.forecast.length) {
      console.log('');
      console.log('  3-day forecast');
      for (const f of sw.forecast) {
        console.log(`    ${f.dateUtc}   S: ${f.sScale || 'n/a'}  (prob ${f.sProbabilityPct ?? 'n/a'}%)   R: ${f.rScale || 'n/a'}   G: ${f.gScale || 'n/a'}`);
      }
    }

    if (sw.recentAlerts.length) {
      console.log('');
      console.log('  recent alerts');
      for (const a of sw.recentAlerts.slice(-5)) console.log(`    [${a.severity}] ${a.at} ${a.type}`);
    }

    console.log('');
    console.log('  feeds');
    for (const [name, s2] of Object.entries(sw.sources)) {
      console.log(`    ${name.padEnd(9)} ${s2.present ? (s2.stale ? 'STALE' : 'ok   ') : 'MISSING'}  ${s2.staleness}`);
    }
    console.log(`  archive              ${sw.archive.samples} samples${sw.archive.earliest ? `, ${sw.archive.earliest.slice(0, 10)} -> ${sw.archive.latest.slice(0, 10)}` : ''}`);
    console.log('');
    console.log(`  ${sw.disclaimer}`);
    console.log('');
    return;
  }

  if (command === 'export') {
    const db = store.open(dbPath);
    console.log(exportLedger(db, flag('format') || 'json'));
    return;
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}
