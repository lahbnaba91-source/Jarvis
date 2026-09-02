'use strict';

// The cabin-baro trap (brief §6.4). WEARABLES ONLY.
//
// Inside a pressurized cabin a worn barometric altimeter measures CABIN pressure
// altitude — typically 6,000-8,000 ft — not the aircraft's altitude. At FL390
// that is wrong by ~31,000 ft and understates dose by well over an order of
// magnitude. It applies to every consumer wearable, Garmin included.
//
// It does NOT apply to ADS-B: that barometric altitude is the aircraft's own,
// measured outside the pressure vessel, and is the preferred input (§13.6).
// Never confuse the two rules.
//
// In an unpressurized GA aircraft the worn baro IS valid, so the cabin state is
// detected per segment rather than assumed.

// A pressurized cabin holds roughly 6,000-8,000 ft while the aircraft climbs
// away from it, so divergence grows large. 3,000 ft is comfortably above normal
// sensor disagreement and well below a pressurized cruise difference.
const PRESSURIZATION_THRESHOLD_FT = 3000;

// Typical cabin altitudes; used only to describe what was detected.
const CABIN_ALTITUDE_RANGE_FT = [5000, 9000];

function classifySample(sample) {
  const { baroAltFt, gnssAltFt } = sample;

  if (gnssAltFt == null) {
    return {
      state: 'unknown',
      usableAltFt: null,
      altSource: null,
      reason: 'No GNSS altitude: a worn barometric reading cannot be verified, so it is not trusted.',
    };
  }

  if (baroAltFt == null) {
    return {
      state: 'gnss-only',
      usableAltFt: gnssAltFt,
      altSource: 'wearable-gnss',
      reason: 'No barometric channel; GNSS altitude used directly.',
    };
  }

  const divergenceFt = gnssAltFt - baroAltFt;

  if (divergenceFt > PRESSURIZATION_THRESHOLD_FT) {
    return {
      state: 'pressurized',
      usableAltFt: gnssAltFt,
      altSource: 'wearable-gnss',
      divergenceFt,
      // Hard discard, per §6.4 rule 3 — not a blend, not a correction.
      discardedBaroAltFt: baroAltFt,
      reason:
        `Baro reads ${Math.round(baroAltFt)} ft against ${Math.round(gnssAltFt)} ft GNSS ` +
        `(${Math.round(divergenceFt)} ft). That is cabin altitude, not aircraft altitude. ` +
        'Barometric value discarded for this sample.',
    };
  }

  return {
    state: 'unpressurized',
    usableAltFt: gnssAltFt,
    altSource: 'wearable-gnss',
    divergenceFt,
    reason:
      'Baro and GNSS agree, so the cabin is unpressurized (GA). The barometric reading is ' +
      'valid here, but GNSS is still used for consistency with the pressurized case.',
  };
}

// Segment-level verdict over a whole track.
function detect(samples, options = {}) {
  const threshold = options.thresholdFt || PRESSURIZATION_THRESHOLD_FT;
  const classified = samples.map((s) => ({ ...s, ...classifySample(s) }));

  const counts = classified.reduce((acc, c) => {
    acc[c.state] = (acc[c.state] || 0) + 1;
    return acc;
  }, {});

  const withBoth = classified.filter((c) => c.divergenceFt != null);
  const meanDivergence = withBoth.length
    ? withBoth.reduce((a, c) => a + c.divergenceFt, 0) / withBoth.length
    : null;

  const pressurizedShare = classified.length ? (counts.pressurized || 0) / classified.length : 0;

  return {
    samples: classified,
    counts,
    thresholdFt: threshold,
    meanDivergenceFt: meanDivergence,
    pressurizedShare,
    // A flight that is mostly pressurized is an airliner; mostly agreeing is GA.
    verdict:
      pressurizedShare > 0.5 ? 'pressurized-cabin'
        : counts.unpressurized ? 'unpressurized-aircraft'
          : counts['gnss-only'] ? 'gnss-only-no-baro-channel'
            : 'indeterminate',
    baroDiscarded: (counts.pressurized || 0) > 0,
    note:
      pressurizedShare > 0.5
        ? 'Pressurized cabin detected. Worn barometric altitude reads cabin pressure ' +
          `(typically ${CABIN_ALTITUDE_RANGE_FT[0]}-${CABIN_ALTITUDE_RANGE_FT[1]} ft) and was discarded. ` +
          'GNSS altitude used throughout.'
        : 'No pressurization detected; barometric and GNSS altitudes agree. Treated as an ' +
          'unpressurized aircraft, where a worn barometer is physically valid.',
  };
}

module.exports = { detect, classifySample, PRESSURIZATION_THRESHOLD_FT, CABIN_ALTITUDE_RANGE_FT };
