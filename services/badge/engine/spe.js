'use strict';

// Solar particle event overlay (brief §4.3). The FAA has stated it has no program
// for estimating SPE dose, so this is BADGE's own empirical model and it is
// labelled as such everywhere: method "empirical-overlay-v1", confidence "low",
// and an explicit uncertainty band that is wide on purpose.
//
// SPE dose is NEVER added into the GCR figure (guardrail §13.4). It is returned as
// its own channel with its own confidence and its own band.
//
// Physical basis, in order of what actually gates the dose at cruise:
//
//  1. Geomagnetic access. A proton only reaches a point if its magnetic rigidity
//     exceeds the local vertical cutoff rigidity. PARMA already gives us Rc per
//     sample point, so gating is done along the real track rather than by a crude
//     latitude band. This is why an equatorial route during a storm can be
//     essentially unaffected while a polar one is not.
//
//  2. Atmospheric penetration. The proton must then have enough range to reach
//     flight level through the overlying air mass. At cruise depth (~200 g/cm2)
//     this threshold is several hundred MeV and usually DOMINATES the geomagnetic
//     one — which is precisely why only the hardest events (GLE-class) matter to
//     aviation, and why the >=100 MeV channel is the one to watch.
//
//  3. Spectrum. The two measured integral channels (>=10 and >=100 MeV) define a
//     power law, which is integrated above the effective threshold.
//
// The weakest link is the fluence-to-dose step, hence the deliberately wide band.

const PROTON_REST_MASS_MEV = 938.272;

const METHOD = 'empirical-overlay-v1';

// Uncertainty on the emitted number, as a multiplicative band. A factor of 3 either
// way is an honest reflection of how poorly constrained SPE dose at altitude is.
const UNCERTAINTY_FACTOR = 3;

// Effective dose per unit proton fluence above the atmospheric threshold, in
// (uSv/h) per (proton/cm2/s). Order-of-magnitude anchor: a hard SPE producing
// ~1 pfu above the cruise-depth threshold contributes single-digit uSv/h at
// polar cruise, consistent with published GLE aviation dose-rate estimates.
// This coefficient is the dominant uncertainty in the model.
const FLUENCE_TO_DOSE_USV_PER_H_PER_PFU = 4.0;

// Kinetic energy (MeV) a proton needs for its rigidity to exceed a cutoff (GV).
function energyFromRigidity(rigidityGV) {
  const pcMeV = rigidityGV * 1000;
  return Math.sqrt(pcMeV * pcMeV + PROTON_REST_MASS_MEV * PROTON_REST_MASS_MEV) - PROTON_REST_MASS_MEV;
}

// Approximate proton range-energy relation for air, inverted: the kinetic energy
// needed to traverse a given atmospheric depth (g/cm2). Fitted to the standard
// proton range curve in air over the aviation-relevant 10-2000 MeV span.
function energyToPenetrateDepth(depthGcm2) {
  if (depthGcm2 <= 0) return 0;
  // R(E) ~ 0.0022 * E^1.77 g/cm2  ->  E(R) = (R / 0.0022)^(1/1.77)
  return Math.pow(depthGcm2 / 0.0022, 1 / 1.77);
}

// Power law through the two measured integral points: J(>E) = J10 * (E/10)^-gamma.
function integralFluxAbove(energyMeV, flux10MeV, flux100MeV) {
  if (!flux10MeV || flux10MeV <= 0) return 0;
  if (energyMeV <= 10) return flux10MeV;

  // Fall back to a typical SPE slope if the high channel is unusable.
  let gamma = 2.0;
  if (flux100MeV > 0 && flux100MeV < flux10MeV) {
    gamma = Math.log(flux10MeV / flux100MeV) / Math.log(100 / 10);
  }
  return flux10MeV * Math.pow(energyMeV / 10, -gamma);
}

// One sample point's SPE dose rate contribution.
function doseRateAtPoint({ cutoffRigidityGV, depthGcm2 }, { flux10MeV, flux100MeV }) {
  const geomagneticThresholdMeV = energyFromRigidity(cutoffRigidityGV);
  const atmosphericThresholdMeV = energyToPenetrateDepth(depthGcm2);
  const effectiveThresholdMeV = Math.max(geomagneticThresholdMeV, atmosphericThresholdMeV);

  const accessibleFluxPfu = integralFluxAbove(effectiveThresholdMeV, flux10MeV, flux100MeV);
  const doseRateUSvPerHr = accessibleFluxPfu * FLUENCE_TO_DOSE_USV_PER_H_PER_PFU;

  return {
    geomagneticThresholdMeV,
    atmosphericThresholdMeV,
    effectiveThresholdMeV,
    gatedBy: atmosphericThresholdMeV >= geomagneticThresholdMeV ? 'atmosphere' : 'geomagnetic',
    accessibleFluxPfu,
    doseRateUSvPerHr,
  };
}

// Overlay an event onto an already-computed flight.
//   samples: from engine/dose.js — each carries cutoffRigidityGV and depthGcm2
//   evidence: from spaceweather archive eventsInWindow()
function overlay(samples, evidence) {
  if (!evidence || evidence.covered !== true) {
    return {
      speMSv: null,
      confidence: null,
      method: METHOD,
      applied: false,
      reason: evidence && evidence.note
        ? evidence.note
        : 'No space weather evidence covers this flight window.',
    };
  }

  if (!evidence.protonEventActive && !evidence.aviationHighEnergyActive) {
    return {
      speMSv: 0,
      confidence: 'high', // confidently zero: no event was running
      method: METHOD,
      applied: true,
      quiet: true,
      reason: 'No proton event was active during this flight window.',
      peak10MeV: evidence.peak10MeV,
      peak100MeV: evidence.peak100MeV,
    };
  }

  // Peak flux across the window is a deliberate upper-bound posture: the event's
  // real time profile is not resolved per sample here.
  const flux = { flux10MeV: evidence.peak10MeV, flux100MeV: evidence.peak100MeV };

  let totalUSv = 0;
  let peakRate = 0;
  let gatedByAtmosphere = 0;
  const perPoint = [];

  for (let i = 0; i < samples.length; i++) {
    const p = doseRateAtPoint(samples[i], flux);
    perPoint.push(p);
    if (p.gatedBy === 'atmosphere') gatedByAtmosphere++;
    peakRate = Math.max(peakRate, p.doseRateUSvPerHr);

    if (i > 0) {
      const dt = samples[i].tHours - samples[i - 1].tHours;
      totalUSv += ((p.doseRateUSvPerHr + perPoint[i - 1].doseRateUSvPerHr) / 2) * dt;
    }
  }

  const speMSv = totalUSv / 1000;

  return {
    speMSv,
    speMSvLow: speMSv / UNCERTAINTY_FACTOR,
    speMSvHigh: speMSv * UNCERTAINTY_FACTOR,
    uncertaintyFactor: UNCERTAINTY_FACTOR,
    confidence: 'low',
    method: METHOD,
    applied: true,
    quiet: false,
    peakDoseRateUSvPerHr: peakRate,
    peak10MeV: evidence.peak10MeV,
    peak100MeV: evidence.peak100MeV,
    minutesAboveEventThreshold: evidence.minutesAboveEventThreshold,
    gating: {
      pointsGatedByAtmosphere: gatedByAtmosphere,
      pointsGatedByGeomagnetic: samples.length - gatedByAtmosphere,
      minEffectiveThresholdMeV: Math.min(...perPoint.map((p) => p.effectiveThresholdMeV)),
      maxEffectiveThresholdMeV: Math.max(...perPoint.map((p) => p.effectiveThresholdMeV)),
    },
    caveat:
      'Modeled SPE contribution from an empirical overlay, not a measurement. The ' +
      'fluence-to-dose step is the dominant uncertainty; treat the band, not the ' +
      'central value, as the answer. Never added to the GCR figure.',
  };
}

module.exports = {
  overlay,
  doseRateAtPoint,
  energyFromRigidity,
  energyToPenetrateDepth,
  integralFluxAbove,
  METHOD,
  UNCERTAINTY_FACTOR,
};
