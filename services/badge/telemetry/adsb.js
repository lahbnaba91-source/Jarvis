'use strict';

// OpenSky Network ADS-B ingest (brief §6.6).
//
// Auth: OpenSky moved to OAuth2 client credentials (basic auth was removed in
// March 2026). Set OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET for the higher rate
// limit; without them the anonymous tier still works, just throttled harder.
//
// Altitude handling is the point of this module. ADS-B broadcasts barometric
// altitude — pressure altitude from the aircraft's air data computer, measured
// OUTSIDE the pressure vessel. That is a direct measure of the atmospheric depth
// PARMA is parameterised on, so it is the PREFERRED input, not a compromise
// (§6.2). Geometric (GNSS) altitude is recorded only as a quality signal; the two
// are never averaged (guardrail §13.6).

const BASE = 'https://opensky-network.org/api';
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const M_TO_FT = 3.28084;

let cachedToken = null;

async function accessToken() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.value;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!res.ok) throw new Error(`OpenSky auth failed: ${res.status}`);
  const body = await res.json();
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 1800) * 1000,
  };
  return cachedToken.value;
}

async function apiGet(path, { timeoutMs = 30000 } = {}) {
  const token = await accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.status === 429) {
      const err = new Error('OpenSky rate limit reached (anonymous tier is throttled hard)');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!res.ok) throw new Error(`OpenSky ${path} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// State vector layout per the OpenSky REST API (derived from RTCA DO-260B fields).
const STATE_FIELDS = [
  'icao24', 'callsign', 'originCountry', 'timePosition', 'lastContact',
  'longitude', 'latitude', 'baroAltitudeM', 'onGround', 'velocityMs',
  'trueTrack', 'verticalRateMs', 'sensors', 'geoAltitudeM', 'squawk',
  'spi', 'positionSource',
];

function decodeStateVector(arr) {
  const out = {};
  STATE_FIELDS.forEach((name, i) => { out[name] = arr[i]; });
  if (typeof out.callsign === 'string') out.callsign = out.callsign.trim();

  out.baroAltitudeFt = out.baroAltitudeM == null ? null : out.baroAltitudeM * M_TO_FT;
  out.geoAltitudeFt = out.geoAltitudeM == null ? null : out.geoAltitudeM * M_TO_FT;

  // Recorded as a data-quality note, never used to "correct" the baro value.
  out.baroGeomDivergenceFt =
    out.baroAltitudeFt != null && out.geoAltitudeFt != null
      ? out.geoAltitudeFt - out.baroAltitudeFt
      : null;

  return out;
}

async function statesInBox({ lamin, lomin, lamax, lomax } = {}) {
  const q = [lamin, lomin, lamax, lomax].every((v) => typeof v === 'number')
    ? `?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`
    : '';
  const body = await apiGet(`/states/all${q}`);
  return {
    time: body.time,
    states: (body.states || []).map(decodeStateVector),
  };
}

// /tracks/all path rows: [time, lat, lon, baroAltitudeM, trueTrack, onGround].
// Note the track endpoint carries barometric altitude only — no geometric value —
// so tracks cannot be quality-flagged for baro/geom divergence the way live state
// vectors can.
function decodeTrackPath(body) {
  return {
    icao24: body.icao24,
    callsign: typeof body.callsign === 'string' ? body.callsign.trim() : body.callsign,
    startTime: body.startTime,
    endTime: body.endTime,
    samples: (body.path || []).map(([t, lat, lon, baroAltitudeM, trueTrack, onGround]) => ({
      t,
      lat,
      lon,
      altFt: baroAltitudeM == null ? null : baroAltitudeM * M_TO_FT,
      altSource: 'baro',
      trueTrack,
      onGround,
    })),
  };
}

// time=0 means "the most recent track". The free tier only reaches about an hour
// back — career backfill needs OpenSky's Trino research tier (§12, unresolved).
async function track(icao24, time = 0) {
  const body = await apiGet(`/tracks/all?icao24=${encodeURIComponent(icao24)}&time=${time}`);
  if (!body || !body.path) throw new Error(`No track available for ${icao24}`);
  return decodeTrackPath(body);
}

// ADS-B samples -> the shape the dose engine consumes.
function toDoseTrack(samples) {
  return samples
    .filter((s) => s.lat != null && s.lon != null && s.altFt != null && !s.onGround)
    .map((s) => ({
      t: s.t,
      lat: s.lat,
      lon: s.lon,
      altFt: s.altFt,
      altSource: s.altSource || 'baro',
    }));
}

function hasCredentials() {
  return Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
}

module.exports = {
  statesInBox, track, decodeStateVector, decodeTrackPath, toDoseTrack,
  hasCredentials, STATE_FIELDS, M_TO_FT,
};
