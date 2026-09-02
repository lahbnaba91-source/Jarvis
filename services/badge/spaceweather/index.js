'use strict';

// The /api/badge/spaceweather payload (brief §8), assembled from cache only.
// Reading never triggers a network call, so a sleeping Codespace or a dead SWPC
// still returns something — carrying its own staleness, always (guardrail §13.3).

const cache = require('./cache');
const { classify, forecastFromScales } = require('./classify');
const archive = require('./archive');
const alerts = require('./alerts');

function getSpaceWeather() {
  const scales = cache.read('scales');
  const protons = cache.read('protons');
  const kindex = cache.read('kindex');
  const xrays = cache.read('xrays');

  const haveAny = scales.present || protons.present || kindex.present;

  const current = haveAny
    ? classify({ protons: protons.data, kindex: kindex.data, scales: scales.data })
    : null;

  // The payload is stale if any feed driving the headline numbers is stale.
  const drivers = [scales, protons, kindex];
  const stale = drivers.some((d) => d.stale);
  const oldest = drivers
    .filter((d) => d.present)
    .reduce((m, d) => (m === null || d.ageMinutes > m ? d.ageMinutes : m), null);

  const alertState = alerts.readState();

  return {
    available: haveAny,
    current,
    forecast: forecastFromScales(scales.data),
    stale,
    lastUpdated: protons.fetchedAt || scales.fetchedAt || null,
    ageMinutes: oldest,
    staleness: cache.describeAge(oldest),
    sources: {
      scales: sourceStatus(scales),
      protons: sourceStatus(protons),
      kindex: sourceStatus(kindex),
      xrays: sourceStatus(xrays),
    },
    recentAlerts: alertState ? alertState.recentAlerts.slice(-10) : [],
    archive: archive.stats(),
    disclaimer:
      'Space weather data from NOAA SWPC. The aviation risk score is a BADGE-modeled ' +
      'value, not an official NOAA product.',
  };
}

function sourceStatus(entry) {
  return {
    present: entry.present,
    fetchedAt: entry.fetchedAt,
    ageMinutes: entry.ageMinutes === null ? null : Math.round(entry.ageMinutes),
    stale: entry.stale,
    staleness: cache.describeAge(entry.ageMinutes),
    url: entry.url || null,
  };
}

// Retrospective attribution for a flight window. Evidence only — no dose. The SPE
// overlay lands in P4 and stays a separate channel from GCR.
function spaceWeatherForFlight(startUtc, endUtc) {
  return {
    window: { startUtc, endUtc },
    protonEvidence: archive.eventsInWindow(startUtc, endUtc),
    note: 'Evidence only. SPE dose contribution is not modeled until P4 and is never ' +
          'merged into the GCR figure.',
  };
}

module.exports = { getSpaceWeather, spaceWeatherForFlight };
