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
      getJson('/api/badge/status' + (new URLSearchParams(location.search).get('asOf')
        ? `?asOf=${encodeURIComponent(new URLSearchParams(location.search).get('asOf'))}` : '')),
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
    <article class="flight-row ${lowConf ? 'low-confidence' : ''} ${f.superseded ? 'superseded' : ''}" data-flight-id="${esc(f.id)}">
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

async function loadBrief(question) {
  const textEl = $('brief-text');
  const srcEl = $('brief-source');
  const provEl = $('brief-provenance');

  if (state.offline) {
    textEl.className = 'loading';
    textEl.textContent = 'The brief needs the backend. Reconnect to generate one.';
    srcEl.textContent = 'offline';
    srcEl.className = 'badge badge-stale';
    provEl.textContent = '';
    return;
  }

  textEl.className = 'loading';
  textEl.textContent = 'generating…';

  try {
    const asOf = new URLSearchParams(location.search).get('asOf');
    const res = await fetch('/api/badge/brief' + (asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question || undefined }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const b = await res.json();

    textEl.className = '';
    textEl.textContent = b.text;
    srcEl.textContent = b.source === 'llm' ? 'LLM · VERIFIED' : 'DETERMINISTIC';
    srcEl.className = `badge ${b.source === 'llm' ? 'badge-ok' : 'badge-muted'}`;

    // The provenance of the words is part of the output, not a footnote.
    const bits = [];
    if (b.note) bits.push(b.note);
    if (b.guard) bits.push(`numeral guard: ${b.guard.checked} checked, ${b.guard.unsupported.length} unsupported`);
    provEl.textContent = bits.join(' · ');
  } catch (err) {
    textEl.className = 'loading';
    textEl.textContent = 'Brief unavailable.';
    srcEl.textContent = 'error';
    srcEl.className = 'badge badge-stale';
    provEl.textContent = '';
  }
}

function renderAll() {
  renderSpaceWeather();
  renderGauge();
  renderLastFlight();
  populateYears();
  renderLedger();
}


/* --------------------------------------------------------- flight detail */

// All charting is geometry over numbers the backend already computed. No dose
// value is derived, rescaled or combined here (guardrail §13.8).
function svgEl(inner, viewBox, cls = '') {
  return `<svg viewBox="${viewBox}" class="${cls}" preserveAspectRatio="none" role="img">${inner}</svg>`;
}

function doseRateChart(samples) {
  const W = 340, H = 170, padL = 34, padR = 30, padT = 10, padB = 22;
  const rates = samples.map((s) => s.effUSvPerHr);
  const alts = samples.map((s) => s.altFt);
  const ts = samples.map((s) => s.tHours);

  const maxRate = Math.max(...rates), maxAlt = Math.max(...alts), maxT = Math.max(...ts) || 1;
  const x = (t) => padL + (t / maxT) * (W - padL - padR);
  const yRate = (r) => H - padB - (maxRate ? r / maxRate : 0) * (H - padT - padB);
  const yAlt = (a) => H - padB - (maxAlt ? a / maxAlt : 0) * (H - padT - padB);

  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const dosePath = line(samples.map((s) => [x(s.tHours), yRate(s.effUSvPerHr)]));
  const altPath = line(samples.map((s) => [x(s.tHours), yAlt(s.altFt)]));

  const grid = [0, 0.5, 1].map((f) => {
    const y = H - padB - f * (H - padT - padB);
    return `<line class="grid-line" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"/>` +
      `<text class="axis-label" x="2" y="${y + 3}">${(maxRate * f).toFixed(1)}</text>` +
      `<text class="axis-label" x="${W - padR + 3}" y="${y + 3}">${Math.round(maxAlt * f / 1000)}k</text>`;
  }).join('');

  const hours = `<text class="axis-label" x="${padL}" y="${H - 6}">0h</text>` +
    `<text class="axis-label" x="${W - padR - 18}" y="${H - 6}">${maxT.toFixed(1)}h</text>`;

  return svgEl(
    grid +
    `<path d="${altPath}" fill="none" stroke="var(--low-conf)" stroke-width="1.5"/>` +
    `<path d="${dosePath}" fill="none" stroke="var(--amber)" stroke-width="2"/>` +
    hours,
    `0 0 ${W} ${H}`
  );
}

// Equirectangular graticule rather than a coastline: what matters here is
// latitude, which is what drives the dose, and it keeps the page self-contained
// with no tile provider and no API key.
function trackMap(samples) {
  const W = 340, H = 180;
  const x = (lon) => ((lon + 180) / 360) * W;
  const y = (lat) => ((90 - lat) / 180) * H;

  let grid = '';
  for (let lat = -60; lat <= 60; lat += 30) {
    grid += `<line class="grid-line" x1="0" y1="${y(lat)}" x2="${W}" y2="${y(lat)}"/>` +
      `<text class="axis-label" x="2" y="${y(lat) - 2}">${lat}°</text>`;
  }
  for (let lon = -120; lon <= 120; lon += 60) {
    grid += `<line class="grid-line" x1="${x(lon)}" y1="0" x2="${x(lon)}" y2="${H}"/>`;
  }
  grid += `<line class="grid-line" x1="0" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="#2a2a2a"/>`;

  const maxRate = Math.max(...samples.map((s) => s.effUSvPerHr)) || 1;
  const dots = samples.map((s) => {
    const f = s.effUSvPerHr / maxRate;
    const colour = f > 0.75 ? 'var(--alert)' : f > 0.45 ? 'var(--warn)' : 'var(--ok)';
    return `<circle cx="${x(s.lon).toFixed(1)}" cy="${y(s.lat).toFixed(1)}" r="1.6" fill="${colour}"${s.interpolated ? ' opacity="0.45"' : ''}/>`;
  }).join('');

  return svgEl(grid + dots, `0 0 ${W} ${H}`);
}

function provRow(k, v) {
  return `<div class="prov-row"><span class="prov-key">${esc(k)}</span><span class="prov-val">${esc(v)}</span></div>`;
}

async function openFlight(id) {
  showScreen('detail');
  const head = $('detail-head');
  head.className = 'loading';
  head.textContent = 'loading…';

  let f;
  try { f = await getJson(`/api/badge/flights/${encodeURIComponent(id)}`); }
  catch (err) { head.textContent = 'Could not load that flight.'; return; }

  head.className = '';
  head.innerHTML = flightRow(f);

  const samples = f.samples || [];
  const hasSeries = samples.length > 1 && samples[0].effUSvPerHr != null;

  $('detail-chart-card').hidden = !hasSeries;
  $('detail-map-card').hidden = !hasSeries;
  if (hasSeries) {
    $('detail-chart').innerHTML = doseRateChart(samples);
    $('detail-map').innerHTML = trackMap(samples);
  }

  // §9.3: this panel is not optional. It is what separates BADGE from a toy.
  $('detail-prov-card').hidden = false;
  const sp = f.solarParams || {};
  $('detail-prov').innerHTML = [
    provRow('model', f.dose.gcrModel),
    provRow('dose quantity', f.dose.gcrQuantity || 'ICRP-116 effective dose'),
    provRow('GCR', mSv(f.dose.gcrMSv)),
    provRow('GCR H*(10)', mSv(f.dose.gcrH10MSv)),
    // Separate rows, never summed (guardrail §13.4).
    provRow('SPE', f.dose.speMSv == null ? 'not determined' : mSv(f.dose.speMSv)),
    provRow('SPE method', f.dose.speMethod || '—'),
    provRow('SPE confidence', f.dose.speConfidence || '—'),
    provRow('telemetry source', f.telemetry.source),
    provRow('coveredFraction', `${(f.telemetry.coveredFraction * 100).toFixed(1)}%`),
    provRow('altitude source', f.telemetry.altSource || '—'),
    provRow('confidence', f.dose.gcrConfidence),
    provRow('uncertainty', f.dose.uncertaintyPct == null ? f.dose.uncertaintyBasis : `± ${pct(f.dose.uncertaintyPct)}`),
    provRow('solar W-index', sp.wIndex == null ? '—' : sp.wIndex.toFixed(1)),
    provRow('force field', sp.forceFieldMV == null ? '—' : `${Math.round(sp.forceFieldMV)} MV`),
    provRow('solar source', sp.source || '—'),
    provRow('entry hash', f.entryHash),
    provRow('previous hash', f.prevHash || '—'),
  ].join('');
}

/* --------------------------------------------------------------- project */

let projectTimer = null;

function projectInputs() {
  return {
    origin: $('proj-from').value.trim().toUpperCase(),
    destination: $('proj-to').value.trim().toUpperCase(),
    date: $('proj-date').value,
    cruiseAltitudeFt: Number($('proj-alt').value) * 100,
  };
}

async function runProjection() {
  const body = projectInputs();
  const card = $('proj-result-card');
  const out = $('proj-result');
  const badge = $('proj-badge');

  if (!body.origin || !body.destination || !body.date) return;

  badge.textContent = 'computing';
  badge.className = 'badge badge-muted';

  try {
    const res = await fetch('/api/badge/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    card.hidden = false;

    if (!res.ok) {
      badge.textContent = 'error';
      badge.className = 'badge badge-alert';
      out.innerHTML = `<p class="pending">${esc(j.error || 'Projection failed.')}</p>`;
      return;
    }

    const p = j.projection;
    badge.textContent = 'NOT RECORDED';
    badge.className = 'badge badge-muted';

    const cp = j.currentPosition;
    out.innerHTML =
      `<div class="proj-dose">${mSv(p.dose.gcrMSv)}</div>` +
      `<div class="proj-sub">` +
      `${esc(p.route)} · ${esc(p.dateUtc)} · FL${Math.round(p.cruiseAltitudeFt / 100)} · ${p.durationHours.toFixed(2)} h<br>` +
      `peak ${p.peakDoseRateUSvPerHr.toFixed(2)} µSv/h · max lat ${p.maxLatitude.toFixed(1)}°<br>` +
      `SPE: ${p.dose.speMSv == null ? 'not determined' : mSv(p.dose.speMSv)} — separate from GCR, never summed<br>` +
      `solar: ${esc(p.solarParams.source)} (${esc(p.solarParams.confidence)}${p.solarParams.uncertaintyPct ? `, ±${p.solarParams.uncertaintyPct}% dose` : ''})<br>` +
      (cp ? `against your position: ${pct(cp.pctOfAnnualLimit)} of the ${cp.annualLimitMSv} mSv limit so far` : 'no recorded flights to compare against') +
      `</div>`;
  } catch (err) {
    card.hidden = false;
    badge.textContent = 'offline';
    badge.className = 'badge badge-stale';
    out.innerHTML = '<p class="pending">Projection needs the backend.</p>';
  }
}

function scheduleProjection() {
  clearTimeout(projectTimer);
  projectTimer = setTimeout(runProjection, 350);
}

/* ---------------------------------------------------------- brief screen */

async function askBriefing(question) {
  const hist = $('briefing-history');
  const src = $('briefing-source');
  src.textContent = 'thinking';
  src.className = 'badge badge-muted';

  try {
    const asOf = new URLSearchParams(location.search).get('asOf');
    const res = await fetch('/api/badge/brief' + (asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question || undefined }),
    });
    const b = await res.json();
    src.textContent = b.source === 'llm' ? 'LLM · VERIFIED' : 'DETERMINISTIC';
    src.className = `badge ${b.source === 'llm' ? 'badge-ok' : 'badge-muted'}`;

    const entry = document.createElement('article');
    entry.className = 'brief-entry';
    entry.innerHTML =
      (question ? `<p class="brief-q">${esc(question)}</p>` : '') +
      `<p class="brief-a">${esc(b.text)}</p>` +
      `<p class="brief-provenance">${esc([b.note, b.guard ? `numeral guard: ${b.guard.checked} checked, ${b.guard.unsupported.length} unsupported` : ''].filter(Boolean).join(' · '))}</p>`;
    hist.prepend(entry);
  } catch (err) {
    src.textContent = 'offline';
    src.className = 'badge badge-stale';
  }
}

/* ------------------------------------------------------------------- wiring */

const SCREENS = ['now', 'ledger', 'detail', 'project', 'briefing'];

function showScreen(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.screen === name);
  });
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showScreen(tab.dataset.screen));
});

$('detail-back').addEventListener('click', () => showScreen('ledger'));

// Ledger rows open the detail view.
$('ledger-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-flight-id]');
  if (row) openFlight(row.dataset.flightId);
});
$('last-flight').addEventListener('click', (e) => {
  const row = e.target.closest('[data-flight-id]');
  if (row) openFlight(row.dataset.flightId);
});

$('proj-alt').addEventListener('input', () => {
  $('proj-alt-read').textContent = `FL${$('proj-alt').value}`;
  scheduleProjection();
});
['proj-from', 'proj-to', 'proj-date'].forEach((id) =>
  $(id).addEventListener('change', scheduleProjection));

$('briefing-go').addEventListener('click', () => {
  askBriefing($('briefing-q').value.trim());
  $('briefing-q').value = '';
});
$('briefing-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { askBriefing($('briefing-q').value.trim()); $('briefing-q').value = ''; }
});

$('refresh').addEventListener('click', () => { refresh(); loadBrief(); });
$('brief-go').addEventListener('click', () => loadBrief($('brief-q').value.trim()));
$('brief-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadBrief($('brief-q').value.trim());
});
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
refresh().then(() => loadBrief());
