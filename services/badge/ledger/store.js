'use strict';

// Append-only, hash-chained flight ledger (brief §7, guardrail §13.5).
//
// No UPDATE, no DELETE — not by convention but by database trigger. A correction
// is a new entry carrying `supersedes` pointing at the row it replaces; the
// original stays in the chain forever.
//
// Column types are deliberately plain (TEXT / INTEGER / REAL, ISO-8601 timestamps)
// so the Postgres swap stays mechanical.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashEntry, GENESIS_HASH } = require('./hash');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'ledger.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                   TEXT PRIMARY KEY,
  seq                  INTEGER NOT NULL UNIQUE,
  created_at           TEXT NOT NULL,
  entry_type           TEXT NOT NULL,
  supersedes           TEXT,

  route                TEXT NOT NULL,
  origin               TEXT NOT NULL,
  destination          TEXT NOT NULL,
  date_utc             TEXT NOT NULL,
  duration_hours       REAL NOT NULL,
  distance_km          REAL NOT NULL,
  cruise_altitude_ft   REAL NOT NULL,
  max_latitude         REAL NOT NULL,

  gcr_msv              REAL NOT NULL,
  gcr_h10_msv          REAL,
  gcr_model            TEXT NOT NULL,
  gcr_quantity         TEXT NOT NULL,
  gcr_confidence       TEXT NOT NULL,
  spe_msv              REAL,
  spe_confidence       TEXT,
  spe_method           TEXT,
  uncertainty_pct      REAL,
  uncertainty_basis    TEXT NOT NULL,

  telemetry_source     TEXT NOT NULL,
  covered_fraction     REAL NOT NULL,
  alt_source           TEXT,

  peak_dose_rate_usv_h REAL,
  mean_dose_rate_usv_h REAL,

  solar_w_index        REAL,
  solar_ffp_mv         REAL,
  solar_source         TEXT,
  geometry_g           REAL,
  inputs_json          TEXT NOT NULL,
  samples_json         TEXT,

  prev_hash            TEXT NOT NULL,
  entry_hash           TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_entries(date_utc);
CREATE INDEX IF NOT EXISTS idx_ledger_seq  ON ledger_entries(seq);

-- Guardrail §13.5 with teeth: the database itself refuses mutation.
CREATE TRIGGER IF NOT EXISTS ledger_no_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only: corrections are new rows with supersedes');
END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger is append-only: entries are never deleted');
END;
`;

// Fields that go into the hash. Order is irrelevant (canonicalized), but membership
// is not: anything omitted here could be altered without breaking the chain.
const HASHED_FIELDS = [
  'id', 'seq', 'created_at', 'entry_type', 'supersedes',
  'route', 'origin', 'destination', 'date_utc', 'duration_hours', 'distance_km',
  'cruise_altitude_ft', 'max_latitude',
  'gcr_msv', 'gcr_h10_msv', 'gcr_model', 'gcr_quantity', 'gcr_confidence',
  'spe_msv', 'spe_confidence', 'spe_method', 'uncertainty_pct', 'uncertainty_basis',
  'telemetry_source', 'covered_fraction', 'alt_source',
  'peak_dose_rate_usv_h', 'mean_dose_rate_usv_h',
  'solar_w_index', 'solar_ffp_mv', 'solar_source', 'geometry_g',
  'inputs_json', 'samples_json',
];

function newId() {
  // Time-ordered so ids sort chronologically, with random tail for uniqueness.
  return 'flt_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

function open(dbPath = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

function head(db) {
  const row = db.prepare('SELECT seq, entry_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1').get();
  return row ? { seq: row.seq, hash: row.entry_hash } : { seq: 0, hash: GENESIS_HASH };
}

function hashableFrom(row) {
  const payload = {};
  for (const f of HASHED_FIELDS) payload[f] = row[f] === undefined ? null : row[f];
  return payload;
}

// result: the object returned by engine/dose.js computeFlightDose
function append(db, result, options = {}) {
  const prev = head(db);
  const seq = prev.seq + 1;

  const row = {
    id: options.id || newId(),
    seq,
    created_at: new Date().toISOString(),
    entry_type: options.supersedes ? 'correction' : 'flight',
    supersedes: options.supersedes || null,

    route: result.route,
    origin: result.route.split('-')[0],
    destination: result.route.split('-')[1],
    date_utc: result.dateUtc,
    duration_hours: result.durationHours,
    distance_km: result.distanceKm,
    cruise_altitude_ft: result.cruiseAltitudeFt,
    max_latitude: result.maxLatitude,

    gcr_msv: result.dose.gcrMSv,
    gcr_h10_msv: result.dose.gcrH10MSv,
    gcr_model: result.dose.gcrModel,
    gcr_quantity: result.dose.gcrQuantity,
    gcr_confidence: result.dose.gcrConfidence,
    // SPE stays its own field and stays null until P4. Never folded into gcr_msv.
    spe_msv: result.dose.speMSv,
    spe_confidence: result.dose.speConfidence,
    spe_method: result.dose.speMethod || null,
    uncertainty_pct: result.dose.uncertaintyPct,
    uncertainty_basis: result.dose.uncertaintyBasis,

    telemetry_source: result.telemetry.source,
    covered_fraction: result.telemetry.coveredFraction,
    alt_source: result.telemetry.altSource,

    peak_dose_rate_usv_h: result.peakDoseRateUSvPerHr,
    mean_dose_rate_usv_h: result.meanDoseRateUSvPerHr,

    solar_w_index: result.solarParams.wIndex,
    solar_ffp_mv: result.solarParams.forceFieldMV,
    solar_source: result.solarParams.source,
    geometry_g: result.geometry.g,

    // §1.2: never store a computed number without the inputs that produced it.
    inputs_json: JSON.stringify({
      spec: options.spec || null,
      profile: result.profile,
      engineVersion: result.dose.gcrModel,
    }),
    samples_json: options.storeSamples === false ? null : JSON.stringify(result.samples),
  };

  row.prev_hash = prev.hash;
  row.entry_hash = hashEntry(hashableFrom(row), prev.hash);

  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO ledger_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  stmt.run(...cols.map((c) => row[c]));

  return row;
}

// Reading the chain head and appending must be one atomic step. Two processes
// sharing a ledger file can otherwise both read head N and both write N+1 — the
// UNIQUE constraint catches the collision, but the loser needs to re-read the head
// and rebuild its hash link rather than fail. BEGIN IMMEDIATE takes the write lock
// up front so the read-then-write is serialized.
function appendAtomic(db, result, options = {}, attempt = 0) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = append(db, result, options);
    db.exec('COMMIT');
    return row;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    const collision = /UNIQUE constraint failed: ledger_entries\.(seq|entry_hash)/.test(err.message);
    if (collision && attempt < 5) {
      return appendAtomic(db, result, options, attempt + 1);
    }
    throw err;
  }
}

function list(db, { limit = 50, from, to } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('date_utc >= ?'); params.push(from); }
  if (to) { where.push('date_utc <= ?'); params.push(to); }
  const sql =
    'SELECT * FROM ledger_entries' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY seq DESC LIMIT ?';
  return db.prepare(sql).all(...params, limit);
}

function get(db, id) {
  return db.prepare('SELECT * FROM ledger_entries WHERE id = ?').get(id);
}

function all(db) {
  return db.prepare('SELECT * FROM ledger_entries ORDER BY seq ASC').all();
}

// Entries that have been superseded by a later correction.
function supersededIds(db) {
  const rows = db.prepare('SELECT supersedes FROM ledger_entries WHERE supersedes IS NOT NULL').all();
  return new Set(rows.map((r) => r.supersedes));
}

module.exports = {
  open, append: appendAtomic, appendUnsafe: append, list, get, all, head, supersededIds,
  hashableFrom, HASHED_FIELDS, DEFAULT_DB, newId,
};
