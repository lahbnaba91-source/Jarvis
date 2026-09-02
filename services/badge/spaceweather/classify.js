'use strict';

// Raw SWPC flux -> normalized aviation-facing assessment.
//
// The aviation risk score is a MODELED number, not an official NOAA product, so
// it carries a method version and its inputs travel with it. It deliberately
// weights the >=100 MeV channel hardest: those are the protons energetic enough
// to reach cruise altitude (brief §4.2).

const {
  S_SCALE_PFU,
  PROTON_EVENT_THRESHOLD_10MEV_PFU,
  AVIATION_THRESHOLD_100MEV_PFU,
} = require('./sources');

const RISK_METHOD = 'aviation-risk-v1';

function sScaleFromPfu(pfu10MeV) {
  if (pfu10MeV === null || pfu10MeV === undefined) return null;
  for (const band of S_SCALE_PFU) {
    if (pfu10MeV >= band.minPfu) return band.scale;
  }
  return 'S0';
}

// Latest reading per integral energy channel from the GOES proton feed.
function latestProtonFlux(records) {
  if (!Array.isArray(records) || !records.length) return {};
  const latest = {};
  for (const r of records) {
    const key = r.energy;
    if (!latest[key] || Date.parse(r.time_tag) > Date.parse(latest[key].time_tag)) {
      latest[key] = r;
    }
  }
  const out = {};
  for (const [energy, rec] of Object.entries(latest)) {
    out[energy] = { fluxPfu: rec.flux, timeTag: rec.time_tag, satellite: rec.satellite };
  }
  return out;
}

// Log-scaled 0..1 ramp between two flux levels.
function logRamp(value, low, high) {
  if (value === null || value === undefined || value <= low) return 0;
  if (value >= high) return 1;
  return (Math.log10(value) - Math.log10(low)) / (Math.log10(high) - Math.log10(low));
}

// Both integral channels carry a permanent galactic-cosmic-ray background, so a
// ramp starting near zero would score a completely quiet sky as elevated risk.
// Measured over the quiet week 2026-08-26..09-02 (2006 archived samples):
//   >=10 MeV   0.155 - 0.970 pfu  (median 0.261)
//   >=100 MeV  0.138 - 0.340 pfu  (median 0.212)
// Both ramps therefore start at 1 pfu, above observed background and at SWPC's
// own >=100 MeV aviation threshold.
const RISK_FLOOR_PFU = 1;

function aviationRiskScore({ pfu10MeV, pfu100MeV, kp }) {
  // >=100 MeV dominates: these are the protons that reach cruise altitude.
  const high = logRamp(pfu100MeV, AVIATION_THRESHOLD_100MEV_PFU, 100) * 60;

  // >=10 MeV / S-scale contribution, full at S3 (1000 pfu).
  const low = logRamp(pfu10MeV, RISK_FLOOR_PFU, 1000) * 30;

  // Geomagnetic disturbance opens lower latitudes to particle access by
  // depressing cutoff rigidity, so it adds a modest amount of risk.
  const geo = kp === null || kp === undefined ? 0 : Math.min(1, Math.max(0, (kp - 3) / 6)) * 10;

  const score = Math.round(Math.min(100, high + low + geo));

  return {
    score,
    method: RISK_METHOD,
    components: {
      highEnergyProtons: Math.round(high),
      lowEnergyProtons: Math.round(low),
      geomagnetic: Math.round(geo),
    },
    inputs: { pfu10MeV, pfu100MeV, kp },
  };
}

function classify({ protons, kindex, scales }) {
  const flux = latestProtonFlux(protons);
  const pfu10MeV = flux['>=10 MeV'] ? flux['>=10 MeV'].fluxPfu : null;
  const pfu100MeV = flux['>=100 MeV'] ? flux['>=100 MeV'].fluxPfu : null;

  let kp = null;
  if (Array.isArray(kindex) && kindex.length) {
    const last = kindex[kindex.length - 1];
    kp = last.Kp ?? last.kp_index ?? null;
  }

  // Prefer NOAA's own published S-scale when present; fall back to deriving it.
  const noaaS = scales && scales['0'] && scales['0'].S ? scales['0'].S.Scale : null;
  const derivedS = sScaleFromPfu(pfu10MeV);
  const sScale = noaaS !== null && noaaS !== undefined ? `S${noaaS}` : derivedS;

  return {
    sScale,
    sScaleSource: noaaS !== null && noaaS !== undefined ? 'noaa-scales' : 'derived-from-flux',
    sScaleDerived: derivedS,
    protons10MeV: pfu10MeV,
    protons100MeV: pfu100MeV,
    kp,
    protonEventActive: pfu10MeV !== null && pfu10MeV >= PROTON_EVENT_THRESHOLD_10MEV_PFU,
    aviationHighEnergyActive: pfu100MeV !== null && pfu100MeV >= AVIATION_THRESHOLD_100MEV_PFU,
    aviationRisk: aviationRiskScore({ pfu10MeV, pfu100MeV, kp }),
    channels: flux,
  };
}

// Days "1".."3" of noaa-scales.json are the 3-day forecast.
function forecastFromScales(scales) {
  if (!scales) return [];
  return ['1', '2', '3']
    .filter((k) => scales[k])
    .map((k) => ({
      dateUtc: scales[k].DateStamp,
      sScale: scales[k].S && scales[k].S.Scale !== null ? `S${scales[k].S.Scale}` : null,
      sProbabilityPct: scales[k].S ? Number(scales[k].S.Prob) : null,
      rScale: scales[k].R && scales[k].R.Scale !== null ? `R${scales[k].R.Scale}` : null,
      gScale: scales[k].G && scales[k].G.Scale !== null ? `G${scales[k].G.Scale}` : null,
    }));
}

module.exports = {
  classify,
  sScaleFromPfu,
  latestProtonFlux,
  aviationRiskScore,
  forecastFromScales,
  RISK_METHOD,
};
