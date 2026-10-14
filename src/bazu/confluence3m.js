/**
 * src/bazu/confluence3m.js  (pure)
 * Stage 1 (regime) and Stage 3 (family confluence) of the decision pipeline, plus the graduated momentum gate and the
 * verdict logic (REJECTED / DELAYED / DATA). Nothing here substitutes zero for missing data: a factor flagged `na`
 * (or a momentum reading that is unavailable) makes its family unavailable, never agreeing and never "neutral confirmation".
 */
import { rsi, stochastic, cci } from './ta3m.js?v=15';
import { MOMENTUM_STATES, momentumState } from './momentum3m.js?v=15';

const fin = Number.isFinite;
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const VERDICT = Object.freeze({ REJECTED: 'REJECTED', DELAYED: 'DELAYED', DATA: 'DATA' });
export const FAMILIES = Object.freeze(['trend', 'oscillator', 'structure', 'volatility', 'momentum', 'flow', 'spike']);

/** Stage 1. type: trending_up | trending_down | ranging | transitioning | unknown (inputs missing). */
export function regimeOf({ adxRes, hurst, volRatio, cusum, cfg }) {
  if (!adxRes || !fin(adxRes.adx)) return { type: 'unknown', reason: 'ADX unavailable', inputs: {} };
  const inputs = { adx: adxRes.adx, hurst, volRatio, di: adxRes.plusDI - adxRes.minusDI };
  const trending = adxRes.adx >= cfg.ADX_TREND && hurst > 0.5, dir = sgn(adxRes.plusDI - adxRes.minusDI);
  if (trending && dir) return { type: dir > 0 ? 'trending_up' : 'trending_down', trending: true, dir, inputs, reason: `ADX ${adxRes.adx.toFixed(0)} >= ${cfg.ADX_TREND}, Hurst ${fin(hurst) ? hurst.toFixed(2) : 'n/a'}, DI ${dir > 0 ? '+' : '-'}` };
  const changing = adxRes.adx >= cfg.ADX_TRANSITION || (fin(volRatio) && volRatio >= cfg.VOL_CHANGE_RATIO) || (fin(cusum) && Math.abs(cusum) > 0);
  if (changing && adxRes.adx >= cfg.ADX_TRANSITION) return { type: 'transitioning', trending: false, dir: 0, inputs, reason: `ADX ${adxRes.adx.toFixed(0)} between ${cfg.ADX_TRANSITION} and ${cfg.ADX_TREND}` };
  return { type: 'ranging', trending: false, dir: 0, inputs, reason: `ADX ${adxRes.adx.toFixed(0)} < ${cfg.ADX_TRANSITION}` };
}

const regimeKey = (r) => (r.type === 'ranging' ? 'range' : r.type === 'transitioning' ? 'transition' : 'trend');

/** Oscillator vote under the regime: ranging -> reversal vote; trending -> with the trend or 0 (never against it); transitioning -> 0. */
export function oscillatorVote(name, setupCandles, rawVote, regime, cfg) {
  const key = regimeKey(regime);
  if (regime.type === 'unknown') return { vote: 0, weight: 0, na: true };
  if (key === 'range') return { vote: rawVote, weight: cfg.OSC_REGIME_WEIGHT.range };
  if (key === 'transition') return { vote: 0, weight: cfg.OSC_REGIME_WEIGHT.transition };
  const cl = setupCandles.map((c) => c.close);
  const side = name === 'rsi' ? sgn(rsi(cl) - 50) : name === 'stoch' ? sgn(stochastic(setupCandles).k - 50) : sgn(cci(setupCandles));
  return { vote: side === regime.dir ? regime.dir : 0, weight: cfg.OSC_REGIME_WEIGHT.trend };
}

/**
 * Family votes. factors = runFactors output; returns { families: {name: {active, available, score, vote, members[]}}, votes[] }.
 * votes[] is the contradiction-report breakdown: one row per factor (plus the momentum family) with vote, weight and reason.
 */
export function familyVotes({ factors, regime, momentum, setupCandles, cfg }) {
  const fam = {}, votes = [];
  const slot = (n) => (fam[n] ||= { name: n, active: true, available: false, num: 0, den: 0, members: [] });
  for (const [id, f] of Object.entries(factors)) {
    const family = cfg.FAMILY_OF[id];
    if (!family || !f.weight) continue;
    const s = slot(family);
    let vote = f.vote, weight = f.weight, na = !!f.na, note = '';
    if (family === 'oscillator' && !na) { const o = oscillatorVote(id, setupCandles, f.vote, regime, cfg); vote = o.vote; weight *= o.weight; na = !!o.na; if (vote !== f.vote) note = ` -> ${regime.type} regime: ${vote === 0 ? 'neutral' : 'with trend'}`; }
    votes.push({ factor: id, family, vote, rawVote: f.vote, weight, na, reason: f.reason + note });
    s.members.push({ id, vote, weight, na });
    if (!na && weight > 0) { s.available = true; s.num += weight * vote; s.den += weight; }
  }
  const mw = cfg.FAMILY_WEIGHT_MOMENTUM ?? 1, m = slot('momentum');
  if (momentum?.available) { m.available = true; m.num = mw * momentum.score; m.den = mw; }
  votes.push({ factor: 'momentum', family: 'momentum', vote: momentum?.available ? (Math.abs(momentum.score) >= cfg.MOM_VOTE_MIN ? sgn(momentum.score) : 0) : 0, rawVote: null, weight: mw, na: !momentum?.available, reason: momentum?.available ? `immediate momentum ${momentum.score.toFixed(2)} (${momentum.n} measures)` : (momentum?.reason || 'momentum unavailable') });
  for (const s of Object.values(fam)) {
    s.score = s.available && s.den > 0 ? s.num / s.den : null;
    s.vote = s.score == null ? 0 : Math.abs(s.score) >= (s.name === 'momentum' ? cfg.MOM_VOTE_MIN : cfg.FAMILY_VOTE_MIN) ? sgn(s.score) : 0;
  }
  return { families: fam, votes };
}

/** Family-agreement rule for direction `dir`. Returns { ok, reasons[], dataWait, agree, oppose, neutral, ratio, available, need }. */
export function agreement(families, dir, cfg) {
  const all = Object.values(families), avail = all.filter((f) => f.available);
  const unavailable = all.filter((f) => !f.available).map((f) => f.name);
  const need = Math.min(cfg.FAMILIES_AGREE_MIN, all.length);
  const agree = avail.filter((f) => f.vote === dir), oppose = avail.filter((f) => f.vote === -dir), neutral = avail.filter((f) => f.vote === 0);
  const strong = avail.filter((f) => f.score * dir <= -cfg.FAMILY_OPPOSE_STRONG);
  const nonNeutral = agree.length + oppose.length, ratio = nonNeutral ? agree.length / nonNeutral : 0;
  const res = { ok: true, reasons: [], dataWait: null, agree: agree.map((f) => f.name), oppose: oppose.map((f) => f.name), neutral: neutral.map((f) => f.name), strongOppose: strong.map((f) => f.name), ratio, available: avail.length, need, unavailable };
  if (avail.length < need) { res.ok = false; res.dataWait = `family: ${unavailable.join(', ') || 'inputs'} unavailable (${avail.length}/${need} families)`; return res; }
  if (agree.length < need) { res.ok = false; res.reasons.push(`only ${agree.length} of ${all.length} families agree (need ${need})`); }
  if (ratio < cfg.AGREE_RATIO_MIN) { res.ok = false; res.reasons.push(`agreeing share ${(ratio * 100).toFixed(0)}% < ${(cfg.AGREE_RATIO_MIN * 100).toFixed(0)}%`); }
  if (strong.length) { res.ok = false; res.reasons.push(`family strongly opposes: ${strong.map((f) => f.name).join(', ')}`); }
  return res;
}

/**
 * Graduated momentum gate. Returns { state, scoreDelta, verdict: null | {kind, reason} }.
 * opposing_strong -> REJECTED unless reversal playbook with a confirmed turn; opposing_moderate -> penalty (and DELAYED until a
 * turn confirms); aligned -> bonus. Counter-trend playbooks always need a confirmed turn (checked by the caller via `turn`).
 */
export function momentumGate({ momentum, dir, playbook, turn, oscReading, cfg }) {
  if (!momentum?.available) return { state: null, scoreDelta: 0, verdict: { kind: VERDICT.DATA, reason: momentum?.reason || 'momentum unavailable' } };
  const state = momentumState(momentum.score, dir, cfg), counter = cfg.COUNTER_TREND.includes(playbook), turned = !!turn?.confirmed;
  const gate = { state, scoreDelta: 0, verdict: null };
  if (state === MOMENTUM_STATES.ALIGNED) gate.scoreDelta = cfg.MOM_BONUS;
  else if (state === MOMENTUM_STATES.OPP_MOD) {
    gate.scoreDelta = -cfg.MOM_PENALTY;
    if (!turned) gate.verdict = { kind: VERDICT.DELAYED, reason: `momentum opposes (moderate${oscReading ? `; ${oscReading}` : ''}), waiting for a confirmed turn` };
  } else if (state === MOMENTUM_STATES.OPP_STRONG) {
    if (!(counter && turned)) gate.verdict = { kind: VERDICT.REJECTED, reason: `${oscReading ? oscReading + ' conflicts with ' : ''}immediate momentum (strong opposition)${counter ? ', no confirmed reversal' : ''}` };
    else gate.scoreDelta = -cfg.MOM_PENALTY;
  }
  return gate;
}
