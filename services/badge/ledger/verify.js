'use strict';

// Hash-chain integrity check. Walks the ledger in sequence order, recomputes each
// entry's hash from its own stored fields, and checks it links to the one before it.
// Detects both content tampering and chain surgery (a removed or reordered entry).

const store = require('./store');
const { hashEntry, GENESIS_HASH } = require('./hash');

function verify(db) {
  const rows = store.all(db);

  if (rows.length === 0) {
    return { intact: true, entries: 0, brokenAt: null, headHash: GENESIS_HASH, issues: [] };
  }

  const issues = [];
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let brokenAt = null;

  for (const row of rows) {
    const problems = [];

    if (row.seq !== expectedSeq) {
      problems.push(`sequence gap: expected seq ${expectedSeq}, found ${row.seq}`);
    }
    if (row.prev_hash !== prevHash) {
      problems.push(`broken link: prev_hash does not match the previous entry's hash`);
    }

    const recomputed = hashEntry(store.hashableFrom(row), row.prev_hash);
    if (recomputed !== row.entry_hash) {
      problems.push(`content tampered: stored hash does not match recomputed hash`);
    }

    if (problems.length) {
      if (!brokenAt) brokenAt = row.id;
      issues.push({ id: row.id, seq: row.seq, problems });
    }

    prevHash = row.entry_hash;
    expectedSeq = row.seq + 1;
  }

  return {
    intact: issues.length === 0,
    entries: rows.length,
    brokenAt,
    headHash: rows[rows.length - 1].entry_hash,
    issues,
  };
}

module.exports = { verify };
