import * as SunCalc from "suncalc"

// Real astronomical sun-position math (SunCalc v2), not a lookup table —
// accurate anywhere on Earth. This package's altitude/azimuth are already in
// degrees, azimuth already compass-style (0=N, 90=E, 180=S, 270=W clockwise),
// so no unit conversion is needed against its output.
//
// Facade exposure below is a deliberately simple estimate (see caveat on
// FacadeExposure): it ignores terrain/neighboring buildings. The 3D view's
// real-time shadow rendering is the ground truth for that — this is a fast
// first-pass comparison across a building's four wall directions.

export interface DaylightSummary {
  sunrise: Date | null
  sunset: Date | null
  solarNoon: Date | null
  daylightHours: number | null
  /** Sun altitude at solar noon, in degrees — higher means stronger winter sun. */
  solarNoonAltitudeDeg: number | null
}

export function getDaylightSummary(date: Date, lat: number, lon: number): DaylightSummary {
  const times = SunCalc.getTimes(date, lat, lon)
  const sunrise = times.sunrise
  const sunset = times.sunset
  const solarNoon = times.solarNoon ?? null
  const noonPos = solarNoon ? SunCalc.getPosition(solarNoon, lat, lon) : null

  return {
    sunrise,
    sunset,
    solarNoon,
    daylightHours: sunrise && sunset ? (sunset.getTime() - sunrise.getTime()) / 3_600_000 : null,
    solarNoonAltitudeDeg: noonPos ? noonPos.altitude : null,
  }
}

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
]

export function bearingToCompass(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360
  return COMPASS_POINTS[Math.round(normalized / 22.5) % 16]
}

function angularDiff(a: number, b: number): number {
  return (((a - b + 540) % 360) + 360) % 360 - 180
}

export interface FacadeExposure {
  /** Outward-facing compass bearing of this wall/roof plane. */
  normalBearingDeg: number
  compass: string
  /** Approximate hours this side faces the sun on the given date. */
  sunHours: number
}

/**
 * Rough sun-hours estimate for each of a building's four wall directions,
 * derived from its footprint's long axis. Sampled every 15 minutes between
 * sunrise and sunset; counts a side as "facing" the sun whenever the sun's
 * compass bearing is within 90° of that wall's outward normal and the sun is
 * above the horizon.
 *
 * Caveat: pure geometry + astronomy, no terrain or neighboring-building
 * shading. Use the 3D scene's shadow rendering to check real obstructions.
 */
export function estimateFacadeExposures(
  date: Date,
  lat: number,
  lon: number,
  longAxisBearingDeg: number,
): FacadeExposure[] {
  const normals = [
    longAxisBearingDeg + 90,
    longAxisBearingDeg + 270,
    longAxisBearingDeg,
    longAxisBearingDeg + 180,
  ].map((deg) => ((deg % 360) + 360) % 360)

  return normals
    .map((normalBearingDeg) => ({
      normalBearingDeg,
      compass: bearingToCompass(normalBearingDeg),
      sunHours: estimateExposureHours(date, lat, lon, normalBearingDeg),
    }))
    .sort((a, b) => b.sunHours - a.sunHours)
}

function estimateExposureHours(
  date: Date,
  lat: number,
  lon: number,
  normalBearingDeg: number,
  stepMinutes = 15,
): number {
  const times = SunCalc.getTimes(date, lat, lon)
  if (!times.sunrise || !times.sunset) return 0

  let hours = 0
  const stepMs = stepMinutes * 60_000
  for (let t = times.sunrise.getTime(); t <= times.sunset.getTime(); t += stepMs) {
    const pos = SunCalc.getPosition(new Date(t), lat, lon)
    if (pos.altitude <= 0) continue
    if (Math.abs(angularDiff(pos.azimuth, normalBearingDeg)) < 90) {
      hours += stepMinutes / 60
    }
  }
  return hours
}
