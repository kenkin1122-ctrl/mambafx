/**
 * src/bazu/duration3m.js  (pure)
 * Contract duration = expected signal lifetime.
 * Estimators E1..E6 (seconds), combination, caps, snapping to Deriv-allowed durations and bucket lookup.
 * a = distance to the target level, b = distance to the invalidation level (price units), s2 = EWMA variance rate / s.
 */

export const Z75 = 0.6744897501960817; // Phi^-1(0.75)

const pos = (x) => Number.isFinite(x) && x > 0;

/** E1: driftless two-sided barrier exit time a*b/sigma^2. */
export const e1 = (a, b, s2) => (pos(a) && pos(b) && pos(s2) ? (a * b) / s2 : null);
/** E2: median time to touch the target a^2 / (z^2 sigma^2). */
export const e2 = (a, s2) => (pos(a) && pos(s2) ? (a * a) / (Z75 * Z75 * s2) : null);
/** E3: trend-speed time d/|mu| (valid only when the trend factor is active). */
export const e3 = (d, mu, trendActive = true) => (trendActive && pos(d) && Number.isFinite(mu) && mu !== 0 ? d / Math.abs(mu) : null);
/** E4: reversion time log2(1/(1-f)) * OU half-life. */
export const e4 = (halfLife, f) => (pos(halfLife) && f > 0 && f < 1 ? Math.log2(1 / (1 - f)) * halfLife : null);
/** E5: pattern horizon multiple x trigger timeframe length. */
export const e5 = (multiple, triggerSecs) => (pos(multiple) && pos(triggerSecs) ? multiple * triggerSecs : null);
/**
 * E6 spike window cap: the expected remaining time to the next spike, shrunk by the last spike's intensity.
 * meanSecs = mean spike interval in seconds, sinceSecs = time since the last spike, intensity = last spike size / spike threshold.
 */
export function e6(meanSecs, sinceSecs, intensity, cfg) {
  if (!pos(meanSecs) || !Number.isFinite(sinceSecs)) return null;
  const remaining = Math.max(0, 1 - sinceSecs / meanSecs) * meanSecs * cfg.SPIKE_CAP_FRAC;
  const shrink = 1 + cfg.SPIKE_INTENSITY_K * Math.max(0, (Number.isFinite(intensity) ? intensity : 1) - 1);
  return Math.max(cfg.SPIKE_CAP_MIN_S, remaining / shrink);
}

/** Which estimators apply to a playbook / market class (config table). */
export function applicableEstimators(playbook, marketClass, cfg) {
  const base = cfg.ESTIMATORS[playbook] || [];
  const extra = cfg.CLASS_ESTIMATORS[marketClass] || [];
  return [...new Set([...base, ...extra])];
}

export function combine(values, mode = 'median') {
  const v = values.filter(pos).sort((x, y) => x - y);
  if (!v.length) return null;
  if (mode === 'min') return v[0];
  if (mode === 'mean') return v.reduce((s, x) => s + x, 0) / v.length;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Lifetime for one signal. `raw` holds every estimator's computed value (null = cannot be computed);
 * only the ones listed for the playbook are used; E6 is only a cap. Others are reported "not applicable" (null).
 */
export function lifetime({ raw, playbook, marketClass, triggerSecs, cfg }) {
  const use = applicableEstimators(playbook, marketClass, cfg);
  const estimators = {};
  for (const k of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']) estimators[k] = use.includes(k) && pos(raw[k]) ? raw[k] : null;
  // P3: versioned correction factors, future predictions only, flag default OFF. estimators stays RAW so records and calibration are never rewritten.
  const corr = cfg.ESTIMATOR_CORRECTION ? (cfg.CORRECTIONS?.factors?.[playbook] || {}) : {};
  const used = {}; for (const k of ['E1', 'E2', 'E3', 'E4', 'E5']) used[k] = pos(estimators[k]) && pos(corr[k]) ? estimators[k] * corr[k] : estimators[k];
  const combined = combine(['E1', 'E2', 'E3', 'E4', 'E5'].map((k) => used[k]), cfg.COMBINE);
  if (combined == null) return { estimators, combined: null, lifetime: null, cappedBy: null, reason: 'no lifetime estimator applies' };
  let life = combined, cappedBy = null;
  if (pos(estimators.E6) && estimators.E6 < life) { life = estimators.E6; cappedBy = 'E6'; }
  const trigCap = cfg.MAX_TRIGGER_MULTIPLE * triggerSecs;
  if (pos(trigCap) && trigCap < life) { life = trigCap; cappedBy = 'MAX_TRIGGER_MULTIPLE'; }
  return { estimators, combined, lifetime: life, cappedBy, reason: null };
}

const dkey = (d) => `${d.n}${d.unit}`;
export { dkey as durationLabel };

/**
 * Allowed durations for a market from its contracts_for ranges (isAllowed = universe.durationAllowed),
 * between MIN_DURATION_S and MAX_DURATION_S, ticks converted to seconds with the market's tick interval.
 * 1 tick is excluded unless cfg.ALLOW_1_TICK.
 */
export function allowedDurations(ranges, tickSecs, cfg, isAllowed) {
  const out = [];
  for (const n of cfg.TICK_GRID) {
    if (n === 1 && !cfg.ALLOW_1_TICK) continue;
    const d = { unit: 't', n };
    if (Number.isFinite(tickSecs) && tickSecs > 0 && isAllowed(ranges, d)) out.push({ ...d, secs: n * tickSecs });
  }
  for (const s of cfg.SEC_GRID) {
    const d = s >= 60 && s % 60 === 0 ? { unit: 'm', n: s / 60 } : { unit: 's', n: s };
    if (isAllowed(ranges, d)) out.push({ ...d, secs: s });
  }
  return out.filter((d) => d.secs >= cfg.MIN_DURATION_S && d.secs <= cfg.MAX_DURATION_S).sort((a, b) => a.secs - b.secs);
}

/** Snap a lifetime (s) to an allowed duration. Returns { duration, reason } (duration null => WAIT). */
export function snapDuration(life, allowed, cfg) {
  const OUT = 'signal lifetime outside tradable range';
  if (!allowed.length) return { duration: null, reason: 'no allowed duration for this market' };
  if (!pos(life)) return { duration: null, reason: 'no lifetime estimator applies' };
  if (life < allowed[0].secs) return { duration: null, reason: OUT };
  if (life > cfg.MAX_DURATION_S * cfg.SKIP_FACTOR) return { duration: null, reason: OUT };
  let pick;
  if (cfg.SNAP === 'round_up') pick = allowed.find((d) => d.secs >= life) || allowed[allowed.length - 1];
  else if (cfg.SNAP === 'round_down') pick = [...allowed].reverse().find((d) => d.secs <= life) || allowed[0];
  else pick = allowed.reduce((b, d) => (Math.abs(Math.log(d.secs / life)) < Math.abs(Math.log(b.secs / life)) ? d : b));
  return { duration: pick, reason: null };
}

/** Fixed mode: the allowed duration closest (log scale) to DEFAULT_DURATION_S. */
export function fixedDuration(allowed, cfg) {
  if (!allowed.length) return { duration: null, reason: 'no allowed duration for this market' };
  return { duration: allowed.reduce((b, d) => (Math.abs(Math.log(d.secs / cfg.DEFAULT_DURATION_S)) < Math.abs(Math.log(b.secs / cfg.DEFAULT_DURATION_S)) ? d : b)), reason: null };
}

/** Timeframe-role bucket for a duration in seconds. */
export function bucketOf(secs, cfg) {
  for (const [name, b] of Object.entries(cfg.BUCKETS)) if (secs <= b.maxS) return name;
  return cfg.DEFAULT_BUCKET;
}

/** Neighbouring allowed durations (one below, one above) of the chosen one, for the shadow log. */
export function neighbours(allowed, chosen) {
  const i = allowed.findIndex((d) => d.unit === chosen.unit && d.n === chosen.n);
  return [allowed[i - 1], allowed[i + 1]].filter(Boolean);
}
