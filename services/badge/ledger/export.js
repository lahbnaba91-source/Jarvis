'use strict';

// Ledger export in three shapes (brief §8 /export):
//   json      — full entries with provenance, ed25519-signed
//   csv       — flat spreadsheet form
//   research  — de-identified: route, dose, model version, solar params,
//               telemetry source, coverage. Schema-stable for recomputation later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { verify } = require('./verify');
const { canonicalize } = require('./hash');

const KEY_PATH = path.join(__dirname, '..', 'data', 'signing-key.json');
const RESEARCH_SCHEMA_VERSION = 'badge-research-1';

// Local ed25519 keypair, created on first export. The private key never leaves
// this file and is never printed, logged, or included in any export.
function signingKey() {
  if (fs.existsSync(KEY_PATH)) {
    const stored = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
    return {
      privateKey: crypto.createPrivateKey(stored.privateKeyPem),
      publicKeyPem: stored.publicKeyPem,
      createdAt: stored.createdAt,
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const record = { privateKeyPem, publicKeyPem, createdAt: new Date().toISOString() };

  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });

  return { privateKey, publicKeyPem, createdAt: record.createdAt };
}

function sign(payload) {
  const key = signingKey();
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), key.privateKey);
  return {
    algorithm: 'ed25519',
    publicKeyPem: key.publicKeyPem,
    signature: signature.toString('base64'),
  };
}

function verifySignature(payload, signatureBlock) {
  return crypto.verify(
    null,
    Buffer.from(canonicalize(payload), 'utf8'),
    crypto.createPublicKey(signatureBlock.publicKeyPem),
    Buffer.from(signatureBlock.signature, 'base64')
  );
}

function entryToJson(row) {
  return {
    id: row.id,
    seq: row.seq,
    createdAt: row.created_at,
    entryType: row.entry_type,
    supersedes: row.supersedes,
    flight: {
      route: row.route,
      origin: row.origin,
      destination: row.destination,
      dateUtc: row.date_utc,
      durationHours: row.duration_hours,
      distanceKm: row.distance_km,
      cruiseAltitudeFt: row.cruise_altitude_ft,
      maxLatitude: row.max_latitude,
    },
    dose: {
      gcrMSv: row.gcr_msv,
      gcrH10MSv: row.gcr_h10_msv,
      gcrModel: row.gcr_model,
      gcrQuantity: row.gcr_quantity,
      gcrConfidence: row.gcr_confidence,
      speMSv: row.spe_msv,
      speConfidence: row.spe_confidence,
      speMethod: row.spe_method,
      uncertaintyPct: row.uncertainty_pct,
      uncertaintyBasis: row.uncertainty_basis,
    },
    telemetry: {
      source: row.telemetry_source,
      coveredFraction: row.covered_fraction,
      altSource: row.alt_source,
    },
    rates: {
      peakUSvPerHr: row.peak_dose_rate_usv_h,
      meanUSvPerHr: row.mean_dose_rate_usv_h,
    },
    solarParams: {
      wIndex: row.solar_w_index,
      forceFieldMV: row.solar_ffp_mv,
      source: row.solar_source,
    },
    geometry: { g: row.geometry_g },
    inputs: JSON.parse(row.inputs_json),
    chain: { prevHash: row.prev_hash, entryHash: row.entry_hash },
  };
}

function exportJson(db) {
  const integrity = verify(db);
  const payload = {
    format: 'badge-ledger-1',
    exportedAt: new Date().toISOString(),
    integrity,
    entries: store.all(db).map(entryToJson),
  };
  return { ...payload, signature: sign(payload) };
}

const CSV_COLUMNS = [
  ['id', (r) => r.id],
  ['seq', (r) => r.seq],
  ['created_at', (r) => r.created_at],
  ['entry_type', (r) => r.entry_type],
  ['supersedes', (r) => r.supersedes || ''],
  ['route', (r) => r.route],
  ['date_utc', (r) => r.date_utc],
  ['duration_hours', (r) => r.duration_hours],
  ['cruise_altitude_ft', (r) => r.cruise_altitude_ft],
  ['max_latitude', (r) => r.max_latitude],
  ['gcr_msv', (r) => r.gcr_msv],
  ['gcr_h10_msv', (r) => r.gcr_h10_msv],
  ['spe_msv', (r) => (r.spe_msv === null ? '' : r.spe_msv)],
  ['gcr_model', (r) => r.gcr_model],
  ['gcr_confidence', (r) => r.gcr_confidence],
  ['uncertainty_pct', (r) => (r.uncertainty_pct === null ? '' : r.uncertainty_pct)],
  ['telemetry_source', (r) => r.telemetry_source],
  ['covered_fraction', (r) => r.covered_fraction],
  ['solar_w_index', (r) => r.solar_w_index],
  ['solar_ffp_mv', (r) => r.solar_ffp_mv],
  ['entry_hash', (r) => r.entry_hash],
];

function csvCell(value) {
  const s = String(value === null || value === undefined ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(db) {
  const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];
  for (const row of store.all(db)) {
    lines.push(CSV_COLUMNS.map(([, fn]) => csvCell(fn(row))).join(','));
  }
  return lines.join('\n') + '\n';
}

// De-identified. Carries everything needed to recompute the corpus with a better
// model later (§1.2), and nothing that identifies the crewmember.
function exportResearch(db) {
  const payload = {
    format: RESEARCH_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    note: 'De-identified. No crewmember identity, no entry ids, no timestamps of record creation.',
    records: store.all(db).map((row) => ({
      route: row.route,
      dateUtc: row.date_utc,
      durationHours: row.duration_hours,
      cruiseAltitudeFt: row.cruise_altitude_ft,
      maxLatitude: row.max_latitude,
      gcrMSv: row.gcr_msv,
      gcrH10MSv: row.gcr_h10_msv,
      speMSv: row.spe_msv,
      gcrModel: row.gcr_model,
      gcrQuantity: row.gcr_quantity,
      solarWIndex: row.solar_w_index,
      solarForceFieldMV: row.solar_ffp_mv,
      telemetrySource: row.telemetry_source,
      coveredFraction: row.covered_fraction,
      geometryG: row.geometry_g,
    })),
  };
  return { ...payload, signature: sign(payload) };
}

function exportLedger(db, format = 'json') {
  switch (format) {
    case 'json': return JSON.stringify(exportJson(db), null, 2);
    case 'csv': return exportCsv(db);
    case 'research': return JSON.stringify(exportResearch(db), null, 2);
    default: throw new Error(`Unknown export format "${format}" (use json, csv, or research)`);
  }
}

module.exports = { exportLedger, exportJson, exportCsv, exportResearch, verifySignature, entryToJson };
