#!/usr/bin/env node
// test-gestures.js -- regression test for barehands' pure gesture
// detectors (../gestures.js). No dependencies, no framework: run with
// `node test/test-gestures.js` from the barehands folder -- same
// "nothing to install" rule as the rest of this repo.
//
// Checks two things against every real hand shape ever RECORDed
// (../state/gesture_log.jsonl):
//
//   1. COLLISIONS -- does any single real hand shape satisfy two or
//      more of these single-hand pose gates at once? Each pose is
//      supposed to represent one distinguishable shape; a real
//      recorded hand tripping two gates simultaneously is exactly the
//      kind of bug that cost several live-testing round-trips before
//      this harness existed (the dun-dun pose silently also reading as
//      a force-pull charge). Fails loudly if found.
//
//   2. SNAPSHOT -- a checked-in baseline (gestures.snapshot.json) of
//      which poses fire on which recorded sample. A future threshold
//      change that silently flips a real recorded sample's behavior
//      shows up as a diff here instead of shipping unnoticed.
//      Run with --update to regenerate the baseline after a
//      deliberate, verified change.
"use strict";

const fs = require("fs");
const path = require("path");
const G = require(path.join(__dirname, "..", "gestures.js"));

const LOG_PATH = path.join(__dirname, "..", "state", "gesture_log.jsonl");
const SNAPSHOT_PATH = path.join(__dirname, "gestures.snapshot.json");
const UPDATE = process.argv.includes("--update");

const POSES = {
  rockSign: G.rockSign,
  middleUpSign: G.middleUpSign,
  peaceSign: G.peaceSign,
  clawPose: G.clawPose,
  snapPose: G.snapPose,
  fingerGunSign: G.fingerGunSign,
};

// Walks any JSON value looking for a "landmarks" array (21 {x,y,z}
// points -- MediaPipe's normalized 2D-ish hand shape, the exact thing
// every pose gate reads). Deliberately schema-agnostic about how
// "kind":"image" vs "kind":"video" entries nest that data, and
// deliberately skips "worldLandmarks" (3D, not what these formulas
// use) so a real hand is never double-counted.
function* findHands(node, key) {
  if (Array.isArray(node)) {
    if (key === "landmarks" && node.length === 21 &&
        node.every(p => p && typeof p.x === "number" && typeof p.y === "number")) {
      yield node;
      return;
    }
    for (const v of node) yield* findHands(v, key);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "worldLandmarks") continue;
      yield* findHands(v, k);
    }
  }
}

function loadSamples() {
  if (!fs.existsSync(LOG_PATH)) return [];
  const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
  const samples = [];
  lines.forEach((line, li) => {
    let entry;
    try { entry = JSON.parse(line); } catch (e) { return; }
    let hi = 0;
    for (const lms of findHands(entry, null)) {
      samples.push({ id: `${li}:${hi++}`, ts: entry.ts, kind: entry.kind, lms });
    }
  });
  return samples;
}

function evaluate(samples) {
  const results = {};
  const collisions = [];
  for (const s of samples) {
    const fired = Object.keys(POSES).filter(name => POSES[name](s.lms));
    results[s.id] = fired;
    if (fired.length > 1) collisions.push({ id: s.id, ts: s.ts, fired });
  }
  return { results, collisions };
}

function main() {
  const samples = loadSamples();
  if (!samples.length) {
    console.error(`no hand samples found in ${LOG_PATH} -- nothing to test`);
    process.exit(1);
  }

  const { results, collisions } = evaluate(samples);
  console.log(`checked ${samples.length} real hand samples from ${path.relative(process.cwd(), LOG_PATH)}`);

  let failed = false;

  if (collisions.length) {
    failed = true;
    console.error(`\nFAIL -- COLLISION: ${collisions.length} sample(s) fired more than one pose gate at once:`);
    collisions.forEach(c => console.error(`  ${c.id} (ts ${c.ts}): ${c.fired.join(" + ")}`));
  } else {
    console.log("PASS -- no collisions: every recorded sample fires at most one pose gate");
  }

  if (UPDATE) {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nsnapshot written: ${path.relative(process.cwd(), SNAPSHOT_PATH)} (${Object.keys(results).length} samples)`);
  } else if (fs.existsSync(SNAPSHOT_PATH)) {
    const baseline = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    const diffs = [];
    for (const id of Object.keys(results)) {
      const before = JSON.stringify(baseline[id] || []);
      const after = JSON.stringify(results[id]);
      if (before !== after) diffs.push({ id, before: baseline[id] || [], after: results[id] });
    }
    for (const id of Object.keys(baseline)) {
      if (!(id in results)) diffs.push({ id, before: baseline[id], after: null, missing: true });
    }
    if (diffs.length) {
      failed = true;
      console.error(`\nFAIL -- SNAPSHOT DIFF: ${diffs.length} sample(s) changed behavior vs the checked-in baseline:`);
      diffs.forEach(d => console.error(`  ${d.id}: ${JSON.stringify(d.before)} -> ${d.missing ? "MISSING" : JSON.stringify(d.after)}`));
      console.error(`\nIf this change was intentional: node test/test-gestures.js --update`);
    } else {
      console.log(`PASS -- matches checked-in snapshot (${Object.keys(baseline).length} samples)`);
    }
  } else {
    console.log(`\nno baseline yet -- run with --update to create ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  }

  process.exit(failed ? 1 : 0);
}

main();
