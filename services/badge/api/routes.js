'use strict';

// Read-only JSON API backing the dashboard (brief §8).
//
// Built on Node's own http module rather than Express. §9.1's stated reasons for
// the no-build-step dashboard — same origin, one process, one port, nothing to
// install on a phone — are better served by keeping the zero-dependency property
// than by adding a framework for routing six GET endpoints. Deviation from the
// brief's "Node/Express" wording, same architecture and same guarantees.
//
// Every dose figure the dashboard renders is computed here. The frontend does no
// dose math (guardrail §13.8).

const store = require('../ledger/store');
const { verify } = require('../ledger/verify');
const { exportLedger } = require('../ledger/export');
const { status } = require('../policy/advisor');
const spaceweather = require('../spaceweather');
const { brief } = require('../brief');
const { computeFlightDose } = require('../engine/dose');

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function text(res, code, body, contentType) {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Rows carry a samples blob that would bloat the list response; the detail
// endpoint returns it, the list does not.
function summarize(row, supersededIds) {
  return {
    id: row.id,
    seq: row.seq,
    entryType: row.entry_type,
    supersedes: row.supersedes,
    superseded: supersededIds.has(row.id),
    route: row.route,
    dateUtc: row.date_utc,
    durationHours: row.duration_hours,
    cruiseAltitudeFt: row.cruise_altitude_ft,
    maxLatitude: row.max_latitude,
    dose: {
      gcrMSv: row.gcr_msv,
      gcrH10MSv: row.gcr_h10_msv,
      gcrModel: row.gcr_model,
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
    peakDoseRateUSvPerHr: row.peak_dose_rate_usv_h,
    solarParams: { wIndex: row.solar_w_index, forceFieldMV: row.solar_ffp_mv },
    entryHash: row.entry_hash,
  };
}

function handle(req, res, options = {}) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (!route.startsWith('/api/')) return false;

  // /brief and /project accept POST because they take inputs, but neither writes.
  const postable = route === '/api/badge/brief' || route === '/api/badge/project';
  if (req.method !== 'GET' && !(req.method === 'POST' && postable)) {
    json(res, 405, { error: 'This API is read-only. Writes arrive with the later phases.' });
    return true;
  }

  const dbPath = options.dbPath || store.DEFAULT_DB;

  try {
    if (route === '/api/badge/status') {
      const db = store.open(dbPath);
      const body = status(db, {
        policyId: url.searchParams.get('policy') || undefined,
        // asOf lets the position be reviewed at a past date. Necessary today
        // because PARMA's solar data ends 2023-05-03, so a 2026 "now" has no
        // computable flights and the headline figure would always read zero.
        now: url.searchParams.get('asOf') || undefined,
      });
      db.close();
      json(res, 200, body);
      return true;
    }

    if (route === '/api/badge/spaceweather') {
      json(res, 200, spaceweather.getSpaceWeather());
      return true;
    }

    if (route === '/api/badge/flights') {
      const db = store.open(dbPath);
      const superseded = store.supersededIds(db);
      const rows = store.list(db, {
        limit: Math.min(500, Number(url.searchParams.get('limit') || 50)),
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
      });
      const total = store.all(db).length;
      db.close();
      json(res, 200, {
        flights: rows.map((r) => summarize(r, superseded)),
        count: rows.length,
        totalEntries: total,
      });
      return true;
    }

    const detail = route.match(/^\/api\/badge\/flights\/([A-Za-z0-9_]+)$/);
    if (detail) {
      const db = store.open(dbPath);
      const row = store.get(db, detail[1]);
      const superseded = store.supersededIds(db);
      db.close();
      if (!row) {
        json(res, 404, { error: `No flight with id ${detail[1]}` });
        return true;
      }
      json(res, 200, {
        ...summarize(row, superseded),
        samples: row.samples_json ? JSON.parse(row.samples_json) : null,
        inputs: JSON.parse(row.inputs_json),
        prevHash: row.prev_hash,
      });
      return true;
    }

    if (route === '/api/badge/brief') {
      const respond = (question) => {
        brief({
          dbPath,
          question,
          asOf: url.searchParams.get('asOf') || undefined,
          deterministicOnly: url.searchParams.get('deterministic') === '1',
        })
          .then((body) => json(res, 200, body))
          .catch((err) => json(res, 500, { error: err.message }));
      };
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
          if (raw.length > 8192) req.destroy();
        });
        req.on('end', () => {
          let question;
          try { question = JSON.parse(raw || '{}').question; } catch { question = undefined; }
          respond(typeof question === 'string' ? question.slice(0, 500) : undefined);
        });
      } else {
        respond(url.searchParams.get('q') || undefined);
      }
      return true;
    }

    // Projection: same computation as a logged flight, but nothing is recorded
    // (brief §8 /project). The frontend never computes a dose, so the altitude
    // slider calls this on every change (guardrail §13.8).
    if (route === '/api/badge/project') {
      const run = (body) => {
        const altFt = Number(body.cruiseAltitudeFt);
        const d = String(body.date || '');
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!body.origin || !body.destination || !m || !Number.isFinite(altFt)) {
          json(res, 400, { error: 'project needs origin, destination, date (YYYY-MM-DD) and cruiseAltitudeFt' });
          return;
        }
        computeFlightDose({
          origin: body.origin,
          destination: body.destination,
          date: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
          cruiseAltitudeFt: altFt,
        })
          .then((result) => {
            const db = store.open(dbPath);
            const position = status(db, { policyId: body.policyId, now: body.asOf });
            db.close();
            json(res, 200, {
              projection: result,
              recorded: false,
              note: 'Projection only. Nothing was written to the ledger.',
              currentPosition: position.empty ? null : {
                ytdGcrMSv: position.ytdGcrMSv,
                pctOfAnnualLimit: position.pctOfAnnualLimit,
                annualLimitMSv: position.annualLimitMSv,
                policyId: position.policyId,
              },
            });
          })
          .catch((err) => json(res, 400, { error: err.message }));
      };

      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
        req.on('end', () => { try { run(JSON.parse(raw || '{}')); } catch { json(res, 400, { error: 'bad JSON' }); } });
      } else {
        run({
          origin: url.searchParams.get('origin'),
          destination: url.searchParams.get('destination'),
          date: url.searchParams.get('date'),
          cruiseAltitudeFt: url.searchParams.get('cruiseAltitudeFt'),
          asOf: url.searchParams.get('asOf') || undefined,
        });
      }
      return true;
    }

    if (route === '/api/badge/verify') {
      const db = store.open(dbPath);
      const body = verify(db);
      db.close();
      json(res, 200, body);
      return true;
    }

    if (route === '/api/badge/export') {
      const format = url.searchParams.get('format') || 'json';
      const db = store.open(dbPath);
      const body = exportLedger(db, format);
      db.close();
      const type = format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
      res.setHeader('Content-Disposition', `attachment; filename="badge-ledger.${format === 'csv' ? 'csv' : 'json'}"`);
      text(res, 200, body, type);
      return true;
    }

    json(res, 404, { error: `Unknown endpoint ${route}` });
    return true;
  } catch (err) {
    json(res, 500, { error: err.message });
    return true;
  }
}

module.exports = { handle, summarize };
