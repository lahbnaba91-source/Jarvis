import * as turf from "@turf/turf"

import type { LatLon, OverpassWay } from "./overpass"

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
