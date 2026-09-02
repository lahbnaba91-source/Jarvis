#!/usr/bin/env node
'use strict';

// P2 ledger tests. The point of a hash-chained append-only ledger is that
// tampering is *detectable* and mutation is *refused* — so these tests try to
// tamper, and fail if the ledger lets them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const { computeFlightDose } = require('../../engine/dose');
const store = require('../../ledger/store');
const { verify } = require('../../ledger/verify');
const { exportJson, exportResearch, exportCsv, verifySignature } = require('../../ledger/export');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badge-ledger-')), 'ledger.db');
}

const FLIGHTS = [
  { origin: 'LAX', destination: 'ICN', date: { year: 2023, month: 1, day: 14 }, cruiseAltitudeFt: 39000 },
  { origin: 'KEWR', destination: 'WSSS', date: { year: 2023, month: 2, day: 3 }, cruiseAltitudeFt: 41000 },
  { origin: 'OMDB', destination: 'KLAX', date: { year: 2023, month: 3, day: 21 }, cruiseAltitudeFt: 43000 },
];

(async () => {
console.log('\nBADGE ledger tests (P2)\n');

// --- append and chain --------------------------------------------------------
const dbPath = tmpDb();
const db = store.open(dbPath);

const written = [];
for (const spec of FLIGHTS) {
  written.push(store.append(db, await computeFlightDose(spec), { spec }));
}

check('three flights appended', store.all(db).length === 3);
check('sequence numbers are 1..3', written.map((r) => r.seq).join(',') === '1,2,3');
check('first entry links to genesis', written[0].prev_hash === 'sha256:' + '0'.repeat(64));
check('each entry links to the previous hash',
  written[1].prev_hash === written[0].entry_hash && written[2].prev_hash === written[1].entry_hash);

const v1 = verify(db);
check('fresh chain verifies intact', v1.intact && v1.entries === 3 && v1.brokenAt === null);

// --- dose values actually stored --------------------------------------------
check('GCR dose stored non-zero', written.every((r) => r.gcr_msv > 0));
check('SPE stays null and separate (guardrail 4)', written.every((r) => r.spe_msv === null));
check('model version stored with every entry', written.every((r) => r.gcr_model === 'PARMA-4.10'));
check('inputs stored for recomputation (§1.2)', written.every((r) => {
  const inputs = JSON.parse(r.inputs_json);
  return inputs.spec && inputs.profile && inputs.engineVersion;
}));
check('coveredFraction recorded', written.every((r) => r.covered_fraction === 1));

// --- mutation is refused by the database ------------------------------------
let updateBlocked = false;
try {
  db.prepare('UPDATE ledger_entries SET gcr_msv = 999 WHERE seq = 1').run();
} catch (err) {
  updateBlocked = /append-only/.test(err.message);
}
check('UPDATE refused by trigger (guardrail 5)', updateBlocked);

let deleteBlocked = false;
try {
  db.prepare('DELETE FROM ledger_entries WHERE seq = 1').run();
} catch (err) {
  deleteBlocked = /append-only/.test(err.message);
}
check('DELETE refused by trigger (guardrail 5)', deleteBlocked);
check('ledger still holds three entries after refused mutations', store.all(db).length === 3);

// --- corrections are new rows, not edits ------------------------------------
const correctedSpec = { ...FLIGHTS[0], cruiseAltitudeFt: 37000 };
const correction = store.append(db, await computeFlightDose(correctedSpec), {
  spec: correctedSpec,
  supersedes: written[0].id,
});
check('correction appended as a new entry', correction.seq === 4 && correction.entry_type === 'correction');
check('correction points at the entry it replaces', correction.supersedes === written[0].id);
check('original entry still present and unchanged',
  store.get(db, written[0].id).gcr_msv === written[0].gcr_msv);
check('superseded id is discoverable', store.supersededIds(db).has(written[0].id));
check('chain still intact after correction', verify(db).intact);

// --- export ------------------------------------------------------------------
const json = exportJson(db);
check('json export carries every entry', json.entries.length === 4);
check('json export carries integrity block', json.integrity.intact === true);
const { signature, ...signedPayload } = json;
check('json export signature verifies', verifySignature(signedPayload, signature));

const csv = exportCsv(db);
check('csv export has header plus one row per entry', csv.trim().split('\n').length === 5);

const research = exportResearch(db);
const researchKeys = Object.keys(research.records[0]);
check('research export keeps route and dose',
  researchKeys.includes('route') && researchKeys.includes('gcrMSv'));
check('research export keeps model version and solar params',
  researchKeys.includes('gcrModel') && researchKeys.includes('solarWIndex'));
check('research export keeps telemetry source and coverage',
  researchKeys.includes('telemetrySource') && researchKeys.includes('coveredFraction'));
check('research export drops entry ids and record timestamps',
  !researchKeys.includes('id') && !researchKeys.includes('createdAt') && !researchKeys.includes('entryHash'));

// --- tampering is detected ---------------------------------------------------
// Simulate someone with raw database access: drop the guard triggers, edit a row.
db.close();
const raw = new DatabaseSync(dbPath);
raw.exec('DROP TRIGGER ledger_no_update');
raw.prepare('UPDATE ledger_entries SET gcr_msv = 0.999 WHERE seq = 2').run();
raw.close();

const tamperedDb = store.open(dbPath);
const v2 = verify(tamperedDb);
check('tampered content detected', !v2.intact);
check('tamper located at the right entry', v2.brokenAt === written[1].id, `brokenAt=${v2.brokenAt}`);
check('tamper reported as content mismatch',
  v2.issues.some((i) => i.problems.some((p) => /content tampered/.test(p))));

// Chain surgery: remove an entry entirely.
tamperedDb.close();
const raw2 = new DatabaseSync(dbPath);
raw2.exec('DROP TRIGGER ledger_no_delete');
raw2.prepare('DELETE FROM ledger_entries WHERE seq = 2').run();
raw2.close();

const gappedDb = store.open(dbPath);
const v3 = verify(gappedDb);
check('removed entry detected as sequence gap', !v3.intact &&
  v3.issues.some((i) => i.problems.some((p) => /sequence gap/.test(p))));
gappedDb.close();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
