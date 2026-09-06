// Free OSM data via the public Overpass API — road centerlines, building
// footprints, and mapped trees/canopy near a searched point, all with inline
// geometry (`out geom`) so no separate node lookup is needed.

// The canonical instance (overpass-api.de) frequently returns 429/504 under
// load, so we fall back across mirrors and retry each once before giving up.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export interface LatLon {
  lat: number
  lon: number
}

export interface OverpassWay {
  id: number
  tags: Record<string, string>
  geometry: LatLon[]
}

export interface OverpassNode {
  id: number
  tags: Record<string, string>
  lat: number
  lon: number
}

export interface TreePoint {
  id: number
  lat: number
  lon: number
  /** Canopy-top height in metres — from the OSM `height` tag or a default. */
  heightM: number
  heightSource: "tag" | "estimate"
}

export type CanopyKind = "wood" | "forest" | "tree_row" | "scrub"

export interface CanopyArea {
  id: number
  kind: CanopyKind
  geometry: LatLon[]
}

async function fetchOnce(url: string, query: string, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

interface OverpassResult {
  ways: OverpassWay[]
  nodes: OverpassNode[]
}

async function runOverpassElements(query: string): Promise<OverpassResult> {
  let lastError: unknown = null

  for (const url of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchOnce(url, query)
        if (res.ok) {
          const data = (await res.json()) as {
            elements: Array<{
              type: string
              id: number
              tags?: Record<string, string>
              lat?: number
              lon?: number
              geometry?: Array<{ lat: number; lon: number }>
            }>
          }
          const ways: OverpassWay[] = []
          const nodes: OverpassNode[] = []
          for (const el of data.elements) {
            if (el.type === "way" && el.geometry && el.geometry.length > 1) {
              ways.push({ id: el.id, tags: el.tags ?? {}, geometry: el.geometry as LatLon[] })
            } else if (
              el.type === "node" &&
              Number.isFinite(el.lat) &&
              Number.isFinite(el.lon)
            ) {
              nodes.push({
                id: el.id,
                tags: el.tags ?? {},
                lat: el.lat as number,
                lon: el.lon as number,
              })
            }
          }
          return { ways, nodes }
        }
        lastError = new Error(`Overpass query failed: ${res.status} ${res.statusText}`)
        // A non-retryable status won't improve on a second try — move to the next mirror.
        if (!RETRYABLE_STATUS.has(res.status)) break
      } catch (err) {
        lastError = err
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }

  throw new Error(
    `Overpass unavailable after ${OVERPASS_ENDPOINTS.length} endpoints: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

/** Default canopy-top height for a mapped tree with no `height` tag. */
const DEFAULT_TREE_HEIGHT_M = 9

const CANOPY_TAGS = new Set(["wood", "forest", "tree_row", "scrub"])

function canopyKind(tags: Record<string, string>): CanopyKind {
  if (tags.natural === "wood") return "wood"
  if (tags.landuse === "forest") return "forest"
  if (tags.natural === "tree_row") return "tree_row"
  return "scrub"
}

export interface SiteOsm {
  /** Highway ways, unsorted. */
  roads: OverpassWay[]
  /** Building footprints, nearest first. */
  buildings: OverpassWay[]
  /** Individually mapped trees. */
  trees: TreePoint[]
  /** Wooded / tree-row / scrub areas. */
  canopies: CanopyArea[]
}

/** One Overpass round-trip for everything the site view needs — roads,
 * buildings, trees, and canopy. A single query keeps us well under the public
 * instances' rate limits (three parallel queries reliably tripped 429s). */
export async function fetchSiteOsm(center: LatLon): Promise<SiteOsm> {
  const { lat, lon } = center
  const query = `[out:json][timeout:30];
(
  way["highway"](around:350,${lat},${lon});
  way["building"](around:120,${lat},${lon});
  node["natural"="tree"](around:160,${lat},${lon});
  way["natural"="wood"](around:180,${lat},${lon});
  way["landuse"="forest"](around:180,${lat},${lon});
  way["natural"="tree_row"](around:160,${lat},${lon});
  way["natural"="scrub"](around:180,${lat},${lon});
);
out geom;`

  const { ways, nodes } = await runOverpassElements(query)

  const roads = ways.filter((w) => w.tags.highway)

  const buildings = ways
    .filter((w) => w.tags.building)
    .map((way) => ({ way, dist: distanceToRingMeters(center, way.geometry) }))
    .sort((a, b) => a.dist - b.dist)
    .map(({ way }) => way)

  const trees: TreePoint[] = nodes
    .filter((n) => n.tags.natural === "tree")
    .map((n) => {
      const tagged = Number.parseFloat(n.tags.height ?? "")
      return Number.isFinite(tagged) && tagged > 0
        ? { id: n.id, lat: n.lat, lon: n.lon, heightM: tagged, heightSource: "tag" as const }
        : {
            id: n.id,
            lat: n.lat,
            lon: n.lon,
            heightM: DEFAULT_TREE_HEIGHT_M,
            heightSource: "estimate" as const,
          }
    })

  const canopies: CanopyArea[] = ways
    .filter(
      (w) =>
        w.geometry.length >= 3 &&
        (CANOPY_TAGS.has(w.tags.natural ?? "") || w.tags.landuse === "forest"),
    )
    .map((w) => ({ id: w.id, kind: canopyKind(w.tags), geometry: w.geometry }))

  return { roads, buildings, trees, canopies }
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
