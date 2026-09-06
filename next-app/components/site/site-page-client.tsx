"use client"

import dynamic from "next/dynamic"
import { ChevronUp, Ruler, Search, Share2, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { CesiumSceneHandle } from "@/components/site/cesium-scene"
import { geocodeAddress, type GeocodeResult } from "@/lib/site/geocode"
import {
  analyzeBuildingFootprint,
  summarizeCanopy,
  summarizeRoads,
  type BuildingProfile,
  type CanopySummary,
  type NearbyRoad,
} from "@/lib/site/geometry"
import {
  fetchSiteOsm,
  type CanopyArea,
  type LatLon,
  type OverpassWay,
  type TreePoint,
} from "@/lib/site/overpass"
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

// Stable empty references so scene effects keyed on these props don't re-run
// on every render before site data has loaded.
const EMPTY_ROADS: OverpassWay[] = []
const EMPTY_TREES: TreePoint[] = []
const EMPTY_CANOPIES: CanopyArea[] = []

interface SiteData {
  target: LatLon
  roads: OverpassWay[]
  trees: TreePoint[]
  canopies: CanopyArea[]
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
  const [sheetOpen, setSheetOpen] = useState(true)

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
        const osm = await fetchSiteOsm(currentTarget)
        if (cancelled) return
        const nearest = osm.buildings[0]
        setSiteData({
          target: currentTarget,
          roads: osm.roads,
          trees: osm.trees,
          canopies: osm.canopies,
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
  const roads = currentSiteData?.roads ?? EMPTY_ROADS
  const trees = currentSiteData?.trees ?? EMPTY_TREES
  const canopies = currentSiteData?.canopies ?? EMPTY_CANOPIES
  const buildingRing = currentSiteData?.buildingRing ?? null

  const nearbyRoads: NearbyRoad[] = useMemo(
    () => (currentSiteData ? summarizeRoads(currentSiteData.roads, currentSiteData.target) : []),
    [currentSiteData],
  )
  const canopySummary: CanopySummary | null = useMemo(
    () =>
      currentSiteData
        ? summarizeCanopy(currentSiteData.trees, currentSiteData.canopies)
        : null,
    [currentSiteData],
  )

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
    <div className="relative h-svh w-full overflow-hidden bg-background text-foreground">
      {/* Full-bleed 3D scene */}
      <div className="absolute inset-0">
        <CesiumScene
          ref={sceneRef}
          ionToken={ION_TOKEN}
          target={target}
          date={date}
          roads={roads}
          trees={trees}
          canopies={canopies}
          buildingHighlight={buildingRing}
          measurementMode={measurementMode}
          onMeasurement={setLastMeasurement}
        />
        {!target && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-muted-foreground">
            Search an address to load its 3D site.
          </div>
        )}
        {measurementMode && (
          <div className="pointer-events-none absolute inset-x-0 top-20 z-10 flex justify-center px-4">
            <span className="rounded-full bg-foreground/90 px-3 py-1 text-xs font-medium text-background shadow-lg">
              Tap two points in the scene
            </span>
          </div>
        )}
      </div>

      {/* Top: floating search */}
      <div className="absolute inset-x-0 top-0 z-20 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSearch()
          }}
          className="flex items-center gap-1 rounded-2xl border bg-background/90 p-1.5 shadow-lg backdrop-blur"
        >
          <Search className="ml-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={addressQuery}
            onChange={(e) => setAddressQuery(e.target.value)}
            placeholder="Search an address…"
            enterKeyHint="search"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground"
          />
          {addressQuery && (
            <button
              type="button"
              onClick={() => {
                setAddressQuery("")
                setSearchResults([])
                setSearchError(null)
              }}
              aria-label="Clear search"
              className="rounded-full p-2 text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={searching}
            className="shrink-0 rounded-xl bg-foreground px-3.5 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {searching ? "…" : "Go"}
          </button>
        </form>

        {searchResults.length > 0 && (
          <ul className="mt-1.5 overflow-hidden rounded-2xl border bg-background/95 text-sm shadow-lg backdrop-blur">
            {searchResults.map((r) => (
              <li key={`${r.lat},${r.lon}`} className="border-b last:border-b-0">
                <button
                  type="button"
                  onClick={() => selectResult(r)}
                  className="block w-full px-4 py-3 text-left leading-snug hover:bg-accent active:bg-accent"
                >
                  {r.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
        {searchError && (
          <p className="mt-1.5 rounded-xl border bg-background/95 px-3 py-2 text-xs text-destructive shadow backdrop-blur">
            {searchError}
          </p>
        )}
        {!ION_TOKEN && (
          <p className="mt-1.5 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs shadow backdrop-blur">
            No Cesium ion token — flat basemap only. Add <code>NEXT_PUBLIC_CESIUM_ION_TOKEN</code>{" "}
            to <code>next-app/.env.local</code> for 3D buildings, terrain, and shadows.
          </p>
        )}
      </div>

      {/* Right-edge action rail — sits just above the sheet on mobile */}
      <div
        className={cn(
          "absolute right-3 z-20 flex flex-col gap-2 transition-[bottom] duration-300 ease-out",
          sheetOpen
            ? "bottom-[calc(72svh+0.75rem)]"
            : "bottom-[calc(3.75rem+env(safe-area-inset-bottom)+0.75rem)]",
          "md:top-1/2 md:bottom-auto md:right-[calc(360px+1.5rem)] md:-translate-y-1/2",
        )}
      >
        <button
          type="button"
          onClick={() => setMeasurementMode((m) => !m)}
          aria-pressed={measurementMode}
          aria-label="Measure distance"
          className={cn(
            "flex size-12 items-center justify-center rounded-full border bg-background/90 shadow-lg backdrop-blur",
            measurementMode && "border-foreground bg-foreground text-background",
          )}
        >
          <Ruler className="size-5" />
        </button>
        {measurementMode && (
          <button
            type="button"
            onClick={() => sceneRef.current?.clearMeasurements()}
            className="flex size-12 items-center justify-center rounded-full border bg-background/90 text-xs font-medium shadow-lg backdrop-blur"
          >
            Clear
          </button>
        )}
        <button
          type="button"
          onClick={handleShare}
          disabled={!target}
          aria-label="Share this view"
          className="flex size-12 items-center justify-center rounded-full border bg-background/90 shadow-lg backdrop-blur disabled:opacity-40"
        >
          {copiedShare ? (
            <span className="text-[10px] font-semibold">Copied</span>
          ) : (
            <Share2 className="size-5" />
          )}
        </button>
      </div>

      {/* Bottom sheet (mobile) / floating side card (md+) */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-2xl border-t bg-background/95 shadow-2xl backdrop-blur transition-[max-height] duration-300 ease-out",
          "md:inset-x-auto md:top-4 md:right-4 md:bottom-4 md:w-[360px] md:rounded-2xl md:border",
          sheetOpen
            ? "max-h-[72svh] md:max-h-[calc(100svh-2rem)]"
            : "max-h-[3.75rem] md:max-h-[3.75rem]",
        )}
      >
        <button
          type="button"
          onClick={() => setSheetOpen((o) => !o)}
          aria-expanded={sheetOpen}
          className="relative flex shrink-0 items-center gap-3 px-4 pt-3 pb-2.5"
        >
          <span className="absolute inset-x-0 top-1.5 mx-auto h-1 w-9 rounded-full bg-muted-foreground/30 md:hidden" />
          <span className="flex-1 truncate text-left text-sm font-semibold">
            {building?.addressLabel
              ? building.addressLabel.split(",")[0]
              : target
                ? "Site details"
                : "Sun & site"}
          </span>
          <ChevronUp
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              sheetOpen && "rotate-180",
            )}
          />
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm">
          <section className="mb-5">
            <h2 className="mb-2 font-semibold">Sun position</h2>
            <label className="mb-1 block text-xs text-muted-foreground">Date</label>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className="mb-3 w-full rounded-lg border bg-transparent px-3 py-2"
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
              className="h-6 w-full"
            />
          </section>

          {daylight && (
            <section className="mb-5">
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

          <section className="mb-5">
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

          {target && (
            <section className="mb-5">
              <h2 className="mb-2 font-semibold">Nearby roads</h2>
              {siteDataLoading && (
                <p className="text-xs text-muted-foreground">Loading OSM data…</p>
              )}
              {!siteDataLoading && nearbyRoads.length === 0 && !siteDataError && (
                <p className="text-xs text-muted-foreground">No mapped roads nearby.</p>
              )}
              {nearbyRoads.length > 0 && (
                <ul className="space-y-1">
                  {nearbyRoads.slice(0, 8).map((r) => (
                    <li key={`${r.name}-${r.highway}`} className="flex justify-between gap-2">
                      <span className={cn("truncate", !r.named && "text-muted-foreground")}>
                        {r.name}
                        <span className="ml-1 text-xs text-muted-foreground">· {r.classLabel}</span>
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {formatMeters(r.distM)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {target && (
            <section className="mb-5">
              <h2 className="mb-2 font-semibold">Trees &amp; canopy</h2>
              {siteDataLoading && (
                <p className="text-xs text-muted-foreground">Loading OSM data…</p>
              )}
              {!siteDataLoading && canopySummary && (
                <>
                  <dl className="space-y-1">
                    <Row label="Mapped trees" value={`${canopySummary.treeCount}`} />
                    <Row
                      label="With real height"
                      value={`${canopySummary.treesTagged} / ${canopySummary.treeCount || 0}`}
                    />
                    <Row
                      label="Canopy area"
                      value={
                        canopySummary.canopyPatches > 0
                          ? `${canopySummary.canopyAreaM2.toFixed(0)} m² (${canopySummary.canopyPatches})`
                          : "—"
                      }
                    />
                  </dl>
                  {canopySummary.treeCount === 0 && canopySummary.canopyPatches === 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Nothing mapped here — that doesn&apos;t mean there are no trees, only that
                      OSM has none recorded. Trust the 3D shadow view for what&apos;s actually
                      there.
                    </p>
                  )}
                  {(canopySummary.treeCount > 0 || canopySummary.canopyPatches > 0) && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Trees without a height tag are drawn at ~9 m. They cast shadows in the 3D
                      view.
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {facadeExposures && (
            <section className="mb-5">
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
                : "Tap the ruler, then tap two points in the scene."}
            </p>
          </section>
        </div>
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

function formatMeters(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`
  return `${Math.round(m)} m`
}

function formatHour(hour: number): string {
  const h = Math.floor(hour)
  const m = Math.round((hour - h) * 60)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}
