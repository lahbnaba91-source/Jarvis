import * as turf from "@turf/turf"

import type { CanopyArea, LatLon, OverpassWay } from "./overpass"

export interface BuildingProfile {
  /** Footprint area in square meters. */
  areaM2: number
  /** Compass bearing (0-360, 0 = north) of the building's longest edge. */
  longAxisBearingDeg: number
  /** Estimated building height in meters (from OSM tags, or a levels fallback). */
  heightM: number
  heightSource: "height-tag" | "levels-estimate" | "unknown"
  addressLabel: string | null
  centroid: LatLon
}

const METERS_PER_LEVEL = 3

export function analyzeBuildingFootprint(way: OverpassWay): BuildingProfile | null {
  const ring = way.geometry
  if (ring.length < 3) return null

  // GeoJSON/turf wants [lon, lat] and a closed ring.
  const coords: [number, number][] = ring.map((p) => [p.lon, p.lat])
  const first = coords[0]
  const last = coords[coords.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first)

  let polygon
  try {
    polygon = turf.polygon([coords])
  } catch {
    return null
  }

  const areaM2 = turf.area(polygon)
  const centroidPoint = turf.centroid(polygon)
  const [lon, lat] = centroidPoint.geometry.coordinates

  // Longest-edge bearing: the strongest signal for how the building is oriented.
  let longestLen = -1
  let longAxisBearingDeg = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const a = turf.point(coords[i])
    const b = turf.point(coords[i + 1])
    const len = turf.distance(a, b, { units: "meters" })
    if (len > longestLen) {
      longestLen = len
      // Normalize to 0-180 since an edge's bearing and its reverse describe
      // the same axis.
      const bearing = turf.bearing(a, b)
      longAxisBearingDeg = ((bearing % 180) + 180) % 180
    }
  }

  const tags = way.tags
  let heightM: number
  let heightSource: BuildingProfile["heightSource"]
  const taggedHeight = Number.parseFloat(tags.height ?? "")
  const levels = Number.parseFloat(tags["building:levels"] ?? "")
  if (Number.isFinite(taggedHeight)) {
    heightM = taggedHeight
    heightSource = "height-tag"
  } else if (Number.isFinite(levels)) {
    heightM = levels * METERS_PER_LEVEL
    heightSource = "levels-estimate"
  } else {
    heightM = 2 * METERS_PER_LEVEL // rough single/two-story fallback
    heightSource = "unknown"
  }

  const addressParts = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean)
  const addressLabel = addressParts.length ? addressParts.join(" ") : null

  return {
    areaM2,
    longAxisBearingDeg,
    heightM,
    heightSource,
    addressLabel,
    centroid: { lat, lon },
  }
}

const ROAD_CLASS_LABEL: Record<string, string> = {
  motorway: "Motorway",
  motorway_link: "Motorway ramp",
  trunk: "Trunk road",
  trunk_link: "Trunk ramp",
  primary: "Primary road",
  primary_link: "Primary ramp",
  secondary: "Secondary road",
  tertiary: "Tertiary road",
  residential: "Residential street",
  living_street: "Living street",
  unclassified: "Minor road",
  service: "Service road",
  pedestrian: "Pedestrian way",
  footway: "Footpath",
  path: "Path",
  steps: "Steps",
  cycleway: "Cycleway",
  track: "Track",
}

export function roadClassLabel(highway: string): string {
  return ROAD_CLASS_LABEL[highway] ?? highway.replace(/_/g, " ")
}

export interface NearbyRoad {
  name: string
  classLabel: string
  highway: string
  distM: number
  named: boolean
}

function minDistanceToPathMeters(center: LatLon, path: LatLon[]): number {
  const from = turf.point([center.lon, center.lat])
  let min = Infinity
  if (path.length === 1) {
    return turf.distance(from, turf.point([path[0].lon, path[0].lat]), { units: "meters" })
  }
  for (let i = 0; i < path.length - 1; i++) {
    const seg = turf.lineString([
      [path[i].lon, path[i].lat],
      [path[i + 1].lon, path[i + 1].lat],
    ])
    const d = turf.pointToLineDistance(from, seg, { units: "meters" })
    if (d < min) min = d
  }
  return min
}

/** Distinct roads near the site, closest first — named ways collapse to one
 * entry, unnamed ways group by class so the list stays short. */
export function summarizeRoads(roads: OverpassWay[], center: LatLon): NearbyRoad[] {
  const byKey = new Map<string, NearbyRoad>()
  for (const way of roads) {
    const highway = way.tags.highway ?? "road"
    const name = way.tags.name ?? way.tags.ref ?? ""
    const key = name || `unnamed:${highway}`
    const distM = minDistanceToPathMeters(center, way.geometry)
    const existing = byKey.get(key)
    if (existing) {
      if (distM < existing.distM) existing.distM = distM
      continue
    }
    byKey.set(key, {
      name: name || `Unnamed ${roadClassLabel(highway).toLowerCase()}`,
      classLabel: roadClassLabel(highway),
      highway,
      distM,
      named: Boolean(name),
    })
  }
  return [...byKey.values()].sort((a, b) => a.distM - b.distM)
}

export interface CanopySummary {
  treeCount: number
  treesTagged: number
  canopyAreaM2: number
  canopyPatches: number
}

export function summarizeCanopy(
  trees: { heightSource: "tag" | "estimate" }[],
  canopies: CanopyArea[],
): CanopySummary {
  let canopyAreaM2 = 0
  for (const c of canopies) {
    const coords: [number, number][] = c.geometry.map((p) => [p.lon, p.lat])
    const first = coords[0]
    const last = coords[coords.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first)
    if (coords.length < 4) continue
    try {
      canopyAreaM2 += turf.area(turf.polygon([coords]))
    } catch {
      // Skip a self-intersecting or degenerate ring.
    }
  }
  return {
    treeCount: trees.length,
    treesTagged: trees.filter((t) => t.heightSource === "tag").length,
    canopyAreaM2,
    canopyPatches: canopies.length,
  }
}
