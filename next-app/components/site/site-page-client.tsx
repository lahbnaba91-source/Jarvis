"use client"

import dynamic from "next/dynamic"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { CesiumSceneHandle } from "@/components/site/cesium-scene"
import { geocodeAddress, type GeocodeResult } from "@/lib/site/geocode"
import { analyzeBuildingFootprint, type BuildingProfile } from "@/lib/site/geometry"
import { fetchBuildingsNear, fetchRoadsNear, type LatLon, type OverpassWay } from "@/lib/site/overpass"
import { bearingToCompass, estimateFacadeExposures, getDaylightSummary } from "@/lib/site/solar"
import { cn } from "@/lib/utils"

// Cesium touches window/DOM on import, so this can only ever render client-side.
const CesiumScene = dynamic(() => import("@/components/site/cesium-scene"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      Loading 3D scene…
    </div>
  ),
})

const ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN || null

interface SiteData {
  target: LatLon
  roads: OverpassWay[]
  building: BuildingProfile | null
  buildingRing: LatLon[] | null
}

function todayISODate(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Reads lat/lon/date/hour from the current URL, if present. This component
 * only ever mounts client-side (see the ssr:false wrapper in app/page.tsx),
 * so reading window.location directly in a lazy useState initializer is safe
 * — no server render to mismatch against. */
function readInitialViewFromUrl(): { target: LatLon | null; dateStr: string; hour: number } {
  const params = new URLSearchParams(window.location.search)
  const lat = Number.parseFloat(params.get("lat") ?? "")
  const lon = Number.parseFloat(params.get("lon") ?? "")
  const target = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null

  const d = params.get("date")
  const dateStr = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : todayISODate()

  const h = Number.parseFloat(params.get("hour") ?? "")
  const hour = Number.isFinite(h) && h >= 0 && h <= 24 ? h : 12

  return { target, dateStr, hour }
}

export default function SitePageClient() {
  const sceneRef = useRef<CesiumSceneHandle>(null)
  // Only ever runs client-side (see the ssr:false wrapper in app/page.tsx),
  // so it's safe to read window.location directly as each hook's initial value.
  const initialView = readInitialViewFromUrl()

  const [addressQuery, setAddressQuery] = useState("")
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [target, setTarget] = useState<LatLon | null>(initialView.target)
  const [dateStr, setDateStr] = useState(initialView.dateStr)
  const [hour, setHour] = useState(initialView.hour)

  const [siteData, setSiteData] = useState<SiteData | null>(null)
  const [siteDataError, setSiteDataError] = useState<string | null>(null)
  const siteDataLoading =
    Boolean(target) &&
    (!siteData || siteData.target.lat !== target!.lat || siteData.target.lon !== target!.lon)

  const [measurementMode, setMeasurementMode] = useState(false)
  const [lastMeasurement, setLastMeasurement] = useState<number | null>(null)
  const [copiedShare, setCopiedShare] = useState(false)

  // The instant driving the 3D scene's clock/shadows.
  const date = useMemo(() => {
    const [y, m, d] = dateStr.split("-").map(Number)
    const dt = new Date(y || 2026, (m || 1) - 1, d || 1)
    dt.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0)
    return dt
  }, [dateStr, hour])

  // Keep the URL in sync (no navigation/refetch) so the current view is shareable.
  useEffect(() => {
    if (!target) return
    const params = new URLSearchParams()
    params.set("lat", target.lat.toFixed(6))
    params.set("lon", target.lon.toFixed(6))
    params.set("date", dateStr)
    params.set("hour", hour.toFixed(2))
    window.history.replaceState(null, "", `?${params.toString()}`)
  }, [target, dateStr, hour])

  // Pull roads + the nearest mapped building whenever the site changes.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    const currentTarget = target

    void (async () => {
      try {
        const [roadWays, buildingWays] = await Promise.all([
          fetchRoadsNear(currentTarget),
          fetchBuildingsNear(currentTarget),
        ])
        if (cancelled) return
        const nearest = buildingWays[0]
        setSiteData({
          target: currentTarget,
          roads: roadWays,
          building: nearest ? analyzeBuildingFootprint(nearest) : null,
          buildingRing: nearest ? nearest.geometry : null,
        })
        setSiteDataError(null)
      } catch (err) {
        if (!cancelled) {
          setSiteDataError(err instanceof Error ? err.message : "Failed to load site data")
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // fetch keyed on coordinates only — re-run when the site moves, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.lat, target?.lon])

  const currentSiteData = siteDataLoading ? null : siteData
  const building = currentSiteData?.building ?? null
  const roads = currentSiteData?.roads ?? []
  const buildingRing = currentSiteData?.buildingRing ?? null

  const daylight = useMemo(
    () => (target ? getDaylightSummary(date, target.lat, target.lon) : null),
    [target, date],
  )

  const facadeExposures = useMemo(() => {
    if (!target || !building) return null
    return estimateFacadeExposures(date, target.lat, target.lon, building.longAxisBearingDeg)
  }, [target, date, building])

  const handleSearch = useCallback(async () => {
    if (!addressQuery.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const results = await geocodeAddress(addressQuery)
      setSearchResults(results)
      if (results.length === 0) setSearchError("No matches found — try a fuller address.")
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setSearching(false)
    }
  }, [addressQuery])

  const selectResult = useCallback((result: GeocodeResult) => {
    setTarget({ lat: result.lat, lon: result.lon })
    setSearchResults([])
    setAddressQuery(result.displayName)
  }, [])

  const handleShare = useCallback(() => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopiedShare(true)
      setTimeout(() => setCopiedShare(false), 2000)
    })
  }, [])

  return (
    <div className="flex h-svh w-full flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-semibold whitespace-nowrap">Site Analyzer</h1>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSearch()
          }}
        >
          <input
            value={addressQuery}
            onChange={(e) => setAddressQuery(e.target.value)}
            placeholder="Search an address…"
            className="w-full max-w-md rounded-md border px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={searching}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => setMeasurementMode((m) => !m)}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent",
            measurementMode && "bg-accent",
          )}
        >
          {measurementMode ? "Measuring… (click 2 points)" : "Measure distance"}
        </button>
        {measurementMode && (
          <button
            type="button"
            onClick={() => sceneRef.current?.clearMeasurements()}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={handleShare}
          disabled={!target}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {copiedShare ? "Link copied!" : "Share view"}
        </button>
      </header>

      {searchResults.length > 0 && (
        <ul className="border-b bg-background text-sm">
          {searchResults.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button
                type="button"
                onClick={() => selectResult(r)}
                className="w-full px-4 py-2 text-left hover:bg-accent"
              >
                {r.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
      {searchError && (
        <p className="border-b px-4 py-1 text-xs text-destructive">{searchError}</p>
      )}

      {!ION_TOKEN && (
        <p className="border-b bg-yellow-500/10 px-4 py-2 text-xs">
          No Cesium ion token set — showing a flat basemap only. Add a free token
          (ion.cesium.com/signup) to <code>next-app/.env.local</code> as{" "}
          <code>NEXT_PUBLIC_CESIUM_ION_TOKEN</code> to unlock 3D buildings, terrain, and real
          shadows.
        </p>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex-1">
          <CesiumScene
            ref={sceneRef}
            ionToken={ION_TOKEN}
            target={target}
            date={date}
            roads={roads}
            buildingHighlight={buildingRing}
            measurementMode={measurementMode}
            onMeasurement={setLastMeasurement}
          />
          {!target && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Search an address to load its 3D site.
            </div>
          )}
        </div>

        <aside className="w-80 shrink-0 overflow-y-auto border-l p-4 text-sm">
          <section className="mb-4">
            <h2 className="mb-2 font-semibold">Sun position</h2>
            <label className="mb-1 block text-xs text-muted-foreground">Date</label>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className="mb-3 w-full rounded-md border px-2 py-1"
            />
            <label className="mb-1 block text-xs text-muted-foreground">
              Time — {formatHour(hour)}
            </label>
            <input
              type="range"
              min={0}
              max={24}
              step={0.25}
              value={hour}
              onChange={(e) => setHour(Number.parseFloat(e.target.value))}
              className="w-full"
            />
          </section>

          {daylight && (
            <section className="mb-4">
              <h2 className="mb-2 font-semibold">Daylight</h2>
              <dl className="space-y-1">
                <Row label="Sunrise" value={daylight.sunrise ? formatTime(daylight.sunrise) : "—"} />
                <Row label="Sunset" value={daylight.sunset ? formatTime(daylight.sunset) : "—"} />
                <Row
                  label="Total daylight"
                  value={daylight.daylightHours !== null ? `${daylight.daylightHours.toFixed(1)} h` : "—"}
                />
                <Row
                  label="Solar noon altitude"
                  value={
                    daylight.solarNoonAltitudeDeg !== null
                      ? `${daylight.solarNoonAltitudeDeg.toFixed(0)}°`
                      : "—"
                  }
                />
              </dl>
            </section>
          )}

          <section className="mb-4">
            <h2 className="mb-2 font-semibold">Nearest building</h2>
            {siteDataLoading && <p className="text-xs text-muted-foreground">Loading OSM data…</p>}
            {siteDataError && <p className="text-xs text-destructive">{siteDataError}</p>}
            {!siteDataLoading && !building && target && !siteDataError && (
              <p className="text-xs text-muted-foreground">No mapped building found nearby.</p>
            )}
            {building && (
              <dl className="space-y-1">
                {building.addressLabel && <Row label="Address" value={building.addressLabel} />}
                <Row label="Footprint area" value={`${building.areaM2.toFixed(0)} m²`} />
                <Row
                  label="Height"
                  value={`${building.heightM.toFixed(1)} m${
                    building.heightSource === "unknown" ? " (estimated)" : ""
                  }`}
                />
                <Row
                  label="Long axis"
                  value={`${bearingToCompass(building.longAxisBearingDeg)} / ${bearingToCompass(
                    building.longAxisBearingDeg + 180,
                  )}`}
                />
              </dl>
            )}
          </section>

          {facadeExposures && (
            <section className="mb-4">
              <h2 className="mb-2 font-semibold">Solar exposure by wall (est.)</h2>
              <p className="mb-2 text-xs text-muted-foreground">
                Rough sun-hours per wall direction for {dateStr}. Geometry + astronomy only —
                check the 3D shadow view for real obstructions.
              </p>
              <ul className="space-y-1">
                {facadeExposures.map((f) => (
                  <li key={f.compass} className="flex justify-between">
                    <span>{f.compass}-facing</span>
                    <span className="font-mono">{f.sunHours.toFixed(1)} h</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 font-semibold">Measurement</h2>
            <p className="text-xs text-muted-foreground">
              {lastMeasurement !== null
                ? `Last: ${lastMeasurement.toFixed(1)} m`
                : 'Toggle "Measure distance" above, then click two points in the scene.'}
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function formatHour(hour: number): string {
  const h = Math.floor(hour)
  const m = Math.round((hour - h) * 60)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}
