// Free OSM data via the public Overpass API — road centerlines and the
// nearest building footprint to a searched point, both with inline geometry
// (`out geom`) so no separate node lookup is needed.

const OVERPASS_URL = "https://overpass-api.de/api/interpreter"

export interface LatLon {
  lat: number
  lon: number
}

export interface OverpassWay {
  id: number
  tags: Record<string, string>
  geometry: LatLon[]
}

async function runOverpassQuery(query: string): Promise<OverpassWay[]> {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: query,
  })
  if (!res.ok) {
    throw new Error(`Overpass query failed: ${res.status} ${res.statusText}`)
  }
  const data = (await res.json()) as {
    elements: Array<{
      type: string
      id: number
      tags?: Record<string, string>
      geometry?: Array<{ lat: number; lon: number }>
    }>
  }
  return data.elements
    .filter((el) => el.type === "way" && el.geometry && el.geometry.length > 1)
    .map((el) => ({
      id: el.id,
      tags: el.tags ?? {},
      geometry: el.geometry as LatLon[],
    }))
}

/** Road/path centerlines within `radiusMeters` of a point. */
export async function fetchRoadsNear(
  center: LatLon,
  radiusMeters = 350,
): Promise<OverpassWay[]> {
  const query = `[out:json][timeout:25];
(
  way["highway"](around:${radiusMeters},${center.lat},${center.lon});
);
out geom;`
  return runOverpassQuery(query)
}

/** Building footprints within `radiusMeters` of a point, nearest first. */
export async function fetchBuildingsNear(
  center: LatLon,
  radiusMeters = 120,
): Promise<OverpassWay[]> {
  const query = `[out:json][timeout:25];
(
  way["building"](around:${radiusMeters},${center.lat},${center.lon});
);
out geom;`
  const ways = await runOverpassQuery(query)
  return ways
    .map((way) => ({ way, dist: distanceToRingMeters(center, way.geometry) }))
    .sort((a, b) => a.dist - b.dist)
    .map(({ way }) => way)
}

function distanceToRingMeters(point: LatLon, ring: LatLon[]): number {
  let minDist = Infinity
  for (const vertex of ring) {
    const d = haversineMeters(point, vertex)
    if (d < minDist) minDist = d
  }
  return minDist
}

function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
