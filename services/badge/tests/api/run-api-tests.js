#!/usr/bin/env node
'use strict';

// P5 tests: the JSON API and the dashboard's display guardrails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const api = require('../../api/routes');
const store = require('../../ledger/store');
const { computeFlightDose } = require('../../engine/dose');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const appJs = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

(async () => {
  console.log('\nBADGE API + dashboard tests (P5)\n');

  // Isolated ledger so the suite never depends on the working ledger's contents.
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badge-api-')), 'ledger.db');
  const db = store.open(dbPath);
  const specs = [
    { origin: 'OTBD', destination: 'KLAX', date: { year: 2023, month: 1, day: 20 }, cruiseAltitudeFt: 43000 },
    { origin: 'YPPH', destination: 'EGLL', date: { year: 2023, month: 2, day: 14 }, cruiseAltitudeFt: 39000 },
  ];
  const rows = [];
  for (const s of specs) rows.push(store.append(db, await computeFlightDose(s), { spec: s }));
  db.close();

  const server = http.createServer((req, res) => {
    if (api.handle(req, res, { dbPath })) return;
    res.writeHead(404).end('nope');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    const type = res.headers.get('content-type') || '';
    return { res, body: type.includes('json') ? await res.json() : await res.text() };
  };

  // --- endpoints -------------------------------------------------------------
  const status = await get('/api/badge/status');
  check('status returns 200', status.res.status === 200);
  check('status names its policy and source', !!status.body.policyId && !!status.body.policySource);
  check('status keeps GCR and SPE separate',
    'ytdGcrMSv' in status.body && 'ytdSpeMSv' in status.body && !('ytdTotalMSv' in status.body));
  check('status carries verifyBeforeUse', status.body.verifyBeforeUse === true);

  const sw = await get('/api/badge/spaceweather');
  check('spaceweather returns 200', sw.res.status === 200);
  check('spaceweather always declares staleness', typeof sw.body.stale === 'boolean');
  check('spaceweather disclaims the modeled risk score',
    /not an official NOAA product/.test(sw.body.disclaimer));

  const flights = await get('/api/badge/flights');
  check('flights returns the ledger', flights.body.flights.length === 2);
  check('flight rows carry confidence and coverage',
    flights.body.flights.every((f) => f.dose.gcrConfidence && f.telemetry.coveredFraction != null));
  check('flight rows carry the model version',
    flights.body.flights.every((f) => f.dose.gcrModel === 'PARMA-4.10'));
  check('list response omits the bulky sample series',
    flights.body.flights.every((f) => !('samples' in f)));

  const detail = await get(`/api/badge/flights/${rows[0].id}`);
  check('flight detail returns the sampled series', Array.isArray(detail.body.samples));
  check('flight detail carries the inputs needed to recompute', !!detail.body.inputs.spec);
  check('unknown flight id 404s', (await get('/api/badge/flights/flt_nope')).res.status === 404);

  const verify = await get('/api/badge/verify');
  check('verify reports an intact chain', verify.body.intact === true && verify.body.entries === 2);

  const csv = await get('/api/badge/export?format=csv');
  check('csv export served as csv', /text\/csv/.test(csv.res.headers.get('content-type')));
  check('csv export has a row per entry', csv.body.trim().split('\n').length === 3);
  const research = await get('/api/badge/export?format=research');
  check('research export is de-identified',
    !('id' in research.body.records[0]) && 'route' in research.body.records[0]);

  // --- projection (§8 /project) ---------------------------------------------
  const projRes = await fetch(base + '/api/badge/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: 'LAX', destination: 'ICN', date: '2023-03-15', cruiseAltitudeFt: 39000 }),
  });
  const proj = await projRes.json();
  check('project returns a dose', projRes.status === 200 && proj.projection.dose.gcrMSv > 0);
  // §8: same shape as a logged flight, but NOTHING is written.
  check('project writes nothing to the ledger', proj.recorded === false);
  const afterProject = await get('/api/badge/flights');
  check('the ledger is unchanged after a projection', afterProject.body.flights.length === 2);
  check('project compares against the current position', 'currentPosition' in proj);
  check('project keeps GCR and SPE separate',
    'gcrMSv' in proj.projection.dose && 'speMSv' in proj.projection.dose &&
    !('totalMSv' in proj.projection.dose));
  check('project carries the solar provenance', !!proj.projection.solarParams.source);
  const badProj = await fetch(base + '/api/badge/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  check('project rejects incomplete input rather than guessing', badProj.status === 400);

  // --- read-only + safety ----------------------------------------------------
  const post = await fetch(base + '/api/badge/status', { method: 'POST' });
  check('writes are rejected, not silently ignored', post.status === 405);
  check('unknown api route 404s', (await get('/api/badge/nonsense')).res.status === 404);

  server.close();

  // --- display guardrails, enforced against the shipped frontend -------------
  // §13.8 / §9.4.7: the frontend must never compute a dose figure.
  check('frontend never sums GCR and SPE',
    !/gcrMSv\s*\+\s*.*speMSv|speMSv\s*\+\s*.*gcrMSv/.test(appJs));
  check('frontend does not rescale dose values',
    !/gcrMSv\s*[*/]\s*\d/.test(appJs) && !/speMSv\s*[*/]\s*\d/.test(appJs));
  check('frontend states the no-math rule for future maintainers',
    /no dose math/i.test(appJs));

  // §9.4.2: cached space weather always carries a staleness indicator.
  check('staleness badge is rendered from the payload', /sw-staleness|badge-stale/.test(appJs));
  check('offline banner exists and names its timestamp',
    /offline-banner/.test(indexHtml) && /offline-stamp/.test(appJs));
  check('offline mode disables write actions', /aria-disabled/.test(appJs));

  // §9.4.4 / §9.4.5.
  check('coveredFraction under 1 is surfaced', /coveredFraction[\s\S]{0,200}recorded/.test(appJs));
  check('low-confidence data gets its own colour', /low-confidence/.test(appJs) && /--low-conf/.test(css));

  // §9.4.6: the medical disclaimer appears once, not on every card.
  const disclaimers = (indexHtml.match(/not medical advice/gi) || []).length;
  check('medical disclaimer appears exactly once', disclaimers === 1, `found ${disclaimers}`);

  // §9.1: no build step, no framework.
  check('dashboard loads no external scripts', !/<script[^>]+src=["']http/i.test(indexHtml));
  check('dashboard ships a font fallback stack rather than a webfont request',
    !/fonts\.googleapis|@font-face/.test(css) && /Orbitron/.test(css));

  // §9.3: the detail screen's provenance panel is not optional, and the project
  // screen's altitude slider must not compute dose in the browser.
  check('detail screen renders a dose-rate chart', /doseRateChart/.test(appJs));
  check('detail screen renders the track', /trackMap/.test(appJs));
  check('provenance panel is built, not optional', /detail-prov/.test(appJs) && /entry hash/.test(appJs));
  check('provenance shows coveredFraction and telemetry source',
    /coveredFraction/.test(appJs) && /telemetry source/.test(appJs));
  check('provenance shows GCR and SPE on separate rows',
    /provRow\('GCR'/.test(appJs) && /provRow\('SPE'/.test(appJs));
  check('altitude slider exists with 44px touch height',
    /proj-alt/.test(indexHtml) && /\.slider \{[^}]*height: 44px/.test(css));
  check('the slider asks the backend rather than computing locally',
    /\/api\/badge\/project/.test(appJs) && !/gcrMSv\s*[*/]/.test(appJs));
  check('projection result states it was not recorded', /NOT RECORDED/.test(appJs));
  check('all five screens are present',
    ['screen-now', 'screen-ledger', 'screen-detail', 'screen-project', 'screen-briefing']
      .every((id) => indexHtml.includes(id)));

  // Mobile-first sizing the brief asks for.
  check('touch targets are at least 44px', /min-height:\s*44px/.test(css));
  check('viewport meta is set for mobile', /width=device-width/.test(indexHtml));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
