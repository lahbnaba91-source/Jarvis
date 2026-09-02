'use strict';

// Orchestrates the §3.2 pipeline for a single flight:
//   route -> vertical profile -> sample points -> PARMA dose rates -> integration.
// GCR only. SPE overlay arrives in P4 and stays a separate field (guardrail §13.4).

const profileEngine = require('./profile');
const parma = require('./parma');
const { integrate } = require('./integrate');

// §6.7 source confidence. Synthesized profiles are the weakest input by design.
const CONFIDENCE_BY_SOURCE = {
  'adsb-baro': 'high',
  'adsb-geom': 'high',
  adsc: 'medium',
  'garmin-fit': 'high',
  'apple-healthkit': 'medium',
  'logbook-import': 'low',
  synthesized: 'low',
  interpolated: 'low',
};

function computeFlightDose(spec) {
  const profile = profileEngine.synthesize(spec);

  const rates = parma.doseRates(
    profile.points.map((p) => ({
      year: p.year,
      month: p.month,
      day: p.day,
      lat: p.lat,
      lon: p.lon,
      altFt: p.altFt,
    })),
    { g: spec.g }
  );

  const totals = integrate(profile.points, rates);
  const g = spec.g === undefined ? parma.G_FREE_AIR : spec.g;

  return {
    route: `${profile.origin.icao}-${profile.destination.icao}`,
    dateUtc: `${spec.date.year}-${String(spec.date.month).padStart(2, '0')}-${String(spec.date.day).padStart(2, '0')}`,
    cruiseAltitudeFt: profile.peakAltitudeFt,
    durationHours: totals.durationHours,
    distanceKm: profile.distanceKm,

    dose: {
      gcrMSv: totals.gcrEffectiveMSv,
      gcrH10MSv: totals.gcrH10MSv,
      gcrModel: parma.MODEL_VERSION,
      gcrQuantity: 'ICRP-116 effective dose, isotropic irradiation',
      gcrConfidence: CONFIDENCE_BY_SOURCE[profile.telemetrySource],
      // SPE is not modeled until P4 and is never folded into the GCR figure.
      speMSv: null,
      speConfidence: null,
      uncertaintyPct: null,
      uncertaintyBasis: 'not quantified in P1 (synthesized profile dominates)',
    },

    telemetry: {
      source: profile.telemetrySource,
      coveredFraction: profile.coveredFraction,
      altSource: 'synthesized-pressure-altitude',
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
      note:
        g === parma.G_FREE_AIR
          ? 'free air, no fuselage shielding applied (§12 open question)'
          : 'aircraft mass modeled via PARMA g parameter (|g| in 100-tonne units)',
    },

    profile: profile.profile,
    samples: profile.points.map((p, i) => ({
      tHours: p.tHours,
      lat: p.lat,
      lon: p.lon,
      altFt: p.altFt,
      phase: p.phase,
      effUSvPerHr: rates[i].effUSvPerHr,
      h10USvPerHr: rates[i].h10USvPerHr,
      cutoffRigidityGV: rates[i].cutoffRigidityGV,
      depthGcm2: rates[i].depthGcm2,
    })),
  };
}

module.exports = { computeFlightDose, CONFIDENCE_BY_SOURCE };
