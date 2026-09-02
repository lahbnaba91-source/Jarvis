'use strict';

// BADGE dashboard. Renders only what the backend computed — the frontend performs
// no dose math of any kind, not even a unit conversion that changes a value
// (guardrail §13.8). Every number here arrives ready-formatted in meaning.

const CACHE_KEY = 'badge.cache.v1';

const state = {
  status: null,
  spaceweather: null,
  flights: null,
  chain: null,
  offline: false,
  cachedAt: null,
};

/* ------------------------------------------------------------------ helpers */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// mSv values are shown at the precision the ledger stores them; no rescaling.
const mSv = (v) => (v == null ? '—' : `${v.toFixed(4)} mSv`);
const pct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

function confidenceClass(confidence) {
  if (confidence === 'high') return 'badge-ok';
  if (confidence === 'medium') return 'badge-warn';
  return 'badge-lowconf';
}

function limitClass(pctOfLimit) {
  if (pctOfLimit >= 100) return 'alert';
  if (pctOfLimit >= 75) return 'warn';
  return 'ok';
}

/* ------------------------------------------------------------- offline cache */

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      status: state.status,
      spaceweather: state.spaceweather,
      flights: state.flights,
      chain: state.chain,
    }));
  } catch (_) { /* storage unavailable; the live view still works */ }
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function setOffline(on, stamp) {
  state.offline = on;
  const banner = $('offline-banner');
  banner.hidden = !on;
  if (on) $('offline-stamp').textContent = stamp ? new Date(stamp).toLocaleString() : 'an earlier session';
  // Writes are disabled offline rather than queued silently (§9.5).
  document.querySelectorAll('.btn').forEach((b) => b.setAttribute('aria-disabled', on ? 'true' : 'false'));
}

/* -------------------------------------------------------------------- fetch */

async function getJson(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const [status, sw, flights, chain] = await Promise.all([
      getJson('/api/badge/status'),
      getJson('/api/badge/spaceweather'),
      getJson('/api/badge/flights?limit=200'),
      getJson('/api/badge/verify'),
    ]);
    state.status = status;
    state.spaceweather = sw;
    state.flights = flights;
    state.chain = chain;
    setOffline(false);
    saveCache();
  } catch (err) {
    const cached = loadCache();
    if (cached) {
      state.status = cached.status;
      state.spaceweather = cached.spaceweather;
      state.flights = cached.flights;
      state.chain = cached.chain;
      setOffline(true, cached.savedAt);
    } else {
      setOffline(true, null);
    }
  }
  renderAll();
}

/* ------------------------------------------------------------ space weather */

function renderSpaceWeather() {
  const el = $('sw-body');
  const badge = $('sw-staleness');
  const sw = state.spaceweather;

  if (!sw || !sw.available) {
    el.className = 'loading';
    el.textContent = 'No space weather data cached. Run the poller: node spaceweather/poller.js --once';
    badge.textContent = 'no data';
    badge.className = 'badge badge-muted';
    return;
  }

  // Guardrail §13.3: cached values never render without a staleness indicator.
  badge.textContent = sw.stale ? sw.staleness.toUpperCase() : 'LIVE';
  badge.className = `badge ${sw.stale ? 'badge-stale' : 'badge-live'}`;

  const c = sw.current;
  const riskColor = c.aviationRisk.score >= 50 ? 'var(--alert)'
    : c.aviationRisk.score >= 25 ? 'var(--warn)' : 'var(--ok)';
  const sClass = c.sScale === 'S0' ? 'badge-ok' : 'badge-alert';

  el.className = 'sw-grid';
  el.innerHTML = `
    <div class="sw-item">
      <div class="sw-label">S-scale</div>
      <div class="sw-value"><span class="badge ${sClass}">${esc(c.sScale)}</span></div>
      <div class="sw-note">${esc(c.sScaleSource)}</div>
    </div>
    <div class="sw-item">
      <div class="sw-label">Kp</div>
      <div class="sw-value">${c.kp == null ? '—' : esc(c.kp)}</div>
    </div>
    <div class="sw-item">
      <div class="sw-label">&ge;10 MeV protons</div>
      <div class="sw-value">${c.protons10MeV == null ? '—' : c.protons10MeV.toFixed(3)}</div>
      <div class="sw-note">pfu · event at 10</div>
    </div>
    <div class="sw-item">
      <div class="sw-label">&ge;100 MeV protons</div>
      <div class="sw-value">${c.protons100MeV == null ? '—' : c.protons100MeV.toFixed(3)}</div>
      <div class="sw-note">pfu · reaches cruise · threshold 1</div>
    </div>
    <div class="sw-item risk-row">
      <div class="sw-label">Aviation risk score</div>
      <div class="sw-value">${c.aviationRisk.score} / 100</div>
      <div class="risk-track">
        <div class="risk-fill" style="width:${c.aviationRisk.score}%;background:${riskColor}"></div>
      </div>
      <div class="risk-method">${esc(c.aviationRisk.method)} — BADGE-modeled, not an official NOAA product</div>
    </div>`;
}

/* -------------------------------------------------------------------- gauge */

function renderGauge() {
  const wrap = $('gauge-wrap');
  const proj = $('projection');
  const s = state.status;

  $('policy-chip').textContent = s && s.policyId ? s.policyId : '—';

  if (!s || s.empty) {
    wrap.className = 'gauge-wrap loading';
    wrap.textContent = s ? 'No flights recorded yet.' : 'No data.';
    proj.textContent = '';
    return;
  }

  const p = s.pctOfAnnualLimit;
  const tone = limitClass(p);
  const color = `var(--${tone})`;

  // 240-degree arc, drawn as an SVG path. Geometry only — no dose math here.
  const cx = 130, cy = 120, r = 96;
  const start = 150, sweep = 240;
  const frac = Math.max(0, Math.min(1, p / 100));
  const polar = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const arc = (fromDeg, toDeg) => {
    const [x1, y1] = polar(fromDeg);
    const [x2, y2] = polar(toDeg);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  wrap.className = 'gauge-wrap';
  wrap.innerHTML = `
    <svg class="gauge" viewBox="0 0 260 190" role="img"
         aria-label="Year-to-date dose ${pct(p)} of the annual limit">
      <path d="${arc(start, start + sweep)}" fill="none" stroke="#1c1c1c" stroke-width="16" stroke-linecap="round"/>
      ${frac > 0 ? `<path d="${arc(start, start + sweep * frac)}" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"/>` : ''}
      <text class="gauge-pct" x="130" y="118" text-anchor="middle" fill="${color}">${p.toFixed(1)}%</text>
      <text class="gauge-sub" x="130" y="144" text-anchor="middle">${s.ytdGcrMSv.toFixed(4)} mSv GCR</text>
      <text class="gauge-limit" x="130" y="168" text-anchor="middle">of ${s.annualLimitMSv} mSv/yr limit</text>
    </svg>`;

  // GCR and SPE are shown on separate lines and are never summed (guardrail §13.4).
  proj.innerHTML = `
    <div><span class="k">projected year-end</span> ${mSv(s.projectedYearEndGcrMSv)} GCR
      &nbsp;<span class="badge badge-${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'alert'}">${esc(s.breachRisk)}</span></div>
    <div><span class="k">rolling 12 months</span> ${mSv(s.rolling12moGcrMSv)} GCR</div>
    <div><span class="k">${s.averagingWindowYears}-yr window average</span> ${mSv(s.windowAverageGcrMSv)}/yr</div>
    <div><span class="k">YTD SPE</span> ${mSv(s.ytdSpeMSv)} <span class="k">— tracked separately, never added to GCR</span></div>
    ${s.daysToThreshold != null ? `<div><span class="k">days to limit at current pace</span> ${s.daysToThreshold}</div>` : ''}
    <div><span class="k">uncertainty</span> ${s.meanUncertaintyPct == null ? esc(s.uncertaintyNote) : pct(s.meanUncertaintyPct)}</div>
    <div><span class="k">policy</span> ${esc(s.policySource)}${s.verifyBeforeUse ? ' — verify before acting on it' : ''}</div>`;
}

/* ------------------------------------------------------------- flight rows */

function flightRow(f) {
  const conf = f.dose.gcrConfidence;
  const lowConf = conf === 'low';
  const covered = f.telemetry.coveredFraction;

  // Guardrail §13.7: partial coverage is always visible.
  const coverChip = covered < 1
    ? `<span class="badge badge-warn">${Math.round(covered * 100)}% recorded</span>` : '';

  const speLine = f.dose.speMSv == null
    ? `<div class="spe-line">SPE: not determined</div>`
    : f.dose.speMSv > 0
      ? `<div class="spe-line">SPE: ${mSv(f.dose.speMSv)} (${esc(f.dose.speConfidence)} confidence, ${esc(f.dose.speMethod)})</div>`
      : `<div class="spe-line">SPE: none active</div>`;

  return `
    <article class="flight-row ${lowConf ? 'low-confidence' : ''} ${f.superseded ? 'superseded' : ''}">
      <div class="flight-top">
        <span class="flight-route">${esc(f.route)}</span>
        <span class="flight-dose">${mSv(f.dose.gcrMSv)}</span>
      </div>
      <div class="flight-meta">
        <span>${esc(f.dateUtc)}</span>
        <span>FL${Math.round(f.cruiseAltitudeFt / 100)}</span>
        <span class="badge ${confidenceClass(conf)}">${esc(conf)} · ${esc(f.telemetry.source)}</span>
        ${coverChip}
        ${f.superseded ? '<span class="badge badge-muted">superseded</span>' : ''}
        ${f.entryType === 'correction' ? '<span class="badge badge-muted">correction</span>' : ''}
      </div>
      ${speLine}
      <div class="flight-meta"><span>${esc(f.dose.gcrModel)} · ${f.dose.uncertaintyPct == null ? esc(f.dose.uncertaintyBasis) : '± ' + pct(f.dose.uncertaintyPct)}</span></div>
    </article>`;
}

function renderLastFlight() {
  const el = $('last-flight');
  const list = state.flights && state.flights.flights;
  if (!list || !list.length) {
    el.className = 'loading';
    el.textContent = 'No flights recorded yet.';
    return;
  }
  el.className = '';
  el.innerHTML = flightRow(list.find((f) => !f.superseded) || list[0]);
}

function renderLedger() {
  const el = $('ledger-list');
  const chain = $('chain-state');

  if (state.chain) {
    chain.textContent = state.chain.intact ? `CHAIN INTACT · ${state.chain.entries}` : 'CHAIN BROKEN';
    chain.className = `badge ${state.chain.intact ? 'badge-ok' : 'badge-alert'}`;
  }

  const all = (state.flights && state.flights.flights) || [];
  const q = $('search').value.trim().toUpperCase();
  const year = $('filter-year').value;
  const conf = $('filter-conf').value;

  const rows = all.filter((f) =>
    (!q || f.route.toUpperCase().includes(q)) &&
    (!year || f.dateUtc.startsWith(year)) &&
    (!conf || f.dose.gcrConfidence === conf));

  if (!rows.length) {
    el.className = 'loading';
    el.textContent = all.length ? 'No flights match those filters.' : 'Ledger is empty.';
    return;
  }
  el.className = '';
  el.innerHTML = rows.map(flightRow).join('');
}

function populateYears() {
  const sel = $('filter-year');
  const all = (state.flights && state.flights.flights) || [];
  const years = [...new Set(all.map((f) => f.dateUtc.slice(0, 4)))].sort().reverse();
  const current = sel.value;
  sel.innerHTML = '<option value="">All years</option>' +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');
  sel.value = current;
}

function renderAll() {
  renderSpaceWeather();
  renderGauge();
  renderLastFlight();
  populateYears();
  renderLedger();
}

/* ------------------------------------------------------------------- wiring */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.screen;
    $('screen-now').hidden = target !== 'now';
    $('screen-ledger').hidden = target !== 'ledger';
  });
});

$('refresh').addEventListener('click', refresh);
['search', 'filter-year', 'filter-conf'].forEach((id) =>
  $(id).addEventListener('input', renderLedger));

// Paint cached data immediately so the page is never a spinner (§9.5).
const boot = loadCache();
if (boot) {
  state.status = boot.status;
  state.spaceweather = boot.spaceweather;
  state.flights = boot.flights;
  state.chain = boot.chain;
  renderAll();
}
refresh();
