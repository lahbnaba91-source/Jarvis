'use strict';

// Trapezoidal integration of per-point dose rates over the flight's time axis.
// GCR only. SPE is a separate channel and is never folded in here (guardrail §13.4).

function integrate(points, rates) {
  if (points.length !== rates.length) {
    throw new Error(`profile has ${points.length} points but ${rates.length} dose rates`);
  }
  if (points.length < 2) throw new Error('need at least two sample points to integrate');

  let effUSv = 0;
  let h10USv = 0;

  for (let i = 1; i < points.length; i++) {
    const dt = points[i].tHours - points[i - 1].tHours;
    effUSv += ((rates[i].effUSvPerHr + rates[i - 1].effUSvPerHr) / 2) * dt;
    h10USv += ((rates[i].h10USvPerHr + rates[i - 1].h10USvPerHr) / 2) * dt;
  }

  const durationHours = points[points.length - 1].tHours - points[0].tHours;
  const peak = rates.reduce((m, r) => Math.max(m, r.effUSvPerHr), 0);
  const maxLatitude = points.reduce((m, p) => (Math.abs(p.lat) > Math.abs(m) ? p.lat : m), 0);

  return {
    gcrEffectiveUSv: effUSv,
    gcrEffectiveMSv: effUSv / 1000,
    gcrH10USv: h10USv,
    gcrH10MSv: h10USv / 1000,
    durationHours,
    meanDoseRateUSvPerHr: durationHours > 0 ? effUSv / durationHours : 0,
    peakDoseRateUSvPerHr: peak,
    maxLatitude,
  };
}

module.exports = { integrate };
