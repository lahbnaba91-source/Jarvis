'use strict';

const crypto = require('crypto');

const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

// Deterministic serialization: object keys sorted at every depth, so the same
// logical entry always hashes identically regardless of property insertion order.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function hashEntry(payload, prevHash) {
  const material = canonicalize({ payload, prevHash });
  return 'sha256:' + crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

module.exports = { canonicalize, hashEntry, GENESIS_HASH };
