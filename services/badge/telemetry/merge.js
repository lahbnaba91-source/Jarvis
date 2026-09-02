'use strict';

// Multi-source per-segment fusion (brief §7 merge.js, §6.3).
//
// ADS-B and wearables fail under OPPOSITE conditions: ADS-B thins over oceans and
// poles where there are no ground receivers, a watch dies when its battery does.
// That makes them genuinely complementary rather than redundant, and it is the
// argument for carrying both.
//
// Preference order follows §6.1: ADS-B first, because its barometric altitude is
// the aircraft's own and is a direct measure of atmospheric depth. A wearable
// fills only where ADS-B is absent, and every sample keeps the source it came
// from so nothing downstream can mistake fill for record.

const geo = require('../engine/geo');

// Sources ranked best first (§6.1 / §6.7).
const PREFERENCE = ['adsb-baro', 'adsb-geom', 'adsc', 'garmin-fit', 'apple-healthkit', 'wearable-gnss', 'logbook-import', 'synthesized', 'interpolated'];

const CONFIDENCE = {
  'adsb-baro': 'high', 'adsb-geom': 'high', adsc: 'medium',
  'garmin-fit': 'high', 'apple-healthkit': 'medium', 'wearable-gnss': 'medium',
  'logbook-import': 'low', synthesized: 'low', interpolated: 'low',
};

function rank(source) {
  const i = PREFERENCE.indexOf(source);
  return i === -1 ? PREFERENCE.length : i;
}

// channels: [{ source, samples: [{t, lat, lon, altFt, altSource}] }]
// A wearable sample is only used where no preferred source covers that moment.
function fuse(channels, options = {}) {
  const toleranceSeconds = options.toleranceSeconds || 120;

  const ordered = [...channels]
    .filter((c) => c.samples && c.samples.length)
    .sort((a, b) => rank(a.source) - rank(b.source));

  if (!ordered.length) return { track: [], sourceBreakdown: {}, channelsUsed: [], gapsFilledBy: {} };

  const merged = [];
  const covered = []; // time windows already claimed by a better source

  const isCovered = (t) => covered.some((w) => t >= w.from - toleranceSeconds && t <= w.to + toleranceSeconds);

  for (const channel of ordered) {
    const taken = channel.samples.filter((s) => !isCovered(s.t));
    if (!taken.length) continue;

    for (const s of taken) {
      merged.push({ ...s, altSource: s.altSource || channel.source, channel: channel.source });
    }

    // Claim contiguous spans this channel now covers.
    const ts = taken.map((s) => s.t).sort((a, b) => a - b);
    let from = ts[0], prev = ts[0];
    for (const t of ts.slice(1)) {
      if (t - prev > toleranceSeconds * 4) { covered.push({ from, to: prev }); from = t; }
      prev = t;
    }
    covered.push({ from, to: prev });
  }

  merged.sort((a, b) => a.t - b.t);

  const sourceBreakdown = merged.reduce((acc, s) => {
    acc[s.channel] = (acc[s.channel] || 0) + 1;
    return acc;
  }, {});

  // The weakest channel that contributed sets the ceiling on confidence: a track
  // is only as trustworthy as the worst data in it.
  const contributing = Object.keys(sourceBreakdown);
  const worst = contributing.sort((a, b) => rank(b) - rank(a))[0];

  return {
    track: merged,
    sourceBreakdown,
    channelsUsed: contributing,
    primarySource: ordered[0].source,
    confidence: CONFIDENCE[worst] || 'low',
    telemetrySource: contributing.length > 1 ? 'merged' : contributing[0],
    distanceKm: merged.length > 1
      ? merged.slice(1).reduce((a, s, i) => a + geo.distanceKm(merged[i], s), 0)
      : 0,
  };
}

module.exports = { fuse, rank, PREFERENCE, CONFIDENCE };
