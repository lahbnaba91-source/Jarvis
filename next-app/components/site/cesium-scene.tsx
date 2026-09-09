"use client"

import * as Cesium from "cesium"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"

import { setCesiumBaseUrl } from "./cesium-base-url"

import { buildingTypeLabel } from "@/lib/site/geometry"
import type { CanopyArea, LatLon, OverpassWay, TreePoint } from "@/lib/site/overpass"

export interface CesiumSceneHandle {
  clearMeasurements: () => void
}

/** What a tap on a 3D building reports back — read straight off the OSM
 * Buildings tile feature's own properties. */
export interface PickedBuilding {
  typeLabel: string
  rawType: string | null
  name: string | null
  address: string | null
  heightM: number | null
  levels: number | null
}

export interface CesiumSceneProps {
  /** Cesium ion access token. Without one, falls back to a flat OSM basemap —
   * no 3D buildings/terrain/shadows (both are ion-hosted free-tier assets). */
  ionToken: string | null
  target: LatLon | null
  date: Date
  roads: OverpassWay[]
  /** Individually mapped trees, drawn as shadow-casting proxies. */
  trees: TreePoint[]
  /** Wooded / tree-row areas, drawn as low translucent canopy volumes. */
  canopies: CanopyArea[]
  /** Footprint ring of the currently analyzed building, outlined on the ground. */
  buildingHighlight: LatLon[] | null
  measurementMode: boolean
  onMeasurement: (distanceMeters: number) => void
  /** Float the street name over each named road centreline. */
  showRoadLabels: boolean
  /** Fires with a building's details on tap, or null when empty ground is tapped. */
  onBuildingPick: (building: PickedBuilding | null) => void
  /** Fires (debounced) after the camera settles: the ground point at the centre
   * of the view and a fetch radius scaled to zoom. radiusM is 0 when the view is
   * too far out to fetch detail centrelines for (the flat road tiles cover it). */
  onViewChange: (center: LatLon, radiusM: number) => void
  /** Drape a translucent OSM road-tile layer over everything so every street in
   * the city is drawn at all zooms, under the styled 3D centrelines. */
  showRoadMap: boolean
}

// OSM Buildings ships untextured. Colour the massing by use-type, with a
// height gradient as the fallback, so a cityscape reads as varied 3D instead
// of a field of identical grey blocks.
const BUILDING_STYLE = new Cesium.Cesium3DTileStyle({
  defines: { h: "${feature['cesium#estimatedHeight']}" },
  color: {
    conditions: [
      [
        "${feature['building']} === 'industrial' || ${feature['building']} === 'warehouse'",
        "color('#a9aeb5')",
      ],
      [
        "${feature['building']} === 'commercial' || ${feature['building']} === 'office'",
        "color('#bfc7d1')",
      ],
      [
        "${feature['building']} === 'retail' || ${feature['building']} === 'supermarket'",
        "color('#cdbfa3')",
      ],
      ["${feature['building']} === 'hotel'", "color('#c9c0ac')"],
      [
        "${feature['building']} === 'church' || ${feature['building']} === 'cathedral' || ${feature['building']} === 'chapel'",
        "color('#bdae93')",
      ],
      ["${h} >= 90", "color('#a6b0bd')"],
      ["${h} >= 40", "color('#c3c9d1')"],
      ["${h} >= 15", "color('#d0cec4')"],
      ["true", "color('#d8d4c8')"],
    ],
  },
})

// Road centreline colour + draw width by OSM highway class, so the network
// reads as a hierarchy instead of one flat colour.
function roadStyle(highway: string): { color: Cesium.Color; width: number } {
  switch (highway) {
    case "motorway":
    case "motorway_link":
    case "trunk":
    case "trunk_link":
      return { color: Cesium.Color.fromCssColorString("#e8743b"), width: 6 }
    case "primary":
    case "primary_link":
      return { color: Cesium.Color.fromCssColorString("#f0a83c"), width: 5 }
    case "secondary":
    case "secondary_link":
      return { color: Cesium.Color.fromCssColorString("#f2cf4a"), width: 4.5 }
    case "tertiary":
    case "tertiary_link":
      return { color: Cesium.Color.fromCssColorString("#f4e59c"), width: 4 }
    case "residential":
    case "unclassified":
    case "living_street":
      return { color: Cesium.Color.WHITE.withAlpha(0.9), width: 3.5 }
    case "service":
      return { color: Cesium.Color.fromCssColorString("#cfd4da").withAlpha(0.8), width: 2.5 }
    case "footway":
    case "path":
    case "pedestrian":
    case "steps":
    case "track":
      return { color: Cesium.Color.fromCssColorString("#8fd07a").withAlpha(0.85), width: 2 }
    case "cycleway":
      return { color: Cesium.Color.fromCssColorString("#6fb7ff").withAlpha(0.85), width: 2 }
    default:
      return { color: Cesium.Color.fromCssColorString("#e2e2e2").withAlpha(0.8), width: 3 }
  }
}

// Opacity of the citywide OSM road-tile overlay over the aerial base. Low
// enough to keep the 3D scene readable, high enough to trace every street.
const OSM_ROAD_TILE_ALPHA = 0.5

// Entity count is the perf ceiling here: each tree is two primitives. Cap the
// individually-drawn trees and lean on the canopy volumes for dense areas.
const MAX_TREE_PROXIES = 350
const CANOPY_HEIGHT_M = 10
const TREE_CANOPY_COLOR = Cesium.Color.fromCssColorString("#5b8f4e")
const TREE_TRUNK_COLOR = Cesium.Color.fromCssColorString("#6b4f36")
const CANOPY_AREA_COLOR = Cesium.Color.fromCssColorString("#5b8f4e").withAlpha(0.55)

// Cheap, GPU-side polish that makes untextured massing look shaded and
// deliberate: multisampling plus ambient occlusion in the crevices. Every
// step is individually guarded so a weak GPU/context can't blank the scene.
function enhanceScene(viewer: Cesium.Viewer) {
  try {
    viewer.scene.msaaSamples = 4
  } catch {
    // Unsupported on this GPU/context — harmless.
  }

  try {
    const ao = viewer.scene.postProcessStages.ambientOcclusion
    ao.enabled = true
    ao.uniforms.intensity = 2.2
    ao.uniforms.bias = 0.12
  } catch (err) {
    console.warn("[site] ambient occlusion unavailable:", err)
  }
}

const CesiumScene = forwardRef<CesiumSceneHandle, CesiumSceneProps>(function CesiumScene(
  {
    ionToken,
    target,
    date,
    roads,
    trees,
    canopies,
    buildingHighlight,
    measurementMode,
    onMeasurement,
    showRoadLabels,
    onBuildingPick,
    onViewChange,
    showRoadMap,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const roadEntityMapRef = useRef<Map<number, Cesium.Entity>>(new Map())
  const roadLabelEntitiesRef = useRef<Cesium.Entity[]>([])
  const osmOverlayLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const treeEntitiesRef = useRef<Cesium.Entity[]>([])
  const highlightEntityRef = useRef<Cesium.Entity | null>(null)
  const measureEntitiesRef = useRef<Cesium.Entity[]>([])
  const pickMarkerEntityRef = useRef<Cesium.Entity | null>(null)
  const pendingPointRef = useRef<Cesium.Cartesian3 | null>(null)
  const measurementModeRef = useRef(measurementMode)
  const onMeasurementRef = useRef(onMeasurement)
  const onBuildingPickRef = useRef(onBuildingPick)
  const onViewChangeRef = useRef(onViewChange)
  const moveEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    measurementModeRef.current = measurementMode
  }, [measurementMode])
  useEffect(() => {
    onMeasurementRef.current = onMeasurement
  }, [onMeasurement])
  useEffect(() => {
    onBuildingPickRef.current = onBuildingPick
  }, [onBuildingPick])
  useEffect(() => {
    onViewChangeRef.current = onViewChange
  }, [onViewChange])

  useImperativeHandle(ref, () => ({
    clearMeasurements() {
      const viewer = viewerRef.current
      if (!viewer) return
      for (const entity of measureEntitiesRef.current) viewer.entities.remove(entity)
      measureEntitiesRef.current = []
      pendingPointRef.current = null
    },
  }))

  // Tap a building in the OSM Buildings tileset -> read its own feature
  // properties and report them up, plus drop a labelled marker on it. Tapping
  // empty ground clears the selection.
  function identifyBuilding(viewer: Cesium.Viewer, position: Cesium.Cartesian2) {
    const clearMarker = () => {
      if (pickMarkerEntityRef.current) {
        viewer.entities.remove(pickMarkerEntityRef.current)
        pickMarkerEntityRef.current = null
      }
    }
    const feature = viewer.scene.pick(position)
    if (!(feature instanceof Cesium.Cesium3DTileFeature)) {
      clearMarker()
      onBuildingPickRef.current(null)
      return
    }

    const prop = (name: string): string | null => {
      const v = feature.getProperty(name)
      return v === undefined || v === null || v === "" ? null : String(v)
    }
    const num = (raw: string | null): number | null => {
      if (raw === null) return null
      const n = Number.parseFloat(raw)
      return Number.isFinite(n) ? n : null
    }
    const rawType = prop("building")
    const address =
      [prop("addr:housenumber"), prop("addr:street")].filter(Boolean).join(" ") || null
    const info: PickedBuilding = {
      typeLabel: buildingTypeLabel(rawType ?? undefined),
      rawType,
      name: prop("name"),
      address,
      heightM: num(prop("height") ?? prop("cesium#estimatedHeight")),
      levels: num(prop("building:levels")),
    }
    onBuildingPickRef.current(info)

    const anchor = viewer.scene.pickPosition(position)
    clearMarker()
    if (Cesium.defined(anchor)) {
      pickMarkerEntityRef.current = viewer.entities.add({
        position: anchor as Cesium.Cartesian3,
        point: {
          pixelSize: 9,
          color: Cesium.Color.ORANGE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: info.name ?? info.typeLabel,
          font: "13px sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  // Mount once: build the viewer, base imagery/terrain/buildings, and the
  // measurement click handler.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return
    let cancelled = false
    // Held locally so cleanup can destroy the viewer even if teardown runs
    // before init finished (React StrictMode double-mounts this effect in dev).
    let localViewer: Cesium.Viewer | null = null
    // Stable ref object (never reassigned) — safe to read here and use in cleanup.
    const roadEntityMap = roadEntityMapRef.current
    setCesiumBaseUrl()

    async function init() {
      const hasIon = Boolean(ionToken)
      if (hasIon) Cesium.Ion.defaultAccessToken = ionToken as string

      const viewer = new Cesium.Viewer(containerRef.current!, {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        terrainProvider: hasIon ? undefined : new Cesium.EllipsoidTerrainProvider(),
        baseLayer: hasIon
          ? undefined
          : new Cesium.ImageryLayer(
              new Cesium.OpenStreetMapImageryProvider({
                url: "https://tile.openstreetmap.org/",
              }),
            ),
      })

      localViewer = viewer
      if (cancelled) {
        viewer.destroy()
        return
      }

      viewer.scene.globe.enableLighting = true
      viewer.shadows = true
      viewer.scene.globe.depthTestAgainstTerrain = true
      viewer.clock.shouldAnimate = false
      viewer.clock.currentTime = Cesium.JulianDate.fromDate(date)

      if (hasIon) {
        try {
          viewer.scene.setTerrain(Cesium.Terrain.fromWorldTerrain())
        } catch (err) {
          console.warn("[site] World Terrain unavailable:", err)
        }
        try {
          const buildingsTileset = await Cesium.createOsmBuildingsAsync()
          if (cancelled) return
          buildingsTileset.style = BUILDING_STYLE
          viewer.scene.primitives.add(buildingsTileset)
        } catch (err) {
          console.warn("[site] OSM Buildings tileset unavailable:", err)
        }
        // Translucent OSM road-map draped over the aerial base so the whole
        // city's street grid is always drawn, at any zoom, with no API cost.
        // (Skipped without ion — there the OSM map already IS the base layer.)
        try {
          const overlay = viewer.imageryLayers.addImageryProvider(
            new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
          )
          overlay.alpha = showRoadMap ? OSM_ROAD_TILE_ALPHA : 0
          osmOverlayLayerRef.current = overlay
        } catch (err) {
          console.warn("[site] OSM road overlay unavailable:", err)
        }
      }

      if (cancelled) return

      try {
        enhanceScene(viewer)
      } catch (err) {
        console.warn("[site] scene enhancement skipped:", err)
      }

      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        if (!measurementModeRef.current) {
          identifyBuilding(viewer, click.position)
          return
        }
        const picked = viewer.scene.pickPosition(click.position)
        if (!Cesium.defined(picked)) return
        const point = picked as Cesium.Cartesian3

        const pointEntity = viewer.entities.add({
          position: point,
          point: {
            pixelSize: 8,
            color: Cesium.Color.CYAN,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
          },
        })
        measureEntitiesRef.current.push(pointEntity)

        if (!pendingPointRef.current) {
          pendingPointRef.current = point
          return
        }

        const start = pendingPointRef.current
        const end = point
        const distance = Cesium.Cartesian3.distance(start, end)

        const lineEntity = viewer.entities.add({
          polyline: { positions: [start, end], width: 3, material: Cesium.Color.CYAN },
        })
        const mid = Cesium.Cartesian3.midpoint(start, end, new Cesium.Cartesian3())
        const labelEntity = viewer.entities.add({
          position: mid,
          label: {
            text: `${distance.toFixed(1)} m`,
            font: "14px sans-serif",
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
          },
        })
        measureEntitiesRef.current.push(lineEntity, labelEntity)

        pendingPointRef.current = null
        onMeasurementRef.current(distance)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      // Viewport-driven OSM loading: after the camera settles, report the
      // ground point under the middle of the view and a zoom-scaled radius so
      // the page can refetch roads/trees for wherever we're now looking.
      const VIEW_MAX_HEIGHT_M = 6000
      const emitViewChange = () => {
        if (viewer.isDestroyed()) return
        const canvas = viewer.scene.canvas
        const centerPx = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
        let center: LatLon | null = null
        const ray = viewer.camera.getPickRay(centerPx)
        if (ray) {
          const hit = viewer.scene.globe.pick(ray, viewer.scene)
          if (Cesium.defined(hit)) {
            const carto = Cesium.Cartographic.fromCartesian(hit as Cesium.Cartesian3)
            center = {
              lat: Cesium.Math.toDegrees(carto.latitude),
              lon: Cesium.Math.toDegrees(carto.longitude),
            }
          }
        }
        const camCarto = viewer.camera.positionCartographic
        if (!center) {
          center = {
            lat: Cesium.Math.toDegrees(camCarto.latitude),
            lon: Cesium.Math.toDegrees(camCarto.longitude),
          }
        }
        const heightM = camCarto.height
        const radiusM =
          heightM > VIEW_MAX_HEIGHT_M ? 0 : Math.min(2000, Math.max(200, heightM * 0.9))
        onViewChangeRef.current(center, radiusM)
      }
      viewer.camera.moveEnd.addEventListener(() => {
        if (moveEndTimerRef.current) clearTimeout(moveEndTimerRef.current)
        moveEndTimerRef.current = setTimeout(emitViewChange, 1000)
      })

      viewerRef.current = viewer
      setReady(true)
    }

    void init()

    return () => {
      cancelled = true
      if (moveEndTimerRef.current) clearTimeout(moveEndTimerRef.current)
      const viewer = viewerRef.current ?? localViewer
      if (viewer && !viewer.isDestroyed()) viewer.destroy()
      viewerRef.current = null
      // Entities belonged to the now-destroyed viewer — drop the id map and
      // label list so the rebuilt viewer re-adds them from scratch.
      roadEntityMap.clear()
      roadLabelEntitiesRef.current = []
      osmOverlayLayerRef.current = null
      // Reset so the rebuilt viewer's setReady(true) re-fires the ready-gated
      // effects below (flyTo, clock, roads, footprint highlight).
      setReady(false)
    }
    // Re-initializing on token change is intentional: base imagery/terrain
    // are chosen at viewer construction time. Everything else (camera, clock,
    // overlays) is handled by the effects below against the live viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ionToken])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.scene.canvas.style.cursor = measurementMode ? "crosshair" : "default"
  }, [measurementMode, ready])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !target) return
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, 350),
      orientation: {
        heading: Cesium.Math.toRadians(20),
        pitch: Cesium.Math.toRadians(-35),
        roll: 0,
      },
      duration: 2,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.lat, target?.lon, ready])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(date)
  }, [date, ready])

  // Styled 3D road centrelines. `roads` accumulates as the camera roams, so
  // this diffs by OSM way id — add only the new ways, drop only the ones that
  // fell out of range — instead of rebuilding every polyline on each pan.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const entityById = roadEntityMapRef.current
    const nextIds = new Set<number>()

    for (const way of roads) {
      nextIds.add(way.id)
      if (entityById.has(way.id)) continue
      const { color, width } = roadStyle(way.tags.highway ?? "road")
      entityById.set(
        way.id,
        viewer.entities.add({
          name: way.tags.name ?? way.tags.ref ?? "",
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(
              way.geometry.flatMap((p) => [p.lon, p.lat]),
            ),
            width,
            material: color,
            clampToGround: true,
          },
        }),
      )
    }
    for (const [id, entity] of entityById) {
      if (!nextIds.has(id)) {
        viewer.entities.remove(entity)
        entityById.delete(id)
      }
    }

    // Labels are far fewer (named ways only, de-duped) — cheap to rebuild whole.
    for (const entity of roadLabelEntitiesRef.current) viewer.entities.remove(entity)
    const labels: Cesium.Entity[] = []
    if (showRoadLabels) {
      const labelled = new Set<string>()
      for (const way of roads) {
        const name = way.tags.name ?? way.tags.ref ?? ""
        if (!name || labelled.has(name) || way.geometry.length === 0) continue
        labelled.add(name)
        const mid = way.geometry[Math.floor(way.geometry.length / 2)]
        labels.push(
          viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat),
            label: {
              text: name,
              font: "12px sans-serif",
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              showBackground: true,
              backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              scaleByDistance: new Cesium.NearFarScalar(150, 1, 1200, 0.55),
              translucencyByDistance: new Cesium.NearFarScalar(900, 1, 2200, 0),
            },
          }),
        )
      }
    }
    roadLabelEntitiesRef.current = labels
  }, [roads, showRoadLabels, ready])

  // Citywide OSM road-tile overlay opacity (added only when an ion token gave
  // us an aerial base — otherwise the OSM map is already the base layer).
  useEffect(() => {
    const layer = osmOverlayLayerRef.current
    if (!layer) return
    layer.alpha = showRoadMap ? OSM_ROAD_TILE_ALPHA : 0
  }, [showRoadMap, ready])

  // Mapped trees as shadow-casting proxies (canopy ellipsoid + trunk), plus
  // wooded areas as low translucent canopy volumes so both block the sun.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const entity of treeEntitiesRef.current) viewer.entities.remove(entity)
    const added: Cesium.Entity[] = []

    for (const canopy of canopies) {
      if (canopy.geometry.length < 3) continue
      added.push(
        viewer.entities.add({
          polygon: {
            hierarchy: Cesium.Cartesian3.fromDegreesArray(
              canopy.geometry.flatMap((p) => [p.lon, p.lat]),
            ),
            material: CANOPY_AREA_COLOR,
            height: 0,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            extrudedHeight: CANOPY_HEIGHT_M,
            extrudedHeightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            shadows: Cesium.ShadowMode.ENABLED,
          },
        }),
      )
    }

    const shown = trees.length > MAX_TREE_PROXIES ? trees.slice(0, MAX_TREE_PROXIES) : trees
    for (const tree of shown) {
      const canopyR = Math.max(1.8, tree.heightM * 0.3)
      added.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(tree.lon, tree.lat, tree.heightM * 0.55),
          ellipsoid: {
            radii: new Cesium.Cartesian3(canopyR, canopyR, canopyR * 1.15),
            material: TREE_CANOPY_COLOR,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            shadows: Cesium.ShadowMode.ENABLED,
          },
        }),
      )
      added.push(
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(tree.lon, tree.lat, tree.heightM * 0.2),
          cylinder: {
            length: tree.heightM * 0.4,
            topRadius: Math.max(0.12, canopyR * 0.12),
            bottomRadius: Math.max(0.15, canopyR * 0.15),
            material: TREE_TRUNK_COLOR,
            heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND,
            shadows: Cesium.ShadowMode.ENABLED,
          },
        }),
      )
    }

    treeEntitiesRef.current = added

  }, [trees, canopies, ready])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    if (highlightEntityRef.current) {
      viewer.entities.remove(highlightEntityRef.current)
      highlightEntityRef.current = null
    }
    if (!buildingHighlight || buildingHighlight.length < 3) return
    highlightEntityRef.current = viewer.entities.add({
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(
          buildingHighlight.flatMap((p) => [p.lon, p.lat]),
        ),
        material: Cesium.Color.ORANGE.withAlpha(0.25),
        outline: true,
        outlineColor: Cesium.Color.ORANGE,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    })
     
  }, [buildingHighlight, ready])

  return <div ref={containerRef} className="h-full w-full" />
})

export default CesiumScene
