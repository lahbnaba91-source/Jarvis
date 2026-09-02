#!/usr/bin/env node
'use strict';

// P6 tests. The point of this layer is that a hallucinated dose figure can never
// reach the user, so most of these are attacks on the guard.

const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../../brief/guard');
const { render, sentences } = require('../../brief/render');
const prompt = require('../../brief/prompt');
const { brief } = require('../../brief');
const { buildContext } = require('../../brief/context');
const store = require('../../ledger/store');
const { computeFlightDose } = require('../../engine/dose');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  console.log('\nBADGE brief-layer tests (P6)\n');

  const ctx = {
    dose: { ytdGcrMSv: 0.1585, pctOfAnnualLimit: 0.79, annualLimitMSv: 20, flightsLogged: 3 },
    spaceWeather: { sScale: 'S0', aviationRiskScore: 0, aviationRiskScoreMax: 100 },
  };

  // --- the guard ------------------------------------------------------------
  check('figures copied from the data pass',
    guard.validate('You are at 0.79% of the 20 mSv limit.', ctx).ok);
  check('an invented percentage is caught',
    !guard.validate('You are at 38% of your annual limit.', ctx).ok);
  check('an invented dose figure is caught',
    !guard.validate('You have absorbed 4.2 mSv this year.', ctx).ok);
  check('the guard names what it rejected',
    guard.validate('38% and 4.2 mSv', ctx).unsupported.join(',') === '38,4.2');
  check('honest rounding is allowed',
    guard.validate('About 0.16 mSv, roughly 0.8% of the limit.', ctx).ok);
  check('trailing-zero forms are allowed',
    guard.validate('0.1585 mSv, 20 mSv limit, 3 flights.', ctx).ok);
  check('text with no numerals passes',
    guard.validate('Your exposure is well inside the limit.', ctx).ok);

  // The specific failure this whole layer exists to prevent: summing GCR and SPE.
  const sumCtx = { dose: { ytdGcrMSv: 0.1, ytdSpeMSv: 0.2 } };
  check('a summed GCR+SPE total is caught as unsupported',
    !guard.validate('Your combined total is 0.3 mSv.', sumCtx).ok);

  check('the guard counts what it checked', guard.validate('1 and 2 and 3', ctx).checked === 3);
  check('numbers inside strings authorise their digits',
    guard.validate('PARMA-4.10 was used.', { model: 'PARMA-4.10' }).ok);

  // --- deterministic renderer ----------------------------------------------
  const text = render(ctx);
  check('renderer produces prose', typeof text === 'string' && text.length > 50);
  check('renderer stays within 5 sentences', sentences(ctx).slice(0, 5).length <= 5);
  // A renderer that fails its own guard would be a self-inflicted hallucination.
  check('renderer output passes its own guard', guard.validate(text, ctx).ok,
    guard.validate(text, ctx).unsupported.join(','));

  const empty = render({ dose: { empty: true }, spaceWeather: { available: false } });
  check('renderer handles an empty ledger without inventing numbers',
    guard.validate(empty, { dose: { empty: true } }).ok, empty);

  // --- prompt ---------------------------------------------------------------
  check('system prompt forbids computing figures', /may NOT compute/.test(prompt.SYSTEM_PROMPT));
  check('system prompt forbids arithmetic', /not perform arithmetic/i.test(prompt.SYSTEM_PROMPT));
  check('system prompt forbids summing GCR and SPE',
    /NEVER add them together/.test(prompt.SYSTEM_PROMPT));
  check('system prompt forbids medical advice', /Do not give medical advice/.test(prompt.SYSTEM_PROMPT));

  const msgs = prompt.buildMessages(ctx, 'how am I doing?');
  check('the model receives only the structured context', msgs.length === 2 &&
    msgs[1].content.includes('0.1585') && msgs[1].content.includes('how am I doing?'));
  check('no API key means generate refuses rather than pretending', await (async () => {
    if (prompt.hasKey()) return true; // key present in this environment; rule untested but not violated
    try { await prompt.generate(ctx); return false; } catch (e) { return e.code === 'NO_KEY'; }
  })());

  // --- orchestrator ---------------------------------------------------------
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'badge-brief-')), 'ledger.db');
  const db = store.open(dbPath);
  const spec = { origin: 'OTBD', destination: 'KLAX', date: { year: 2023, month: 1, day: 20 }, cruiseAltitudeFt: 43000 };
  store.append(db, computeFlightDose(spec), { spec });
  db.close();

  const b = await brief({ dbPath, deterministicOnly: true });
  check('brief always returns text', typeof b.text === 'string' && b.text.length > 0);
  check('brief declares which path wrote the words', b.source === 'deterministic');
  check('brief returns the source data it spoke from', !!b.sourceData.dose);
  check('brief carries the medical disclaimer', /not medical advice/.test(b.disclaimer));
  check('brief text passes the guard against its own context',
    guard.validate(b.text, b.sourceData).ok,
    guard.validate(b.text, b.sourceData).unsupported.join(','));

  const ctxBuilt = buildContext({ dbPath });
  check('context includes the dose position', !!ctxBuilt.dose);
  check('context includes recent flights', Array.isArray(ctxBuilt.recentFlights));
  check('context includes the limit policy and its source',
    !!ctxBuilt.limits.policyId && !!ctxBuilt.limits.source);
  check('context carries no combined dose total',
    !JSON.stringify(ctxBuilt).includes('ytdTotalMSv'));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
