/**
 * src/bazu/momentum3m.js  (pure, causal)
 * Stage 2 of the decision pipeline: what price is doing NOW. Everything here reads closed candles plus ticks with
 * epoch <= the decision time. The forming candle only feeds a separately labelled `provisional` reading and never the
 * score. Also holds the extreme-reading and confirmed-turn logic used by counter-trend playbooks.
 */
import { emaSeries, emaSlope, rsi, stochastic, cci } from './ta3m.js?v=15';
import { structureState } from './factors3m.js?v=15';
import { zonesNear, supportiveKinds, liquiditySweep } from './context3m.js?v=15';

const clip = (x) => Math.max(-1, Math.min(1, x));
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const fin = Number.isFinite;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export const MOMENTUM_STATES = Object.freeze({ ALIGNED: 'aligned', NEUTRAL: 'neutral', OPP_MOD: 'opposing_moderate', OPP_STRONG: 'opposing_strong' });

/** State of a momentum score (-1..+1) relative to a proposed direction (+1 Rise / -1 Fall). */
export function momentumState(score, dir, cfg) {
  if (!fin(score) || !dir) return null;
  const s = score * dir;
  if (s >= cfg.MOM_ALIGNED) return MOMENTUM_STATES.ALIGNED;
  if (s > -cfg.MOM_OPPOSE_MOD) return MOMENTUM_STATES.NEUTRAL;
  if (s > -cfg.MOM_OPPOSE_STRONG) return MOMENTUM_STATES.OPP_MOD;
  return MOMENTUM_STATES.OPP_STRONG;
}

/** Net change over the last `winS` seconds in sigma units (ticks with epoch <= now only). null when the window is not covered. */
export function windowZ(prices, epochs, winS, sigma2PerSec) {
  const n = prices.length;
  if (n < 2 || !(sigma2PerSec > 0) || !(winS > 0)) return null;
  const end = epochs[n - 1];
  let i = n - 1;
  while (i > 0 && epochs[i - 1] >= end - winS) i--;
  if (epochs[0] > end - winS) return null;
  const dt = end - epochs[i];
  if (!(dt > 0)) return null;
  return (prices[n - 1] - prices[i]) / Math.sqrt(sigma2PerSec * dt);
}

/** Ratio of the recent realised tick volatility to the EWMA estimate (>1 = fast, <1 = subdued). */
export function volRatio(prices, stat, k = 20) {
  if (prices.length <= k || !(stat?.sigma2PerSec > 0) || !(stat?.tickSecs > 0)) return NaN;
  const d = []; for (let i = prices.length - k; i < prices.length; i++) d.push(prices[i] - prices[i - 1]);
  return Math.sqrt(mean(d.map((x) => x * x)) / (stat.sigma2PerSec * stat.tickSecs));
}

/**
 * Immediate momentum reading. `dir`-independent: score in [-1, +1] (positive = price moving up now).
 * Missing inputs make a measure unavailable; fewer than MOM_MIN_MEASURES available -> `available:false` (never a 0).
 */
export function momentumReading({ frames, prices, epochs, now, cfg, stat, T, trigSecs }) {
  const tr = frames.trigger || [], W = cfg.MOM_WEIGHTS, N = cfg.MOM_CANDLES, m = {};
  const put = (name, value, reason, raw = null) => { if (fin(value)) m[name] = { value: clip(value), reason, raw }; };
  const sigTick = stat?.sigma2PerSec > 0 && stat?.tickSecs > 0 ? Math.sqrt(stat.sigma2PerSec * stat.tickSecs) : NaN;
  const sigBar = stat?.sigma2PerSec > 0 && trigSecs > 0 ? Math.sqrt(stat.sigma2PerSec * trigSecs) : NaN;

  if (tr.length >= N) {
    const last = tr.slice(-N), bulls = last.filter((c) => c.close > c.open).length, bears = last.filter((c) => c.close < c.open).length;
    put('candles', (bulls - bears) / N, `${bulls} bullish / ${bears} bearish of last ${N} closed candles`, { bulls, bears });
    const bodies = last.map((c) => (c.close > c.open ? 1 : c.close < c.open ? -1 : 0) * (c.bodyRange ?? NaN));
    if (bodies.every(fin)) put('body', mean(bodies), `candle body strength ${mean(bodies).toFixed(2)} (signed body/range)`);
  }
  if (tr.length >= 6) {
    let run = 0, d = 0;
    for (let i = tr.length - 1; i > 0; i--) {
      const s = sgn(tr[i].close - tr[i - 1].close);
      if (!s) break;
      if (!d) d = s; else if (s !== d) break;
      run++;
    }
    put('persistence', clip((d * run) / (cfg.PERSIST_MIN * 2)), `${run} consecutive ${d > 0 ? 'higher' : d < 0 ? 'lower' : 'flat'} closes`, { run, dir: d });
  }
  if (fin(sigBar)) {
    const zs = [];
    for (const k of cfg.MOM_RET_BARS) if (tr.length > k) zs.push((tr.at(-1).close - tr.at(-1 - k).close) / (sigBar * Math.sqrt(k)));
    if (zs.length) put('retBars', mean(zs) / 2, `bar returns ${cfg.MOM_RET_BARS.join('/')}: z ${zs.map((z) => z.toFixed(1)).join('/')}`, zs);
  }
  if (fin(sigTick)) {
    const zs = [], n = prices.length;
    for (const k of cfg.MOM_RET_BARS) if (n > k) zs.push((prices[n - 1] - prices[n - 1 - k]) / (sigTick * Math.sqrt(k)));
    if (zs.length) put('retTicks', mean(zs) / 2, `tick returns ${cfg.MOM_RET_BARS.join('/')}: z ${zs.map((z) => z.toFixed(1)).join('/')}`, zs);
  }
  const w = Math.min(cfg.MOM_VEL_MAX_S, Math.max(cfg.MOM_VEL_MIN_S, cfg.MOM_VEL_T_FRAC * (T || cfg.DEFAULT_DURATION_S)));
  const vz = windowZ(prices, epochs, w, stat?.sigma2PerSec);
  if (vz != null) put('velocity', vz / 2, `tick velocity over ${w.toFixed(0)}s: z ${vz.toFixed(1)}`, vz);

  const st = tr.length >= 20 ? structureState(tr) : null;
  if (st && !st.na) put('swing', 0.6 * st.trend + 0.4 * (st.bos || st.choch), `swings ${st.trend > 0 ? 'rising' : st.trend < 0 ? 'falling' : 'mixed'}${st.bos ? ', BOS' : ''}${st.choch ? ', CHoCH' : ''}`, st);
  const atr = tr.at(-1)?.atr;
  if (tr.length >= 25 && atr > 0) {
    const cl = tr.map((c) => c.close), sl = emaSlope(cl, cfg.MOM_EMA_FAST, 3);
    if (fin(sl)) put('emaSlope', sl / atr / 0.15, `EMA${cfg.MOM_EMA_FAST} slope ${(sl / atr).toFixed(3)} ATR/bar`, sl / atr);
    const f = emaSeries(cl, cfg.MOM_EMA_FAST), s = emaSeries(cl, cfg.MOM_EMA_SLOW);
    put('emaCross', (f.at(-1) - s.at(-1)) / atr / 0.5, `EMA${cfg.MOM_EMA_FAST} ${f.at(-1) > s.at(-1) ? 'above' : 'below'} EMA${cfg.MOM_EMA_SLOW}`, (f.at(-1) - s.at(-1)) / atr);
  }
  if (prices.length > cfg.MOM_TICKS_DELTA) {
    let d = 0; for (let i = prices.length - cfg.MOM_TICKS_DELTA; i < prices.length; i++) d += sgn(prices[i] - prices[i - 1]);
    put('tickDelta', d / cfg.MOM_TICKS_DELTA, `signed tick delta ${d}/${cfg.MOM_TICKS_DELTA} (proxy)`, d);
  }

  let sw = 0, sv = 0;
  for (const [k, x] of Object.entries(m)) { const wt = W[k] ?? 1; sw += wt; sv += wt * x.value; }
  const names = Object.keys(m), available = names.length >= cfg.MOM_MIN_MEASURES && sw > 0;
  const ret60z = windowZ(prices, epochs, cfg.CONTRADICT_WINDOW_S, stat?.sigma2PerSec);
  const vr = volRatio(prices, stat);
  const f = frames.forming;
  const provisional = f && tr.length ? {
    provisional: true, epoch: f.epoch, dir: sgn(f.close - f.open), bodyRange: f.high > f.low ? Math.abs(f.close - f.open) / (f.high - f.low) : 0,
    vsLastClose: sgn(f.close - tr.at(-1).close), note: 'forming candle: intrabar, not used in the score',
  } : null;
  return {
    available, reason: available ? null : `momentum unavailable: ${names.length}/${cfg.MOM_MIN_MEASURES} measures`,
    score: available ? clip(sv / sw) : null, measures: m, n: names.length, ret60z,
    volRatio: vr, volRegime: !fin(vr) ? null : vr >= cfg.MOM_VOL_FAST ? 'fast' : vr <= cfg.MOM_VOL_SUBDUED ? 'subdued' : 'normal', provisional,
  };
}

/** Does the last CONTRADICT_WINDOW_S of movement oppose `dir` by more than MOMENTUM_OPPOSE_SIGMA? null when unknown. */
export const opposesRecentMove = (ret60z, dir, cfg) => (fin(ret60z) && dir ? ret60z * dir < -cfg.MOMENTUM_OPPOSE_SIGMA : null);

// ---------------- extreme readings and confirmed turns ----------------

/** Most recent closed candle (within EXTREME_LOOKBACK) where an oscillator was at an extreme that favours `dir` (oversold for Rise). */
export function oscillatorExtreme({ dir, candles, trigSecs, cfg }) {
  const n = candles.length;
  for (let back = 0; back < Math.min(cfg.EXTREME_LOOKBACK, n); back++) {
    const i = n - 1 - back, win = candles.slice(Math.max(0, i - 200), i + 1), cl = win.map((c) => c.close);
    const r = rsi(cl), st = stochastic(win), cc = cci(win), hits = [];
    if (fin(r) && (dir > 0 ? r <= cfg.RSI_OS : r >= cfg.RSI_OB)) hits.push(`RSI ${r.toFixed(0)}`);
    if (fin(st.k) && (dir > 0 ? st.k <= cfg.STOCH_OS : st.k >= cfg.STOCH_OB)) hits.push(`Stoch ${st.k.toFixed(0)}`);
    if (fin(cc) && (dir > 0 ? cc <= -100 : cc >= 100)) hits.push(`CCI ${cc.toFixed(0)}`);
    if (hits.length) return { ts: candles[i].epoch + trigSecs, index: i, kind: 'oscillator', reason: `${dir > 0 ? 'oversold' : 'overbought'} ${hits.join(', ')}` };
  }
  return null;
}

/** Most recent closed candle that touched a zone band (the event that prompted a zone / sweep / fakeout setup). */
export function zoneTouchExtreme({ candles, zone, trigSecs, cfg }) {
  if (!zone) return null;
  const n = candles.length;
  for (let back = 0; back < Math.min(cfg.EXTREME_LOOKBACK, n); back++) {
    const i = n - 1 - back, c = candles[i];
    if (c.low <= zone.high && c.high >= zone.low) return { ts: c.epoch + trigSecs, index: i, kind: 'zone', reason: `touched ${zone.tf || ''} ${zone.kind} zone` };
  }
  return null;
}

/**
 * Confirmed turn in direction `dir`: at least one configured trigger, occurring AFTER the extreme reading
 * (turn timestamp > extreme timestamp, and at least TURN_MIN_GAP_CANDLES completed candles later). A turn on the same candle
 * as the extreme is concurrent, not confirmation. Returns { confirmed, trigger, turnTs, extremeTs, concurrent, reason }.
 */
export function confirmedTurn({ dir, frames, prices, epochs, trigSecs, zones, atr, extreme, cfg }) {
  const tr = frames.trigger, out = { confirmed: false, trigger: null, turnTs: null, extremeTs: extreme ? extreme.ts : null, concurrent: false, reason: null };
  if (!extreme) { out.reason = 'no extreme reading to anchor a reversal'; return out; }
  const gap = cfg.TURN_MIN_GAP_CANDLES * trigSecs, okTs = (ts) => ts > extreme.ts && ts - extreme.ts >= gap, seen = [];
  const hit = (name, ts, why) => { if (okTs(ts)) { out.confirmed = true; out.trigger = name; out.turnTs = ts; out.reason = `${name}: ${why}`; return true; } seen.push(ts); return false; };
  for (let back = 0; back < Math.min(cfg.TURN_LOOKBACK, tr.length); back++) {
    const j = tr.length - 1 - back, c = tr[j], ts = c.epoch + trigSecs, sl = tr.slice(0, j + 1);
    for (const name of cfg.TURN_TRIGGERS) {
      if (name === 'choch' && sl.length >= 20) { const s = structureState(sl); if (s.choch === dir && hit('choch', ts, 'change of character on the trigger frame')) return out; }
      if (name === 'rejection') {
        const near = zonesNear(zones || [], dir > 0 ? c.low : c.high, atr || c.atr || 0, 0.5).some((z) => supportiveKinds(dir).includes(z.kind));
        const wick = dir > 0 ? c.lowerFrac : c.upperFrac;
        if (near && wick >= cfg.TURN_WICK_FRAC && (dir > 0 ? c.close >= c.open : c.close <= c.open) && hit('rejection', ts, `${dir > 0 ? 'lower' : 'upper'} wick rejection at a zone`)) return out;
      }
      if (name === 'shrinking' && j >= 3) {
        const b = [tr[j - 3], tr[j - 2], tr[j - 1], tr[j]].map((x) => x.body), imp = tr[j - 3];
        if (imp.dir === -dir && b[1] <= cfg.SHRINK_BODY_FRAC * b[0] && b[2] < b[1] && b[3] < b[2] && hit('shrinking', ts, 'bodies shrinking against the prior impulse')) return out;
      }
    }
  }
  if (cfg.TURN_TRIGGERS.includes('sweepReclaim') && frames.setup?.length >= 8) {
    const sw = liquiditySweep(frames.setup, cfg), s = frames.setup.at(-1);
    if (sw.present && sw.direction === dir && hit('sweepReclaim', s.epoch + (frames.setupSecs || trigSecs), sw.reason || 'closed back inside the zone after a sweep')) return out;
  }
  if (cfg.TURN_TRIGGERS.includes('tickFlip') && prices.length > cfg.TICK_FLIP_K * 2) {
    const k = cfg.TICK_FLIP_K, n = prices.length, sum = (a, b) => { let d = 0; for (let i = a; i < b; i++) d += sgn(prices[i] - prices[i - 1]); return d; };
    const recent = sum(n - k, n), prior = sum(n - 2 * k, n - k);
    if (sgn(recent) === dir && sgn(prior) === -dir && hit('tickFlip', epochs[n - 1], `signed tick delta flipped ${prior} -> ${recent} (proxy)`)) return out;
  }
  out.concurrent = seen.length > 0;
  out.reason = out.concurrent ? 'a turn exists but it is not after the extreme reading (concurrent)' : 'no confirming turn after the extreme reading';
  return out;
}
