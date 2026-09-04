#!/usr/bin/env node
'use strict';

// BADGE first-principles physics + math audit.
//
//   Group A  BADGE's own arithmetic / geometry / calculus vs exact analytic truth
//            -> hard gate, must pass under 1e-3 relative
//   Group B  BADGE math vs external closed-form physics (WGS84 geodesic, PSTAR)
//            -> characterised, printed, not gated
//   Group C  PARMA engine output vs closed-form physics (USSA76 depth, Stormer)
//            -> soft gate on structure; deviation printed
//   Group D  PARMA dose behaviour in known limiting cases (ratios, e-folding)
//            -> gate on physically expected ranges
//
// Like the validation harness, this reports. It never tunes anything.
// Run: node tests/physics/run-physics-tests.js

const geo = require('../../engine/geo');
const { integrate } = require('../../engine/integrate');
const profile = require('../../engine/profile');
const solarmod = require('../../engine/solarmod');
const spe = require('../../engine/spe');
const parma = require('../../engine/parma');
const ref = require('./lib/physics-refs');

const GATE = 1e-3; // Group A relative-error gate
let failures = 0;
const line = () => console.log('-'.repeat(78));

function rel(a, b) {
  return b === 0 ? Math.abs(a) : Math.abs((a - b) / b);
}
function pct(a, b) {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}
function check(name, got, want, tol = GATE, unit = '') {
  const r = rel(got, want);
  const ok = r <= tol;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ` +
      `got ${fmt(got)}${unit}  want ${fmt(want)}${unit}  (${(r * 100).toExponential(2)}%)`
  );
  return ok;
}
function report(name, got, want, unit = '') {
  console.log(
    `        ${name.padEnd(46)} badge ${fmt(got)}${unit}  ref ${fmt(want)}${unit}  ` +
      `dev ${pct(got, want).toFixed(2)}%`
  );
}
function fmt(x) {
  if (!isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return x.toExponential(4);
  return x.toPrecision(6).replace(/\.?0+$/, '');
}
function structural(name, ok, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
}

/* ============================================================= GROUP A ===== */

function groupA() {
  line();
  console.log('GROUP A  BADGE math vs exact analytic truth   (gate: rel err <= 1e-3)');
  line();

  // --- geo.js: great-circle identities -------------------------------------
  const JFK = { lat: 40.6413, lon: -73.7781 };
  const LHR = { lat: 51.47, lon: -0.4543 };
  const LAX = { lat: 33.9416, lon: -118.4085 };
  const SYD = { lat: -33.9399, lon: 151.1753 };

  check('geo distance(a,a) == 0', geo.distanceKm(JFK, JFK), 0, GATE, ' km');

  const p0 = geo.interpolate(JFK, LHR, 0);
  const p1 = geo.interpolate(JFK, LHR, 1);
  check('geo interpolate(a,b,0).lat == a.lat', p0.lat, JFK.lat);
  check('geo interpolate(a,b,1).lon == b.lon', p1.lon, LHR.lon);

  // Great-circle arc length is additive: sum of N chords along the geodesic
  // must converge to the direct distance.
  const N = 400;
  const total = geo.distanceKm(JFK, LHR);
  let summed = 0;
  let prev = JFK;
  for (let i = 1; i <= N; i++) {
    const cur = geo.interpolate(JFK, LHR, i / N);
    summed += geo.distanceKm(prev, cur);
    prev = cur;
  }
  check('geo segmented arc sums to direct distance', summed, total, 5e-4, ' km');

  const mid = geo.interpolate(LAX, SYD, 0.5);
  check(
    'geo midpoint is equidistant from endpoints',
    geo.distanceKm(LAX, mid),
    geo.distanceKm(mid, SYD),
    1e-4,
    ' km'
  );

  // --- integrate.js: trapezoid vs closed-form integrals -------------------
  const T = 9.5;
  const grid = (n) => {
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push({ tHours: (T * i) / n, lat: 0, lon: 0, altFt: 39000 });
    return pts;
  };
  const rateArr = (pts, f) =>
    pts.map((p) => ({ effUSvPerHr: f(p.tHours), h10USvPerHr: f(p.tHours) }));

  const nSteps = Math.round((T * 3600) / 60); // real 60 s cadence
  const gp = grid(nSteps);

  // constant
  const cA = integrate(gp, rateArr(gp, () => 2.7));
  check('integrate constant rate', cA.gcrEffectiveUSv, 2.7 * T, 1e-9, ' uSv');

  // linear  r(t) = 0.4 + 0.15 t   ->  0.4 T + 0.075 T^2
  const cB = integrate(gp, rateArr(gp, (t) => 0.4 + 0.15 * t));
  check('integrate linear rate', cB.gcrEffectiveUSv, 0.4 * T + 0.075 * T * T, 1e-9, ' uSv');

  // exponential  r(t) = 1.8 e^{0.08 t}  ->  (1.8/0.08)(e^{0.08 T} - 1)
  const k = 0.08;
  const expExact = (1.8 / k) * (Math.exp(k * T) - 1);
  const cC = integrate(gp, rateArr(gp, (t) => 1.8 * Math.exp(k * t)));
  check('integrate exponential rate @ 60 s cadence', cC.gcrEffectiveUSv, expExact, 1e-4, ' uSv');

  // O(h^2): halving the step must cut trapezoid error ~4x
  const err = (n) =>
    Math.abs(integrate(grid(n), rateArr(grid(n), (t) => 1.8 * Math.exp(k * t))).gcrEffectiveUSv - expExact);
  const e1 = err(200);
  const e2 = err(400);
  structural(
    'integrate error scales as O(h^2)',
    e1 / e2 > 3.6 && e1 / e2 < 4.4,
    `err(h)/err(h/2) = ${(e1 / e2).toFixed(3)}  (expect ~4.0)`
  );

  // --- profile.js: kinematic identities ----------------------------------
  const prof = profile.synthesize({
    origin: { lat: 50.0379, lon: 8.5622, elevationFt: 364 }, // EDDF
    destination: { lat: 40.6413, lon: -73.7781, elevationFt: 13 }, // KJFK
    date: { year: 2020, month: 1, day: 15 },
    cruiseAltitudeFt: 39000,
  });
  const pr = prof.profile;
  check(
    'profile climb: rate x time == altitude gained',
    pr.climbHours * prof.profile.climbRateFtPerMin * 60,
    prof.peakAltitudeFt - 364,
    1e-9,
    ' ft'
  );
  check(
    'profile duration == climb + cruise + descent',
    prof.durationHours,
    pr.climbHours + pr.cruiseHours + pr.descentHours,
    1e-12,
    ' h'
  );
  // climb + cruise + descent ground distance must reconstruct the great-circle
  // route length. Ramp ground speed is cruiseSpeed * rampSpeedFactor (profile.js).
  const rampKmh = pr.cruiseSpeedKmh * profile.DEFAULTS.rampSpeedFactor;
  const reconstructedKm =
    rampKmh * pr.climbHours + pr.cruiseSpeedKmh * pr.cruiseHours + rampKmh * pr.descentHours;
  check('profile climb+cruise+descent distance == route length', reconstructedKm, prof.distanceKm, 1e-9, ' km');
  const last = prof.points[prof.points.length - 1];
  check('profile last sample time == duration', last.tHours, prof.durationHours, 1e-12, ' h');

  // --- solarmod.js: exact inverse round-trips ---------------------------
  let maxRT = 0;
  for (let w = 5; w <= 260; w += 5) {
    const back = solarmod.wIndexFromPhi(solarmod.phiFromWIndex(w));
    maxRT = Math.max(maxRT, rel(back, w));
  }
  check('solarmod wIndex<->phi round-trip (worst of sweep)', 1 + maxRT, 1, 1e-9);

  const cal = solarmod.NMDB_CALIBRATION;
  // N ~ 100 is a realistic Oulu corrected count rate; gives Phi ~ 770 MV.
  check(
    'solarmod phiFromCountRate matches its stated linear fit',
    solarmod.phiFromCountRate(100),
    cal.intercept + cal.slope * 100,
    1e-12,
    ' MV'
  );

  // --- spe.js energyFromRigidity vs exact special relativity -----------
  for (const R of [0.445, 1.0, 2.0, 5.0, 10.0]) {
    check(
      `spe energyFromRigidity(${R} GV) vs exact SR`,
      spe.energyFromRigidity(R),
      ref.kineticEnergyMeVFromRigidityGV(R),
      2e-4,
      ' MeV'
    );
  }
  check('spe energyFromRigidity(1 GV) ~ 433 MeV (hand value)', spe.energyFromRigidity(1.0), 433.0, 3e-3, ' MeV');
}

/* ============================================================= GROUP B ===== */

function groupB() {
  line();
  console.log('GROUP B  BADGE math vs external closed-form physics   (characterised)');
  line();

  // Spherical geo.js vs WGS84 geodesic. The known, documented modelling choice
  // in engine/geo.js: how big is the spherical-Earth route-length error?
  const pairs = [
    ['JFK-LHR', { lat: 40.6413, lon: -73.7781 }, { lat: 51.47, lon: -0.4543 }],
    ['LAX-SYD', { lat: 33.9416, lon: -118.4085 }, { lat: -33.9399, lon: 151.1753 }],
    ['SIN-LHR', { lat: 1.3592, lon: 103.9894 }, { lat: 51.47, lon: -0.4543 }],
    ['GRU-JNB', { lat: -23.4356, lon: -46.4731 }, { lat: -26.1392, lon: 28.246 }],
    ['NRT-ORD', { lat: 35.7647, lon: 140.3863 }, { lat: 41.9786, lon: -87.9048 }],
  ];
  let worst = 0;
  for (const [name, a, b] of pairs) {
    const sph = geo.distanceKm(a, b);
    const ell = ref.geodesicDistanceKm(a, b);
    worst = Math.max(worst, Math.abs(pct(sph, ell)));
    report(`route length ${name}`, sph, ell, ' km');
  }
  structural(
    'spherical-Earth route error stays sub-1%',
    worst < 1.0,
    `worst deviation vs WGS84 geodesic = ${worst.toFixed(2)}%`
  );

  // spe.js proton range-energy power law vs NIST PSTAR (air, CSDA).
  console.log('');
  console.log('  engine/spe.js energyToPenetrateDepth() vs NIST PSTAR proton range (air):');
  let maxDev = 0;
  for (const row of ref.PSTAR_AIR_CSDA) {
    const eFit = spe.energyToPenetrateDepth(row.rangeGcm2); // depth -> energy
    maxDev = Math.max(maxDev, Math.abs(pct(eFit, row.tMeV)));
    report(`  depth ${row.rangeGcm2} g/cm^2 -> E`, eFit, row.tMeV, ' MeV');
  }
  console.log(
    `        --> max deviation ${maxDev.toFixed(1)}%  ` +
      `(SPE overlay is method "empirical-overlay-v1", confidence low, band x/÷${spe.UNCERTAINTY_FACTOR})`
  );
  // Cruise-relevant band only: does the atmospheric threshold land near ~600 MeV?
  const eCruise = spe.energyToPenetrateDepth(200);
  report('  atmospheric threshold @ 200 g/cm^2', eCruise, 650, ' MeV');
}

/* ============================================================= GROUP C ===== */

function pointDose(overrides) {
  const p = {
    year: 2020,
    month: 1,
    day: 15,
    lat: 45,
    lon: 0,
    altFt: 39000,
    ...overrides,
  };
  const w = overrides.wIndex;
  return parma.doseRates([p], w === undefined ? {} : { wIndex: w })[0];
}

function groupC() {
  line();
  console.log('GROUP C  PARMA engine output vs closed-form physics   (soft gate on structure)');
  line();

  // --- atmospheric depth vs US Standard Atmosphere 1976 -----------------
  console.log('  PARMA depthGcm2 vs USSA76 hydrostatic column (lat 45, 2020-01-15):');
  let maxDepthDev = 0;
  for (const altFt of [0, 5000, 10000, 20000, 30000, 35000, 39000, 43000, 50000]) {
    const rec = pointDose({ altFt });
    const ussa = ref.atmosphericDepthGcm2(altFt);
    maxDepthDev = Math.max(maxDepthDev, Math.abs(pct(rec.depthGcm2, ussa)));
    report(`  FL${String(Math.round(altFt / 100)).padStart(3, '0')}`, rec.depthGcm2, ussa, ' g/cm^2');
  }
  structural(
    'PARMA altitude->depth within 5% of USSA76',
    maxDepthDev < 5.0,
    `max deviation = ${maxDepthDev.toFixed(2)}%`
  );

  // --- vertical cutoff rigidity vs Stormer dipole ----------------------
  // PARMA carries a real IGRF-derived cutoff grid (CORdata.inp), so point-wise
  // disagreement with a centred-dipole Stormer formula is EXPECTED and correct:
  // the true field is offset and tilted, and near the lon 0 meridian it runs
  // past the South Atlantic Anomaly. We check structure and magnitude, not fit.
  console.log('');
  console.log('  PARMA cutoffRigidityGV vs Stormer dipole (lon 0, FL390) -- structure check:');
  const lats = [];
  const parmaRc = [];
  const stormRc = [];
  for (let lat = -85; lat <= 85; lat += 5) {
    const rec = pointDose({ lat, lon: 0 });
    const st = ref.stormerVerticalCutoffGV(lat, 0);
    lats.push(lat);
    parmaRc.push(rec.cutoffRigidityGV);
    stormRc.push(st);
    if (lat % 20 === 0) report(`  lat ${String(lat).padStart(3)}`, rec.cutoffRigidityGV, st, ' GV');
  }
  const peakLat = lats[parmaRc.indexOf(Math.max(...parmaRc))];
  const pole = pointDose({ lat: 88, lon: 0 }).cutoffRigidityGV;
  // Pearson correlation across the meridian.
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const mp = mean(parmaRc);
  const ms = mean(stormRc);
  const cov = parmaRc.reduce((s, x, i) => s + (x - mp) * (stormRc[i] - ms), 0);
  const sp = Math.sqrt(parmaRc.reduce((s, x) => s + (x - mp) ** 2, 0));
  const ss = Math.sqrt(stormRc.reduce((s, x) => s + (x - ms) ** 2, 0));
  const r = cov / (sp * ss);
  // The dip equator crosses lon 0 near +8 deg N; the offset dipole can push the
  // cutoff peak a little further north still. Accept a broad equatorial band.
  structural('cutoff peaks in the equatorial band (lat -10..+35 on lon 0)',
    peakLat >= -10 && peakLat <= 35,
    `PARMA peak Rc ${Math.max(...parmaRc).toFixed(1)} GV at lat ${peakLat}`);
  structural('cutoff collapses toward the pole', pole < 1.0, `Rc(lat 88) = ${pole.toFixed(3)} GV`);
  structural('cutoff still correlates with the dipole form', r > 0.85,
    `Pearson r = ${r.toFixed(3)} (point-wise Stormer offsets are expected)`);
  const eqIdx = lats.indexOf(0);
  report('  cutoff magnitude at geographic equator', parmaRc[eqIdx], stormRc[eqIdx], ' GV');
}

/* ============================================================= GROUP D ===== */

function groupD() {
  line();
  console.log('GROUP D  PARMA dose in known limiting cases   (gate: physically expected range)');
  line();

  // solar-min-ish and solar-max-ish force-field via explicit W-index.
  const wMin = 30; // FFP ~ 425 MV
  const wMax = 175; // FFP ~ 1150 MV

  const eqFL390 = pointDose({ lat: 2, lon: 30, wIndex: wMin }).effUSvPerHr;
  const poFL390 = pointDose({ lat: 78, lon: 30, wIndex: wMin }).effUSvPerHr;
  const ratio = poFL390 / eqFL390;
  structural(
    'polar / equatorial effective dose-rate ratio @ FL390',
    ratio > 2.5 && ratio < 8,
    `${poFL390.toFixed(3)} / ${eqFL390.toFixed(3)} uSv/h = ${ratio.toFixed(2)}x  (expect 3-6x)`
  );

  // Altitude e-folding in the cruise band: fit ln(rate) vs altitude.
  const alts = [28000, 32000, 36000, 40000, 44000];
  const xs = [];
  const ys = [];
  for (const a of alts) {
    xs.push(a);
    ys.push(Math.log(pointDose({ lat: 60, lon: 0, altFt: a, wIndex: wMin }).effUSvPerHr));
  }
  const n = xs.length;
  const sx = xs.reduce((s, x) => s + x, 0);
  const sy = ys.reduce((s, y) => s + y, 0);
  const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sxx = xs.reduce((s, x) => s + x * x, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx); // per ft
  const doublingFt = Math.log(2) / slope;
  structural(
    'cruise-band dose-rate doubling distance',
    doublingFt > 8000 && doublingFt < 13000,
    `${Math.round(doublingFt)} ft  (PARMA note: ~9,300 ft; brief §3.3 claims ~6,000 ft)`
  );

  // Solar modulation: more modulation (solar max) must lower GCR dose at cruise.
  const rMin = pointDose({ lat: 60, lon: 0, wIndex: wMin }).effUSvPerHr;
  const rMax = pointDose({ lat: 60, lon: 0, wIndex: wMax }).effUSvPerHr;
  const suppression = (1 - rMax / rMin) * 100;
  structural(
    'solar-max suppresses cruise GCR dose vs solar-min',
    suppression > 12 && suppression < 55,
    `${rMin.toFixed(3)} -> ${rMax.toFixed(3)} uSv/h  (${suppression.toFixed(1)}% lower; ` +
      `W ${wMin}->${wMax}, expect 12-55%)`
  );

  // Sea-level GCR sanity: PARMA's own reference file gives ~0.0382 uSv/h.
  const sl = pointDose({ lat: 5, lon: 0, altFt: 0, wIndex: wMin }).effUSvPerHr;
  structural(
    'sea-level GCR effective dose rate is tens of nSv/h',
    sl > 0.02 && sl < 0.09,
    `${(sl * 1000).toFixed(1)} nSv/h  (PARMA DoseOut reference ~38 nSv/h)`
  );
}

/* ================================================================= main ==== */

(function main() {
  console.log('BADGE physics + math audit');
  console.log(`node ${process.version}   PARMA ${parma.MODEL_VERSION}`);

  groupA();
  groupB();
  try {
    groupC();
    groupD();
  } catch (e) {
    console.log('');
    console.log(`GROUP C/D could not run: ${e.message}`);
    console.log('(needs the compiled PARMA driver: services/badge/engine/native/build.sh)');
    failures++;
  }

  line();
  if (failures === 0) {
    console.log('RESULT: all gated checks passed. Group B deviations are characterisation, not failures.');
    process.exit(0);
  }
  console.log(`RESULT: ${failures} gated check(s) failed or could not run. See above.`);
  process.exit(1);
})();
