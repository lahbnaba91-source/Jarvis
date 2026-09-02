'use strict';

// NOAA SWPC endpoints. Open JSON over HTTPS, no auth, no key — a static file
// service, so we poll and cache rather than query (brief §4.1).
//
// Verified live 2026-09-01. Note: the brief's planetary-k-index URL
// (products/summary/planetary-k-index.json) now 404s; the working path is
// products/noaa-planetary-k-index.json.

const BASE = 'https://services.swpc.noaa.gov';

const SOURCES = {
  scales: {
    url: `${BASE}/products/noaa-scales.json`,
    // Current conditions under key "0", then 3 forecast days under "1".."3".
    staleAfterMinutes: 90,
  },
  protons: {
    url: `${BASE}/json/goes/primary/integral-protons-1-day.json`,
    // All integral channels; we use >=10 MeV (S-scale) and >=100 MeV (aviation).
    staleAfterMinutes: 30,
  },
  protons7Day: {
    url: `${BASE}/json/goes/primary/integral-protons-7-day.json`,
    staleAfterMinutes: 360,
  },
  xrays: {
    url: `${BASE}/json/goes/primary/xrays-1-day.json`,
    staleAfterMinutes: 30,
  },
  alerts: {
    url: `${BASE}/products/alerts.json`,
    staleAfterMinutes: 120,
  },
  kindex: {
    url: `${BASE}/products/noaa-planetary-k-index.json`,
    staleAfterMinutes: 240,
  },
};

// SWPC S-scale, driven by the >=10 MeV integral proton flux in pfu (brief §4.2).
const S_SCALE_PFU = [
  { scale: 'S5', minPfu: 100000 },
  { scale: 'S4', minPfu: 10000 },
  { scale: 'S3', minPfu: 1000 },
  { scale: 'S2', minPfu: 100 },
  { scale: 'S1', minPfu: 10 },
];

// SWPC's proton event threshold, and the aviation-relevant high-energy threshold.
const PROTON_EVENT_THRESHOLD_10MEV_PFU = 10;
const AVIATION_THRESHOLD_100MEV_PFU = 1;

module.exports = {
  BASE,
  SOURCES,
  S_SCALE_PFU,
  PROTON_EVENT_THRESHOLD_10MEV_PFU,
  AVIATION_THRESHOLD_100MEV_PFU,
};
