/**
 * src/bazu/config3m.js  (pure)
 * Configuration for BAZU's Rise/Fall decision path (duration = expected signal lifetime). Every weight, threshold and
 * enabled flag lives here (per market class) so it can be tuned without touching code.
 * Nothing here is shared with the 5-Tick Signal Engine or the research/validation modules.
 */

export const TARGET = Object.freeze({
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
  // ---- contract duration = expected signal lifetime ----
  DURATION_MODE: 'lifetime',   // lifetime | fixed (fixed uses DEFAULT_DURATION_S)
  DEFAULT_DURATION_S: 180,
  MIN_DURATION_S: 5, MAX_DURATION_S: 1200, SKIP_FACTOR: 1.5, ALLOW_1_TICK: false,
  SNAP: 'nearest',             // nearest (log scale) | round_up | round_down
  COMBINE: 'median',           // median | min | mean
  OU_FRACTION: 0.7,            // E4 reversion fraction f
  EWMA_LAMBDA: 0.94,           // sigma^2 EWMA decay per tick
  MAX_TRIGGER_MULTIPLE: 20,    // lifetime cap = this x trigger timeframe length
  INVALIDATION_ATR: 1,         // b fallback when no supportive zone: this x setup ATR
  SPIKE_COOLDOWN_T_FRAC: 0.5,  // spike cooldown = this x chosen duration T
  SPIKE_CAP_FRAC: 0.5, SPIKE_CAP_MIN_S: 10, SPIKE_INTENSITY_K: 0.5, JUMP_MEAN_S: 1200,
  PATTERN_MULTIPLE: { default: 3, byPlaybook: { breakout: 4, 'trending pullback': 3, 'fakeout reversal': 3, 'liquidity sweep': 3, 'range fade': 3 }, byPattern: { engulfing: 3, pinBar: 3, displacement: 2, star: 4 } },
  ESTIMATORS: { 'trending pullback': ['E1', 'E3'], breakout: ['E1', 'E3', 'E5'], 'range fade': ['E1', 'E4'], 'liquidity sweep': ['E1', 'E5'], 'fakeout reversal': ['E1', 'E5'] },
  CLASS_ESTIMATORS: { boomcrash: ['E6'], jump: ['E6'] },
  TICK_GRID: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  SEC_GRID: [15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, 540, 600, 720, 900, 1080, 1200],
  FRAMES: { S10: 10, S30: 30, M1: 60, M3: 180, M5: 300, M15: 900, H1: 3600 },
  BUCKETS: { tick: { maxS: 15 }, short: { maxS: 90 }, mid: { maxS: 300 }, long: { maxS: Infinity } },
  DEFAULT_BUCKET: 'mid',
  // timeframe roles by duration bucket (frame names are keys of FRAMES)
  ROLES: {
    tick: { trigger: 'S10', setup: 'S30', context: 'M1', bias: 'M5' },
    short: { trigger: 'S30', setup: 'M1', context: 'M5', bias: 'M15' },
    mid: { trigger: 'M1', setup: 'M5', context: 'M15', bias: 'H1' },
    long: { trigger: 'M5', setup: 'M15', context: 'H1', bias: 'H1' },
  },
  FLOW_MAX_FRAME_S: 300,
  ROOM_CHECK: 'rr',         // lifetime mode only: 'rr' = RR_MIN + MIN_TARGET_MOVE checks; 'legacy' = room-to-run vs sigma*sqrt(T)
  RR_MIN: 1.0,             // target distance / invalidation distance
  MIN_TARGET_MOVE: 1.0,    // target distance in sigma units of one trigger-frame (sigma * sqrt(trigger secs))
  BACKFILL_FRAMES: ['M1', 'M3', 'M5', 'M15', 'H1'],
  BACKFILL_COUNT: 300,     // candles per frame at startup
  BACKFILL_CONCURRENCY: 2,
  BACKFILL_RETRIES: 3,       // retries per frame on rate-limit/timeout
  BACKFILL_RETRY_MS: 2000,  // back-off step (x attempt number)
  BACKFILL_GAP_MS: 400,    // min spacing between history requests (<= 2.5/s)
  LOG_MIN_GAP_S: 30,
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

/** Settle a Rise/Fall contract: entry = first tick after purchase, exit = tick at expiry. Ties lose (as on Deriv). */
export function settle(direction, entry, exit) {
  if (exit === entry) return TARGET.tiesWin ? 'win' : 'loss';
  return (direction > 0 ? exit > entry : exit < entry) ? 'win' : 'loss';
}
