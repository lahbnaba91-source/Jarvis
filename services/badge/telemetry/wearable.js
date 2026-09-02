'use strict';

// Wearable track normalizers (brief §7 wearable.js).
//
// Garmin exports FIT (native) and GPX; Apple Health exports GPX. Both are
// normalized to the same sample shape the dose engine consumes, keeping the
// barometric and GNSS altitude channels SEPARATE so telemetry/pressurization.js
// can apply the cabin-baro rule (§6.4). They are never merged here.

const pressurization = require('./pressurization');

const M_TO_FT = 3.28084;
// FIT timestamps count seconds from 1989-12-31T00:00:00Z.
const FIT_EPOCH_OFFSET = Date.UTC(1989, 11, 31) / 1000;
const SEMICIRCLE_TO_DEG = 180 / Math.pow(2, 31);

/* ------------------------------------------------------------------ GPX */

// Deliberately a narrow reader rather than a general XML parser: trackpoints are
// a simple, stable shape and pulling in a dependency would break the zero-install
// property the whole service relies on.
function parseGpx(xml) {
  const samples = [];
  const trkptRe = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;

  let m;
  while ((m = trkptRe.exec(xml)) !== null) {
    const [, lat, lon, body] = m;
    const ele = /<ele>([-\d.]+)<\/ele>/.exec(body);
    const time = /<time>([^<]+)<\/time>/.exec(body);
    if (!time) continue;

    samples.push({
      t: Math.floor(Date.parse(time[1]) / 1000),
      lat: Number(lat),
      lon: Number(lon),
      // GPX carries one elevation channel and does not say how it was derived.
      // Treated as GNSS, which is the safe reading: if it were in fact a fused
      // barometric value from inside a cabin it would be catastrophically low,
      // and the pressurization check cannot see that without a second channel.
      gnssAltFt: ele ? Number(ele[1]) * M_TO_FT : null,
      baroAltFt: null,
      channelNote: 'GPX carries a single unlabelled elevation; treated as GNSS.',
    });
  }
  return samples.sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ FIT */

const BASE_TYPE_SIZES = {
  0: 1, 1: 1, 2: 1, 131: 2, 132: 2, 133: 4, 134: 4, 7: 1,
  136: 4, 137: 8, 10: 1, 139: 2, 140: 4, 141: 4, 142: 8, 143: 8, 144: 8,
};

function readValue(buf, offset, baseType, size) {
  const t = baseType & 0x1f;
  try {
    switch (t) {
      case 1: return buf.readInt8(offset);
      case 2: return buf.readUInt8(offset);
      case 3: return buf.readInt16LE(offset);
      case 4: return buf.readUInt16LE(offset);
      case 5: return buf.readInt32LE(offset);
      case 6: return buf.readUInt32LE(offset);
      case 12: return buf.readUInt32LE(offset);
      default: return size === 4 ? buf.readUInt32LE(offset) : size === 2 ? buf.readUInt16LE(offset) : buf.readUInt8(offset);
    }
  } catch (_) {
    return null;
  }
}

// Minimal FIT decoder: enough of the format to pull record messages (global
// message 20), which is all BADGE needs. Definition messages describe the
// layout of the data messages that follow them.
function parseFit(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 14) throw new Error('FIT file too short');

  const headerSize = buf.readUInt8(0);
  if (buf.toString('ascii', 8, 12) !== '.FIT') throw new Error('Not a FIT file (missing .FIT signature)');
  const dataSize = buf.readUInt32LE(4);

  let pos = headerSize;
  const end = Math.min(buf.length, headerSize + dataSize);
  const definitions = {};
  const samples = [];

  while (pos < end) {
    const header = buf.readUInt8(pos);
    pos += 1;

    const isDefinition = (header & 0x40) !== 0 && (header & 0x80) === 0;
    const localType = header & 0x0f;

    if (isDefinition) {
      pos += 1; // reserved
      const arch = buf.readUInt8(pos); pos += 1;
      if (arch !== 0) throw new Error('Big-endian FIT files are not supported');
      const globalMsg = buf.readUInt16LE(pos); pos += 2;
      const numFields = buf.readUInt8(pos); pos += 1;

      const fields = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({
          num: buf.readUInt8(pos),
          size: buf.readUInt8(pos + 1),
          baseType: buf.readUInt8(pos + 2),
        });
        pos += 3;
      }

      let devFields = 0;
      if ((header & 0x20) !== 0) { // developer fields present
        const numDev = buf.readUInt8(pos); pos += 1;
        for (let i = 0; i < numDev; i++) { devFields += buf.readUInt8(pos + 1); pos += 3; }
      }

      definitions[localType] = { globalMsg, fields, devFields };
      continue;
    }

    const def = definitions[localType];
    if (!def) break; // data before its definition: stop rather than misread

    const values = {};
    for (const f of def.fields) {
      values[f.num] = readValue(buf, pos, f.baseType, f.size);
      pos += f.size;
    }
    pos += def.devFields;

    if (def.globalMsg !== 20) continue; // record messages only

    const ts = values[253];
    const lat = values[0];
    const lon = values[1];
    if (ts == null) continue;

    // altitude and enhanced_altitude are both scale 5, offset 500, in metres.
    const alt = values[2] != null && values[2] !== 0xffff ? values[2] / 5 - 500 : null;
    const enhanced = values[78] != null && values[78] !== 0xffffffff ? values[78] / 5 - 500 : null;

    samples.push({
      t: ts + FIT_EPOCH_OFFSET,
      lat: lat != null && lat !== 0x7fffffff ? lat * SEMICIRCLE_TO_DEG : null,
      lon: lon != null && lon !== 0x7fffffff ? lon * SEMICIRCLE_TO_DEG : null,
      // Garmin's `altitude` is barometric-fused; `enhanced_altitude` is the
      // higher-precision channel. Kept apart so §6.4 can be applied.
      baroAltFt: alt != null ? alt * M_TO_FT : null,
      gnssAltFt: enhanced != null ? enhanced * M_TO_FT : null,
      channelNote: 'FIT altitude treated as barometric-fused; enhanced_altitude as GNSS.',
    });
  }

  return samples.filter((s) => s.lat != null && s.lon != null).sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------ normalize */

// Produces the track shape the dose engine consumes, after applying the
// cabin-baro rule. Never returns a worn barometric altitude for a pressurized
// segment (§6.4, §13.6).
function normalize(samples, options = {}) {
  const source = options.source || 'wearable';
  const check = pressurization.detect(samples, options);

  const track = check.samples
    .filter((s) => s.lat != null && s.lon != null && s.usableAltFt != null)
    .map((s) => ({
      t: s.t,
      lat: s.lat,
      lon: s.lon,
      altFt: s.usableAltFt,
      altSource: s.altSource,
      cabinState: s.state,
    }));

  return {
    track,
    telemetrySource: source,
    pressurization: {
      verdict: check.verdict,
      baroDiscarded: check.baroDiscarded,
      meanDivergenceFt: check.meanDivergenceFt,
      pressurizedShare: check.pressurizedShare,
      thresholdFt: check.thresholdFt,
      note: check.note,
    },
    dropped: samples.length - track.length,
  };
}

module.exports = { parseGpx, parseFit, normalize, M_TO_FT, FIT_EPOCH_OFFSET, SEMICIRCLE_TO_DEG };
