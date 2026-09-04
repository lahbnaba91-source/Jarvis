'use strict';

// Independent closed-form physics references for the BADGE math audit.
//
// Nothing here imports BADGE engine code. These are the "known answer" side of
// the comparison: standard-atmosphere hydrostatics, WGS84 geodesics, relativistic
// rigidity, a Stormer dipole cutoff, and a small NIST PSTAR proton-range table.
// The harness (../run-physics-tests.js) drives BADGE and diffs against these.

/* ------------------------------------------------------------------ constants */

const PROTON_REST_MASS_MEV = 938.27208816;

/* --------------------------------------------- US Standard Atmosphere 1976 */
// Piecewise hydrostatic model, geopotential formulation. Gives pressure at a
// geometric altitude; atmospheric depth (column mass above the level) is P / g0.

const G0 = 9.80665;          // m/s^2
const RSTAR = 8.31432;       // J/(mol K)  (the 1976 value, deliberately)
const M_AIR = 0.0289644;     // kg/mol
const RE_USSA = 6356766;     // m, USSA76 effective Earth radius for geopotential

const HB = [0, 11000, 20000, 32000, 47000, 51000, 71000];        // geopotential m
const LB = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002];      // K per m
const T0 = 288.15;
const P0 = 101325;

// Base temperature and pressure at the foot of each layer.
const _TB = [T0];
const _PB = [P0];
for (let i = 0; i < 6; i++) {
  const dH = HB[i + 1] - HB[i];
  const Tnext = _TB[i] + LB[i] * dH;
  let Pnext;
  if (LB[i] === 0) {
    Pnext = _PB[i] * Math.exp((-G0 * M_AIR * dH) / (RSTAR * _TB[i]));
  } else {
    Pnext = _PB[i] * Math.pow(_TB[i] / (_TB[i] + LB[i] * dH), (G0 * M_AIR) / (RSTAR * LB[i]));
  }
  _TB.push(Tnext);
  _PB.push(Pnext);
}

function geopotentialHeightM(zGeometricM) {
  return (RE_USSA * zGeometricM) / (RE_USSA + zGeometricM);
}

function pressurePa(zGeometricM) {
  const H = geopotentialHeightM(zGeometricM);
  let i = 0;
  while (i < 6 && H > HB[i + 1]) i++;
  const dH = H - HB[i];
  if (LB[i] === 0) {
    return _PB[i] * Math.exp((-G0 * M_AIR * dH) / (RSTAR * _TB[i]));
  }
  return _PB[i] * Math.pow(_TB[i] / (_TB[i] + LB[i] * dH), (G0 * M_AIR) / (RSTAR * LB[i]));
}

// Atmospheric depth in g/cm^2 at a geometric altitude given in feet.
// P/g0 is kg/m^2; * 0.1 converts to g/cm^2. Sea level -> ~1033 g/cm^2.
function atmosphericDepthGcm2(altFt) {
  const zM = altFt * 0.3048;
  return (pressurePa(zM) / G0) * 0.1;
}

/* --------------------------------------------------- WGS84 geodesic (Vincenty) */
// Inverse problem. Converges everywhere the harness needs (no near-antipodal
// pairs). Used to characterise the spherical-Earth error in engine/geo.js.

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

function geodesicDistanceKm(p1, p2) {
  const L = ((p2.lon - p1.lon) * Math.PI) / 180;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan((p1.lat * Math.PI) / 180));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan((p2.lat * Math.PI) / 180));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaPrev;
  let iter = 0;
  let cosSqAlpha;
  let sinSigma;
  let cos2SigmaM;
  let cosSigma;
  let sigma;

  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambdaPrev = lambda;
    lambda =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaPrev) > 1e-12 && ++iter < 200);

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));

  return (WGS84_B * A * (sigma - deltaSigma)) / 1000;
}

/* ----------------------------------------------- relativistic rigidity <-> E */
// Magnetic rigidity R = pc/(Ze). For a proton Z = 1, so R in GV equals pc in GeV.
// Exact special relativity: E_total = sqrt((pc)^2 + m^2), T = E_total - m.

function kineticEnergyMeVFromRigidityGV(rigidityGV, restMassMeV = PROTON_REST_MASS_MEV) {
  const pcMeV = rigidityGV * 1000; // Z = 1
  return Math.sqrt(pcMeV * pcMeV + restMassMeV * restMassMeV) - restMassMeV;
}

function rigidityGVFromKineticEnergyMeV(tMeV, restMassMeV = PROTON_REST_MASS_MEV) {
  const eTot = tMeV + restMassMeV;
  const pcMeV = Math.sqrt(eTot * eTot - restMassMeV * restMassMeV);
  return pcMeV / 1000;
}

/* --------------------------------------------------- Stormer dipole cutoff */
// Vertical geomagnetic cutoff rigidity from the tilted-dipole approximation:
//   Rc = 14.9 * cos^4(lambda_m)  GV   at the surface.
// Real cutoffs (Smart & Shea, IGRF trajectory tracing) depart from this by tens
// of percent, especially over the South Atlantic Anomaly, so this is used only
// for structure and order of magnitude, never as a tight oracle.

// IGRF-13 geomagnetic north pole, epoch ~2020.
const DIPOLE_POLE_LAT = 80.65;
const DIPOLE_POLE_LON = -72.68;

function geomagneticLatitudeDeg(latDeg, lonDeg) {
  const toR = Math.PI / 180;
  const lat = latDeg * toR;
  const lon = lonDeg * toR;
  const pLat = DIPOLE_POLE_LAT * toR;
  const pLon = DIPOLE_POLE_LON * toR;
  const sinMLat =
    Math.sin(lat) * Math.sin(pLat) +
    Math.cos(lat) * Math.cos(pLat) * Math.cos(lon - pLon);
  return Math.asin(Math.max(-1, Math.min(1, sinMLat))) / toR;
}

function stormerVerticalCutoffGV(latDeg, lonDeg) {
  const mLat = (geomagneticLatitudeDeg(latDeg, lonDeg) * Math.PI) / 180;
  return 14.9 * Math.cos(mLat) ** 4;
}

/* ------------------------------------------------ NIST PSTAR proton range, air */
// CSDA range in dry air, g/cm^2. Values read from the NIST PSTAR database
// (physics.nist.gov/PhysRefData/Star/Text/PSTAR.html), rounded. Used to grade the
// power-law range fit inside engine/spe.js (energyToPenetrateDepth).

const PSTAR_AIR_CSDA = [
  { tMeV: 10, rangeGcm2: 0.1233 },
  { tMeV: 20, rangeGcm2: 0.4267 },
  { tMeV: 50, rangeGcm2: 2.227 },
  { tMeV: 100, rangeGcm2: 7.718 },
  { tMeV: 150, rangeGcm2: 15.85 },
  { tMeV: 200, rangeGcm2: 26.30 },
  { tMeV: 300, rangeGcm2: 54.15 },
  { tMeV: 500, rangeGcm2: 128.8 },
  { tMeV: 1000, rangeGcm2: 366.8 },
];

module.exports = {
  PROTON_REST_MASS_MEV,
  atmosphericDepthGcm2,
  pressurePa,
  geodesicDistanceKm,
  kineticEnergyMeVFromRigidityGV,
  rigidityGVFromKineticEnergyMeV,
  geomagneticLatitudeDeg,
  stormerVerticalCutoffGV,
  PSTAR_AIR_CSDA,
};
