'use strict';

// Synthesized 4D flight profile: great-circle track with a climb / cruise / descent
// vertical profile, sampled at fixed cadence. This is the "synthesized" telemetry
// source of §6.1 — the lowest-confidence input, used when no ADS-B or wearable
// track exists. Real tracks replace it wholesale in P7/P8.

const fs = require('fs');
const path = require('path');
const geo = require('./geo');

const AIRPORTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'airports.json'), 'utf8')
).airports;

const DEFAULTS = {
  cruiseSpeedKmh: 907, // A380 / B777 cruise, per the CARI-7A reference study
  climbRateFtPerMin: 2300,
  rampSpeedFactor: 0.54, // ground speed during climb/descent, per the same study
  sampleIntervalSec: 60, // §3.2 sample cadence
};

function lookupAirport(code) {
  const key = String(code).toUpperCase();
  const hit = AIRPORTS.find((a) => a.icao === key || a.iata === key);
  if (!hit) throw new Error(`Unknown airport code "${code}" (not in data/airports.json)`);
  return hit;
}

function synthesize(spec) {
  const origin = typeof spec.origin === 'string' ? lookupAirport(spec.origin) : spec.origin;
  const destination =
    typeof spec.destination === 'string' ? lookupAirport(spec.destination) : spec.destination;

  const opts = { ...DEFAULTS, ...spec };
  const cruiseAltitudeFt = spec.cruiseAltitudeFt;
  const { year, month, day } = spec.date;

  const totalDistanceKm = geo.distanceKm(origin, destination);
  const rampSpeedKmh = opts.cruiseSpeedKmh * opts.rampSpeedFactor;

  let climbHours = (cruiseAltitudeFt - origin.elevationFt) / opts.climbRateFtPerMin / 60;
  let descentHours = (cruiseAltitudeFt - destination.elevationFt) / opts.climbRateFtPerMin / 60;
  let climbDistanceKm = rampSpeedKmh * climbHours;
  let descentDistanceKm = rampSpeedKmh * descentHours;

  // Sector too short to reach cruise: shrink both ramps proportionally so the
  // profile stays physical (peak altitude below the requested cruise level).
  let peakAltitudeFt = cruiseAltitudeFt;
  if (climbDistanceKm + descentDistanceKm > totalDistanceKm) {
    const k = totalDistanceKm / (climbDistanceKm + descentDistanceKm);
    climbHours *= k;
    descentHours *= k;
    climbDistanceKm *= k;
    descentDistanceKm *= k;
    peakAltitudeFt = origin.elevationFt + opts.climbRateFtPerMin * 60 * climbHours;
  }

  const cruiseDistanceKm = Math.max(0, totalDistanceKm - climbDistanceKm - descentDistanceKm);
  const cruiseHours = cruiseDistanceKm / opts.cruiseSpeedKmh;
  const durationHours = climbHours + cruiseHours + descentHours;

  const stepHours = opts.sampleIntervalSec / 3600;
  const times = [];
  for (let t = 0; t < durationHours; t += stepHours) times.push(t);
  times.push(durationHours);

  const points = times.map((t) => {
    let altFt;
    let distanceKm;
    let phase;

    if (t <= climbHours && climbHours > 0) {
      phase = 'climb';
      altFt = origin.elevationFt + (peakAltitudeFt - origin.elevationFt) * (t / climbHours);
      distanceKm = rampSpeedKmh * t;
    } else if (t <= climbHours + cruiseHours) {
      phase = 'cruise';
      altFt = peakAltitudeFt;
      distanceKm = climbDistanceKm + opts.cruiseSpeedKmh * (t - climbHours);
    } else {
      phase = 'descent';
      const td = t - climbHours - cruiseHours;
      const frac = descentHours > 0 ? td / descentHours : 1;
      altFt = peakAltitudeFt - (peakAltitudeFt - destination.elevationFt) * Math.min(1, frac);
      distanceKm = climbDistanceKm + cruiseDistanceKm + rampSpeedKmh * td;
    }

    const f = totalDistanceKm > 0 ? Math.min(1, Math.max(0, distanceKm / totalDistanceKm)) : 0;
    const { lat, lon } = geo.interpolate(origin, destination, f);

    return { tHours: t, lat, lon, altFt, phase, year, month, day };
  });

  return {
    origin,
    destination,
    points,
    durationHours,
    distanceKm: totalDistanceKm,
    peakAltitudeFt,
    telemetrySource: 'synthesized',
    coveredFraction: 1.0, // fully synthesized, not partially recorded
    profile: {
      climbHours,
      cruiseHours,
      descentHours,
      cruiseSpeedKmh: opts.cruiseSpeedKmh,
      climbRateFtPerMin: opts.climbRateFtPerMin,
      sampleIntervalSec: opts.sampleIntervalSec,
      dateHeldConstant: true, // §3.2 simplification: one UTC date per flight
    },
  };
}

module.exports = { synthesize, lookupAirport, DEFAULTS };
