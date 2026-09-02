'use strict';

// Numeral guard (brief §7, guardrail §13.2).
//
// "A hallucinated mSv figure is a safety problem, not a quality problem." So every
// numeral appearing in generated text must be traceable to the structured input.
// If any numeral is not, the whole generation is REJECTED — not patched, not
// partially used. The deterministic renderer takes over instead.

// Collect every number in the context, plus the roundings a writer would
// legitimately use for it (0.05089 -> "0.05", "0.051", "0.0509", "0").
function allowedNumerals(context) {
  const allowed = new Set();

  const addNumber = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    allowed.add(String(n));
    for (let dp = 0; dp <= 6; dp++) {
      allowed.add(n.toFixed(dp));
      // Strip trailing zeros so "0.10" also authorises "0.1".
      allowed.add(String(Number(n.toFixed(dp))));
    }
    allowed.add(String(Math.round(n)));
    allowed.add(String(Math.trunc(n)));
  };

  // Any digit run inside a string value (dates, ids, model versions) is fair game.
  const addString = (s) => {
    for (const m of String(s).matchAll(/\d+(?:\.\d+)?/g)) {
      allowed.add(m[0]);
      allowed.add(String(Number(m[0])));
    }
  };

  const walk = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'number') return addNumber(value);
    if (typeof value === 'string') return addString(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') return Object.values(value).forEach(walk);
  };

  walk(context);
  return allowed;
}

// Numerals in the text that no value in the context can account for.
function findUnsupportedNumerals(text, allowed) {
  const found = [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const unsupported = [];
  for (const numeral of found) {
    if (allowed.has(numeral) || allowed.has(String(Number(numeral)))) continue;
    unsupported.push(numeral);
  }
  return [...new Set(unsupported)];
}

function validate(text, context) {
  const allowed = allowedNumerals(context);
  const unsupported = findUnsupportedNumerals(text, allowed);
  return {
    ok: unsupported.length === 0,
    unsupported,
    checked: [...String(text).matchAll(/\d+(?:\.\d+)?/g)].length,
  };
}

module.exports = { validate, allowedNumerals, findUnsupportedNumerals };
