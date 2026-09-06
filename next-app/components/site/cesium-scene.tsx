"use client"

import * as Cesium from "cesium"
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"

import { setCesiumBaseUrl } from "./cesium-base-url"

import type { LatLon, OverpassWay } from "@/lib/site/overpass"

export interface CesiumSceneHandle {
  clearMeasurements: () => void
}

export interface CesiumSceneProps {
  /** Cesium ion access token. Without one, falls back to a flat OSM basemap —
   * no 3D buildings/terrain/shadows (both are ion-hosted free-tier assets). */
  ionToken: string | null
  target: LatLon | null
  date: Date
  roads: OverpassWay[]
  /** Footprint ring of the currently analyzed building, outlined on the ground. */
  buildingHighlight: LatLon[] | null
  measurementMode: boolean
  onMeasurement: (distanceMeters: number) => void
}

const CesiumScene = forwardRef<CesiumSceneHandle, CesiumSceneProps>(function CesiumScene(
  { ionToken, target, date, roads, buildingHighlight, measurementMode, onMeasurement },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const roadEntitiesRef = useRef<Cesium.Entity[]>([])
  const highlightEntityRef = useRef<Cesium.Entity | null>(null)
  const measureEntitiesRef = useRef<Cesium.Entity[]>([])
  const pendingPointRef = useRef<Cesium.Cartesian3 | null>(null)
  const measurementModeRef = useRef(measurementMode)
  const onMeasurementRef = useRef(onMeasurement)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    measurementModeRef.current = measurementMode
  }, [measurementMode])
  useEffect(() => {
    onMeasurementRef.current = onMeasurement
  }, [onMeasurement])

  useImperativeHandle(ref, () => ({
    clearMeasurements() {
      const viewer = viewerRef.current
      if (!viewer) return
      for (const entity of measureEntitiesRef.current) viewer.entities.remove(entity)
      measureEntitiesRef.current = []
      pendingPointRef.current = null
    },
  }))

  // Mount once: build the viewer, base imagery/terrain/buildings, and the
  // measurement click handler.
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return
    let cancelled = false
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
          viewer.scene.primitives.add(buildingsTileset)
        } catch (err) {
          console.warn("[site] OSM Buildings tileset unavailable:", err)
        }
      }

      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
      handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        if (!measurementModeRef.current) return
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

      viewerRef.current = viewer
      setReady(true)
    }

    void init()

    return () => {
      cancelled = true
      if (viewerRef.current) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
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

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    for (const entity of roadEntitiesRef.current) viewer.entities.remove(entity)
    roadEntitiesRef.current = roads.map((way) =>
      viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(
            way.geometry.flatMap((p) => [p.lon, p.lat]),
          ),
          width: 4,
          material: Cesium.Color.YELLOW.withAlpha(0.85),
          clampToGround: true,
        },
      }),
    )
     
  }, [roads, ready])

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
