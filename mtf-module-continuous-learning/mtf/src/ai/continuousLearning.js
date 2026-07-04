/**
 * ai/continuousLearning.js
 *
 * "Every trade updates the database. The AI gradually learns what worked,
 * what failed, under what conditions." This is that feedback loop.
 *
 * INTEGRATION, STATED PLAINLY: this listens for `mambafx:tradeOpened` and
 * `mambafx:tradeClosed` — two CustomEvents dispatched from the MAIN
 * dashboard's trading bots (added as two small, purely-additive edits;
 * they don't alter any existing bot behavior). Coverage is NOT uniform:
 *   - Trading Grid: full open+close pair, so the "at entry" snapshot is
 *     exact — evidence captured at the moment the trade was actually placed.
 *   - Every other bot (Digits, 5-Tick Engine, Only Ups/Downs, ADX, Mamba FX
 *     floating bot, Deriv Auto Bot): only the shared settlement point fires
 *     tradeClosed. For these, this module falls back to snapshotting
 *     evidence AT SETTLEMENT time instead of entry time, and marks that
 *     entry `approximate: true` in the log. This is a real, stated
 *     limitation — hooking every bot's own trade-opening code was judged
 *     too invasive to do safely in one pass across a large, sensitive
 *     trading file. The calibration algorithm below still uses approximate
 *     entries, but a future pass could add proper open-hooks per bot.
 *
 * WHAT "LEARNING" MEANS HERE: deterministic statistical recalibration, not
 * a neural net and not an external AI call. For each of the Probability
 * Engine's 8 evidence dimensions, this measures — across this user's own
 * logged trades — whether that dimension AGREEING with the trade's
 * direction actually correlated with a higher win rate than the baseline.
 * Dimensions that have been genuinely predictive get weighted up; ones
 * that haven't get weighted down. Every number is inspectable and derived
 * from real outcomes in getLog() — there is no hidden model.
 */

import { AppState } from '../core/AppState.js';
import { runProbabilityEngine, DEFAULT_WEIGHTS } from './probabilityEngine.js';
import { recordOutcome, getLog, getLogSummary, clearLog } from '../workspace/learningLog.js';

const MIN_TRADES_FOR_CALIBRATION = 20;
const pendingEntries = new Map();

function snapshotDimensions() {
  const { htf, ltf } = AppState.panels;
  if (!htf || htf.candles.length < 40) return null;
  const result = runProbabilityEngine(htf.candles, ltf ? ltf.candles : [], 'neutral');
  return result ? result.dimensions.map(d => ({ name: d.name, score: d.score })) : null;
}

function onTradeOpened(e) {
  const { id, symbol, dir } = e.detail;
  if (symbol !== AppState.symbol) return;
  const dimensions = snapshotDimensions();
  if (!dimensions) return;
  pendingEntries.set(id, { dimensions, symbol, dir });
}

function onTradeClosed(e) {
  const { id, symbol, dir, won, pnl } = e.detail;
  const pending = pendingEntries.get(id);
  pendingEntries.delete(id);

  if (pending) {
    recordOutcome({ symbol, dir, won, pnl, approximate: false, dimensions: pending.dimensions });
    return;
  }
  if (symbol !== AppState.symbol) return;
  const dimensions = snapshotDimensions();
  if (!dimensions) return;
  recordOutcome({ symbol, dir, won, pnl, approximate: true, dimensions });
}

/**
 * @returns {{weights: object, calibrated: boolean, sampleSize: number}}
 */
export function getCalibratedWeights() {
  const log = getLog();
  if (log.length < MIN_TRADES_FOR_CALIBRATION) {
    return { weights: { ...DEFAULT_WEIGHTS }, calibrated: false, sampleSize: log.length };
  }

  const overallWinRate = log.filter(e => e.won).length / log.length;
  const weights = {};

  for (const dimName of Object.keys(DEFAULT_WEIGHTS)) {
    const relevant = log.filter(e => {
      const d = e.dimensions.find(x => x.name === dimName);
      return d && d.score !== 0;
    });
    if (relevant.length < 5) { weights[dimName] = DEFAULT_WEIGHTS[dimName]; continue; }

    const agreeing = relevant.filter(e => {
      const d = e.dimensions.find(x => x.name === dimName);
      return Math.sign(d.score) === e.dir;
    });
    if (agreeing.length < 3) { weights[dimName] = DEFAULT_WEIGHTS[dimName]; continue; }

    const winRateWhenAgreed = agreeing.filter(e => e.won).length / agreeing.length;
    const reliability = Math.max(0.5, Math.min(1.5, 1 + (winRateWhenAgreed - overallWinRate) * 2));
    weights[dimName] = DEFAULT_WEIGHTS[dimName] * reliability;
  }

  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  if (total > 0) for (const k of Object.keys(weights)) weights[k] = weights[k] / total;

  return { weights, calibrated: true, sampleSize: log.length };
}

export function getLearningStatus() {
  const summary = getLogSummary();
  return { ...summary, minRequired: MIN_TRADES_FOR_CALIBRATION, isCalibrating: summary.total >= MIN_TRADES_FOR_CALIBRATION };
}

export function resetLearning() {
  clearLog();
  pendingEntries.clear();
}

export function initContinuousLearning() {
  window.addEventListener('mambafx:tradeOpened', onTradeOpened);
  window.addEventListener('mambafx:tradeClosed', onTradeClosed);
}
