# Sky Radar

A single-page, Apple Maps–style live map that shows your position and the aircraft around you.

- **Open it:** https://raw.githack.com/lahbnaba91-source/Jarvis/sky-radar/sky-radar/index.html
- **Location:** the browser's own location permission (no Find My, no app install). Safari pauses it when the screen locks.
- **Aircraft:** live ADS-B from free community feeds — adsb.lol first, then airplanes.live, then adsb.fi if one is down. Refreshed every 8 s, positions extrapolated between refreshes.
- **Identifiers:** real callsign, registration, ICAO address, aircraft type, operator, squawk, altitude, speed and climb rate, straight from the feed. Route and schedule open on FlightAware.
- **Map:** CARTO Voyager (light) / Dark Matter (dark) tiles over OpenStreetMap.
- **Home screen:** Safari › Share › Add to Home Screen opens it full-screen like an app.

Everything is in `index.html` — no build step, no keys, no server.
