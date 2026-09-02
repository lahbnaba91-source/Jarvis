#!/usr/bin/env node
'use strict';

// P8 tests: wearable normalizers, the cabin-baro trap, and multi-source fusion.

const wearable = require('../../telemetry/wearable');
const pressurization = require('../../telemetry/pressurization');
const merge = require('../../telemetry/merge');
const { computeTrackDose } = require('../../engine/track-dose');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// Build a minimal but genuine FIT file so the decoder is tested against the real
// binary layout rather than a mock.
function buildFit(records) {
  const defBody = Buffer.alloc(6 + 4 * 3);
  defBody.writeUInt8(0, 0);              // reserved
  defBody.writeUInt8(0, 1);              // little endian
  defBody.writeUInt16LE(20, 2);          // global message: record
  defBody.writeUInt8(4, 4);              // 4 fields
  let o = 5;
  const fields = [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84]];
  for (const [num, size, base] of fields) {
    defBody.writeUInt8(num, o); defBody.writeUInt8(size, o + 1); defBody.writeUInt8(base, o + 2);
    o += 3;
  }
  const defRec = Buffer.concat([Buffer.from([0x40]), defBody.subarray(0, o)]);

  const dataRecs = records.map((r) => {
    const b = Buffer.alloc(1 + 4 + 4 + 4 + 2);
    b.writeUInt8(0x00, 0);
    b.writeUInt32LE(r.fitTime, 1);
    b.writeInt32LE(Math.round(r.lat / wearable.SEMICIRCLE_TO_DEG), 5);
    b.writeInt32LE(Math.round(r.lon / wearable.SEMICIRCLE_TO_DEG), 9);
    b.writeUInt16LE(Math.round((r.altM + 500) * 5), 13);
    return b;
  });

  const body = Buffer.concat([defRec, ...dataRecs]);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16LE(2140, 2);
  header.writeUInt32LE(body.length, 4);
  header.write('.FIT', 8, 'ascii');
  return Buffer.concat([header, body]);
}

(async () => {
  console.log('\nBADGE wearable tests (P8)\n');

  // --- FIT decode -----------------------------------------------------------
  const base = Math.floor((Date.UTC(2023, 2, 15) - Date.UTC(1989, 11, 31)) / 1000);
  const fitBuf = buildFit([
    { fitTime: base, lat: 51.5, lon: -0.5, altM: 2073 },
    { fitTime: base + 60, lat: 51.6, lon: -0.7, altM: 2073 },
    { fitTime: base + 120, lat: 51.7, lon: -0.9, altM: 2073 },
  ]);
  const fit = wearable.parseFit(fitBuf);
  check('FIT decodes every record message', fit.length === 3, String(fit.length));
  check('FIT timestamps convert from the 1989 epoch',
    new Date(fit[0].t * 1000).toISOString().startsWith('2023-03-15'),
    new Date(fit[0].t * 1000).toISOString());
  check('FIT semicircles convert to degrees',
    Math.abs(fit[0].lat - 51.5) < 1e-5 && Math.abs(fit[0].lon - (-0.5)) < 1e-5,
    `${fit[0].lat}, ${fit[0].lon}`);
  check('FIT altitude decodes with its scale and offset',
    Math.round(fit[0].baroAltFt) === Math.round(2073 * 3.28084), String(Math.round(fit[0].baroAltFt)));
  // §6.4 depends on the channels staying apart.
  check('FIT keeps barometric and GNSS altitude in separate fields',
    'baroAltFt' in fit[0] && 'gnssAltFt' in fit[0]);
  let rejected = false;
  try { wearable.parseFit(Buffer.from('not a fit file at all!!')); } catch { rejected = true; }
  check('a non-FIT buffer is rejected', rejected);

  // --- GPX ------------------------------------------------------------------
  const gpx = '<gpx><trk><trkseg>' +
    [0, 1, 2].map((i) => `<trkpt lat="${51 + i * 0.1}" lon="${-0.5 - i * 0.1}"><ele>${11887}</ele><time>2023-03-15T0${i}:00:00Z</time></trkpt>`).join('') +
    '</trkseg></trk></gpx>';
  const gpxPts = wearable.parseGpx(gpx);
  check('GPX decodes trackpoints', gpxPts.length === 3);
  check('GPX elevation converts to feet', Math.round(gpxPts[0].gnssAltFt) === 38999);
  // A single unlabelled elevation must not be assumed barometric.
  check('GPX single elevation is treated as GNSS, not barometric',
    gpxPts[0].baroAltFt === null && gpxPts[0].gnssAltFt !== null);
  check('GPX without a time element is skipped',
    wearable.parseGpx('<trkpt lat="1" lon="2"><ele>100</ele></trkpt>').length === 0);

  // --- the cabin-baro trap (§6.4) -------------------------------------------
  const airliner = Array.from({ length: 30 }, (_, i) => ({
    t: i * 60, lat: 51 + i * 0.05, lon: -1 - i * 0.2, baroAltFt: 6800 + i * 3, gnssAltFt: 39000,
  }));
  const pressurized = pressurization.detect(airliner);
  check('a pressurized cabin is detected', pressurized.verdict === 'pressurized-cabin');
  check('worn barometric altitude is discarded when pressurized', pressurized.baroDiscarded === true);
  check('GNSS altitude is used instead',
    pressurized.samples[0].usableAltFt === 39000 && pressurized.samples[0].altSource === 'wearable-gnss');
  check('the discarded barometric value is retained for the record',
    pressurized.samples[0].discardedBaroAltFt === 6800);
  check('the detector explains itself', /cabin altitude/i.test(pressurized.samples[0].reason));

  const ga = Array.from({ length: 30 }, (_, i) => ({
    t: i * 60, lat: 51, lon: -1, baroAltFt: 8500 + i * 2, gnssAltFt: 8560 + i * 2,
  }));
  const unpressurized = pressurization.detect(ga);
  // §6.4 rule 4: a worn barometer IS valid in an unpressurized aircraft.
  check('an unpressurized GA aircraft is not misclassified',
    unpressurized.verdict === 'unpressurized-aircraft' && unpressurized.baroDiscarded === false);

  const noGnss = pressurization.detect([{ t: 0, baroAltFt: 7000, gnssAltFt: null }]);
  check('an unverifiable barometric reading is not trusted',
    noGnss.samples[0].state === 'unknown' && noGnss.samples[0].usableAltFt === null);

  // The consequence, in dose, of getting this wrong.
  const t0 = Math.floor(Date.UTC(2023, 2, 15) / 1000);
  const mk = (alt) => Array.from({ length: 60 }, (_, i) => ({
    t: t0 + i * 60, lat: 55 + i * 0.1, lon: -30 - i * 0.2, altFt: alt, altSource: 'baro',
  }));
  const truth = await computeTrackDose(mk(39000), { callsign: 'TRUTH' });
  const trap = await computeTrackDose(mk(6800), { callsign: 'TRAP' });
  const ratio = truth.dose.gcrMSv / trap.dose.gcrMSv;
  check('trusting cabin altitude would understate dose by more than an order of magnitude',
    ratio > 10, `${ratio.toFixed(1)}x`);

  // --- normalize ------------------------------------------------------------
  const norm = wearable.normalize(airliner, { source: 'garmin-fit' });
  check('normalize returns an engine-ready track', norm.track.length === 30);
  check('normalize never emits a worn barometric altitude when pressurized',
    norm.track.every((s) => s.altSource === 'wearable-gnss'));
  check('normalize reports the pressurization verdict',
    norm.pressurization.verdict === 'pressurized-cabin' && norm.pressurization.baroDiscarded);

  // --- fusion (§6.3) --------------------------------------------------------
  const adsbPts = [], watchPts = [];
  for (let i = 0; i < 60; i++) adsbPts.push({ t: i * 60, lat: 51 + i * 0.05, lon: -1 - i * 0.2, altFt: 39000, altSource: 'baro' });
  for (let i = 0; i < 180; i++) watchPts.push({ t: i * 60, lat: 51 + i * 0.05, lon: -1 - i * 0.2, altFt: 39000 });
  for (let i = 0; i < 60; i++) adsbPts.push({ t: (180 + i) * 60, lat: 60 + i * 0.02, lon: -40 - i * 0.2, altFt: 39000, altSource: 'baro' });

  const fused = merge.fuse([
    { source: 'garmin-fit', samples: watchPts },
    { source: 'adsb-baro', samples: adsbPts },
  ]);
  check('ADS-B is preferred regardless of channel order',
    fused.primarySource === 'adsb-baro');
  check('the wearable fills only where ADS-B is absent',
    fused.sourceBreakdown['adsb-baro'] === 120 && fused.sourceBreakdown['garmin-fit'] > 0,
    JSON.stringify(fused.sourceBreakdown));
  check('a fused track is labelled merged', fused.telemetrySource === 'merged');
  check('every sample keeps the channel it came from',
    fused.track.every((s) => typeof s.channel === 'string'));
  check('fusion is ordered in time',
    fused.track.every((s, i) => i === 0 || s.t >= fused.track[i - 1].t));

  const adsbOnly = merge.fuse([{ source: 'adsb-baro', samples: adsbPts }]);
  check('a single channel is not mislabelled as merged',
    adsbOnly.telemetrySource === 'adsb-baro' && adsbOnly.confidence === 'high');

  const weak = merge.fuse([
    { source: 'adsb-baro', samples: adsbPts.slice(0, 10) },
    { source: 'logbook-import', samples: watchPts.slice(120) },
  ]);
  // A track is only as trustworthy as the worst data in it.
  check('the weakest contributing channel caps the confidence',
    weak.confidence === 'low', weak.confidence);

  check('fusing nothing returns an empty track, not a crash',
    merge.fuse([]).track.length === 0);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
