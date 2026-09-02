'use strict';

// Deterministic structured-JSON -> terse human text (brief §7 render.js).
//
// This is not a fallback bolted on as an afterthought — it is the reference
// output. It cannot hallucinate, needs no API key, and works offline, so the
// brief card always has something true to show. The LLM path only ever replaces
// this when it passes the numeral guard.

function fmtMSv(v) {
  if (v === null || v === undefined) return null;
  return `${v.toFixed(4)} mSv`;
}

function sentences(context) {
  const out = [];
  const d = context.dose;
  const sw = context.spaceWeather;

  if (!d || d.empty) {
    out.push('No flights are recorded yet, so there is no dose position to report.');
  } else {
    out.push(
      `You are at ${d.pctOfAnnualLimit.toFixed(1)}% of the ${d.annualLimitMSv} mSv annual limit ` +
      `under ${d.policyId}, with ${fmtMSv(d.ytdGcrMSv)} of modeled GCR dose year to date across ` +
      `${d.flightsLogged} recorded flights.`
    );

    if (d.projectedYearEndGcrMSv > 0) {
      const risk = d.breachRisk === 'low'
        ? 'well inside the limit'
        : d.breachRisk === 'moderate'
          ? 'close enough to the limit to watch'
          : d.breachRisk === 'high'
            ? 'on track to breach the limit'
            : 'already past the limit';
      out.push(
        `At the current pace the projection for year end is ${fmtMSv(d.projectedYearEndGcrMSv)}, ${risk}` +
        `${d.daysToThreshold != null ? `, roughly ${d.daysToThreshold} days of flying from the limit` : ''}.`
      );
    }

    if (d.topContributors && d.topContributors.length) {
      const t = d.topContributors[0];
      out.push(`Your heaviest single flight on record is ${t.route} on ${t.dateUtc} at ${fmtMSv(t.gcrMSv)}.`);
    }

    // GCR and SPE are reported as separate quantities, never as one total.
    out.push(
      d.ytdSpeMSv > 0
        ? `Solar particle event dose is tracked separately and stands at ${fmtMSv(d.ytdSpeMSv)}; it is modeled at low confidence and is never added into the GCR figure.`
        : 'No solar particle event dose is recorded, and SPE is always reported separately from GCR rather than summed into it.'
    );
  }

  if (sw && sw.available) {
    const staleNote = sw.stale ? ` (${sw.staleness}, not live)` : '';
    out.push(
      sw.protonEventActive
        ? `Space weather is ${sw.sScale} with a proton event running${staleNote} — the aviation risk score is ${sw.aviationRiskScore} out of ${sw.aviationRiskScoreMax}, so a polar sector today is a materially different exposure than a mid-latitude one.`
        : `Space weather is quiet at ${sw.sScale}${staleNote}, aviation risk score ${sw.aviationRiskScore} out of ${sw.aviationRiskScoreMax}.`
    );
  } else {
    out.push('No space weather data is cached, so no storm context is available for this brief.');
  }

  if (d && !d.empty && d.meanUncertaintyPct === null) {
    out.push('Per-flight uncertainty is not quantified yet, so treat these as modeled estimates rather than measurements.');
  }

  return out;
}

// 3-5 sentences (§8).
function render(context, limit = 5) {
  return sentences(context).slice(0, limit).join(' ');
}

module.exports = { render, sentences };
