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
  // ---- Change Order 8: price-action confirmation, family confluence, dynamic signals ----
  CONFLUENCE_MODE: 'families', // families | legacy (legacy = the old "AGREE_MIN of N features" rule, no momentum gate; kept for replay)
  FAMILIES_AGREE_MIN: 3,       // agreeing families needed (of the families available for the market class)
  AGREE_RATIO_MIN: 0.6,        // agreeing share of non-neutral families
  FAMILY_VOTE_MIN: 0.34,       // a family votes when its weighted share for one side reaches this
  FAMILY_OPPOSE_STRONG: 0.6,   // a family score this far against the trade counts as strongly opposing
  FAMILY_OF: { mtfTrend: 'trend', macd: 'trend', adx: 'trend', kalman: 'trend', rsi: 'oscillator', stoch: 'oscillator', cci: 'oscillator', structure: 'structure', zones: 'structure', rangeBreak: 'structure', stepStructure: 'structure', volatility: 'volatility', tickFlow: 'flow', spike: 'spike' },
  // momentum (immediate price action), all measures are causal
  MOM_CANDLES: 5,              // completed candles in the candle-direction / strength readings (5 to 10)
  MOM_RET_BARS: [3, 5, 10],    // net change over the last k ticks and k bars, in sigma units
  MOM_VEL_T_FRAC: 0.5, MOM_VEL_MIN_S: 5, MOM_VEL_MAX_S: 120, // tick-velocity window = clamp(frac x T, min, max)
  MOM_EMA_FAST: 9, MOM_EMA_SLOW: 21,
  MOM_TICKS_DELTA: 20,         // ticks in the signed tick-delta proxy
  MOM_WEIGHTS: { candles: 1, persistence: 0.8, retBars: 1, retTicks: 0.6, velocity: 1, swing: 0.8, body: 0.6, emaSlope: 1, emaCross: 0.5, tickDelta: 0.4 },
  MOM_MIN_MEASURES: 4,         // fewer available measures -> momentum unavailable (WAIT, never zero)
  MOM_VOTE_MIN: 0.25,          // |score| needed for the momentum family to vote
  MOM_ALIGNED: 0.25, MOM_OPPOSE_MOD: 0.25, MOM_OPPOSE_STRONG: 0.5,
  MOM_BONUS: 0.05, MOM_PENALTY: 0.08, // score adjustment: aligned bonus, opposing_moderate penalty
  MOM_VOL_FAST: 1.8, MOM_VOL_SUBDUED: 0.5,  // recent / long volatility ratio bounds
  MOMENTUM_OPPOSE_SIGMA: 1.0, CONTRADICT_WINDOW_S: 60, // contradiction = last-window move against the trade by more than this many sigma
  ADX_TRANSITION: 18, VOL_CHANGE_RATIO: 1.6, PERSIST_MIN: 3,
  OSC_REGIME_WEIGHT: { range: 1, trend: 0.5, transition: 0 }, // oscillator weight by regime (trend: votes with the trend, never reverses)
  // reversal / confirmed turn
  COUNTER_TREND: ['range fade', 'liquidity sweep', 'fakeout reversal'],
  EXTREME_LOOKBACK: 12, TURN_LOOKBACK: 3, TURN_MIN_GAP_CANDLES: 1,
  TURN_WICK_FRAC: 0.5, SHRINK_BODY_FRAC: 0.6, TICK_FLIP_K: 8,
  TURN_TRIGGERS: ['choch', 'rejection', 'sweepReclaim', 'shrinking', 'tickFlip'],
  REQUIRE_TRIGGER: true,       // a configured trigger (pattern, breakout, confirmed turn) is needed to execute
  // dynamic signal state machine
  ARM_MAX_WAIT_S: { mult: 3, min: 30, max: 300 },     // armed -> triggered window = clamp(mult x T, min, max)
  SIGNAL_MAX_AGE_S: { mult: 6, min: 60, max: 900 },   // signal age limit = clamp(mult x T, min, max)
  EXEC_MAX_DELAY_S: 15,        // a TRIGGERED signal must be executed within this many seconds
  FORMING_MAX_HZ: 0.5,         // provisional (intrabar) re-evaluations per second at most
  REJECT_LOG_GAP_S: 60,        // do not log the same rejected setup more often than this
  // pre-trade recheck and data freshness
  RECHECK_MAX_SIGMA: 1.0,      // cancel if price moved this many sigma(T) against the trade since the decision
  STALE_TICK_MS: 5000, CANDLE_STALE_BARS: 3, MAX_ESTIMATE_AGE_S: 30,
  DEMO_ONLY: true,             // Bazu-originated and manual orders are refused on a real account while true
  MAX_OPEN_PER_MARKET: 1,
  MAX_CHASE_ATR: 2,
  ROOM_FACTOR: 1,           // nearest opposing zone must be farther than ROOM_FACTOR * sigma * sqrt(T)
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
