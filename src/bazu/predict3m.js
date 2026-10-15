/**
 * src/bazu/predict3m.js  (pure)
 * BAZU rule-based Rise/Fall prediction: playbooks (trend pullback / range fade / breakout / fakeout / sweep),
 * context-validated candle patterns, weighted scoring and vetoes. No edge-validation or research gate.
 * The contract duration T is the expected signal lifetime (duration3m.js), snapped to an allowed Deriv duration,
 * or DEFAULT_DURATION_S in fixed mode. Every time-dependent calculation uses that T.
 * Target: Rise wins if exit > entry, Fall wins if exit < entry (ties lose); entry = first tick after purchase,
 * exit = tick at expiry. Only CLOSED candles feed patterns; the forming trigger candle is provisional and built
 * only from ticks <= decisionEpoch.
 */
import { configFor, marketClass, spikeInterval } from './config3m.js?v=16';
import { buildFrames } from './candles3m.js?v=15';
import { PATTERNS, runPatterns, fibPullback } from './patterns3m.js?v=15';
import { runFactors, structureState } from './factors3m.js?v=15';
import { statRegime, emaSlope, adx } from './ta3m.js?v=15';
import { buildZones, zonesNear, supportiveKinds, roomToRun, extendedMove, confirmed, breakoutState, liquiditySweep, expectedMove } from './context3m.js?v=15';
import * as D from './duration3m.js?v=15';
import { lapTimer } from './perf3m.js?v=15';
import { momentumReading, oscillatorExtreme, zoneTouchExtreme, confirmedTurn, opposesRecentMove } from './momentum3m.js?v=15';
import { sigmaPerTick, tickFlowProxy } from './expiry3m.js?v=15';
import { breakoutFilters, failedFilters, rangeFadeExp, roomChecks, volatilityFilter } from './filters3m.js?v=15';
import { regimeOf, familyVotes, agreement, momentumGate, VERDICT } from './confluence3m.js?v=15';

const MIN_BARS = { trigger: 30, setup: 30, context: 20 };

/** Spike context for Boom/Crash/Jump from closed trigger candles. bias = lean with the drift between spikes. */
export function spikeContext(symbol, frames, prices, epochs, cfg, tickSecs) {
  const cls = marketClass(symbol);
  if (cls !== 'boomcrash' && cls !== 'jump') return null;
  const tr = frames.trigger, lastSpike = [...tr].reverse().find((c) => c.spike) || null, now = epochs[epochs.length - 1];
  const meanSecs = cls === 'jump' ? cfg.JUMP_MEAN_S : spikeInterval(symbol) * tickSecs;
  const since = lastSpike ? epochs.filter((e) => e > lastSpike.epoch).length * tickSecs : epochs.length * tickSecs;
  const dueFrac = meanSecs > 0 ? since / meanSecs : 0;
  const spikeDir = /^BOOM/i.test(symbol) ? 1 : /^CRASH/i.test(symbol) ? -1 : 0;
  const due = !!spikeDir && dueFrac >= cfg.SPIKE_DUE_FRAC;
  const intensity = lastSpike && lastSpike.atr > 0 ? lastSpike.range / (cfg.SPIKE_ATR * lastSpike.atr) : 1;
  return {
    sinceSecs: lastSpike ? now - lastSpike.epoch : Infinity, meanSecs, intensity, dueFrac, due, spikeDir, bias: spikeDir ? (due ? spikeDir : -spikeDir) : 0,
    reason: spikeDir ? `${spikeDir > 0 ? 'Boom' : 'Crash'}: ${(dueFrac * 100).toFixed(0)}% of mean spike interval elapsed${due ? ' (spike due)' : ''}` : 'jump index',
  };
}

const wickAgainst = (c, dir) => { const r = c.high - c.low; return r > 0 ? (dir > 0 ? c.high - Math.max(c.open, c.close) : Math.min(c.open, c.close) - c.low) / r : null; };
const shortMomentum = (prices, dir, n = 20) => { const s = sigmaPerTick(prices); return s && prices.length > n ? ((prices.at(-1) - prices.at(-1 - n)) * dir) / (s * Math.sqrt(n)) : null; };
const emaPos = (cs, atr) => {
  if (cs.length < 25 || !(atr > 0)) return null;
  const k = 2 / 21; let e = cs[0].close;
  for (const c of cs) e += k * (c.close - e);
  return { ema: e, dist: (cs.at(-1).close - e) / atr };
};

function agreeCount(factors, dir) {
  let up = 0, down = 0, total = 0; const drivers = [];
  for (const [id, f] of Object.entries(factors)) {
    if (!f.weight) continue;
    total++;
    if (f.vote > 0) up++; else if (f.vote < 0) down++;
    if (f.vote === dir) drivers.push(id);
  }
  return { up, down, total, drivers };
}

/** Context-validated trigger for direction `dir` on a role frame ('trigger' | 'setup'). Pure of logging. */
export function triggerFor(dir, frameName, ctx) {
  const { frames, cfg, zones, atr, flow } = ctx, cs = frames[frameName];
  const res = { score: 0, reasons: [], provisional: false, pattern: null };
  if (cs.length < 8) return res;
  const avgN = flow?.avgN || 0;
  for (const back of [0, 1]) {
    const i = cs.length - 1 - back, c = cs[i];
    if (!c?.patternOk) continue;
    const near = zonesNear(zones, c.close, atr).filter((z) => supportiveKinds(dir).includes(z.kind) || z.kind === 'level');
    const ext = extendedMove(cs, i - 1, cfg);
    let conf = back === 1 ? confirmed(cs, i, dir, avgN) : false, prov = false;
    if (back === 0 && frames.forming && frameName === 'trigger') {
      const f = frames.forming; prov = true;
      conf = dir > 0 ? f.close > c.close && f.delta >= 0 : f.close < c.close && f.delta <= 0;
    }
    for (const [name, fn] of Object.entries(PATTERNS)) {
      if (!cfg.patterns[name]?.enabled) continue;
      const p = fn(cs, i, cfg);
      if (!p.present || p.direction !== dir) continue;
      const w = (cfg.patterns[name].weight || 1) * (cfg.patternWeights[name] ?? 1);
      if (p.kind === 'reversal') {
        if (!near.length) continue;
        if (!(ext.ext && ext.dir === -dir)) continue;
        if (!conf) continue;
      } else if (p.kind === 'continuation') {
        const s1 = structureState(frames.setup).trend, s2 = structureState(frames.context).trend;
        if (!(s1 === dir && s2 !== -dir)) continue;
        const fb = fibPullback(frames.setup, frames.setup.length - 1, cfg);
        if (name !== 'fibPullback' && !(fb.present && fb.direction === dir)) continue;
      } else continue;
      const s = Math.min(1, p.strength * w);
      if (s > res.score) { res.score = s; res.pattern = name; res.reasons = [`${ctx.names?.[frameName] || frameName} ${p.reason}${prov && back === 0 ? ' (provisional)' : ''}`]; res.provisional = prov && back === 0; }
    }
  }
  return res;
}

const keyOf = (d) => D.durationLabel(d);

/**
 * Main entry. Returns a prediction object compatible with decision.js (+ wait/reason/lifetime/record fields).
 * allowed = allowed durations for the market [{unit,n,secs}] (default: config grid, no contracts_for filter).
 * manualKey = a duration label (e.g. '5m') chosen by the user; it overrides the lifetime duration and is tagged manual.
 */
export function predict3m({ symbol, prices, epochs, remote = {}, decisionEpoch, overrides, logPatterns = true, allowed = null, manualKey = null, wallNow = null }) {
  const lap = lapTimer('predict'), cfg = configFor(symbol, overrides), now = decisionEpoch ?? epochs[epochs.length - 1];
  const blank = () => ({ wait: true, direction: 0, strength: 0, up: 0, down: 0, total: 0, drivers: [], proxy: false, decisionTs: now, durationSec: null, duration: null, manual: false, lifetime: null, playbook: null, vetoes: [], reasons: [], factors: {}, patterns: [], provisional: false, minStrength: cfg.SCORE_MIN, marketClass: marketClass(symbol),   bucket: null, record: null, verdicts: [], setup: null, regime: null, momentum: null, families: null, votes: [], mode: cfg.CONFLUENCE_MODE });
    const fam = cfg.CONFLUENCE_MODE === 'families';
    const fail = (why, kind = VERDICT.DATA) => { const o = blank(); o.vetoes.push(why); o.reason = why; if (fam) o.verdicts.push({ kind, reason: why }); return o; };
  if (!prices.length) return fail('no ticks');
  const n = epochs.filter((e) => e <= now).length;
  prices = prices.slice(0, n); epochs = epochs.slice(0, n);
  const stat = statRegime(prices, epochs, cfg.EWMA_LAMBDA);
  if (!stat) return fail('warming up: not enough ticks');
  if (fam) {
    for (let i = Math.max(1, epochs.length - 600); i < epochs.length; i++) if (!(epochs[i] >= epochs[i - 1])) return fail('tick timestamps inconsistent (non-monotonic)');
    if (!(stat.sigma2PerSec > 0) || !Number.isFinite(stat.sigma2PerSec)) return fail('volatility estimate unavailable');
    if (wallNow != null && wallNow - epochs.at(-1) > cfg.STALE_TICK_MS / 1000) return fail(`no ticks for ${Math.round(wallNow - epochs.at(-1))}s`);
  }
  lap('slice+stat');
  const allow = allowed || D.allowedDurations(null, stat.tickSecs, cfg, () => true);
  const cls = marketClass(symbol);

  const manualD = manualKey ? allow.find((d) => keyOf(d) === manualKey) || null : null;
  const fixedD = cfg.DURATION_MODE === 'fixed' ? D.fixedDuration(allow, cfg).duration : null;
  const bucket0 = manualD ? D.bucketOf(manualD.secs, cfg) : fixedD ? D.bucketOf(fixedD.secs, cfg) : cfg.DEFAULT_BUCKET;

  function analyse(bucket) {
    const roles = cfg.ROLES[bucket], out = blank();
    out.bucket = bucket; out.roles = roles;
    const wait = (why, kind = /^(warming|ATR)/.test(why) ? VERDICT.DATA : null) => { out.vetoes.push(why); out.reason = why; if (fam && kind) out.verdicts.push({ kind, reason: why }); return out; };
    const names = [...new Set([roles.trigger, roles.setup, roles.context, roles.bias, 'H1'])];
    const raw = buildFrames({ remote, prices, epochs, decisionEpoch: now, cfg, names, formingSecs: cfg.FRAMES[roles.trigger] });
    const frames = { trigger: raw[roles.trigger], setup: raw[roles.setup], context: raw[roles.context], bias: raw[roles.bias], H1: raw.H1, forming: raw.forming };
    lap('frames');
    for (const [k, need] of Object.entries(MIN_BARS)) if (frames[k].length < need) return wait(`warming up: ${roles[k]} ${frames[k].length}/${need} candles`);
    const price = prices.at(-1), atr = frames.setup.at(-1).atr, trigSecs = cfg.FRAMES[roles.trigger];
    if (!(atr > 0)) return wait('ATR unavailable');
    if (fam && now - (frames.trigger.at(-1).epoch + trigSecs) > cfg.CANDLE_STALE_BARS * trigSecs) return wait(`candle history stale: last closed ${roles.trigger} candle ${Math.round(now - frames.trigger.at(-1).epoch)}s old`, VERDICT.DATA);
    const zones = buildZones(frames, cfg, roles), spikeInfo = spikeContext(symbol, frames, prices, epochs, cfg, stat.tickSecs);
    lap('zones+spike');
    const factors = runFactors({ frames, cfg, stat, zones, price, atr, symbol, spikeInfo });
    lap('factors');
    out.factors = factors;
    if (logPatterns) out.patterns = [...runPatterns(frames.trigger, frames.trigger.length - 1, cfg), ...runPatterns(frames.setup, frames.setup.length - 1, cfg)];

    lap('patterns');
    const noiseTrig = expectedMove(stat.sigmaPerSec, trigSecs);
    const flowF = factors.tickFlow, ctx = { frames, cfg, zones, atr, price, flow: { avgN: 0 }, names: roles };
    const m5 = structureState(frames.setup), m15 = structureState(frames.context), a5 = adx(frames.setup), a15 = adx(frames.context);
    const ep = emaPos(frames.setup, atr), brk = breakoutState(frames.setup, zones, cfg), sweep = liquiditySweep(frames.setup, cfg);
    const trending = a5.adx >= cfg.ADX_TREND && stat.hurst > 0.5;
    const biasSlope = frames.bias.length > 25 ? Math.sign(emaSlope(frames.bias.map((c) => c.close), 20, 3)) : 0;
    const near = zonesNear(zones, price, atr);

    const cands = [];
    const add = (dir, playbook, loc, str, trig, why, bestZ) => cands.push({ dir, playbook, loc, str, trig: trig.score, trigR: trig.reasons, prov: trig.provisional, pattern: trig.pattern || null, why, zone: bestZ || null });
    for (const dir of [1, -1]) {
      let tCache = null;
      const trig = () => tCache || (tCache = [triggerFor(dir, 'trigger', ctx), triggerFor(dir, 'setup', ctx)].sort((a, b) => b.score - a.score)[0]);
      const support = near.filter((z) => supportiveKinds(dir).includes(z.kind));
      const bestZ = support.sort((a, b) => b.strength + b.overlap - (a.strength + a.overlap))[0];
      const locScore = bestZ ? Math.min(1, 0.5 + 0.1 * bestZ.touches + 0.15 * bestZ.overlap + (bestZ.fresh ? 0.1 : 0)) : 0;
      if (cfg.playbooks.trending && trending && m5.trend === dir && m15.trend !== -dir) {
        const pull = ep && (dir > 0 ? ep.dist <= 0.5 && ep.dist >= -1 : ep.dist >= -0.5 && ep.dist <= 1);
        const loc = Math.max(locScore, pull ? 0.6 : 0);
        if (loc > 0) add(dir, 'trending pullback', loc, m15.trend === dir ? 1 : 0.7, trig(), `${dir > 0 ? 'uptrend' : 'downtrend'} pullback to ${bestZ ? bestZ.tf + ' ' + bestZ.kind : 'EMA20'}, structure intact`, bestZ);
      }
      if (cfg.playbooks.ranging && !trending && bestZ && ['support', 'demand', 'resistance', 'supply'].includes(bestZ.kind)) {
        const osc = [factors.rsi, factors.stoch, factors.cci].filter((f) => f && f.vote === dir).length;
        if (osc > 0 || flowF?.absorption || sweep.direction === dir) add(dir, 'range fade', locScore, 0.5 + 0.15 * osc, trig(), `fade ${bestZ.kind} edge${osc ? ', oscillator extreme' : ''}${flowF?.absorption ? ', absorption' : ''}`, bestZ);
      }
      if (cfg.RANGE_FADE_EXP && bestZ && ['support', 'demand', 'resistance', 'supply'].includes(bestZ.kind) && rangeFadeExp({ adxVal: a5.adx, dir, zone: bestZ, price, candle: frames.setup.at(-1), cfg }).ok) add(dir, 'range fade exp', locScore, 0.5, trig(), 'experimental fade: ADX low, price at zone edge, rejection wick', bestZ);
      if (cfg.playbooks.breakout && brk.state === 'confirmed' && brk.direction === dir) add(dir, 'breakout', 0.8, m5.bos === dir || m5.choch === dir ? 1 : 0.6, { score: 0.7, reasons: [brk.reason], provisional: false }, brk.reason, brk.zone);
      if (brk.state === 'fakeout' && brk.direction === dir) add(dir, 'fakeout reversal', 0.7, 0.6, { score: 0.7, reasons: [brk.reason], provisional: false }, brk.reason, brk.zone);
      if (sweep.present && sweep.direction === dir) add(dir, 'liquidity sweep', 0.7, 0.6, { score: 0.7, reasons: [sweep.reason], provisional: false }, sweep.reason);
    }
    if (!cands.length) return wait(near.length ? 'no playbook conditions met' : 'no zone context: no trade');

    // expected lifetime -> contract duration for each candidate
    for (const c of cands) {
      const room = roomToRun(zones, price, c.dir), a = Number.isFinite(room) && room > 0 ? room : null;
      const zb = c.zone && supportiveKinds(c.dir).includes(c.zone.kind) ? (c.dir > 0 ? price - c.zone.low : c.zone.high - price) : NaN;
      const b = zb > 0 ? zb : cfg.INVALIDATION_ATR * atr;
      const kalMu = stat.kalVelPerSec * c.dir;
      const emaMu = frames.trigger.length > 25 ? (emaSlope(frames.trigger.map((x) => x.close), 20, 3) / trigSecs) * c.dir : NaN;
      const mu = Number.isFinite(kalMu) ? kalMu : emaMu;
      const trendOn = !!cfg.factors.mtfTrend?.enabled && factors.mtfTrend?.vote === c.dir && mu > 0;
      const mult = cfg.PATTERN_MULTIPLE.byPattern[c.pattern] ?? cfg.PATTERN_MULTIPLE.byPlaybook[c.playbook] ?? cfg.PATTERN_MULTIPLE.default;
      const s2 = stat.sigma2PerSec;
      const rawE = {
        E1: D.e1(a, b, s2), E2: D.e2(a, s2), E3: D.e3(a, mu, trendOn), E4: D.e4(stat.halfLifeSec, cfg.OU_FRACTION), E5: D.e5(mult, trigSecs),
        E6: spikeInfo ? D.e6(spikeInfo.meanSecs, spikeInfo.sinceSecs, spikeInfo.intensity, cfg) : null,
      };
      const L = D.lifetime({ raw: rawE, playbook: c.playbook, marketClass: cls, triggerSecs: trigSecs, cfg });
      let snap, manual = false;
      if (manualD) { snap = { duration: manualD, reason: null }; manual = true; }
      else if (cfg.DURATION_MODE === 'fixed') snap = D.fixedDuration(allow, cfg);
      else snap = D.snapDuration(L.lifetime, allow, cfg);
      c.life = { ...L, a, b, target: a == null ? null : price + c.dir * a, invalid: price - c.dir * b, duration: snap.duration, waitReason: snap.reason, manual, mode: cfg.DURATION_MODE };
      c.T = snap.duration ? snap.duration.secs : (L.lifetime ?? cfg.DEFAULT_DURATION_S);
    }

    const W = cfg.weights;
    for (const c of cands) {
      const move = expectedMove(stat.sigmaPerSec, c.T);
      const flowS = flowF ? (flowF.vote === c.dir ? 1 : flowF.vote === 0 ? 0.4 : 0) : 0.4;
      const room = roomToRun(zones, price, c.dir);
      const rrMode = cfg.DURATION_MODE === 'lifetime' && cfg.ROOM_CHECK === 'rr' && !c.life.manual;
      let roomOk, roomWhy = 'no room to run vs expected move over the contract duration';
      if (rrMode) {
        const { a, b } = c.life, unit = Math.sqrt(stat.sigma2PerSec * trigSecs);
        roomOk = a == null || (a / b >= cfg.RR_MIN && a >= cfg.MIN_TARGET_MOVE * unit);
        if (!roomOk) roomWhy = a / b < cfg.RR_MIN ? `reward/risk ${(a / b).toFixed(2)} < RR_MIN ${cfg.RR_MIN}` : `target < ${cfg.MIN_TARGET_MOVE} sigma`;
      } else roomOk = !Number.isFinite(move) || room >= cfg.ROOM_FACTOR * move;
      const timing = !Number.isFinite(move) ? 0.5 : Math.min(1, Number.isFinite(room) ? room / (2 * Math.max(move, 1e-12)) : 1);
      Object.assign(c, { flowS, roomOk, roomWhy, timing, move });
      c.score = W.location * c.loc + W.structure * (c.str - (biasSlope === -c.dir ? 0.15 : 0)) + W.trigger * c.trig + W.flow * flowS + W.timing * timing;
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands[0], dir = top.dir, vetoes = [], T = top.T;
    const ag = agreeCount(factors, dir);

    if (top.life.waitReason && !top.life.manual) vetoes.push(top.life.waitReason);
    if (top.playbook !== 'breakout' && top.playbook !== 'range fade' && top.playbook !== 'range fade exp' && m15.trend === -dir && a15.adx >= cfg.ADX_TREND) {
      const htf = near.some((z) => z.tf !== roles.setup || z.overlap > 0);
      if (!(top.playbook === 'fakeout reversal' || (m5.choch === dir && htf))) vetoes.push('context frame strongly opposes');
    }
    const last = frames.setup.at(-1);
    if (last.patternOk && PATTERNS.doji(frames.setup, frames.setup.length - 1, cfg).present && !near.length) vetoes.push('mid-range doji');
    if (!top.roomOk) vetoes.push(top.roomWhy);
    out.zoneMid = top.zone?.mid ?? null;
    const brkF = top.playbook === 'breakout' ? breakoutFilters({ cs: frames.setup, zone: top.zone, dir, atr, prices, epochs, zones, price, cfg }) : null;
    if (brkF) for (const k of failedFilters(brkF, cfg.BREAKOUT_FILTERS)) vetoes.push('breakout filter ' + k + ': ' + brkF[k].reason);
    const roomN = roomChecks({ move: top.move, room: roomToRun(zones, price, dir), atr, price, dir, target: top.life.target, invalid: top.life.invalid, cfg });
    { const opp = zones.filter((z) => (dir > 0 ? z.low > price : z.high < price) && ['resistance', 'supply', 'support', 'demand'].includes(z.kind)).sort((a, b) => (dir > 0 ? a.low - b.low : b.high - a.high))[0];
      out.roomInfo = { text: roomN.text, fired: roomN.fired, sigmaT: top.move, price, dir, zone: opp ? { low: opp.low, high: opp.high } : null, lifetimeDerived: cfg.DURATION_MODE === 'lifetime' }; }
    if (cfg.ROOM_NAMED && roomN.fired) vetoes.push('room check ' + roomN.fired + ': ' + roomN.checks.find((c) => c.name === roomN.fired).text);
    const lastC = frames.setup.at(-1), volF = volatilityFilter({ rangeATR: lastC?.rangeATR, adxVal: a5.adx, momentumAligned: ep ? Math.sign(ep.dist) === dir : false, cfg });
    if (cfg.VOL_FILTER) { if (volF.high && !volF.allow) vetoes.push(volF.label); }
    else if (ep && Math.abs(ep.dist) > cfg.MAX_CHASE_ATR && Math.sign(ep.dist) === dir) vetoes.push(`chasing: ${Math.abs(ep.dist).toFixed(1)} ATR from EMA20`);
    const zone = near.find((z) => supportiveKinds(dir).includes(z.kind));
    if (zone && Number.isFinite(noiseTrig)) { const inval = dir > 0 ? price - zone.low : zone.high - price; if (inval >= 0 && inval < cfg.NOISE_FACTOR * noiseTrig) vetoes.push('invalidation inside trigger-frame noise'); }
    if (spikeInfo) {
      if (spikeInfo.sinceSecs <= cfg.SPIKE_COOLDOWN_T_FRAC * T) vetoes.push('spike cooldown');
      if (spikeInfo.due && spikeInfo.spikeDir && dir === -spikeInfo.spikeDir) vetoes.push('spike due against trade direction');
    }
    if (brk.state === 'fakeout' && brk.direction === -dir && top.playbook === 'breakout') vetoes.push('fakeout/trap against break');
    if (top.playbook === 'trending pullback' && flowF?.absorption) vetoes.push('absorption against continuation');
    if (!fam && ag.total && (dir > 0 ? ag.up : ag.down) < cfg.AGREE_MIN) vetoes.push(`only ${dir > 0 ? ag.up : ag.down} factors agree (need ${cfg.AGREE_MIN})`);
    let finalScore = top.score;
    const verdicts = out.verdicts;
    if (fam) {
      const vd = (kind, reason) => { vetoes.push(reason); verdicts.push({ kind, reason }); };
      const regime = regimeOf({ adxRes: a5, hurst: stat.hurst, volRatio: null, cusum: stat.cusum, cfg });
      const momentum = momentumReading({ frames, prices, epochs, now, cfg, stat, T, trigSecs });
      const fv = familyVotes({ factors, regime, momentum, setupCandles: frames.setup, cfg });
      const agr = agreement(fv.families, dir, cfg);
      const tframes = { ...frames, setupSecs: cfg.FRAMES[roles.setup] };
      const extreme = oscillatorExtreme({ dir, candles: frames.trigger, trigSecs, cfg }) || zoneTouchExtreme({ candles: frames.trigger, zone: top.zone, trigSecs, cfg });
      const turn = confirmedTurn({ dir, frames: tframes, prices, epochs, trigSecs, zones, atr, extreme, cfg });
      const oscTxt = extreme && extreme.kind === 'oscillator' ? extreme.reason : null;
      const gate = momentumGate({ momentum, dir, playbook: top.playbook, turn, oscReading: oscTxt, cfg });
      const counter = cfg.COUNTER_TREND.includes(top.playbook);
      if (regime.type === 'unknown') vd(VERDICT.DATA, `regime: ${regime.reason}`);
      if (agr.dataWait) vd(VERDICT.DATA, agr.dataWait);
      else for (const r of agr.reasons) vd(VERDICT.REJECTED, r);
      if (gate.verdict) vd(gate.verdict.kind, gate.verdict.reason);
      if (counter && !turn.confirmed && !gate.verdict) vd(VERDICT.DELAYED, `${top.playbook} needs a confirmed turn: ${turn.reason}`);
      const trigName = top.pattern || (top.playbook === 'breakout' ? 'breakout' : top.playbook === 'fakeout reversal' ? 'fakeout' : top.playbook === 'liquidity sweep' ? 'sweep' : null);
      const entryTrigger = trigName || (counter && turn.confirmed ? turn.trigger : null);
      if (cfg.REQUIRE_TRIGGER && !entryTrigger) vd(VERDICT.DELAYED, 'no configured trigger has fired yet');
      finalScore = Math.max(0, top.score + gate.scoreDelta);
      Object.assign(out, {
        regime, momentum: { ...momentum, state: gate.state, scoreDelta: gate.scoreDelta, opposes60s: opposesRecentMove(momentum.ret60z, dir, cfg) }, families: fv.families, votes: fv.votes, familyAgreement: agr,
        entry: { playbook: top.playbook, trigger: entryTrigger, counterTrend: counter, extreme: extreme && { ts: extreme.ts, kind: extreme.kind, reason: extreme.reason }, turn },
      });
    }
    if (finalScore < cfg.SCORE_MIN) { vetoes.push(`score ${finalScore.toFixed(2)} < ${cfg.SCORE_MIN}`); if (fam) verdicts.push({ kind: VERDICT.REJECTED, reason: vetoes.at(-1) }); }
    if (fam) for (const v of vetoes) if (!verdicts.some((x) => x.reason === v)) verdicts.push({ kind: VERDICT.REJECTED, reason: v });

    const d = top.life.duration;
    Object.assign(out, {
      direction: dir, strength: Math.min(1, finalScore), up: ag.up, down: ag.down, total: ag.total, drivers: ag.drivers.slice(0, 4), playbook: top.playbook, provisional: top.prov, vetoes,
      candidateScores: cands.map((c) => ({ direction: c.dir, playbook: c.playbook, score: c === top ? finalScore : c.score })),
      reasons: [top.why, ...top.trigR], score: finalScore, parts: { location: top.loc, structure: top.str, trigger: top.trig, flow: top.flowS, timing: top.timing },
      lifetime: top.life, duration: d ? { unit: d.unit, n: d.n, secs: d.secs, key: keyOf(d) } : null, durationSec: d ? d.secs : null, manual: top.life.manual,
      decisionPrice: price, sigmaT: expectedMove(stat.sigmaPerSec, T), invalid: top.life.invalid, target: top.life.target, candleId: frames.trigger.at(-1).epoch,
    });
    if (fam) {
      const q = !verdicts.some((v) => v.kind === VERDICT.REJECTED || v.kind === VERDICT.DATA), delayed = verdicts.filter((v) => v.kind === VERDICT.DELAYED);
      out.setup = { dir, playbook: top.playbook, qualifies: q, triggered: q && !delayed.length, trigger: out.entry.trigger, delayReason: delayed.map((v) => v.reason).join('; ') || null };
    }
    out.wait = vetoes.length > 0;
    out.reason = out.wait ? vetoes.join('; ') : `${top.playbook}: ${top.why}`;
    if (d && top.life.target != null) {
      const sd = [d, ...D.neighbours(allow, d)].map((x) => ({ unit: x.unit, n: x.n, key: keyOf(x) }));
      out.record = { filters: { breakout: brkF, room: roomN, vol: volF }, symbol, playbook: top.playbook, dir, at: now, entry: price, target: top.life.target, invalid: top.life.invalid, predicted: top.life.lifetime, estimators: top.life.estimators, durSec: d.secs, durKey: keyOf(d), shadowDs: sd, bucket, manual: top.life.manual,
        features: { price, atr, adx: a5.adx, adxCtx: a15.adx, sigmaPerSec: stat.sigmaPerSec, sigma2PerSec: stat.sigma2PerSec, hurst: stat.hurst, halfLifeSec: stat.halfLifeSec, a: top.life.a, b: top.life.b, score: finalScore, strength: Math.min(1, finalScore), trigSecs, wait: out.wait,
          emaDist: ep ? ep.dist * dir : null, wickAgainst: wickAgainst(last, dir), flowProxy: tickFlowProxy(prices, dir), flowLabel: 'proxy', momentum: shortMomentum(prices, dir), tauTicks: d.unit === 't' ? d.n : d.secs / Math.max(1e-9, (epochs.at(-1) - epochs[Math.max(0, epochs.length - 201)]) / Math.min(200, epochs.length - 1)) } };
    }
    return out;
  }

  let res = analyse(bucket0);
  lap('analyse-rest');
  if (res.duration && D.bucketOf(res.duration.secs, cfg) !== bucket0) res = analyse(D.bucketOf(res.duration.secs, cfg));
  return res;
}
