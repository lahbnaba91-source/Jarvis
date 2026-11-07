# Sky Radar

Apple Maps–style live map showing your position and the aircraft around you.

## How it works
- **Map:** MapLibre GL (bundled in `vendor/`) with OpenFreeMap vector styles — no API key, no limits. Light: Liberty. Dark: Dark (falls back to Fiord).
- **Location:** the browser's own location permission. Pauses when the screen locks.
- **Aircraft:** the public ADS-B feeds block direct calls from web pages (CORS), so `server.js` relays them at `/api/aircraft` — adsb.lol first, then airplanes.live, then adsb.fi. 4-second cache, 8-second refresh in the page, positions extrapolated in between.
- **Identifiers:** callsign, registration, ICAO address, aircraft type, operator, squawk, altitude, speed, climb rate. Route and schedule open on FlightAware.

## Deploy on Railway (from a phone)
1. Railway → New Project → Deploy from GitHub repo → `Jarvis`.
2. Open the new service → Settings:
   - **Source → Branch:** `sky-radar`
   - **Source → Root Directory:** `/sky-radar`
3. Settings → Networking → **Generate Domain**.
4. Open the domain in Safari or Chrome, tap **Use My Location**. Add to Home Screen for full-screen.

No environment variables or API keys needed. `npm start` runs `node server.js` (Node 18+, zero dependencies).

## Without the server
`index.html` alone (e.g. via raw.githack.com) shows the map and your position, but flights only load through the server.
