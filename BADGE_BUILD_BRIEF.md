# BADGE — build brief for JARVIS

**A JARVIS domain agent. Every other radiation-exposed worker in America gets a badge. Flight crews don't. This is the badge.**

Version 1.0 — authoritative build brief. Supersedes all earlier BADGE drafts.

> **Provenance note.** An earlier working file (`BADGE_SPEC_UNVERIFIED.md`) picked up sections 13–17
> of unknown origin covering ML/analytics, compliance, geospatial, and sensor scope. That content was
> not authored as part of this design process and is excluded here. Do not build from it without
> independently verifying its claims. This file contains only reviewed material.

---

## 0. What we are building

A personal, portable, append-only radiation dose ledger for aircrew, running as a domain agent
inside JARVIS.

It reconstructs where and how high a pilot actually flew from the aircraft's own ADS-B broadcast,
models the galactic cosmic radiation dose that trajectory earned, overlays any solar particle event
that was live during the flight window, writes an immutable record, and keeps a running career total
against occupational limits. An LLM layer converts that into plain language:

> *"You're at 38% of your annual limit. Your next three polar flights add ~0.9 mSv. There's an S2
> storm running — LAX–ICN tonight at FL390 costs you roughly 3× normal."*

**The point is not to produce a number. The point is to produce a decision.**

No hardware to buy. Works backwards across a career already flown.

---

## 1. Why this exists — the 2026 National Academies finding

In June 2026 NASEM released *Assessing Radiation Exposure, Health Outcomes, and Mitigation
Strategies for Flight Crewmembers*, congressionally mandated by the FAA Reauthorization Act of 2024.
Finding: regulatory protections are insufficient, and the lack of data itself complicates
understanding the risk. Crews "accumulate significant dose with no centralized record or cap." ALPA
was blunter — flight crews are effectively the only radiation-exposed workforce in America without
the basic protections other radiation workers get.

### 1.1 Root causes → design requirements

| # | Root cause | Why it happens | BADGE response |
|---|---|---|---|
| C1 | **No system of record** | FAA treats cosmic radiation as advisory, not regulated occupational exposure. Nobody is *required* to keep a record, so nobody does. | Append-only, hash-chained ledger owned by the crewmember. Exists regardless of who regulates. |
| C2 | **Non-portable history** | Even where an airline estimates dose, the record dies at employer change. 25 years across 3 airlines = 3 partial records, or none. | Crew-owned, exportable (signed JSON + CSV). Employer is a data *source*, never custodian. |
| C3 | **Models cover GCR, not solar events** | CARI-6/-7 model galactic cosmic radiation well. FAA has stated it has no program or web app for estimating solar particle event dose, and that individual SPE dose cannot be estimated in advance. The biggest spikes are the ones nobody logs. | Two channels: baseline GCR (deterministic) + SPE overlay (from live NOAA GOES proton flux). Separate fields, separate confidence. |
| C4 | **No real-time awareness** | Dose is computed retrospectively, if at all. No way to know mid-trip that an S3 storm started. | Continuous space weather ingest with alerting, plus pre-flight projection. |
| C5 | **Illegibility** | mSv means nothing to a human. NASEM explicitly calls out empowering crewmembers to make decisions about their health — a communication failure, not a physics failure. | LLM briefing layer turning dose into comparisons and concrete options. |
| C6 | **Broken epidemiology loop** | Flight crew studies are inconclusive partly *because* exposure data is bad. Bad data → weak studies → no regulatory urgency → no data requirement. Circular. | Schema-stable, research-grade export with full provenance. |

### 1.2 The core insight

**C6 is load-bearing.** The regulatory gap persists because the evidence is weak, and the evidence is
weak because there is no data pipeline. Everything else is downstream.

So BADGE is **a data-collection instrument that happens to be useful to the individual today**.
Individual utility is the acquisition strategy; the aggregate dataset is the actual product.

That drives every schema decision: **never store a computed number without the inputs and model
version that produced it**, because in five years someone will want to recompute the whole corpus
with a better model.

### 1.3 What BADGE is NOT

- Not a regulatory dosimetry record of legal standing.
- Not a medical device, not medical advice. It reports modeled exposure against published reference
  limits. Health decisions belong with an AME or physician.
- Not a physical dosimeter. It models.

---

## 2. Regulatory framing — TSO is the wrong target

**Do not pursue a TSO.** A Technical Standard Order is a minimum performance standard for aircraft
parts and appliances — installed equipment. BADGE is software. No TSO covers radiation dosimetry.

### 2.1 The standards that apply

**ISO 20785 — *Dosimetry for exposures to cosmic radiation in civilian aircraft*** (ISO/TC 85/SC 2):

| Part | Title | Relevance |
|---|---|---|
| -1 (2020) | Conceptual basis for measurements | Vocabulary and calibration basis. Read first. |
| -2 (2020) | Characterization of instrument response | Hardware conformance path — only if a detector ever ships. |
| -3 (2023) | Measurements at aviation altitudes | Governs measured-dose ingest. |
| **-4** (2019 / EN 2021) | **Validation of codes** | Guidance for validating computational codes that calculate doses aboard aircraft; defines functional requirements for dose-calculation software and validation against measurement and reference benchmarks. |
| -5 (in development) | Intermittent sources at aviation altitudes | The SPE-adjacent standard. Watch it. |

**ISO 20785-4 is the conformance target.** It is written for exactly what BADGE is. Achievable by a
small team, and it is the credential that makes an airline or union take the output seriously.

### 2.2 The European driver

Following ICRP-60 (confirmed by ICRP-103), the EU introduced a revised Basic Safety Standards
Directive treating natural ionizing radiation — cosmic radiation included — as occupational
exposure. It requires account to be taken of the exposure of aircraft crew liable to receive more
than 1 mSv per year, with protection measures beginning with **assessing the exposure of the crew
concerned**. Requirements for determining and recording aircrew exposure are in national legislation
across EU member states and other countries.

The European mandate is for **assessment and recording** — a software obligation, not hardware
certification. That makes the EU the more receptive first market: the legal duty already exists
there while the US is still at the recommendation stage.

### 2.3 Roadmap

1. P1–P5: build to ISO 20785-1 vocabulary and -4 functional requirements from day one.
2. Validation: benchmark against CARI-7 reference values and published measurement campaigns.
3. Only if hardware ships: -2 and -3.
4. Never: TSO.

---

## 3. Dose model

### 3.1 Engine selection

| Engine | Verdict |
|---|---|
| **CARI-7 / CARI-7A** (FAA CAMI) | Reference standard — waypoint or geodesic routes, altitudes to 300,000 ft, dates from 1958, ICRP-60/-103/H*(10) dose types. But a Windows/Fortran desktop program driven by init files. **Validation oracle, not runtime.** |
| **PARMA4 / EXPACS** (JAEA, Sato) | Analytical model fitted to PHITS air-shower simulations. Free. A C++ port exists (`WeiMXi/PARMA`) whose readme states it is explicitly designed for embedding in route-dose calculation systems. **Runtime engine.** |
| NAIRAS (NASA) | Third comparison point, useful for SPE-period cross-checks. Not a dependency. |

**PARMA4 computes, CARI-7 validates.** Build `tests/validation/` with ~20 canonical routes having
published CARI-7 values; assert BADGE lands within tolerance. That suite is the credibility of the
product and the core artifact of ISO 20785-4 conformance.

### 3.2 Pipeline

```
ADS-B track (or fallback source)
  → route resolution   (ADS-B > wearable > filed waypoints > great-circle)
  → vertical profile   (ADS-B pressure altitude > wearable GNSS > synthesized)
  → sample points, 60 s cadence: lat, lon, altitude, altSource, UTC
  → atmospheric depth (g/cm²) — direct from pressure altitude
       optional: correct standard-pressure reference against GFS/ERA5 actual pressure
  → geomagnetic cutoff rigidity per point
  → solar modulation parameter for that date
  → PARMA4 → dose rate (µSv/h) per point
  → integrate → GCR effective dose (mSv)
  → SPE overlay if a proton event was active in the window
  → ledger write with full provenance
```

Every intermediate persists. Model version, solar params, and telemetry source stored per entry so
the ledger can be fully recomputed later.

### 3.3 The altitude sensitivity constant — memorize this

Dose rate at cruise **roughly doubles for every 2,000 m (~6,000 ft)** of altitude. Consistently
reported across sources; NAIRAS/ARMAS comparison work found GCR dose rate depends more strongly on
altitude than on cutoff rigidity.

```
d(dose)/dose  =  ln(2) / 6000 ft  ×  Δaltitude_error
              ≈  1.16 × 10⁻⁴ per foot

  100 ft error  ≈  1.2% dose error
  500 ft error  ≈  5.9%
 1000 ft error  ≈ 12.3%
 2000 ft error  ≈ 26.0%
```

**Altitude accuracy dominates the entire telemetry error budget.** Horizontal error of several
kilometres barely moves the answer. Design accordingly.

---

## 4. Space weather subsystem

### 4.1 Sources

NOAA SWPC publishes open JSON/text over HTTPS, no auth, no key — a static file service, not a query
API. Poll and cache.

```
https://services.swpc.noaa.gov/products/noaa-scales.json
https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json
https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json
https://services.swpc.noaa.gov/products/alerts.json
https://services.swpc.noaa.gov/products/summary/planetary-k-index.json
```

Historical fluence and event archives under `https://services.swpc.noaa.gov/json/goes/` and NCEI for
backfill.

### 4.2 Thresholds

The ≥10 MeV integral proton flux drives the NOAA S-scale at 10 / 100 / 1,000 / 10,000 / 100,000 pfu
(S1→S5); SWPC's proton event threshold is 10 pfu at ≥10 MeV. A separate ≥100 MeV product uses a 1 pfu
threshold — **that one matters more for aviation**, because higher-energy protons penetrate deeper
and are what reach cruise altitude. Ingest both; weight ≥100 MeV heavily in the aviation risk score.

SWPC issues S1-or-greater warnings, per-level S1–S5 alerts, and post-event summaries with
start/max/end times and peak flux — ideal for retrospective attribution.

### 4.3 SPE overlay

FAA has no tool for this. This is where BADGE earns its keep.

1. Detect overlap between the flight's UTC window and any active proton event.
2. Apply a **geomagnetic exposure factor** — SPE protons funnel down field lines near the poles, so a
   polar route during an event is a completely different exposure than an equatorial one. Published
   SPE analyses show events producing essentially no increase between roughly 40°S and 40°N while
   being severe at high latitude, with both time and longitude dependence. Gate on cutoff rigidity
   along the actual track.
3. Apply an altitude penetration factor keyed to the ≥100 MeV channel.
4. Emit with an explicit uncertainty band, `confidence: "low"`, `method: "empirical-overlay-v1"`.

**Never merge SPE into the GCR number silently.** Separate fields, both surfaced. Honesty about
uncertainty is the credibility of the product.

---

## 5. Limits & advisory engine

Limits are configurable policy objects, never hardcoded constants.

```json
{
  "policyId": "icrp-103-occupational",
  "annualLimitMSv": 20,
  "averagingWindowYears": 5,
  "singleYearCeilingMSv": 50,
  "pregnancy": { "totalMSv": 1, "monthlyMaxMSv": 0.5, "basis": "declared pregnancy, remainder of term" },
  "source": "ICRP-103 / FAA AC 120-61B",
  "verifyBeforeUse": true
}
```

> **Build note:** pull exact current values from FAA AC 120-61B (or successor), ICRP-103, and the EU
> BSS Directive at implementation time and cite them in-app. Do not ship the above as authoritative.
> An advisory tool quoting a stale limit is worse than one quoting none.

Outputs: `pctOfAnnual`, `pctOf5YearAverage`, `projectedYearEnd`, `daysToThreshold`, `breachRisk`, and
the top-3 highest-dose flights driving the total.

---

## 6. Telemetry — ADS-B first

### 6.1 Source ranking

| Rank | Source | Confidence | Why |
|---|---|---|---|
| 1 | **ADS-B** | high | The aircraft's own broadcast. No hardware, no battery, works retrospectively. |
| 2 | **Garmin (Connect IQ)** | high | Full-flight GNSS endurance. Fills ADS-B coverage gaps. |
| 3 | **Apple Watch** | medium | Comparable GNSS hardware on Ultra, battery-limited coverage. |
| 4 | **Synthesized** | low | Filed route + assumed cruise altitude. Fallback, never the plan. |

### 6.2 Why ADS-B wins — the atmospheric-depth argument

ADS-B broadcasts **two** altitudes: barometric (pressure altitude from the aircraft's air data
computer, standard-pressure referenced) and geometric (GNSS, height above WGS84 ellipsoid). Having
both allows applications needing one or the other, and provides a means of verifying correct
pressure altitude reporting.

**First:** the aircraft's barometric altitude is *not* cabin altitude. It is flight level — pressure
measured outside the pressure vessel. The cabin-pressurization trap (§6.4) applies only to worn
devices. ADS-B is immune.

**Second, and this is the one that matters:** cosmic ray dose is governed by **atmospheric depth** —
the mass of air above you in g/cm² — not geometric height. Pressure altitude is a direct measurement
of exactly that. Geometric altitude must be converted to depth through an atmosphere model, an extra
step with its own error.

PARMA is parameterized on atmospheric depth. **ADS-B pressure altitude is therefore the physically
preferred input, not a compromise.** The wearables' GNSS altitude is the compromise.

**Refinement worth building:** ADS-B pressure altitude is standard-pressure referenced and not
corrected for actual local pressure. For true depth, correct each sample against reanalysis/NWP
pressure fields (GFS / ERA5) at that lat/lon/time. A genuine accuracy gain over every consumer tool
in this space, and defensible under ISO 20785-4.

**Use geometric altitude as a quality signal, not a correction.** Published analysis found barometric
readings higher than geometric at cruise, absolute differences ranging 25 ft to 1,325 ft, averaging
about 569 ft, with larger discrepancies during climb; a separate study found only 8.7% of altitude
deviations fell within ICAO's 245 ft RVSM requirement. Large divergence flags possible altimetry
system error on that airframe — record it as a data-quality note, never "average the two."

**Quantization:** geometric altitude updates less often than barometric (often every fourth record);
readings round to 25 ft or 100 ft. Per §3.3 that is 0.3–1.2% dose error. Negligible.

### 6.3 ADS-B's real weakness: coverage fails where dose peaks

Terrestrial ADS-B is line-of-sight from ground stations. Oceanic and polar regions have sparse to no
coverage — precisely the high-latitude, long-duration routes producing the highest doses. **This is
the central limitation and must be handled explicitly.**

1. **ADS-C.** OpenSky publishes an ADS-C dataset aimed at improving crowdsourced trajectories; ADS-C
   is the standard surveillance method in oceanic airspace. Ingest as a second channel.
2. **Watch cross-fill.** A wearable has no ground-station dependency. ADS-B and the watch fail under
   *opposite* conditions — mid-ocean versus battery drain. Genuinely complementary, not redundant.
3. **Space-based ADS-B** (Aireon) covers the poles but is enterprise-priced. Future path.
4. **Gap interpolation.** Great-circle at last-known flight level. Tag every interpolated segment and
   subtract from `coveredFraction`. Never present interpolation as recorded data.

### 6.4 The cabin-baro trap — WEARABLES ONLY

Inside a pressurized cabin a worn barometric altimeter measures *cabin* pressure altitude, typically
6,000–8,000 ft — not aircraft altitude. At FL390 that is wrong by ~31,000 ft, understating dose by
well over an order of magnitude. Applies to every consumer wearable, Garmin included. Does **not**
apply to ADS-B.

Rules for worn devices:

1. Use GNSS geometric altitude. Never their baro.
2. If the platform fuses baro into altitude output, reject it and take raw GNSS.
3. **Pressurization detector:** if a wearable's baro and GNSS altitude diverge by more than ~3,000 ft,
   the cabin is pressurized — hard-discard baro for that segment.
4. Wearable baro *is* valid in unpressurized GA aircraft. Detect and switch; never assume.
5. Log altitude source per sample.

### 6.5 Telemetry error budget

Failure mode A — vertical error, propagated through §3.3:

| Source | Vertical error (est.) | Dose error |
|---|---|---|
| **ADS-B pressure altitude** | native depth measure; 25–100 ft quantization | **0.3 – 1.2%** |
| Garmin, multi-band GNSS in cabin | ±150–300 ft | 1.7 – 3.5% |
| Apple Watch Ultra (L1+L5) | ±200–350 ft | 2.3 – 4.1% |
| Apple Watch Series (L1 only) | ±300–600 ft | 3.5 – 7.0% |

**ADS-B is roughly an order of magnitude better than any wearable** on the dominant term. And on raw
GNSS hardware, **Apple Watch Ultra is roughly comparable to Garmin** — the gap between them is not
in the sensor.

Failure mode B — coverage loss (wearables). Continuous high-rate GNSS is the most power-hungry thing
a watch does. Uncovered fraction of flight:

| Flight length | Garmin | Apple Series | Apple Ultra |
|---|---|---|---|
| ≤3 h | 0% | ~0% | 0% |
| 5–8 h | 0% | ~20–40% | 0% |
| 12 h | 0% | ~50–60% | ~10–25% |
| 15 h+ | 0% | ~60–70% | ~25–40% |

Combined telemetry-induced dose uncertainty:

| Flight length | ADS-B | Garmin | Apple Ultra | Apple Series |
|---|---|---|---|---|
| ≤3 h | ~1% | ~3% | ~4% | ~6% |
| 5–8 h | ~1% | ~3% | ~4% | ~9% |
| 12 h | ~1%* | ~3% | ~6% | ~12% |
| 15 h+ | ~1%* | ~3% | ~8% | ~14% |

\* assumes ground coverage. On oceanic/polar segments without ADS-C, ADS-B degrades to interpolated
and is *worse* than a watch that held its recording — which is why cross-fill matters.

**Headline:** ADS-B carries ~3× lower dose uncertainty than the best wearable where coverage exists.
Apple Watch carries ~30–50% higher uncertainty than Garmin on short/medium sectors, rising to 2–4× on
long-haul; Ultra closes most of that gap below ~10 hours.

**Confidence:** these are engineering estimates from consumer GNSS performance and published
endurance figures, not measured in-flight benchmarks. **P6 must replace this table with real data** —
fly both watches on one sector, compare against the ADS-B track, publish the numbers. Label the table
as estimated in the app until then.

### 6.6 ADS-B data sources

| Source | Access | Notes |
|---|---|---|
| **OpenSky Network** | Free, research-friendly. REST for live, Trino for historical. | **Start here.** Historical tables follow RTCA DO-260B (`position_data4`, `velocity_data4`, `operational_status_data4`, `identification_data4`), plus MLAT state vectors and the ADS-C dataset. |
| ADSB.lol / ADS-B Exchange | Free / community, unfiltered | Cross-check. |
| FlightAware AeroAPI | Paid | Altitudes returned are typically uncorrected pressure altitudes; GNSS altitude collected but not fully exposed. Confirm before depending on it. |
| Flightradar24 | Paid | Broad coverage, restrictive terms. |
| Aireon | Enterprise | Space-based, global including poles. |

### 6.7 Source confidence tags

```
telemetrySource: "adsb-baro"       → high    (preferred; native atmospheric depth)
                 "adsb-geom"       → high
                 "adsc"            → medium  (oceanic, lower sample rate)
                 "garmin-fit"      → high
                 "apple-healthkit" → medium
                 "logbook-import"  → low
                 "synthesized"     → low
                 "interpolated"    → low     (gap-fill; excluded from coveredFraction)
                 "merged"          → per-segment, + sourceBreakdown
```

`coveredFraction` (0–1) is mandatory on any partially-recorded flight and must be surfaced. A 12-hour
flight recorded 45% is not the same datum as one recorded 100%.

---

## 7. Backend architecture

```
services/badge/
  index.js                    # JARVIS agent registration, intent handlers
  engine/
    parma.js                  # subprocess / N-API wrapper around PARMA4
    profile.js                # telemetry → sampled 4D flight profile
    depth.js                  # pressure altitude → atmospheric depth, GFS/ERA5 correction
    geomag.js                 # cutoff rigidity lookup (precomputed 1° grid, static asset)
    solarmod.js                # solar modulation parameter by date
    integrate.js               # dose-rate integration
    spe.js                     # solar particle event overlay
  telemetry/
    adsb.js                    # OpenSky REST + Trino historical, DO-260B decode
    adsc.js                    # oceanic ADS-C channel
    wearable.js                # FIT / HealthKit normalizers
    pressurization.js          # baro-vs-GNSS divergence detector (§6.4)
    merge.js                   # multi-source per-segment fusion, ADS-B preferred
    coverage.js                # gap detection, coveredFraction
  spaceweather/
    poller.js                  # cron ingest of SWPC endpoints
    cache.js                   # last-known-good, survives SWPC outage
    classify.js                # raw flux → aviation risk score
    alerts.js                  # threshold crossing → push
  ledger/
    store.js                   # append-only writes
    verify.js                  # hash-chain integrity check
    export.js                  # signed JSON + CSV + research schema
  policy/
    limits.js                  # configurable limit policies
    advisor.js                 # status computation
  brief/
    prompt.js                  # LLM system prompt + tool schema
    render.js                  # structured JSON → terse human text
  conformance/
    iso20785.js                # functional-requirement checks, validation harness
  api/
    routes.js
  public/                      # the dashboard — see §9
```

**Storage:** SQLite to start (matches the prior JARVIS vehicle-tracking pattern); schema written so a
Postgres swap is mechanical. Ledger is append-only — no UPDATE, no DELETE. Corrections are new rows
with `supersedes: <id>`.

**Runtime:** Node/Express. Codespaces for development (§10). The SWPC poller must be always-on, so
Railway hosts it in production — Codespaces sleeps.

**LLM:** Groq. The model never computes dose. It receives a structured JSON status object and renders
language. Enforce it — a hallucinated mSv figure is a safety problem, not a quality problem. Add a
validation step asserting every numeral in LLM output appears in the input JSON.

---

## 8. API surface

### `POST /api/badge/flights`
Log a flight and compute dose.

```json
// in — ADS-B path (preferred)
{ "callsign": "UAL892", "tail": "N2846U", "dateUtc": "2026-09-14", "role": "pilot" }

// in — explicit track
{ "telemetrySource": "adsb-baro",
  "track": [ { "t": "2026-09-14T05:41:12Z", "lat": 33.94, "lon": -118.41,
               "altFt": 39000, "altSource": "baro" } ] }

// in — no-telemetry fallback
{ "origin": "LAX", "destination": "ICN",
  "departUtc": "2026-09-14T05:40:00Z", "arriveUtc": "2026-09-14T18:15:00Z",
  "cruiseAltitudeFt": 39000, "telemetrySource": "synthesized" }

// out
{
  "flightId": "flt_01J...",
  "durationHours": 12.58,
  "dose": {
    "gcrMSv": 0.081, "gcrConfidence": "high", "gcrModel": "PARMA-4.10",
    "speMSv": 0.0, "speConfidence": null,
    "totalMSv": 0.081, "uncertaintyPct": 1.1
  },
  "telemetry": {
    "source": "adsb-baro", "coveredFraction": 1.0,
    "altSource": "baro", "baroGeomDivergenceFt": 480, "qualityFlag": "nominal"
  },
  "peakDoseRateUSvPerHr": 7.4,
  "maxLatitude": 62.1,
  "solarParams": { "wIndex": 71, "forceFieldMV": 612 },
  "spaceWeatherAtDeparture": { "sScale": "S0", "protons10MeV": 0.21, "protons100MeV": 0.008 },
  "ledgerHash": "sha256:..."
}
```

### `POST /api/badge/project`
Same shape, **no ledger write**. "What will this trip cost me?" Uses forecast space weather. Drives
pre-flight and bid planning.

### `GET /api/badge/status`
```json
{ "ytdMSv": 3.42, "rolling12moMSv": 4.11, "fiveYearAvgMSv": 3.98,
  "pctOfAnnualLimit": 20.6, "projectedYearEndMSv": 5.9,
  "policyId": "icrp-103-occupational", "flightsLogged": 214,
  "meanUncertaintyPct": 2.1,
  "topContributors": [ { "flightId": "...", "route": "JFK-NRT", "mSv": 0.11 } ] }
```

### `GET /api/badge/spaceweather`
Current + 3-day forecast, normalized. Includes `aviationRiskScore` (0–100, weighted toward ≥100 MeV
and S-scale), `lastUpdated`, `stale: bool`.

### `GET /api/badge/flights?from=&to=&limit=`
Paginated ledger for the dashboard list view.

### `GET /api/badge/flights/:id`
Full flight detail including the sampled dose-rate series for charting.

### `POST /api/badge/backfill`
Career reconstruction. In: list of `{callsign|tail, date}` or a roster blob. Runs async, returns a
job id. Poll `GET /api/badge/backfill/:jobId`.

### `POST /api/badge/brief`
LLM layer. In: optional question. Out: `{ "text": "...", "sourceData": {...} }`. 3–5 sentences.

### `GET /api/badge/export?format=json|csv|research`
Full ledger with provenance. `research` strips identity, keeps route, dose, model version, solar
params, telemetry source, coverage.

### `POST /api/badge/measured`
Optional detector reading, characterized per ISO 20785-2. Separate field, never overwrites the model.

### `GET /api/badge/verify`
`{ "intact": true, "entries": 214, "brokenAt": null }`

### `GET /api/badge/conformance`
ISO 20785-4 validation status: benchmark routes, deviation from CARI-7 reference values, model
version, last run.

---

## 9. The dashboard — how the information is displayed

### 9.1 Stack decision: no build step

**Serve a static `public/` directory from the same Express process that serves the API.** Plain HTML,
CSS, and vanilla JS. No React, no Vite, no bundler.

Reasons, in order:

1. **Same origin, same port → zero CORS.** The dashboard fetches `/api/badge/status` as a relative
   path. Nothing to configure, nothing to break behind Codespaces port forwarding.
2. **Mobile-only workflow.** Development happens from an iPhone. A build step means `npm run build`
   on every change through a phone terminal — a tax paid on every iteration forever.
3. **One process, one port.** Simpler to forward, simpler to reason about, simpler to move to Railway.

```js
// in api/routes.js or server.js
app.use(express.static(path.join(__dirname, '../public')));
```

Charts without a bundler: generate **inline SVG in JS**. A dose-rate line and a cumulative bar are
~40 lines of path-building each. If something heavier is needed later, load uPlot or Chart.js from a
CDN `<script>` tag — still no build step.

### 9.2 Visual language

Inherit the existing JARVIS HUD: black background, amber primary, Orbitron display face with a
sane fallback stack. But **the data is medical-adjacent, so legibility beats theatre**. Amber for
chrome and accents; a plain high-contrast sans for every number the user has to read and trust.

```css
:root {
  --bg:        #0a0a0a;
  --panel:     #121212;
  --amber:     #ffb000;
  --amber-dim: #7a5400;
  --text:      #e8e8e8;
  --muted:     #8a8a8a;
  --ok:        #3fb950;   /* well under limit */
  --warn:      #d29922;   /* approaching */
  --alert:     #f85149;   /* over / SPE active */
  --low-conf:  #6e7681;   /* low-confidence data */
}
```

Mobile-first: ~380 px design width, 44 px minimum touch targets, single column, bottom tab bar.

### 9.3 Screens

**1 — NOW (default view)**

The glanceable one. Top to bottom:

- **Space weather strip.** S-scale badge (S0–S5), ≥10 MeV and ≥100 MeV proton flux, `aviationRiskScore`
  as a 0–100 bar. **Staleness badge is mandatory** — green "live" or amber "cached 14m ago". Never
  render cached values as live.
- **Dose gauge.** YTD mSv as a radial arc against the annual limit, with the percentage large and the
  raw mSv beneath it. Arc colour from `--ok` / `--warn` / `--alert`.
- **Projection line.** Projected year-end against the limit, with `daysToThreshold` when applicable.
- **AI brief card.** 3–5 sentences from `/api/badge/brief`, amber-bordered. This is the "JARVIS
  talking" element. Refresh button, not auto-polling.
- **Last flight summary.** Route, dose, uncertainty, confidence chip.

**2 — LEDGER**

Reverse-chronological flight list. Each row: date, route, mSv, and a **confidence chip** colour-coded
by `telemetrySource`. Rows with `coveredFraction < 1` show it inline ("62% recorded"). Filter by
year, route, or confidence. Search. Export button hits `/api/badge/export`.

**3 — FLIGHT DETAIL**

- Dose-rate line chart across the flight (µSv/h vs time), with the altitude profile overlaid on a
  second axis. This is the chart that makes the physics visible — the reader sees dose rate climb
  with altitude and again with latitude.
- Great-circle track on a simple equirectangular SVG world map, coloured by dose rate. No tile
  provider, no API key — a static world outline SVG is enough and keeps the page self-contained.
- Provenance panel: model version, solar params, telemetry source, `coveredFraction`,
  `baroGeomDivergenceFt`, quality flags. **This panel is not optional.** It is what separates BADGE
  from a toy.
- GCR and SPE shown as **separate rows**, never summed into one unqualified figure.

**4 — PROJECT**

Route/altitude/date form → `/api/badge/project` → projected dose, with a comparison against the
user's YTD position. Altitude slider showing dose changing live is the single most persuasive UI
element in the product: drag FL350 → FL410 and watch the number climb. That is §3.3 made tangible.

**5 — BRIEF**

Full conversational view against `/api/badge/brief`. Question box, response history.

### 9.4 Display guardrails — enforce in the render layer

1. **No number without its uncertainty.** Every mSv figure renders with `± x%` or a confidence chip.
2. **No cached space weather without a staleness badge.**
3. **GCR and SPE never summed into one unqualified number.** Separate lines, always.
4. **`coveredFraction < 1` always visible** on that flight, in the list and in detail.
5. **Low-confidence data renders in `--low-conf`, not the normal text colour.** Synthesized and
   interpolated segments must look different from recorded ones at a glance.
6. **The medical-disclaimer line appears once**, in the footer or on first load — not repeated on
   every card.
7. **Never display a figure the backend did not compute.** The frontend does no dose math, not even
   unit conversion that changes a value.

### 9.5 Offline behaviour

Codespaces sleeps. The dashboard will frequently open against a dead backend.

- Cache the last successful `/api/badge/status` and `/api/badge/spaceweather` in memory and in
  `localStorage`.
- On fetch failure, render the cached view with a **prominent amber "BACKEND OFFLINE — showing data
  from {timestamp}"** banner. Never a blank screen, never a spinner that spins forever.
- Disable write actions while offline rather than queuing them silently.

---

## 10. Running it in Codespaces

### 10.1 Port forwarding

```js
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`BADGE on ${PORT}`));
```

**Bind `0.0.0.0`, not `127.0.0.1`.** Codespaces cannot forward a loopback-only listener — this is the
single most common failure and it produces a silent "connection refused" with no useful error.

Codespaces auto-detects the listening port and issues a forwarded URL of the form
`https://<codespace-name>-<port>.app.github.dev`. Open that in Safari — it is the dashboard.

Commit the port config so it survives rebuilds:

```json
// .devcontainer/devcontainer.json
{
  "forwardPorts": [3000],
  "portsAttributes": {
    "3000": { "label": "BADGE dashboard", "visibility": "private", "onAutoForward": "notify" }
  }
}
```

Visibility `private` requires a GitHub login in the browser — fine on your own iPhone and the right
default. Switch to `public` only for a demo, and never with real ledger data loaded.

### 10.2 Copy-paste startup

```bash
# from the repo root inside the Codespace
npm install
node services/badge/server.js
```

```bash
# check the forwarded URL from the terminal
gh codespace ports
```

```bash
# make port 3000 public for a demo (revert afterwards)
gh codespace ports visibility 3000:public
```

```bash
# keep the SWPC poller alive separately during dev
node services/badge/spaceweather/poller.js &
```

### 10.3 Codespaces limitations to design around

- **It sleeps** (30 min idle by default). The dashboard must degrade gracefully — §9.5.
- **The SWPC poller cannot run in Codespaces in production.** Cron ingest needs an always-on host.
  Railway runs the poller and the API; Codespaces is dev only.
- **PARMA4 is a compiled binary.** Build it in the devcontainer image, not at runtime, or every
  rebuild costs a compile. Add the build step to `.devcontainer/Dockerfile` and commit the
  precompiled artifact if the license permits.
- **SQLite lives on the Codespace volume** and vanishes on rebuild. For dev that is acceptable; for
  anything you want to keep, point `DATABASE_URL` at Railway.

---

## 11. Build phases

**P1 — Dose core.** PARMA4 compiled and wrapped. Route + synthetic vertical profile. Integration. CLI
taking `LAX ICN 2026-09-14 FL390` and printing mSv. Validation suite against CARI-7 reference values,
structured per ISO 20785-4. *Nothing else until this is right.*

**P2 — Ledger.** SQLite, append-only, hash chain, verify, export. Manual flight entry API.

**P3 — Space weather.** SWPC poller, cache with staleness, classify, `/spaceweather`. Historical event
backfill for retrospective SPE attribution.

**P4 — SPE overlay + policy engine.** Cutoff-rigidity gating, uncertainty bands, limits/advisor.

**P5 — Dashboard v1.** Static `public/`, NOW and LEDGER screens, offline behaviour. First thing that
feels like a product.

**P6 — LLM brief layer.** Structured-input-only, numeral-validation guard. Wire into the brief card.

**P7 — ADS-B.** OpenSky ingest, DO-260B decode, pressure-altitude → depth path, baro/geom quality
flagging, coverage accounting. Then ADS-C for oceanic. Then `/backfill` for career reconstruction.

**P8 — Wearables.** Garmin Connect IQ with the pressurization detector, then Apple Watch. Then fly
both on one sector against the ADS-B track and replace §6.5's estimated table with measured numbers.

**P9 — Remaining screens.** Flight detail with charts, project view with the altitude slider.

---

## 12. Open questions for P1

- Is `WeiMXi/PARMA` current against PARMA 4.10, and does its license permit redistribution in a
  hosted service? Verify before depending on it.
- Cutoff rigidity: precomputed 1° global grid shipped as a static asset vs on-the-fly. Grid is almost
  certainly right — size it.
- Solar modulation parameter for *future* dates, needed by `/project`. Needs a forecast or
  solar-cycle interpolation. Document the assumption explicitly.
- Aircraft shielding: PARMA gives free-air dose; fuselage shielding is a small type-dependent
  correction. Ship a per-type factor table, default 1.0, flagged approximate.
- Primary dose quantity: ICRP-103 effective dose is the right default for occupational comparison.
  Keep H*(10) available — ISO 20785 is written in terms of ambient dose equivalent.
- Obtain ISO 20785-1 and -4 (paid, roughly €74–200 each). Building to a standard you have not read is
  theatre.
- OpenSky historical access: confirm current terms, rate limits, and research-tier eligibility for
  Trino. This gates career backfill.
- How far back does usable ADS-B coverage extend? Mandates phased in around 2017 (US) and 2020
  (EU/other). Pre-mandate history needs roster or logbook ingest — scope this before promising
  "reconstruct your whole career."
- Is the GFS/ERA5 pressure correction worth its complexity in v1, or a later refinement? Quantify the
  gain against uncorrected standard-pressure altitude first.

---

## 13. Guardrails to write into the code

1. Never display a modeled number without its confidence, uncertainty, and model version.
2. Never let the LLM emit a figure absent from its structured input.
3. Never show cached space weather without a staleness indicator.
4. Never merge SPE and GCR into one unqualified number.
5. Never mutate a ledger row. Corrections are new rows with `supersedes`.
6. Never use a **worn device's** barometric altitude in pressurized flight — it reads cabin altitude.
   ADS-B barometric altitude is the aircraft's own and is *preferred*. Log the altitude source per
   sample; never confuse the two rules.
7. Never present a partially-covered flight without its `coveredFraction`.
8. Never let the frontend compute a dose figure.
9. Never claim TSO, EASA, or FAA approval. Claim ISO 20785-4 conformance only once the validation
   suite passes, and link the results.
10. Every health-adjacent response carries the modeled-estimate / not-medical-advice /
    discuss-with-your-AME line once, at the boundary — not in every sentence.
