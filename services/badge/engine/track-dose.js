'use strict';

// Dose from a RECORDED track (brief §3.2, telemetry path).
//
// Same pipeline as the synthesized route, but the 4D profile comes from real
// ADS-B positions instead of an assumed great circle. This is the high-confidence
// path: ADS-B barometric altitude is a direct measurement of atmospheric depth,
// which is what PARMA is parameterised on.

const parma = require('./parma');
const { integrate } = require('./integrate');
const spe = require('./spe');
const spaceweather = require('../spaceweather');
const coverage = require('../telemetry/coverage');
const { CONFIDENCE_BY_SOURCE } = require('./dose');

function utcParts(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function computeTrackDose(rawTrack, options = {}) {
  if (!Array.isArray(rawTrack) || rawTrack.length < 2) {
    throw new Error('A track needs at least two positions to integrate');
  }

  const prepared = coverage.prepare(rawTrack, options);
  const samples = prepared.samples;
  const startT = samples[0].t;
  const date = options.date || utcParts(startT);

  const points = samples.map((s) => ({
    tHours: (s.t - startT) / 3600,
    lat: s.lat,
    lon: s.lon,
    altFt: s.altFt,
    phase: s.interpolated ? 'interpolated' : 'recorded',
  }));

  const rates = parma.doseRates(
    points.map((p) => ({ year: date.year, month: date.month, day: date.day, lat: p.lat, lon: p.lon, altFt: p.altFt })),
    { g: options.g }
  );

  const totals = integrate(points, rates);
  const g = options.g === undefined ? parma.G_FREE_AIR : options.g;

  const enriched = points.map((p, i) => ({
    ...p,
    effUSvPerHr: rates[i].effUSvPerHr,
    h10USvPerHr: rates[i].h10USvPerHr,
    cutoffRigidityGV: rates[i].cutoffRigidityGV,
    depthGcm2: rates[i].depthGcm2,
    interpolated: p.phase === 'interpolated',
  }));

  const departUtc = new Date(startT * 1000).toISOString();
  const arriveUtc = new Date(samples[samples.length - 1].t * 1000).toISOString();

  let speResult = { speMSv: null, confidence: null, method: spe.METHOD, applied: false,
    reason: 'SPE overlay not requested.' };
  if (options.speOverlay !== false) {
    const evidence = spaceweather.spaceWeatherForFlight(departUtc, arriveUtc).protonEvidence;
    speResult = spe.overlay(enriched, evidence);
  }

  // A track that is largely reconstructed is not a high-confidence datum however
  // good the source was, so coverage drags the confidence down (§6.7).
  const baseSource = options.telemetrySource || 'adsb-baro';
  const baseConfidence = CONFIDENCE_BY_SOURCE[baseSource] || 'low';
  const confidence =
    prepared.coveredFraction >= 0.95 ? baseConfidence
      : prepared.coveredFraction >= 0.7 ? (baseConfidence === 'high' ? 'medium' : 'low')
        : 'low';

  const divergences = rawTrack
    .map((s) => s.baroGeomDivergenceFt)
    .filter((v) => typeof v === 'number');
  const meanDivergence = divergences.length
    ? divergences.reduce((a, b) => a + b, 0) / divergences.length
    : null;

  return {
    route: options.route || `${options.callsign || options.icao24 || 'TRACK'}`,
    callsign: options.callsign || null,
    icao24: options.icao24 || null,
    dateUtc: `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`,
    cruiseAltitudeFt: Math.max(...points.map((p) => p.altFt)),
    durationHours: totals.durationHours,
    distanceKm: null, // measured track: distance is not an input to the dose

    dose: {
      gcrMSv: totals.gcrEffectiveMSv,
      gcrH10MSv: totals.gcrH10MSv,
      gcrModel: parma.MODEL_VERSION,
      gcrQuantity: 'ICRP-116 effective dose, isotropic irradiation',
      gcrConfidence: confidence,
      speMSv: speResult.speMSv,
      speMSvLow: speResult.speMSvLow ?? null,
      speMSvHigh: speResult.speMSvHigh ?? null,
      speConfidence: speResult.confidence,
      speMethod: speResult.method,
      speApplied: speResult.applied,
      speReason: speResult.reason ?? null,
      uncertaintyPct: null,
      uncertaintyBasis:
        prepared.coveredFraction < 1
          ? `not quantified; ${(100 - prepared.coveredFraction * 100).toFixed(0)}% of the flight is interpolated`
          : 'not quantified in P1 (per-sample telemetry error not yet propagated)',
    },

    telemetry: {
      source: prepared.coveredFraction < 1 ? 'merged' : baseSource,
      coveredFraction: prepared.coveredFraction,
      altSource: 'baro',
      recordedSamples: prepared.recordedSamples,
      interpolatedSamples: prepared.interpolatedSamples,
      gaps: prepared.gaps.length,
      longestGapMinutes: prepared.gaps.length
        ? Math.round(Math.max(...prepared.gaps.map((gp) => gp.seconds)) / 60)
        : 0,
      sourceBreakdown: prepared.sourceBreakdown,
      // Quality signal only — the two altitudes are never averaged (§13.6).
      baroGeomDivergenceFt: meanDivergence,
      qualityFlag:
        meanDivergence == null ? 'no-geometric-reference'
          : Math.abs(meanDivergence) > 1325 ? 'baro-geom-divergence-above-published-range'
            : 'nominal',
    },

    peakDoseRateUSvPerHr: totals.peakDoseRateUSvPerHr,
    meanDoseRateUSvPerHr: totals.meanDoseRateUSvPerHr,
    maxLatitude: totals.maxLatitude,

    solarParams: {
      wIndex: rates[0].wIndex,
      forceFieldMV: rates[0].forceFieldMV,
      source: 'PARMA bundled daily force-field table (Usoskin-derived)',
    },

    geometry: {
      g,
      note: g === parma.G_FREE_AIR
        ? 'free air, no fuselage shielding applied (§12 open question)'
        : 'aircraft mass modeled via PARMA g parameter (|g| in 100-tonne units)',
    },

    window: { departUtc, arriveUtc },
    spe: speResult,
    profile: { source: 'recorded-track', samples: samples.length, gapSeconds: coverage.DEFAULT_GAP_SECONDS },
    samples: enriched,
  };
}

module.exports = { computeTrackDose, utcParts };
