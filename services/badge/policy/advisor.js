'use strict';

// Career dose status against a configurable limit policy (brief §5).
//
// Reads the ledger, drops superseded entries, and reports position against the
// selected policy. GCR and SPE are carried as separate running totals and are
// never summed into one unqualified figure (guardrail §13.4).

const store = require('../ledger/store');
const { getPolicy, DEFAULT_POLICY_ID } = require('./limits');

const MS_PER_DAY = 86400000;

function activeEntries(db) {
  const superseded = store.supersededIds(db);
  return store.all(db).filter((r) => !superseded.has(r.id));
}

function sumGcr(entries) {
  return entries.reduce((a, r) => a + r.gcr_msv, 0);
}

function sumSpe(entries) {
  // Only entries that actually carry an SPE figure contribute.
  return entries.reduce((a, r) => a + (r.spe_msv || 0), 0);
}

function yearOf(dateUtc) {
  return Number(dateUtc.slice(0, 4));
}

function status(db, options = {}) {
  const policy = getPolicy(options.policyId || DEFAULT_POLICY_ID);
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const currentYear = now.getUTCFullYear();

  const entries = activeEntries(db);

  if (!entries.length) {
    return {
      policyId: policy.policyId,
      policyLabel: policy.label,
      policySource: policy.source,
      verifyBeforeUse: policy.verifyBeforeUse,
      flightsLogged: 0,
      empty: true,
      note: 'No flights recorded yet.',
    };
  }

  const thisYear = entries.filter((r) => yearOf(r.date_utc) === currentYear);
  const rolling12 = entries.filter((r) => nowMs - Date.parse(r.date_utc) <= 365 * MS_PER_DAY);

  const windowYears = policy.averagingWindowYears || 5;
  const windowStartYear = currentYear - windowYears + 1;
  const inWindow = entries.filter((r) => yearOf(r.date_utc) >= windowStartYear);

  const ytdGcr = sumGcr(thisYear);
  const ytdSpe = sumSpe(thisYear);
  const rolling12Gcr = sumGcr(rolling12);
  const windowAvg = sumGcr(inWindow) / windowYears;

  // Year-end projection from the pace so far this year.
  const yearStart = Date.UTC(currentYear, 0, 1);
  const daysElapsed = Math.max(1, (nowMs - yearStart) / MS_PER_DAY);
  const daysInYear = (Date.UTC(currentYear + 1, 0, 1) - yearStart) / MS_PER_DAY;
  const dailyRate = ytdGcr / daysElapsed;
  const projectedYearEnd = dailyRate * daysInYear;

  const pctOfAnnual = (ytdGcr / policy.annualLimitMSv) * 100;
  const pctOfWindowAverage = (windowAvg / policy.annualLimitMSv) * 100;

  const remainingToLimit = policy.annualLimitMSv - ytdGcr;
  const daysToThreshold =
    dailyRate > 0 && remainingToLimit > 0 ? Math.round(remainingToLimit / dailyRate) : null;

  let breachRisk = 'low';
  if (ytdGcr >= policy.annualLimitMSv) breachRisk = 'exceeded';
  else if (projectedYearEnd >= policy.annualLimitMSv) breachRisk = 'high';
  else if (projectedYearEnd >= policy.annualLimitMSv * 0.75) breachRisk = 'moderate';

  const topContributors = [...entries]
    .sort((a, b) => b.gcr_msv - a.gcr_msv)
    .slice(0, 3)
    .map((r) => ({
      flightId: r.id,
      route: r.route,
      dateUtc: r.date_utc,
      gcrMSv: r.gcr_msv,
      confidence: r.gcr_confidence,
      telemetrySource: r.telemetry_source,
    }));

  const withUncertainty = entries.filter((r) => r.uncertainty_pct !== null);
  const meanUncertaintyPct = withUncertainty.length
    ? withUncertainty.reduce((a, r) => a + r.uncertainty_pct, 0) / withUncertainty.length
    : null;

  const byConfidence = entries.reduce((acc, r) => {
    acc[r.gcr_confidence] = (acc[r.gcr_confidence] || 0) + 1;
    return acc;
  }, {});

  return {
    policyId: policy.policyId,
    policyLabel: policy.label,
    policySource: policy.source,
    annualLimitMSv: policy.annualLimitMSv,
    averagingWindowYears: windowYears,
    singleYearCeilingMSv: policy.singleYearCeilingMSv,
    verifyBeforeUse: policy.verifyBeforeUse,

    asOf: now.toISOString(),
    flightsLogged: entries.length,

    // GCR and SPE stay separate all the way to the output.
    ytdGcrMSv: ytdGcr,
    ytdSpeMSv: ytdSpe,
    rolling12moGcrMSv: rolling12Gcr,
    windowAverageGcrMSv: windowAvg,

    pctOfAnnualLimit: pctOfAnnual,
    pctOfWindowAverage: pctOfWindowAverage,
    projectedYearEndGcrMSv: projectedYearEnd,
    daysToThreshold,
    breachRisk,

    topContributors,
    meanUncertaintyPct,
    uncertaintyNote:
      meanUncertaintyPct === null
        ? 'Per-flight uncertainty is not quantified yet (P1 synthesized profiles).'
        : null,
    confidenceBreakdown: byConfidence,

    speNote:
      ytdSpe > 0
        ? 'SPE contributions are modeled at low confidence and are reported separately from GCR.'
        : 'No SPE contribution recorded. SPE is never folded into the GCR total.',
    disclaimer:
      'Modeled estimate against published reference limits. Not a dosimetry record of legal ' +
      'standing and not medical advice — discuss with your AME.',
  };
}

module.exports = { status, activeEntries };
