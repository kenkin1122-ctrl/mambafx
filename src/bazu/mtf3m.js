// Multi-timeframe playbook analysis. LOG / SHADOW ONLY: output is written to the signal log and shown in the UI.
// Nothing here is read by prediction, gating, sizing or any order path. MTF_GATE is reserved and intentionally unused.
import { buildFrames } from './candles3m.js?v=15';
import { trendDiagnostics } from './diagnostics3m.js?v=17';

export const MTF_FRAMES = Object.freeze(['M1', 'M3', 'M5', 'M15', 'H1']);
const MIN_CLOSES = 30;

// Regime from the shared diagnostics: VR(5) and Hurst agreeing on persistence or reversion.
export function classifyRegime(d) {
  if (!d || !Number.isFinite(d.varianceRatio) || !Number.isFinite(d.hurst)) return 'insufficient';
  if (d.varianceRatio > 1.1 && d.hurst > 0.55) return 'trending';
  if (d.varianceRatio < 0.9 && d.hurst < 0.5) return 'mean-reverting';
  return 'random';
}

export const playbookFor = (regime) => (regime === 'trending' ? 'trend-pullback' : regime === 'mean-reverting' ? 'range-fade' : 'none');

function slopeDir(closes, n = 20) {
  const w = closes.slice(-n);
  if (w.length < 5) return 0;
  const mean = w.reduce((a, b) => a + b, 0) / w.length, last = w[w.length - 1];
  return last > mean ? 1 : last < mean ? -1 : 0;
}

export function analyseFrames(framesByName, signalDir = 0) {
  const grid = {};
  for (const k of MTF_FRAMES) {
    const closes = (framesByName[k] || []).map((c) => c.close).filter(Number.isFinite);
    if (closes.length < MIN_CLOSES) { grid[k] = { n: closes.length, regime: 'insufficient', playbook: 'none', direction: 0, aligned: false }; continue; }
    const d = trendDiagnostics(closes), regime = classifyRegime(d), direction = slopeDir(closes);
    grid[k] = { n: closes.length, varianceRatio: d.varianceRatio, autocorr1: d.autocorr1, runsZ: d.runsZ, hurst: d.hurst, regime, playbook: playbookFor(regime), direction, aligned: signalDir ? direction === signalDir : false };
  }
  const used = MTF_FRAMES.filter((k) => grid[k].regime !== 'insufficient');
  return { frames: grid, alignedCount: used.filter((k) => grid[k].aligned).length, usedCount: used.length };
}

export function analyseMtf({ remote, prices, epochs, decisionEpoch, cfg, signalDir = 0 }) {
  const frames = buildFrames({ remote: remote || {}, prices, epochs, decisionEpoch, cfg, names: MTF_FRAMES });
  return analyseFrames(frames, signalDir);
}
