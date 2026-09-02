'use strict';

// Builds the structured object the brief layer is allowed to talk about.
//
// This is the ONLY thing the model ever sees. It contains no free text from the
// user's ledger and no computed-on-the-fly figures — every number in it was
// produced by the dose engine, the advisor, or the space weather classifier.

const store = require('../ledger/store');
const { status } = require('../policy/advisor');
const spaceweather = require('../spaceweather');

function buildContext(options = {}) {
  const db = store.open(options.dbPath || store.DEFAULT_DB);
  // asOf must flow through, or the brief and the gauge can disagree on the same screen.
  const advisor = status(db, { policyId: options.policyId, now: options.asOf });
  const superseded = store.supersededIds(db);
  const recent = store
    .list(db, { limit: 20 })
    .filter((r) => !superseded.has(r.id))
    .slice(0, 5)
    .map((r) => ({
      route: r.route,
      dateUtc: r.date_utc,
      gcrMSv: r.gcr_msv,
      speMSv: r.spe_msv,
      cruiseAltitudeFt: r.cruise_altitude_ft,
      confidence: r.gcr_confidence,
      telemetrySource: r.telemetry_source,
      coveredFraction: r.covered_fraction,
    }));
  db.close();

  const sw = spaceweather.getSpaceWeather();

  return {
    generatedAt: new Date().toISOString(),
    dose: advisor,
    spaceWeather: sw.available
      ? {
          available: true,
          stale: sw.stale,
          staleness: sw.staleness,
          sScale: sw.current.sScale,
          protons10MeV: sw.current.protons10MeV,
          protons100MeV: sw.current.protons100MeV,
          aviationRiskScore: sw.current.aviationRisk.score,
          // The scale maximum is part of the datum, not a number prose may invent.
          aviationRiskScoreMax: 100,
          aviationRiskMethod: sw.current.aviationRisk.method,
          protonEventActive: sw.current.protonEventActive,
          forecast: sw.forecast,
        }
      : { available: false },
    recentFlights: recent,
    limits: {
      policyId: advisor.policyId,
      annualLimitMSv: advisor.annualLimitMSv,
      source: advisor.policySource,
      verifyBeforeUse: advisor.verifyBeforeUse,
    },
  };
}

module.exports = { buildContext };
