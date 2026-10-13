/**
 * src/bazu/config3m.js  (pure)
 * Configuration for BAZU's 3-minute Rise/Fall decision path. Every weight, threshold and
 * enabled flag lives here (per market class) so it can be tuned without touching code.
 * Nothing here is shared with the 5-Tick Signal Engine or the research/validation modules.
 */

export const TARGET = Object.freeze({
  durationSec: 180,
  // Deriv Rise/Fall: exit must be strictly above entry for Rise (below for Fall). A tie loses.
  tiesWin: false,
});

const ALL_FACTORS = ['mtfTrend', 'macd', 'adx', 'stoch', 'rsi', 'cci', 'structure', 'zones', 'volatility', 'tickFlow', 'hurst', 'varianceRatio', 'ouHalfLife', 'kalman', 'cusum', 'spike', 'rangeBreak', 'stepStructure'];
const ALL_PATTERNS = ['pinBar', 'engulfing', 'star', 'tweezer', 'piercing', 'harami', 'doji', 'insideBar', 'flagPennant', 'threeMethods', 'displacement', 'abcd', 'fibPullback'];

const on = (names, off = [], weight = 1) => Object.fromEntries(names.map((n) => [n, { enabled: !off.includes(n), weight }]));

export const BASE_CONFIG = Object.freeze({
  weights: { location: 0.30, structure: 0.25, trigger: 0.25, flow: 0.10, timing: 0.10 },
  SCORE_MIN: 0.45,
  AGREE_MIN: 3,
  MAX_CHASE_ATR: 2,
  ROOM_FACTOR: 1,          // nearest opposing zone must be farther than ROOM_FACTOR * sigma * sqrt(T)
  NOISE_FACTOR: 0.5,       // invalidation closer than NOISE_FACTOR * one-minute sigma is noise
  ATR_PERIOD: 14,
  zoneK: 0.5,              // zone band width = zoneK * ATR
  EXTENDED_ATR: 1.5, EXTENDED_N: 6,
  SPIKE_ATR: 4, SPIKE_COOLDOWN: 3, SPIKE_DUE_FRAC: 0.6,
  BREAKOUT_MIN_ATR: 0.25, BREAKOUT_MAX_ATR: 0.5, BREAKOUT_BODY: 0.6,
  RETEST_BARS: 4, FAKEOUT_BARS: 3,
  PULLBACK_MIN: 0.382, PULLBACK_MAX: 0.618,
  RSI_OB: 65, RSI_OS: 35, STOCH_OB: 80, STOCH_OS: 20, ADX_TREND: 22,
  playbooks: { trending: true, ranging: true, breakout: true },
  patternCfg: {
    pinWick: 2, pinWickFrac: 0.6, pinOppFrac: 0.25, pinRangeATR: 0.8,
    engulfBodyATR: 0.6, tweezerATR: 0.1, dojiBody: 0.1,
    displaceBody: 0.8, displaceRangeATR: 1.5, insideMaxRangeFrac: 1,
  },
  factors: on(ALL_FACTORS, ['spike', 'rangeBreak', 'stepStructure']),
  patterns: on(ALL_PATTERNS, ['abcd', 'fibPullback'], 1),
  patternWeights: { harami: 0.4, doji: 0.5, abcd: 0.3, fibPullback: 0.3 },
});

const merge = (a, b) => {
  if (!b) return a;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b)) out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k];
  return out;
};

export const CLASS_CONFIG = Object.freeze({
  volatility: {},
  bullbear: {},
  boomcrash: { SPIKE_COOLDOWN: 5, factors: { spike: { enabled: true, weight: 1 } } },
  jump: { SPIKE_COOLDOWN: 4, factors: { spike: { enabled: true, weight: 1 } } },
  step: { factors: { stepStructure: { enabled: true, weight: 1.2 }, volatility: { enabled: false } }, patterns: { pinBar: { enabled: false }, engulfing: { enabled: false }, star: { enabled: false }, tweezer: { enabled: false }, piercing: { enabled: false }, harami: { enabled: false }, doji: { enabled: false }, flagPennant: { enabled: false }, threeMethods: { enabled: false } } },
  rangebreak: { factors: { rangeBreak: { enabled: true, weight: 1.2 } }, patterns: { pinBar: { enabled: false }, doji: { enabled: false }, harami: { enabled: false } } },
});

export function marketClass(symbol) {
  const s = String(symbol || '');
  if (/^BOOM|^CRASH/i.test(s)) return 'boomcrash';
  if (/^JD/i.test(s)) return 'jump';
  if (/^stpRNG/i.test(s)) return 'step';
  if (/^RB\d/i.test(s)) return 'rangebreak';
  if (/^RDBULL|^RDBEAR/i.test(s)) return 'bullbear';
  return 'volatility';
}

/** Effective config for a symbol: base <- class defaults <- caller overrides. */
export function configFor(symbol, overrides) {
  return merge(merge(BASE_CONFIG, CLASS_CONFIG[marketClass(symbol)]), overrides);
}

/** Mean spike interval (in ticks) for Boom/Crash indices, e.g. BOOM1000 -> 1000, CRASH300N -> 300. */
export function spikeInterval(symbol) {
  const m = /(?:BOOM|CRASH)(\d+)/i.exec(symbol || '');
  return m ? Number(m[1]) : null;
}

/** 3-minute duration check against Deriv's allowed ranges; falls back to the shortest allowed 1m-or-longer duration. */
export function threeMinuteDuration(durationAllowedFn, ranges, secs = TARGET.durationSec) {
  const d = { unit: 's', n: secs };
  if (durationAllowedFn(ranges, d)) return d;
  const m = { unit: 'm', n: Math.round(secs / 60) };
  return durationAllowedFn(ranges, m) ? m : null;
}

/** Settle a Rise/Fall contract: entry = first tick after purchase, exit = tick at expiry. Ties lose (as on Deriv). */
export function settle(direction, entry, exit) {
  if (exit === entry) return TARGET.tiesWin ? 'win' : 'loss';
  return (direction > 0 ? exit > entry : exit < entry) ? 'win' : 'loss';
}
