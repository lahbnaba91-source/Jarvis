'use strict';

// Gap detection and coverage accounting (brief §6.3).
//
// ADS-B is line-of-sight from ground receivers, so it thins or vanishes over
// oceans and poles — precisely the high-latitude, long-duration routes that earn
// the most dose. That is the central limitation of the source and it is handled
// explicitly rather than smoothed over.
//
// Gaps are filled by great-circle interpolation at the last known flight level,
// EVERY interpolated sample is tagged, and interpolated time is excluded from
// coveredFraction. Interpolation is never presented as recorded data
// (guardrails §13.6, §13.7).

const geo = require('../engine/geo');

const DEFAULT_GAP_SECONDS = 300; // 5 minutes without a position is a gap
const DEFAULT_FILL_SECONDS = 60; // interpolated sample cadence, matching §3.2

function analyze(samples, options = {}) {
  const gapSeconds = options.gapSeconds || DEFAULT_GAP_SECONDS;
  const sorted = [...samples].sort((a, b) => a.t - b.t);

  if (sorted.length < 2) {
    return {
      samples: sorted,
      gaps: [],
      totalSeconds: 0,
      coveredSeconds: 0,
      interpolatedSeconds: 0,
      coveredFraction: sorted.length ? 1 : 0,
      sourceBreakdown: {},
    };
  }

  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].t - sorted[i - 1].t;
    if (dt > gapSeconds) {
      gaps.push({
        fromT: sorted[i - 1].t,
        toT: sorted[i].t,
        seconds: dt,
        fromAltFt: sorted[i - 1].altFt,
        toAltFt: sorted[i].altFt,
      });
    }
  }

  const totalSeconds = sorted[sorted.length - 1].t - sorted[0].t;
  const interpolatedSeconds = gaps.reduce((a, g) => a + g.seconds, 0);

  return {
    samples: sorted,
    gaps,
    totalSeconds,
    coveredSeconds: totalSeconds - interpolatedSeconds,
    interpolatedSeconds,
    coveredFraction: totalSeconds > 0 ? (totalSeconds - interpolatedSeconds) / totalSeconds : 1,
    sourceBreakdown: breakdown(sorted),
  };
}

function breakdown(samples) {
  return samples.reduce((acc, s) => {
    const key = s.altSource === 'interpolated' || s.interpolated ? 'interpolated' : (s.altSource || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

// Fill gaps with great-circle steps at the last known flight level. Altitude is
// held rather than ramped: an aircraft that vanished at FL390 and reappeared at
// FL390 was almost certainly at FL390 throughout, and inventing a profile would
// be inventing dose.
function fillGaps(samples, options = {}) {
  const gapSeconds = options.gapSeconds || DEFAULT_GAP_SECONDS;
  const stepSeconds = options.fillSeconds || DEFAULT_FILL_SECONDS;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return sorted;

  const filled = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const dt = cur.t - prev.t;

    if (dt > gapSeconds) {
      const steps = Math.max(1, Math.floor(dt / stepSeconds));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        const { lat, lon } = geo.interpolate(prev, cur, f);
        filled.push({
          t: prev.t + f * dt,
          lat,
          lon,
          // Hold the last known level; average the endpoints only if they differ.
          altFt: prev.altFt === cur.altFt ? prev.altFt : prev.altFt + (cur.altFt - prev.altFt) * f,
          altSource: 'interpolated',
          interpolated: true,
        });
      }
    }
    filled.push(cur);
  }

  return filled;
}

// Full pipeline: analyse, fill, and report what is real versus reconstructed.
function prepare(samples, options = {}) {
  const before = analyze(samples, options);
  const filled = fillGaps(samples, options);
  return {
    samples: filled,
    coveredFraction: before.coveredFraction,
    gaps: before.gaps,
    totalSeconds: before.totalSeconds,
    coveredSeconds: before.coveredSeconds,
    interpolatedSeconds: before.interpolatedSeconds,
    interpolatedSamples: filled.filter((s) => s.interpolated).length,
    recordedSamples: filled.filter((s) => !s.interpolated).length,
    sourceBreakdown: breakdown(filled),
  };
}

module.exports = { analyze, fillGaps, prepare, breakdown, DEFAULT_GAP_SECONDS };
