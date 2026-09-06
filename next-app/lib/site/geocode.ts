// Free geocoding via OpenStreetMap's Nominatim. No API key required; keep
// request volume light (Nominatim's usage policy caps at ~1 req/sec and asks
// for an identifiable client — the browser's own Referer header covers that
// for client-side calls like this one).

export interface GeocodeResult {
  lat: number
  lon: number
  displayName: string
  boundingBox: [south: number, north: number, west: number, east: number] | null
}

export async function geocodeAddress(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const url = new URL("https://nominatim.openstreetmap.org/search")
  url.searchParams.set("q", trimmed)
  url.searchParams.set("format", "jsonv2")
  url.searchParams.set("limit", "5")

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(`Geocoding failed: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as Array<{
    lat: string
    lon: string
    display_name: string
    boundingbox?: [string, string, string, string]
  }>

  return data.map((entry) => ({
    lat: Number.parseFloat(entry.lat),
    lon: Number.parseFloat(entry.lon),
    displayName: entry.display_name,
    boundingBox: entry.boundingbox
      ? (entry.boundingbox.map(Number.parseFloat) as [number, number, number, number])
      : null,
  }))
}
