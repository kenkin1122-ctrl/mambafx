/**
 * src/bazu/siglog3m.js  (pure)
 * Complete data package for one signal. Sections A-E are built at decision / buy time and never change; F and G are appended
 * later (append-only) from real ticks and the Deriv contract. Nothing here feeds back into a decision.
 * Missing values are null with a reason in the nearest `null_reasons` map; never zero and never invented.
 */
import { buildFrames, formingCandle, robustAtr } from './candles3m.js?v=15';
import { buildZones, roomToRun } from './context3m.js?v=15';
import { adx, rsi, emaSeries, statRegime, stochastic, cci } from './ta3m.js?v=15';
import { FACTORS } from './factors3m.js?v=15';
import { agreement, regimeOf } from './confluence3m.js?v=15';
import { shadowOutcome } from './calibration3m.js?v=15';
import { tickGapsConstant, roomChecks } from './filters3m.js?v=15';
import { bucketCandles } from './timeframes.js?v=15';
import { settle, marketClass } from './config3m.js?v=16';
import { spikeContext } from './predict3m.js?v=16';
import { expiryProbBaseline, sigmaPerTick } from './expiry3m.js?v=15';

export const SCHEMA_VERSION = '1.0.0';
const fin = Number.isFinite;
const clone = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
const iso = (ms) => new Date(ms).toISOString();
const SIGN = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const NOVOL = 'not available: market has no volume';
const LABEL_SCORE = 'rule-based confluence score, not a probability';

export function stableStringify(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

function fillNullReasons(section) {
  const reasons = section.null_reasons ||= {};
  const walk = (value, path) => {
    if (value === null) {
      const normalized = path.replace(/\[\d+\]/g, '.*');
      if (!reasonCovered(reasons, normalized)) reasons[normalized] = 'not available: source value was missing at decision/settlement time';
      return;
    }
    if (Array.isArray(value)) { value.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (k !== 'null_reasons') walk(v, path ? `${path}.${k}` : k);
  };
  for (const [k, v] of Object.entries(section)) if (k !== 'null_reasons') walk(v, k);
}
/** Short deterministic hash (two FNV-1a lanes, 16 hex chars) used to tag the configuration; not a security hash. */
export function configHash(cfg) {
  const s = stableStringify(clone(cfg)); let a = 0x811c9dc5, b = 0x01000193 ^ 0xdeadbeef;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c ^ (i & 255), 0x85ebca6b) >>> 0; }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
export function uuid() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  const h = [...Array(16)].map(() => Math.floor(Math.random() * 256)); h[6] = (h[6] & 15) | 64; h[8] = (h[8] & 63) | 128;
  const x = h.map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const sect = (avail) => ({ available_at_decision: avail, null_reasons: {} });
/** Set a (dotted) path; a missing / non-finite value becomes null with a reason. */
function put(s, path, v, reason) {
  const bad = v === undefined || v === null || (typeof v === 'number' && !fin(v));
  const keys = path.split('.'); let o = s;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] ||= {};
  o[keys.at(-1)] = bad ? null : v;
  if (bad) s.null_reasons[path] = reason || 'not available';
}

const flagsOf = (cfg) => {
  const out = {};
  const visit = (value, path = '') => {
    for (const [k, v] of Object.entries(value || {})) {
      const key = path ? `${path}.${k}` : k;
      if (typeof v === 'boolean') out[key] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, key);
    }
  };
  visit(cfg);
  return out;
};
const lastIdxLE = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };
const firstIdxGE = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const firstIdxAfter = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] > x) hi = m; else lo = m + 1; } return lo; };
const median = (a) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const candleOut = (c) => ({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close, volume: null });
const durParts = (key) => { const m = /^(\d+)([tsmhd])$/.exec(String(key || '')); return m ? { n: Number(m[1]), unit: m[2] } : null; };
const UNIT_S = { s: 1, m: 60, h: 3600, d: 86400 };

// Which factors a playbook needs (read from the playbook definitions in predict3m.js).
export const PLAYBOOK_FACTORS = Object.freeze({
  'trending pullback': { required: ['structure trend on the setup frame', 'ADX >= ADX_TREND with Hurst > 0.5', 'pullback to EMA20 or a supportive zone', 'context frame not opposing'], optional: ['trigger candle pattern', 'tick-flow proxy'] },
  'range fade': { required: ['ADX below trend level', 'price at a supportive zone edge', 'oscillator extreme or absorption or sweep'], optional: ['trigger candle pattern', 'tick-flow proxy'] },
  'range fade exp': { required: ['ADX <= RFX_ADX_MAX', 'price near a zone edge', 'rejection wick'], optional: ['trigger candle pattern'] },
  breakout: { required: ['confirmed breakout of a zone'], optional: ['break of structure on the setup frame', 'breakout filters (recorded; only enforced when their flags are on)'] },
  'fakeout reversal': { required: ['fakeout against a broken zone'], optional: [] },
  'liquidity sweep': { required: ['liquidity sweep present'], optional: [] },
});

function indicators(frame, cfg, price, atrArr) {
  const closes = frame.map((c) => c.close), n = frame.length, res = { null_reasons: {} };
  const set = (k, v, why) => put(res, k, v, why);
  set('atr_14', (() => { const a = robustAtr(frame, 14); return a.at(-1); })(), 'not available: fewer than 5 candles');
  set('atr_50', n >= 50 ? robustAtr(frame, 50).at(-1) : null, `not available: ${n} candles (need 50)`);
  const a = adx(frame), a5 = n > 31 ? adx(frame.slice(0, -5)) : { adx: NaN };
  set('adx_14', a.adx, 'not available: fewer than 29 candles');
  set('adx_slope_5', fin(a.adx) && fin(a5.adx) ? (a.adx - a5.adx) / 5 : null, 'not available: not enough candles for the 5-candle slope');
  set('rsi_14', rsi(closes), 'not available: fewer than 15 candles');
  const atrV = res.atr_14;
  for (const p of [20, 50, 200]) {
    const e = n >= p ? emaSeries(closes, p).at(-1) : null;
    set('ema_' + p, e, `not available: ${n} candles (need ${p})`);
    if (p < 200) set(`dist_ema_${p}_atr`, e != null && atrV > 0 ? (price - e) / atrV : null, 'not available: EMA or ATR missing');
  }
  if (n >= 20) {
    const w = closes.slice(-20), mid = w.reduce((x, y) => x + y, 0) / 20, sd = Math.sqrt(w.reduce((x, y) => x + (y - mid) ** 2, 0) / 20);
    set('bollinger.upper', mid + 2 * sd); set('bollinger.lower', mid - 2 * sd); set('bollinger.mid', mid); set('bollinger.width', mid ? (4 * sd) / mid : null, 'mid is zero');
  } else for (const k of ['upper', 'lower', 'mid', 'width']) set('bollinger.' + k, null, 'not available: fewer than 20 candles');
  const w20 = frame.slice(-20);
  if (w20.length) { const hi = Math.max(...w20.map((c) => c.high)), lo = Math.min(...w20.map((c) => c.low)); set('recent_high_20', hi); set('recent_low_20', lo); set('range_height_20', hi - lo); }
  else for (const k of ['recent_high_20', 'recent_low_20', 'range_height_20']) set(k, null, 'not available: no candles');
  return res;
}

function tickFlow(P, E, dE, secs = 60) {
  const j = lastIdxLE(E, dE), i0 = firstIdxGE(E, dE - secs);
  let up = 0, dn = 0, maxGap = 0;
  for (let i = Math.max(1, i0); i <= j; i++) { const d = P[i] - P[i - 1]; if (d > 0) up++; else if (d < 0) dn++; maxGap = Math.max(maxGap, E[i] - E[i - 1]); }
  return { up, dn, ratio: up + dn ? (up - dn) / (up + dn) : null, ticks: Math.max(0, j - i0 + 1), maxGap, sinceLast: dE - E[j] };
}

function zoneOut(z, price) {
  const mid = fin(z.mid) ? z.mid : (z.low + z.high) / 2;
  return { price: mid, low: z.low, high: z.high, type: z.kind, timeframe: z.tf ?? null, touches: z.touches ?? null, last_touch_epoch: z.lastTouch ?? z.last ?? z.lastTouchEpoch ?? null, strength: z.strength ?? null, fresh: z.fresh ?? null, flipped: z.flipped ?? false, overlap: z.overlap ?? 0, distance: Math.abs(mid - price) };
}

/** Pure E2-E4 computation on a stored snapshot (so it is reproducible from the record). */
export function analyse(inp) {
  const { dir, strength, minStrength, votes, readings, hypothetical, T, checks = [], notApplied = [], nearMissFrac, nearNeutralFrac } = inp;
  const fams = inp.families, famList = Object.values(fams);
  const agr = agreement(fams, dir, T), opp = agreement(fams, -dir, T);
  const vname = (v) => (v === dir ? 'agree' : v === -dir ? 'oppose' : 'neutral');

  // E2
  const live = votes.filter((v) => !v.na && v.weight > 0);
  const e2 = {
    opposing_factors: live.filter((v) => v.vote === -dir).map((v) => ({ factor: v.factor, family: v.family, weight: v.weight, reason: v.reason })),
    opposing_families: famList.filter((f) => f.available && f.vote === -dir).map((f) => ({ family: f.name, score: f.score })),
    neutral_near_threshold: [], neutral_without_numeric_reading: [],
    disabled_or_zero_weight: (hypothetical || []).map((h) => ({ factor: h.factor, family: h.family ?? null, vote: h.vote, relation: h.vote == null ? 'unavailable' : vname(h.vote), weight: h.weight ?? 0, enabled: !!h.enabled, reason: h.reason, in_decision: false, flag: 'not in decision' })),
    near_miss_checks: [], not_applied_or_overridden: notApplied.slice(),
  };
  for (const v of live.filter((x) => x.vote === 0)) {
    const r = readings && readings[v.factor];
    if (!r) { e2.neutral_without_numeric_reading.push(v.factor); continue; }
    const thr = [r.lower, r.upper].filter(fin), dist = Math.min(...thr.map((t) => Math.abs(r.value - t) / (Math.abs(t) || 1)));
    if (dist <= nearNeutralFrac) e2.neutral_near_threshold.push({ factor: v.factor, value: r.value, thresholds: thr, relative_distance: dist });
  }

  // E4 margins
  const need = agr.need, margins = [];
  const addM = (name, value, threshold, margin) => margins.push({ name, value, threshold, margin, margin_rel: threshold ? margin / Math.abs(threshold) : null });
  addM('score_min', strength, minStrength, strength - minStrength);
  addM('families_agree_min', agr.agree.length, need, agr.agree.length - need);
  addM('agree_ratio_min', agr.ratio, T.AGREE_RATIO_MIN, agr.ratio - T.AGREE_RATIO_MIN);
  const worstOpp = Math.max(0, ...famList.filter((f) => f.available && fin(f.score)).map((f) => -f.score * dir));
  addM('family_oppose_strong', worstOpp, T.FAMILY_OPPOSE_STRONG, T.FAMILY_OPPOSE_STRONG - worstOpp);
  if (inp.momentum && fin(inp.momentum.score)) addM('momentum_gate', inp.momentum.score * dir, -T.MOM_OPPOSE_MOD, inp.momentum.score * dir + T.MOM_OPPOSE_MOD);
  for (const c of checks) if (fin(c.value) && fin(c.threshold)) addM(c.name, c.value, c.threshold, c.margin);
  for (const m of margins) { m.would_fail = m.margin < 0; m.near_miss = m.margin >= 0 && m.margin_rel != null && m.margin_rel <= nearMissFrac; }
  e2.near_miss_checks = margins.filter((m) => m.near_miss).map((m) => ({ check: m.name, margin: m.margin, margin_rel: m.margin_rel }));

  const candidates = inp.candidateScores || [];
  const picked = candidates.filter((x) => x.direction === dir).sort((a, b) => b.score - a.score)[0];
  const opposite = candidates.filter((x) => x.direction === -dir).sort((a, b) => b.score - a.score)[0];
  const decisionOf = (f) => {
    if (picked && picked.score >= minStrength && agreement(f, dir, T).ok) return 'TRADE';
    if (opposite && opposite.score >= minStrength && agreement(f, -dir, T).ok) return 'OPPOSITE';
    return 'WAIT';
  };
  const base = decisionOf(fams);
  const mutate = (name, fn) => { const c = clone(fams); fn(c); return decisionOf(c); };
  const famOf = (f, members) => {
    const av = members.filter((m) => !m.na && m.weight > 0), den = av.reduce((a, m) => a + m.weight, 0);
    f.members = members; f.available = av.length > 0 || (f.name === 'momentum' && f.available);
    f.score = den > 0 ? av.reduce((a, m) => a + m.weight * m.vote, 0) / den : null;
    f.vote = f.score == null ? 0 : Math.abs(f.score) >= (f.name === 'momentum' ? T.MOM_VOTE_MIN : T.FAMILY_VOTE_MIN) ? SIGN(f.score) : 0;
  };
  const sensFamily = famList.map((f) => {
    const rm = mutate(f.name, (c) => { c[f.name].available = false; c[f.name].vote = 0; c[f.name].score = null; });
    const fl = mutate(f.name, (c) => { c[f.name].vote = -c[f.name].vote; c[f.name].score = c[f.name].score == null ? null : -c[f.name].score; });
    return { family: f.name, remove_alone: rm, flip_alone: fl, remove_changes_decision: rm !== base, flip_changes_decision: fl !== base };
  });
  const sensFactor = [];
  for (const v of live.filter((x) => x.family !== 'momentum')) {
    const rm = mutate(v.factor, (c) => famOf(c[v.family], c[v.family].members.filter((m) => m.id !== v.factor)));
    const fl = mutate(v.factor, (c) => famOf(c[v.family], c[v.family].members.map((m) => (m.id === v.factor ? { ...m, vote: -m.vote } : m))));
    sensFactor.push({ factor: v.factor, family: v.family, remove_alone: rm, flip_alone: fl, remove_changes_decision: rm !== base, flip_changes_decision: fl !== base });
  }
  const summary = (arr, k) => { const x = arr.filter((s) => s[k]); return x.length ? x.map((s) => s.family || s.factor).join(', ') : 'none'; };
  const e4 = {
    baseline_decision: base, margins, by_family: sensFamily, by_factor: sensFactor,
    note: 'Only the family-agreement gate is re-run; score and room checks are held at their recorded values.',
    summary: `margins: ${margins.map((m) => `${m.name} ${m.margin >= 0 ? '+' : ''}${fin(m.margin) ? m.margin.toFixed(3) : 'n/a'}`).join('; ')}. Families whose removal changes the decision: ${summary(sensFamily, 'remove_changes_decision')}. Families whose flip changes it: ${summary(sensFamily, 'flip_changes_decision')}.`,
  };

  // E3
  const wsum = (d) => { const den = live.reduce((a, v) => a + v.weight, 0); return den > 0 ? live.reduce((a, v) => a + v.weight * v.vote * d, 0) / den : null; };
  const st = wsum(dir), so = wsum(-dir);
  const toFlip = famList.filter((f) => f.available && f.vote === dir && fin(f.score)).map((f) => ({ indicator: 'family:' + f.name, distance_to_flip: f.score * dir + T.FAMILY_VOTE_MIN }));
  if (readings) {
    const r = readings.rsi, s = readings.stoch, c = readings.cci;
    if (r) toFlip.push({ indicator: 'rsi', distance_to_flip: dir > 0 ? r.upper - r.value : r.value - r.lower });
    if (s) toFlip.push({ indicator: 'stoch', distance_to_flip: dir > 0 ? s.upper - s.value : s.value - s.lower });
    if (c) toFlip.push({ indicator: 'cci', distance_to_flip: dir > 0 ? c.upper - c.value : c.value - c.lower });
  }
  const e3 = {
    opposite_direction: dir > 0 ? 'Fall' : 'Rise',
    opposite_playbook_score: opposite?.score ?? null, opposite_playbook_score_reason: opposite ? null : 'not available: no opposite-direction playbook candidate was generated',
    opposite_playbook: opposite?.playbook ?? null,
    factor_vote_score_traded: st, factor_vote_score_opposite: so, margin: st != null && so != null ? st - so : null,
    playbook_score_traded: picked?.score ?? strength, playbook_score_opposite: opposite?.score ?? null,
    playbook_score_margin: picked && opposite ? picked.score - opposite.score : null,
    traded_agreement: { agree: agr.agree, oppose: agr.oppose, neutral: agr.neutral, ratio: agr.ratio, ok: agr.ok },
    opposite_agreement: { agree: opp.agree, oppose: opp.oppose, neutral: opp.neutral, ratio: opp.ratio, ok: opp.ok, reasons: opp.reasons },
    families_supporting_opposite: opp.agree,
    closest_to_flipping: toFlip.filter((x) => fin(x.distance_to_flip)).sort((a, b) => a.distance_to_flip - b.distance_to_flip).slice(0, 5),
    note: 'factor_vote_score = weighted mean of factor votes toward the direction; it is not the playbook score.',
  };
  return { e2, e3, e4 };
}

/** Hindsight classification of one vote against the realised price direction (1 up, -1 down, 0 flat). */
export function classifyVote(vote, tradeDir, realised) {
  if (!vote) return 'neutral';
  const correct = realised !== 0 && vote === realised;
  return vote === tradeDir ? (correct ? 'agreed_correct' : 'agreed_wrong') : (correct ? 'dissented_correct' : 'dissented_wrong');
}

/**
 * Sections A-E. inp: { sig, trade|null, cfg, symbol, name, prices, epochs, remote, rec|null, id, meta, now, traded }
 * Uses only ticks with epoch <= the decision epoch.
 */
export function buildRecord(inp) {
  const { sig, trade = null, cfg, symbol, rec = null, meta = {}, traded = !!inp.trade } = inp;
  const dE = sig.decisionTs, dir = sig.contractType === 'CALL' ? 1 : -1;
  const n = lastIdxLE(inp.epochs, dE) + 1, P = inp.prices.slice(Math.max(0, n - 6000), n), E = inp.epochs.slice(Math.max(0, n - 6000), n);
  const price = P.at(-1), bucket = rec?.bucket || cfg.DEFAULT_BUCKET, roles = cfg.ROLES[bucket];
  const names = [...new Set([roles.trigger, roles.setup, roles.context, roles.bias, 'H1'])];
  const frames = buildFrames({ remote: inp.remote || {}, prices: P, epochs: E, decisionEpoch: dE, cfg, names, formingSecs: cfg.FRAMES[roles.trigger] });
  const F = { trigger: frames[roles.trigger], setup: frames[roles.setup], context: frames[roles.context], bias: frames[roles.bias], H1: frames.H1 || [] };
  const atr = F.setup.at(-1)?.atr;
  const tickInt = median(E.slice(-200).map((e, i, a) => (i ? e - a[i - 1] : NaN)));
  const ms = Math.round(dE * 1000);

  const H = { signal_id: inp.id || uuid(), schema_version: SCHEMA_VERSION, null_reasons: {} };
  put(H, 'software.build_id', meta.buildId, 'not injected: zero-build static app (set globalThis.MAMBAFX_BUILD)');
  put(H, 'software.commit', meta.commit, 'not injected: zero-build static app (set globalThis.MAMBAFX_BUILD)');
  Object.assign(H, { config_hash: configHash(cfg), config: clone(cfg), flags: flagsOf(cfg), decision_time_iso: iso(ms), decision_time_epoch_ms: ms, created_iso: iso(inp.now ?? Date.now()), created_epoch_ms: inp.now ?? Date.now() });
  put(H, 'contract_id', trade ? trade.id : null, 'not traded: no contract');
  Object.assign(H, { market: symbol, market_class: marketClass(symbol), traded });
  put(H, 'market_name', inp.name || null, 'not available: market name was not supplied');
  put(H, 'account_type', trade ? (trade.isReal ? 'real' : 'demo') : null, 'not traded: account type is not applicable');
  put(H, 'tick_interval_s', tickInt, 'not available: too few ticks');

  const A = sect(true), hist = sig.signalHistory || [];
  put(A, 'timestamp_decision_iso', iso(ms)); put(A, 'timestamp_decision_epoch_ms', ms);
  put(A, 'timestamp_entry_iso', null, 'not available at decision: the entry tick is known after the buy (section F, entry.epoch)');
  put(A, 'timestamp_entry_epoch_ms', null, 'not available at decision: the entry tick is known after the buy (section F, entry.epoch)');
  put(A, 'playbook', sig.playbook, 'no playbook'); put(A, 'direction', sig.direction);
  const dp = durParts(sig.duration);
  put(A, 'duration.key', sig.duration, 'no duration selected'); put(A, 'duration.seconds', sig.durationSec, 'no duration selected');
  put(A, 'duration.deriv_unit', dp ? dp.unit : null, 'no duration selected');
  put(A, 'duration_mode.mode', sig.manual ? 'manual' : cfg.DURATION_MODE === 'fixed' ? 'fixed' : 'auto');
  put(A, 'duration_mode.why', sig.manual ? 'duration chosen manually; lifetime-based checks not applied' : cfg.DURATION_MODE === 'fixed' ? `fixed duration ${cfg.DEFAULT_DURATION_S}s` : `expected signal lifetime ${fin(sig.lifetime?.lifetime) ? sig.lifetime.lifetime.toFixed(1) + 's' : 'n/a'} snapped to the nearest allowed duration`);
  put(A, 'score.value', sig.strength); put(A, 'score.label', LABEL_SCORE); put(A, 'score.minimum', sig.minStrength ?? null, 'not recorded');
  A.state_transitions = hist.map((h) => ({ at_epoch_s: h.ts ?? null, from: h.from ?? null, to: h.to, reason: h.reason ?? null }));
  put(A, 'trigger', sig.entry?.trigger ?? null, 'no trigger fired (setup without a configured trigger)');
  put(A, 'display_label', `${sig.direction} ${sig.duration || ''} ${sig.gate || ''}`.trim());
  put(A, 'signal_book_id', sig.signalId, 'not in signal book');

  const B = sect(true);
  B.volume_note = NOVOL; B.null_reasons['candles.*.volume'] = NOVOL;
  B.candles = {}; B.roles = { ...roles }; B.frame_for_indicators = roles.setup;
  for (const nm of names) B.candles[nm] = (frames[nm] || []).slice(-20).map(candleOut);
  const ind = indicators(F.setup, cfg, price);
  for (const [k, v] of Object.entries(ind.null_reasons)) B.null_reasons['indicators.' + k] = v;
  delete ind.null_reasons; B.indicators = ind;
  const tf = tickFlow(P, E, dE);
  put(B, 'tick_flow_ratio_60s.value', tf.ratio, 'not available: no up/down ticks in the last 60 s'); B.tick_flow_ratio_60s.label = 'proxy derived from the price path, not order flow';
  put(B, 'tick_intensity.value', tickGapsConstant(E) ? null : tf.ticks / 60, 'not available: constant tick rate');
  put(B, 'tick_gap_max_60s_s', tf.maxGap); put(B, 'seconds_since_last_tick', tf.sinceLast);

  const C = sect(true), tsec = cfg.FRAMES[roles.trigger], fc = frames.forming || formingCandle(P, E, tsec, dE), g = fc ? { body: Math.abs(fc.close - fc.open), range: fc.high - fc.low, upper: fc.high - Math.max(fc.open, fc.close), lower: Math.min(fc.open, fc.close) - fc.low } : null;
  put(C, 'price_at_decision', price);
  C.null_reasons['current_candle.volume'] = NOVOL;
  put(C, 'current_candle', fc ? { ...candleOut(fc), closed: false, forming: true, timeframe: roles.trigger, upper_wick: g.upper, lower_wick: g.lower, body: g.body, range: g.range, range_atr: atr > 0 ? g.range / atr : null } : null, 'not available: no ticks in the forming candle');
  const back = (s) => { const i = firstIdxGE(E, dE - s); return i < P.length && E[i] <= dE ? price - P[i] : null; };
  put(C, 'momentum_60s_points', back(60), 'not available: not enough ticks'); put(C, 'momentum_300s_points', back(300), 'not available: not enough ticks');
  put(C, 'immediate_momentum.score', sig.momentum?.score ?? null, sig.momentum?.reason || 'momentum unavailable'); put(C, 'immediate_momentum.state', sig.momentum?.state ?? null, 'momentum state unavailable');
  put(C, 'regime.label', sig.regime?.type ?? null, 'regime unavailable'); put(C, 'regime.text', sig.regime?.reason ?? null, 'regime unavailable'); C.null_reasons['regime.inputs.volRatio'] = 'not available: volatility ratio needs a longer baseline'; put(C, 'regime.inputs', sig.regime?.inputs ?? null, 'regime unavailable');
  const ranges = F.setup.slice(-100).map((c) => c.range), cur = F.setup.at(-1)?.range;
  put(C, 'volatility_regime.percentile', ranges.length >= 20 && fin(cur) ? ranges.filter((r) => r <= cur).length / ranges.length : null, 'not available: fewer than 20 setup candles');
  C.volatility_regime.basis = 'percentile of the last closed setup-frame candle range among the last 100 (own definition)';
  put(C, 'decision_to_entry', null, 'not available at decision: latency and slippage are filled in section F after Deriv supplies the entry tick');

  const D = sect(true);
  const zones = buildZones(F, cfg, roles).map((z) => zoneOut(z, price));
  const sup = zones.filter((z) => ['support', 'demand'].includes(z.type) && z.high <= price + 1e-12).sort((a, b) => b.high - a.high)[0];
  const res = zones.filter((z) => ['resistance', 'supply'].includes(z.type) && z.low >= price - 1e-12).sort((a, b) => a.low - b.low)[0];
  put(D, 'nearest_support', sup ? { price: sup.price, low: sup.low, high: sup.high, distance_points: price - sup.high, distance_atr: atr > 0 ? (price - sup.high) / atr : null } : null, 'not available: no support zone below price');
  put(D, 'nearest_resistance', res ? { price: res.price, low: res.low, high: res.high, distance_points: res.low - price, distance_atr: atr > 0 ? (res.low - price) / atr : null } : null, 'not available: no resistance zone above price');
  D.zones = zones; D.null_reasons['zones.last_touch_epoch'] = 'not available: the zone builder does not expose the last touch time (see fresh)';
  put(D, 'target', sig.lifetime?.target ?? null, 'no target (lifetime estimators unavailable)'); put(D, 'invalidation', sig.lifetime?.invalid ?? null, 'no invalidation level');
  const rawZ = buildZones(F, cfg, roles), room = roomToRun(rawZ, price, dir), move = sig.roomInfo?.sigmaT;
  put(D, 'room_ratio', fin(room) && move > 0 ? room / move : null, fin(room) ? 'expected move unavailable' : 'not available: no opposing zone ahead');
  put(D, 'room_points', fin(room) ? room : null, 'not available: no opposing zone ahead');
  const rc = roomChecks({ move, room, atr, price, dir, target: sig.lifetime?.target, invalid: sig.lifetime?.invalid, cfg });
  const reward = fin(sig.lifetime?.target) ? (sig.lifetime.target - price) * dir : null, risk = fin(sig.lifetime?.invalid) ? (price - sig.lifetime.invalid) * dir : null;
  const rrMode = cfg.DURATION_MODE === 'lifetime' && cfg.ROOM_CHECK === 'rr' && !sig.manual;
  const num = { 'no-room': { value: move, threshold: fin(room) ? cfg.NOROOM_FRAC * room : null, margin: fin(room) && fin(move) ? cfg.NOROOM_FRAC * room - move : null }, 'available-distance': { value: fin(room) && atr > 0 ? room / atr : null, threshold: cfg.AVAIL_ATR, margin: fin(room) && atr > 0 ? room / atr - cfg.AVAIL_ATR : null }, 'reward-to-risk': { value: reward != null && risk > 0 ? reward / risk : null, threshold: cfg.RR_MIN, margin: reward != null && risk > 0 ? reward / risk - cfg.RR_MIN : null } };
  D.checks = rc.checks.map((c) => ({ name: c.name, result: c.ok ? 'PASS' : (cfg.ROOM_NAMED || (c.name === 'reward-to-risk' && rrMode) ? 'VETO' : 'FAIL'), applied_as_veto: !c.ok && (cfg.ROOM_NAMED || (c.name === 'reward-to-risk' && rrMode)), detail: c.text, numbers: Object.fromEntries(Object.entries(num[c.name]).map(([k, v]) => [k, fin(v) ? v : null])) }));
  D.null_reasons['checks.numbers'] = 'a number is null when its input does not exist (for example no opposing zone ahead)';

  // E
  const votes = (sig.votes || []).map((v) => ({ factor: v.factor, family: v.family, vote: v.vote, weight: v.weight, na: !!v.na, reason: v.reason }));
  const fams = {}; for (const [k, f] of Object.entries(sig.families || {})) fams[k] = { name: f.name || k, available: !!f.available, score: f.score ?? null, vote: f.vote || 0, members: (f.members || []).map((m) => ({ id: m.id, vote: m.vote, weight: m.weight, na: !!m.na })) };
  const setupC = F.setup, readings = {};
  { const cl = setupC.map((c) => c.close), r = rsi(cl), a = adx(setupC);
    if (fin(r)) readings.rsi = { value: r, lower: cfg.RSI_OS, upper: cfg.RSI_OB };
    if (fin(a.adx)) readings.adx = { value: a.adx, lower: null, upper: cfg.ADX_TREND };
    const sk = stochastic(setupC).k, cv = cci(setupC);
    if (fin(sk)) readings.stoch = { value: sk, lower: cfg.STOCH_OS, upper: cfg.STOCH_OB };
    if (fin(cv)) readings.cci = { value: cv, lower: -100, upper: 100 };
  }
  const stat = safe(() => statRegime(P, E, cfg.EWMA_LAMBDA)), live = new Set(votes.filter((v) => !v.na && v.weight > 0).map((v) => v.factor));
  const spikeInfo = safe(() => spikeContext(symbol, F, P, E, cfg, stat?.tickSecs));
  const hypo = [];
  for (const [id, fn] of Object.entries(FACTORS)) {
    if (live.has(id)) continue;
    const r = safe(() => fn({ frames: F, cfg, stat, zones: rawZ, price, atr, symbol, spikeInfo }));
    const setting = cfg.factors?.[id], reason = r ? r.reason : 'factor computation failed or its inputs are unavailable';
    hypo.push(r
      ? { factor: id, family: cfg.FAMILY_OF[id] || r.group, vote: r.na ? null : r.vote, weight: setting?.weight ?? 0, enabled: !!setting?.enabled, reason: r.na ? `not available: ${reason}` : reason }
      : { factor: id, family: cfg.FAMILY_OF[id] || null, vote: null, weight: setting?.weight ?? 0, enabled: !!setting?.enabled, reason: `not available: ${reason}` });
  }
  const notApplied = [];
  if (sig.manual) notApplied.push({ check: 'reward-to-risk / lifetime room checks', reason: 'manual duration mode: lifetime-derived checks are not applied' });
  for (const [k, v] of Object.entries(rec?.filters?.breakout || {})) if (v && v.pass === false && !cfg.BREAKOUT_FILTERS?.[k]) notApplied.push({ check: 'breakout filter ' + k, reason: 'flag off; recorded only', would_have: v.reason || 'fail' });
  if (rec?.filters?.vol && rec.filters.vol.high && !rec.filters.vol.allow && !cfg.VOL_FILTER) notApplied.push({ check: 'volatility filter', reason: 'flag off; recorded only', would_have: rec.filters.vol.label });
  if (rc.fired && !cfg.ROOM_NAMED && rc.fired !== 'reward-to-risk') notApplied.push({ check: 'room check ' + rc.fired, reason: 'ROOM_NAMED off; recorded only' });
  const T = { FAMILIES_AGREE_MIN: cfg.FAMILIES_AGREE_MIN, AGREE_RATIO_MIN: cfg.AGREE_RATIO_MIN, FAMILY_OPPOSE_STRONG: cfg.FAMILY_OPPOSE_STRONG, FAMILY_VOTE_MIN: cfg.FAMILY_VOTE_MIN, MOM_VOTE_MIN: cfg.MOM_VOTE_MIN, MOM_OPPOSE_MOD: cfg.MOM_OPPOSE_MOD };
  const minStrength = sig.minStrength ?? cfg.SCORE_MIN;
  const inputs = { dir, strength: sig.strength, minStrength, families: fams, votes, readings, hypothetical: hypo, candidateScores: sig.candidateScores || [], T, momentum: { score: sig.momentum?.score ?? null }, checks: D.checks.map((c) => ({ name: c.name, value: c.numbers.value, threshold: c.numbers.threshold, margin: c.numbers.margin })).filter((c) => c.value != null), notApplied, nearMissFrac: cfg.NEAR_MISS_FRAC, nearNeutralFrac: cfg.NEAR_NEUTRAL_FRAC };
  const an = analyse(inputs);

  const Eo = sect(true);
  const tauTicks = dp ? (dp.unit === 't' ? dp.n : fin(sig.durationSec) && tickInt > 0 ? sig.durationSec / tickInt : null) : null;
  const expiryProbability = safe(() => expiryProbBaseline({ dir, spot: price, entry: price, tau: tauTicks, sigma: sigmaPerTick(P) }));
  const agr = sig.familyAgreement || {}, pf = PLAYBOOK_FACTORS[sig.playbook] || { required: [], optional: [] }, wsum = votes.filter((v) => !v.na && v.weight > 0).reduce((a, v) => a + v.weight, 0);
  const el = sig.lifetime || {}, est = {};
  for (const k of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']) { const v = el.estimators?.[k]; est[k] = fin(v) ? v : null; if (est[k] == null) Eo.null_reasons['prediction.estimators.' + k] = 'not applicable for this playbook / market class, or its inputs are unavailable'; }
  Eo.prediction = {
    direction: sig.direction, predicted_direction: trade?.predicted || sig.direction, score: sig.strength, score_label: LABEL_SCORE,
    family_votes: Object.fromEntries(Object.values(fams).map((f) => [f.name, { vote: !f.available ? 'unavailable' : f.vote === dir ? 'agree' : f.vote === -dir ? 'oppose' : 'neutral', score: f.score }])),
    family_agreeing_share: fin(agr.ratio) ? agr.ratio : null, families_agree: agr.agree || [], families_oppose: agr.oppose || [], families_neutral: agr.neutral || [], families_unavailable: agr.unavailable || [],
    factor_votes: votes.map((v) => ({ factor: v.factor, family: v.family, vote: v.na ? 'unavailable' : v.vote === dir ? 'agree' : v.vote === -dir ? 'oppose' : 'neutral', raw_vote: v.vote, weight: v.weight, reason: v.reason, signed_contribution: v.na || !(wsum > 0) ? null : (v.weight * v.vote * dir) / wsum })),
    contribution_basis: 'weight x vote x direction / sum of available weights; the playbook score is not additive in factors',
    estimators: est, expected_lifetime_s: fin(el.lifetime) ? el.lifetime : null, snapped_duration: sig.duration, expected_move_points: fin(move) ? move : null, expected_move_atr: fin(move) && atr > 0 ? move / atr : null,
    quoted_payout: sig.quote?.payout ?? null, quoted_ask: sig.quote?.ask ?? null, break_even: fin(sig.breakEven) ? sig.breakEven : null,
    expiry_probability: expiryProbability, expiry_probability_method: 'unadjusted analytic zero-drift expiry baseline; entry and spot both use decision-time price', required_factors: pf.required, optional_factors: pf.optional,
  };
  if (!fin(el.lifetime)) Eo.null_reasons['prediction.expected_lifetime_s'] = 'lifetime estimators unavailable';
  if (!fin(move)) { Eo.null_reasons['prediction.expected_move_points'] = 'expected move unavailable'; Eo.null_reasons['prediction.expected_move_atr'] = 'expected move or ATR unavailable'; }
  if (sig.quote?.payout == null) { Eo.null_reasons['prediction.quoted_payout'] = 'no Deriv quote at decision'; Eo.null_reasons['prediction.quoted_ask'] = 'no Deriv quote at decision'; }
  if (!fin(sig.breakEven)) Eo.null_reasons['prediction.break_even'] = 'no Deriv quote at decision';
  if (!fin(agr.ratio)) Eo.null_reasons['prediction.family_agreeing_share'] = 'family agreement unavailable (legacy mode or data wait)';
  if (expiryProbability == null) Eo.null_reasons['prediction.expiry_probability'] = 'not available: expiry baseline needs enough price ticks and a valid duration';
  Eo.null_reasons['prediction.factor_votes.signed_contribution'] = 'null for factors that were unavailable or have no weight';
  Eo.e2 = an.e2; Eo.e3 = an.e3; Eo.e4 = an.e4; Eo.inputs = inputs;
  Object.assign(Eo.null_reasons, { 'e2.disabled_or_zero_weight.vote': 'not available: factor produced no reading', 'inputs.hypothetical.vote': 'not available: factor produced no reading', 'inputs.momentum.score': 'momentum unavailable', 'e3.factor_vote_score_traded': 'no available weighted votes', 'e3.factor_vote_score_opposite': 'no available weighted votes', 'e3.margin': 'no available weighted votes', 'e4.margins.margin_rel': 'threshold is zero, relative margin undefined', 'inputs.readings.adx.lower': 'ADX has only an upper (trend) threshold', 'inputs.checks.threshold': 'check has no threshold because an input (for example room) does not exist', 'inputs.checks.margin': 'check has no margin because an input does not exist' });
  if (!an.e3.opposite_playbook) Eo.null_reasons['e3.opposite_playbook'] = 'not available: no opposite-direction playbook candidate was generated';
  if (an.e3.playbook_score_opposite == null) Eo.null_reasons['e3.playbook_score_opposite'] = 'not available: no opposite-direction playbook candidate was generated';
  if (an.e3.playbook_score_margin == null) Eo.null_reasons['e3.playbook_score_margin'] = 'not available: one direction had no playbook candidate';
  Object.assign(Eo.null_reasons, {
    'inputs.families.*.score': 'not available: family has no directional members',
    'inputs.families.*.members.*.weight': 'not available: factor weight was not available',
    'e4.margins.margin_rel': 'threshold is zero; relative margin is undefined',
  });

  for (const section of [H, A, B, C, D, Eo]) fillNullReasons(section);
  return {
    ...H, A, B, C, D, E: Eo,
    F: { ...sect(false), pending: true, status: 'pending: filled after the contract settles' },
    G: { ...sect(false), pending: true, status: 'pending: filled after the post-trade window closes', window_end_epoch: null, null_reasons: { window_end_epoch: 'not available: trade not closed yet' } },
    _decision: { epoch: dE, price, dir, atr: fin(atr) ? atr : null, trigger_secs: tsec, bucket, durKey: sig.duration, durSec: sig.durationSec, target: sig.lifetime?.target ?? null, invalid: sig.lifetime?.invalid ?? null, shadowDs: rec?.shadowDs || (dp ? [{ unit: dp.unit, n: dp.n, key: sig.duration }] : []) },
  };
}
function safe(fn) { try { return fn(); } catch { return null; } }

/** Entry / exit tick indices under the contract rules (entry = first tick after the decision, exit = tick count or first tick at/after expiry). */
export function entryExitIdx(epochs, at, d) {
  const i = firstIdxAfter(epochs, at); if (i >= epochs.length) return null;
  let j;
  if (d.unit === 't') j = i + d.n; else { const exp = epochs[i] + d.n * UNIT_S[d.unit]; j = i; while (j < epochs.length && epochs[j] < exp) j++; }
  return j >= epochs.length ? null : { i, j };
}

/** Section F (append-only). `trade` = BAZU trade (Deriv fields) or null for an untraded signal (hypothetical). */
export function finalizeF(rec, { trade = null, prices, epochs, now = Date.now() }) {
  if (rec.F && rec.F.finalised) return rec;
  const d = rec._decision, dir = d.dir, dp = durParts(d.durKey), F = sect(false);
  const ee = dp ? entryExitIdx(epochs, d.epoch, dp) : null;
  const eEpoch = trade?.entryEpoch ?? (ee ? epochs[ee.i] : null), ePrice = fin(trade?.entry) ? Number(trade.entry) : ee ? prices[ee.i] : null;
  const xEpoch = trade?.exitEpoch ?? (ee ? epochs[ee.j] : null), xPrice = fin(trade?.exit) ? Number(trade.exit) : ee ? prices[ee.j] : null;
  F.finalised = true; F.hypothetical = !trade; F.finalised_iso = iso(now);
  F.contract = {};
  put(F, 'contract.contract_id', trade?.id, 'not traded: hypothetical outcome'); put(F, 'contract.deriv_status', trade?.derivStatus, 'not traded or Deriv status not stored');
  put(F, 'contract.deriv_result', trade?.result, 'not traded or Deriv result not available'); put(F, 'contract.buy_price', trade?.buyPrice, 'not traded'); put(F, 'contract.payout', trade?.payout, 'not traded');
  put(F, 'contract.stake', trade?.stake, 'not traded'); put(F, 'contract.profit_raw', trade?.profit, 'not available: contract not settled or not traded');
  put(F, 'entry.price', ePrice, 'not available: entry tick not in tick history'); put(F, 'entry.epoch', eEpoch, 'not available: entry tick not in tick history');
  put(F, 'exit.price', xPrice, 'not available: exit tick not in tick history'); put(F, 'exit.epoch', xEpoch, 'not available: exit tick not in tick history');
  F.entry_exit_source = trade && fin(trade.entry) ? 'Deriv contract fields' : 'tick history under the contract rules (hypothetical)';
  const known = fin(ePrice) && fin(xPrice);
  const derivResult = trade?.result === 'win' || trade?.result === 'loss' || trade?.result === 'tie' ? trade.result : null;
  const result = trade ? (known && xPrice === ePrice ? 'tie' : derivResult) : known ? (xPrice === ePrice ? 'tie' : settle(dir, ePrice, xPrice)) : null;
  put(F, 'result', result ? result[0].toUpperCase() + result.slice(1) : null, trade ? 'not available: Deriv result is missing' : 'not available: entry or exit price missing');
  F.tie_rule = 'a tie (exit == entry) loses, as on Deriv';
  put(F, 'price_change', known ? xPrice - ePrice : null, 'not available: entry or exit missing'); put(F, 'price_change_atr', known && d.atr > 0 ? (xPrice - ePrice) / d.atr : null, 'not available: ATR or prices missing');
  put(F, 'decision_to_entry_delay_s', fin(eEpoch) ? eEpoch - d.epoch : null, 'not available: entry epoch unknown');
  put(F, 'slippage_points', fin(ePrice) ? (ePrice - d.price) * dir : null, 'not available: entry price unknown'); put(F, 'slippage_atr', fin(ePrice) && d.atr > 0 ? ((ePrice - d.price) * dir) / d.atr : null, 'not available: entry price or ATR unknown');
  F.slippage_sign = 'positive = the entry was worse for the trade than the decision price';
  const iA = fin(eEpoch) ? firstIdxGE(epochs, eEpoch) : ee ? ee.i : null, jB = fin(xEpoch) ? lastIdxLE(epochs, xEpoch) : ee ? ee.j : null;
  const covered = iA != null && jB != null && jB >= iA && epochs.length && epochs.at(-1) >= (xEpoch ?? Infinity);
  F.censored = !covered;
  if (!covered) F.null_reasons.censored = 'window not fully covered by tick history (censored)';
  let tT = null, tI = null, mae = null, mfe = null, candles = [];
  if (covered) {
    for (let k = iA; k <= jB; k++) {
      const mv = (prices[k] - (ePrice ?? prices[iA])) * dir;
      if (tT == null && d.target != null && (dir > 0 ? prices[k] >= d.target : prices[k] <= d.target)) tT = epochs[k] - (eEpoch ?? epochs[iA]);
      if (tI == null && d.invalid != null && (dir > 0 ? prices[k] <= d.invalid : prices[k] >= d.invalid)) tI = epochs[k] - (eEpoch ?? epochs[iA]);
      mfe = mfe == null ? mv : Math.max(mfe, mv); mae = mae == null ? -mv : Math.max(mae, -mv);
    }
    candles = bucketCandles(prices.slice(iA, jB + 1), epochs.slice(iA, jB + 1), 10).map(candleOut);
  }
  const first = !covered ? null : tT == null && tI == null ? 'Neither' : tI != null && (tT == null || tI <= tT) ? 'Invalidation' : 'Target';
  put(F, 'first_touch', first, 'not available: window not covered by tick history');
  put(F, 'time_to_target_s', tT, covered ? 'target not touched during the contract' : 'not available: window not covered');
  put(F, 'time_to_invalidation_s', tI, covered ? 'invalidation not touched during the contract' : 'not available: window not covered');
  put(F, 'max_adverse_points', mae == null ? null : Math.max(0, mae), 'not available: window not covered'); put(F, 'max_favourable_points', mfe == null ? null : Math.max(0, mfe), 'not available: window not covered');
  put(F, 'max_adverse_atr', mae != null && d.atr > 0 ? Math.max(0, mae) / d.atr : null, 'not available: window or ATR missing'); put(F, 'max_favourable_atr', mfe != null && d.atr > 0 ? Math.max(0, mfe) / d.atr : null, 'not available: window or ATR missing');
  F.candles_during_trade = candles; F.candle_timeframe_s = 10; F.null_reasons['candles_during_trade.volume'] = NOVOL;
  const real = known ? SIGN(xPrice - ePrice) : null;
  if (real == null) { F.hindsight = null; F.null_reasons.hindsight = 'not available: outcome unknown'; }
  else {
    const cls = (v) => classifyVote(v, dir, real);
    F.hindsight = {
      realised_direction: real > 0 ? 'up' : real < 0 ? 'down' : 'flat',
      note: 'anecdotal per-trade attribution; conclusions come from the aggregate dissent analysis',
      factors: rec.E.inputs.votes.filter((v) => !v.na && v.weight > 0).map((v) => ({ factor: v.factor, vote: v.vote, class: cls(v.vote) })),
      families: Object.values(rec.E.inputs.families).filter((f) => f.available).map((f) => ({ family: f.name, vote: f.vote, class: cls(f.vote) })),
      e2_not_in_decision: rec.E.inputs.hypothetical.filter((h) => h.vote != null).map((h) => ({ factor: h.factor, vote: h.vote, class: cls(h.vote) })),
    };
  }
  F.hypothetical_outcomes = d.shadowDs.map((sd) => ({ duration: sd.key, traded_direction: shadowOutcome({ prices, epochs, at: d.epoch, dir, d: sd }), opposite_direction: shadowOutcome({ prices, epochs, at: d.epoch, dir: -dir, d: sd }) }));
  F.hypothetical_basis = 'real tick history, entry = first tick after the decision, exit = tick count or first tick at/after expiry, ties lose';
  const out = { ...rec, F };
  const win = cfgNum(rec, 'REVERSAL_WINDOW_S', 900);
  out.G = { ...sect(false), pending: true, status: 'pending: filled after the post-trade window closes', window_end_epoch: fin(xEpoch) ? xEpoch + win : null };
  if (!fin(xEpoch)) { out.G.status = 'not available: expiry epoch unknown'; out.G.null_reasons.window_end_epoch = 'not available: expiry epoch unknown'; }
  fillNullReasons(F);
  return out;
}
const cfgNum = (rec, k, dflt) => (fin(rec.config?.[k]) ? rec.config[k] : dflt);

export const gReady = (rec, latestEpoch) => !!(rec.F?.finalised && rec.G?.pending && fin(rec.G.window_end_epoch) && latestEpoch >= rec.G.window_end_epoch);

/** Section G (append-only): post-trade context from ticks after expiry. */
export function finalizeG(rec, { prices, epochs, remote = {}, now = Date.now() }) {
  if (!rec.G?.pending && rec.G?.finalised) return rec;
  const d = rec._decision, cfg = rec.config, G = sect(false), xE = rec.F.exit?.epoch, dir = d.dir;
  G.finalised = true; G.finalised_iso = iso(now);
  const covered = fin(xE) && epochs.length && epochs.at(-1) >= rec.G.window_end_epoch && epochs[0] <= xE;
  G.censored = !covered;
  const tsec = d.trigger_secs;
  if (!covered) {
    for (const k of ['candles_after_expiry', 'price_5m_after', 'price_15m_after', 'regime_5m_after', 'did_reverse', 'reversal_atr']) put(G, k, null, 'not available: tick history does not cover the post-trade window');
    G.reversal = { window_s: cfg.REVERSAL_WINDOW_S, min_atr: cfg.REVERSAL_MIN_ATR };
    fillNullReasons(G); return { ...rec, G };
  }
  const i0 = firstIdxGE(epochs, xE), at = (s) => { const i = firstIdxGE(epochs, xE + s); return i < prices.length ? prices[i] : null; };
  const after = bucketCandles(prices.slice(i0), epochs.slice(i0), tsec).filter((c) => c.epoch >= Math.ceil(xE / tsec) * tsec && c.epoch + tsec <= epochs.at(-1)).slice(0, 20);
  put(G, 'candles_after_expiry', after.length ? after.map(candleOut) : null, 'not available: no complete candles after expiry'); G.null_reasons['candles_after_expiry.volume'] = NOVOL; G.candle_timeframe_s = tsec;
  put(G, 'price_5m_after', at(300), 'not available: no tick after +5 min'); put(G, 'price_15m_after', at(900), 'not available: no tick after +15 min');
  const cut = lastIdxLE(epochs, xE + 300) + 1, P5 = prices.slice(0, cut), E5 = epochs.slice(0, cut);
  const reg = safe(() => { const names = [cfg.ROLES[d.bucket].setup], fr = buildFrames({ remote, prices: P5, epochs: E5, decisionEpoch: xE + 300, cfg, names, formingSecs: null }), st = statRegime(P5, E5, cfg.EWMA_LAMBDA); return regimeOf({ adxRes: adx(fr[names[0]]), hurst: st?.hurst, volRatio: null, cusum: st?.cusum, cfg }); });
  put(G, 'regime_5m_after.label', reg?.type ?? null, 'not available: regime inputs missing'); put(G, 'regime_5m_after.text', reg?.reason ?? null, 'not available: regime inputs missing');
  const entry = rec.F.entry?.price, jEnd = lastIdxLE(epochs, xE + cfg.REVERSAL_WINDOW_S);
  let mag = null;
  if (fin(entry)) for (let k = i0; k <= jEnd; k++) { const adv = (entry - prices[k]) * dir; mag = mag == null ? adv : Math.max(mag, adv); }
  const magAtr = mag != null && d.atr > 0 ? Math.max(0, mag) / d.atr : null;
  put(G, 'reversal_atr', magAtr, 'not available: entry price or ATR missing');
  put(G, 'did_reverse', magAtr == null ? null : magAtr >= cfg.REVERSAL_MIN_ATR, 'not available: entry price or ATR missing');
  G.reversal = { window_s: cfg.REVERSAL_WINDOW_S, min_atr: cfg.REVERSAL_MIN_ATR, definition: 'after expiry, price crosses back through the entry price against the contract direction by at least min_atr ATR within window_s' };
  fillNullReasons(G);
  return { ...rec, G };
}

/** Validation used by the tests and before export: structure, sections, and a reason for every null. */
/** A null at a relative path is explained by an exact entry, a parent entry, or a * wildcard entry. */
function reasonCovered(reasons, rel) {
  return Object.keys(reasons).some((r) => {
    if (r === rel || rel.startsWith(r + '.')) return true;
    if (!r.includes('*')) return false;
    const re = new RegExp('^' + r.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+') + '(\\..*)?$');
    return re.test(rel);
  });
}

export function validateRecord(rec) {
  const errs = [];
  for (const k of ['signal_id', 'schema_version', 'config_hash', 'config', 'flags', 'market', 'traded', 'A', 'B', 'C', 'D', 'E', 'F', 'G']) if (rec[k] === undefined) errs.push('missing ' + k);
  for (const s of ['A', 'B', 'C', 'D', 'E']) if (rec[s]?.available_at_decision !== true) errs.push(`${s}.available_at_decision must be true`);
  for (const s of ['F', 'G']) if (rec[s]?.available_at_decision !== false) errs.push(`${s}.available_at_decision must be false`);
  const walk = (v, path, owner) => {
    if (v === null) { const rel = path.replace(/\[\d+\]/g, '').replace(/^\./, ''); if (!owner || !reasonCovered(owner.reasons, rel)) errs.push(`null without reason: ${owner ? owner.name : ''}.${rel}`); return; }
    if (typeof v === 'number' && !fin(v)) { errs.push('non-finite number at ' + path); return; }
    if (v === undefined) { errs.push('undefined at ' + path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, owner)); return; }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'null_reasons' || k === 'config' || k === '_decision') continue; walk(x, `${path}.${k}`, owner); }
  };
  for (const s of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) if (rec[s]) {
    const owner = { name: s, reasons: rec[s].null_reasons || {} };
    for (const [k, x] of Object.entries(rec[s])) { if (k === 'null_reasons') continue; walk(x, `.${k}`, owner); }
  }
  for (const [k, x] of Object.entries(rec)) if (!['null_reasons', 'config', '_decision', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(k)) walk(x, '.' + k, { name: 'header', reasons: rec.null_reasons || {} });
  if (rec.contract_id === null && !rec.null_reasons?.contract_id) errs.push('contract_id null without reason');
  return errs;
}
