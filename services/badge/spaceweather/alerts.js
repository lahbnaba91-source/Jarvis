'use strict';

// Threshold-crossing detection. Compares a fresh classification against the last
// one the poller saw and emits an alert only on a transition, so a running storm
// does not re-alert every poll.

const fs = require('fs');
const path = require('path');
const {
  PROTON_EVENT_THRESHOLD_10MEV_PFU,
  AVIATION_THRESHOLD_100MEV_PFU,
} = require('./sources');

const STATE_PATH = path.join(__dirname, '..', 'data', 'spaceweather', 'alert-state.json');

const S_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
const sRank = (s) => Math.max(0, S_ORDER.indexOf(s || 'S0'));

function readState() {
  if (!fs.existsSync(STATE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function detect(current, previous) {
  const alerts = [];
  const now = new Date().toISOString();

  if (!previous) return alerts; // first observation establishes the baseline

  if (sRank(current.sScale) > sRank(previous.sScale)) {
    alerts.push({
      at: now,
      type: 's-scale-escalation',
      severity: sRank(current.sScale) >= 3 ? 'high' : 'medium',
      from: previous.sScale,
      to: current.sScale,
      message: `Solar radiation storm escalated ${previous.sScale} -> ${current.sScale}.`,
    });
  } else if (sRank(current.sScale) < sRank(previous.sScale)) {
    alerts.push({
      at: now,
      type: 's-scale-easing',
      severity: 'info',
      from: previous.sScale,
      to: current.sScale,
      message: `Solar radiation storm eased ${previous.sScale} -> ${current.sScale}.`,
    });
  }

  if (current.protonEventActive && !previous.protonEventActive) {
    alerts.push({
      at: now,
      type: 'proton-event-start',
      severity: 'high',
      message: `>=10 MeV proton flux crossed ${PROTON_EVENT_THRESHOLD_10MEV_PFU} pfu ` +
               `(now ${current.protons10MeV?.toFixed(2)} pfu). SWPC proton event threshold.`,
    });
  }
  if (!current.protonEventActive && previous.protonEventActive) {
    alerts.push({ at: now, type: 'proton-event-end', severity: 'info',
      message: '>=10 MeV proton flux dropped back below the event threshold.' });
  }

  // The one that actually matters at cruise altitude.
  if (current.aviationHighEnergyActive && !previous.aviationHighEnergyActive) {
    alerts.push({
      at: now,
      type: 'high-energy-proton-event',
      severity: 'high',
      message: `>=100 MeV proton flux crossed ${AVIATION_THRESHOLD_100MEV_PFU} pfu ` +
               `(now ${current.protons100MeV?.toFixed(3)} pfu). These reach cruise altitude.`,
    });
  }

  const prevScore = previous.aviationRisk ? previous.aviationRisk.score : 0;
  const curScore = current.aviationRisk ? current.aviationRisk.score : 0;
  for (const step of [25, 50, 75]) {
    if (curScore >= step && prevScore < step) {
      alerts.push({
        at: now, type: 'aviation-risk-threshold', severity: step >= 50 ? 'high' : 'medium',
        message: `Aviation risk score crossed ${step} (now ${curScore}/100).`,
      });
    }
  }

  return alerts;
}

// Persists the new baseline and returns whatever crossings just happened.
function evaluate(current) {
  const previousState = readState();
  const alerts = detect(current, previousState ? previousState.classification : null);
  const history = (previousState ? previousState.recentAlerts : []).concat(alerts).slice(-50);
  writeState({ updatedAt: new Date().toISOString(), classification: current, recentAlerts: history });
  return { alerts, recentAlerts: history };
}

module.exports = { detect, evaluate, readState, STATE_PATH };
