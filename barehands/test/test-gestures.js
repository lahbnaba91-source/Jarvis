#!/usr/bin/env node
// test-gestures.js -- regression test for barehands' pure gesture
// detectors (../gestures.js). No dependencies, no framework: run with
// `node test/test-gestures.js` from the barehands folder -- same
// "nothing to install" rule as the rest of this repo.
//
// Checks two things, against two sources:
//
//   - fixtures/gesture-samples.jsonl -- the tracked, checked-in regression
//     corpus. This is the one CI runs, so it's ALWAYS checked here too,
//     on every machine, regardless of what else is present. Its baseline
//     is the tracked fixtures/gesture-samples.snapshot.json.
//   - ../state/gesture_log.jsonl -- your gitignored, machine-local
//     recording log, checked IN ADDITION when it has samples (never
//     required, never seen by CI). Its baseline is the gitignored
//     gestures.snapshot.json.
//
// The two checks are independent: a broken pose gate that only shows up
// against the fixture can't hide just because a dev machine also has a
// large personal log, and vice versa.
//
//   1. COLLISIONS -- does any single hand shape satisfy two or more of
//      these single-hand pose gates at once? Each pose is supposed to
//      represent one distinguishable shape; a real recorded hand
//      tripping two gates simultaneously is exactly the kind of bug
//      that cost several live-testing round-trips before this harness
//      existed (the dun-dun pose silently also reading as a force-pull
//      charge). Fails loudly if found.
//
//   2. SNAPSHOT -- a checked-in baseline of which poses fire on which
//      sample. A future threshold change that silently flips a
//      sample's behavior shows up as a diff here instead of shipping
//      unnoticed. Run with --update-fixture to deliberately regenerate
//      the tracked fixture baseline, or --update for your personal
//      log's baseline (requires a live log with samples) -- kept as two
//      separate flags on purpose so refreshing your own baseline can
//      never accidentally overwrite the shared, CI-relied-upon one.
"use strict";

const fs = require("fs");
const path = require("path");
const G = require(path.join(__dirname, "..", "gestures.js"));

const LOG_PATH = path.join(__dirname, "..", "state", "gesture_log.jsonl");
const FIXTURE_PATH = path.join(__dirname, "fixtures", "gesture-samples.jsonl");
const SNAPSHOT_PATH = path.join(__dirname, "gestures.snapshot.json");
const FIXTURE_SNAPSHOT_PATH = path.join(__dirname, "fixtures", "gesture-samples.snapshot.json");
const UPDATE = process.argv.includes("--update");
const UPDATE_FIXTURE = process.argv.includes("--update-fixture");

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

function loadSamplesFrom(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
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

// Runs both checks (collision + snapshot) for one source and reports
// against its own baseline. `updateFlag` is this source's own flag
// (--update-fixture for the fixture, --update for the live log) so a
// snapshot is only ever refreshed by the flag that names it. Returns
// { collisionFailed, snapshotFailed } separately -- only a snapshot diff
// is fixable by re-running with the update flag, so the caller must not
// suggest that remedy for a collision failure, which is a real gesture-
// detection bug the update flag can't do anything about.
function checkSource(label, samples, logPath, snapshotPath, updateFlag) {
  const { results, collisions } = evaluate(samples);
  console.log(`[${label}] checked ${samples.length} hand samples from ${path.relative(process.cwd(), logPath)}`);

  let collisionFailed = false;
  let snapshotFailed = false;

  if (collisions.length) {
    collisionFailed = true;
    console.error(`[${label}] FAIL -- COLLISION: ${collisions.length} sample(s) fired more than one pose gate at once:`);
    collisions.forEach(c => console.error(`  ${c.id} (ts ${c.ts}): ${c.fired.join(" + ")}`));
  } else {
    console.log(`[${label}] PASS -- no collisions: every sample fires at most one pose gate`);
  }

  if (updateFlag) {
    fs.writeFileSync(snapshotPath, JSON.stringify(results, null, 2) + "\n");
    console.log(`[${label}] snapshot written: ${path.relative(process.cwd(), snapshotPath)} (${Object.keys(results).length} samples)`);
  } else if (fs.existsSync(snapshotPath)) {
    const baseline = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
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
      snapshotFailed = true;
      console.error(`[${label}] FAIL -- SNAPSHOT DIFF: ${diffs.length} sample(s) changed behavior vs the checked-in baseline:`);
      diffs.forEach(d => console.error(`  ${d.id}: ${JSON.stringify(d.before)} -> ${d.missing ? "MISSING" : JSON.stringify(d.after)}`));
    } else {
      console.log(`[${label}] PASS -- matches checked-in snapshot (${Object.keys(baseline).length} samples)`);
    }
  } else {
    console.log(`[${label}] no baseline yet -- run with the update flag to create ${path.relative(process.cwd(), snapshotPath)}`);
  }

  return { collisionFailed, snapshotFailed };
}

function main() {
  let failed = false;

  // Fixture: the tracked, CI-authoritative regression corpus. Always
  // checked, on every machine, whether or not a live log also exists --
  // this is what closes the original CI-no-op gap and what
  // --update-fixture always targets.
  const fixtureSamples = loadSamplesFrom(FIXTURE_PATH);
  if (!fixtureSamples.length) {
    console.log(`no hand samples found in fixture ${FIXTURE_PATH} -- nothing to test`);
    process.exit(1);
  }
  {
    const { collisionFailed, snapshotFailed } = checkSource(
      "fixture", fixtureSamples, FIXTURE_PATH, FIXTURE_SNAPSHOT_PATH, UPDATE_FIXTURE);
    if (collisionFailed || snapshotFailed) failed = true;
    if (snapshotFailed) console.error("If this change was intentional: node test/test-gestures.js --update-fixture");
  }

  console.log("");

  // Live log: your gitignored, machine-local recording data. Checked in
  // addition to the fixture whenever it has samples; never required, and
  // CI never has one.
  const liveSamples = loadSamplesFrom(LOG_PATH);
  if (liveSamples.length) {
    const { collisionFailed, snapshotFailed } = checkSource(
      "live log", liveSamples, LOG_PATH, SNAPSHOT_PATH, UPDATE);
    if (collisionFailed || snapshotFailed) failed = true;
    if (snapshotFailed) console.error("If this change was intentional: node test/test-gestures.js --update");
  } else if (UPDATE) {
    const reason = fs.existsSync(LOG_PATH)
      ? `log at ${LOG_PATH} exists but has no usable hand samples`
      : `no live log at ${LOG_PATH}`;
    console.error(`[live log] ${reason} -- nothing of yours to update with --update.`);
    console.error("[live log] --update-fixture instead regenerates the tracked fixture baseline (already handled above).");
    failed = true;
  } else {
    console.log(`[live log] ${LOG_PATH} not present or empty -- skipping (fixture check above already ran)`);
  }

  process.exit(failed ? 1 : 0);
}

main();
