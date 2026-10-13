/**
 * src/bazu/predict3m.js  (pure)
 * BAZU 3-minute Rise/Fall prediction: rule-based playbooks (trend pullback / range fade / breakout),
 * context-validated candle patterns, weighted scoring and vetoes. No edge-validation or research gate.
 * Target: Rise wins if exit > entry, Fall wins if exit < entry (ties lose); entry = first tick after
 * purchase, exit = tick at expiry. Only CLOSED candles feed patterns; the forming M1 candle is
 * provisional and built only from ticks <= decisionEpoch.
 */
import { configFor, marketClass, spikeInterval, TARGET } from './config3m.js?v=14';
import { buildFrames } from './candles3m.js?v=14';
import { PATTERNS, runPatterns, fibPullback } from './patterns3m.js?v=14';
import { runFactors, structureState } from './factors3m.js?v=14';
import { statRegime, emaSlope, adx } from './ta3m.js?v=14';
import { buildZones, zonesNear, supportiveKinds, roomToRun, extendedMove, confirmed, breakoutState, liquiditySweep, expectedMove } from './context3m.js?v=14';

const MIN_BARS = { M1: 30, M5: 30, M15: 20 };

/** Spike context for Boom/Crash/Jump from closed M1 candles. bias = lean with the drift between spikes. */
export function spikeContext(symbol, frames, prices, epochs, cfg) {
  const cls = marketClass(symbol);
  if (cls !== 'boomcrash' && cls !== 'jump') return null;
  const m1 = frames.M1, lastSpike = [...m1].reverse().find((c) => c.spike);
  const cooling = m1.slice(-cfg.SPIKE_COOLDOWN - 1).some((c) => c.spike || c.cooling) && !!lastSpike && m1.at(-1).epoch - lastSpike.epoch <= 60 * cfg.SPIKE_COOLDOWN;
  const mean = spikeInterval(symbol);
  const since = lastSpike ? epochs.filter((e) => e > lastSpike.epoch).length : epochs.length;
  const dueFrac = mean ? since / mean : 0;
  const spikeDir = /^BOOM/i.test(symbol) ? 1 : /^CRASH/i.test(symbol) ? -1 : 0;
  const due = !!spikeDir && dueFrac >= cfg.SPIKE_DUE_FRAC;
  return { cooling, due, spikeDir, dueFrac, bias: spikeDir ? (due ? spikeDir : -spikeDir) : 0, reason: spikeDir ? `${spikeDir > 0 ? 'Boom' : 'Crash'}: ${(dueFrac * 100).toFixed(0)}% of mean spike interval elapsed${due ? ' (spike due)' : ''}` : `jump index, ${cooling ? 'in cooldown' : 'no cooldown'}` };
}

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

/** Context-validated trigger for direction `dir` on a candle frame. Pure of logging. */
export function triggerFor(dir, frameName, ctx) {
  const { frames, cfg, zones, atr, price, flow } = ctx, cs = frames[frameName];
  const res = { score: 0, reasons: [], provisional: false };
  if (cs.length < 8) return res;
  const avgN = flow?.avgN || 0;
  for (const back of [0, 1]) {
    const i = cs.length - 1 - back, c = cs[i];
    if (!c?.patternOk) continue;
    const near = zonesNear(zones, c.close, atr).filter((z) => supportiveKinds(dir).includes(z.kind) || z.kind === 'level');
    const ext = extendedMove(cs, i - 1, cfg);
    let conf = back === 1 ? confirmed(cs, i, dir, avgN) : false, prov = false;
    if (back === 0 && frames.forming && frameName === 'M1') {
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
        const m5 = structureState(frames.M5).trend, m15 = structureState(frames.M15).trend;
        if (!(m5 === dir && m15 !== -dir)) continue;
        const fb = fibPullback(frames.M5, frames.M5.length - 1, cfg);
        if (name !== 'fibPullback' && !(fb.present && fb.direction === dir)) continue;
      } else continue;
      const s = Math.min(1, p.strength * w);
      if (s > res.score) { res.score = s; res.reasons = [`${frameName} ${p.reason}${prov && back === 0 ? ' (provisional)' : ''}`]; res.provisional = prov && back === 0; }
    }
  }
  return res;
}

/** Main entry. Returns a prediction object compatible with decision.js (+ wait/reason/log fields). */
export function predict3m({ symbol, prices, epochs, remote = {}, decisionEpoch, overrides, logPatterns = true, durationSec = TARGET.durationSec }) {
  const cfg = configFor(symbol, overrides), now = decisionEpoch ?? epochs[epochs.length - 1];
  const out = { wait: true, direction: 0, strength: 0, up: 0, down: 0, total: 0, drivers: [], proxy: false, decisionTs: now, durationSec, playbook: null, vetoes: [], reasons: [], factors: {}, patterns: [], provisional: false, minStrength: cfg.SCORE_MIN, marketClass: marketClass(symbol) };
  const wait = (why) => { out.vetoes.push(why); out.reason = why; return out; };
  if (!prices.length) return wait('no ticks');
  const n = epochs.filter((e) => e <= now).length;
  prices = prices.slice(0, n); epochs = epochs.slice(0, n);
  const frames = buildFrames({ remote, prices, epochs, decisionEpoch: now, cfg });
  for (const [k, need] of Object.entries(MIN_BARS)) if (frames[k].length < need) return wait(`warming up: ${k} ${frames[k].length}/${need} candles`);
  const price = prices.at(-1), atr = frames.M5.at(-1).atr;
  if (!(atr > 0)) return wait('ATR unavailable');
  const stat = statRegime(prices, epochs), zones = buildZones(frames, cfg);
  const spikeInfo = spikeContext(symbol, frames, prices, epochs, cfg);
  const factors = runFactors({ frames, cfg, stat, zones, price, atr, symbol, spikeInfo });
  out.factors = factors;
  if (logPatterns) out.patterns = [...runPatterns(frames.M1, frames.M1.length - 1, cfg), ...runPatterns(frames.M5, frames.M5.length - 1, cfg)];

  if (spikeInfo?.cooling) return wait('spike cooldown');
  const move = expectedMove(stat?.sigmaPerSec, durationSec), noise1m = expectedMove(stat?.sigmaPerSec, 60);
  const flowF = factors.tickFlow, ctx = { frames, cfg, zones, atr, price, flow: { avgN: 0 } };
  const m5 = structureState(frames.M5), m15 = structureState(frames.M15), a5 = adx(frames.M5), a15 = adx(frames.M15);
  const ep = emaPos(frames.M5, atr), brk = breakoutState(frames.M5, zones, cfg), sweep = liquiditySweep(frames.M5, cfg);
  const trending = a5.adx >= cfg.ADX_TREND && stat && stat.hurst > 0.5;
  const h1Slope = frames.H1.length > 25 ? Math.sign(emaSlope(frames.H1.map((c) => c.close), 20, 3)) : 0;
  const near = zonesNear(zones, price, atr);

  const cands = [];
  const base = (dir, playbook, loc, str, trig, why) => cands.push({ dir, playbook, loc, str, trig: trig.score, trigR: trig.reasons, prov: trig.provisional, why });
  for (const dir of [1, -1]) {
    let tCache = null;
    const trig = () => tCache || (tCache = [triggerFor(dir, 'M1', ctx), triggerFor(dir, 'M5', ctx)].sort((a, b) => b.score - a.score)[0]);
    const support = near.filter((z) => supportiveKinds(dir).includes(z.kind));
    const bestZ = support.sort((a, b) => b.strength + b.overlap - (a.strength + a.overlap))[0];
    const locScore = bestZ ? Math.min(1, 0.5 + 0.1 * bestZ.touches + 0.15 * bestZ.overlap + (bestZ.fresh ? 0.1 : 0)) : 0;
    if (cfg.playbooks.trending && trending && m5.trend === dir && m15.trend !== -dir) {
      const pull = ep && (dir > 0 ? ep.dist <= 0.5 && ep.dist >= -1 : ep.dist >= -0.5 && ep.dist <= 1);
      const loc = Math.max(locScore, pull ? 0.6 : 0);
      if (loc > 0) base(dir, 'trending pullback', loc, m15.trend === dir ? 1 : 0.7, trig(), `${dir > 0 ? 'uptrend' : 'downtrend'} pullback to ${bestZ ? bestZ.tf + ' ' + bestZ.kind : 'EMA20'}, structure intact`);
    }
    if (cfg.playbooks.ranging && !trending && bestZ && ['support', 'demand', 'resistance', 'supply'].includes(bestZ.kind)) {
      const osc = [factors.rsi, factors.stoch, factors.cci].filter((f) => f && f.vote === dir).length;
      if (osc > 0 || flowF?.absorption || sweep.direction === dir) base(dir, 'range fade', locScore, 0.5 + 0.15 * osc, trig(), `fade ${bestZ.kind} edge${osc ? ', oscillator extreme' : ''}${flowF?.absorption ? ', absorption' : ''}`);
    }
    if (cfg.playbooks.breakout && brk.state === 'confirmed' && brk.direction === dir) base(dir, 'breakout', 0.8, m5.bos === dir || m5.choch === dir ? 1 : 0.6, { score: 0.7, reasons: [brk.reason], provisional: false }, brk.reason);
    if (brk.state === 'fakeout' && brk.direction === dir) base(dir, 'fakeout reversal', 0.7, 0.6, { score: 0.7, reasons: [brk.reason], provisional: false }, brk.reason);
    if (sweep.present && sweep.direction === dir) base(dir, 'liquidity sweep', 0.7, 0.6, { score: 0.7, reasons: [sweep.reason], provisional: false }, sweep.reason);
  }
  if (!cands.length) return wait(near.length ? 'no playbook conditions met' : 'no zone context: no trade');

  const W = cfg.weights;
  for (const c of cands) {
    const flowS = flowF ? (flowF.vote === c.dir ? 1 : flowF.vote === 0 ? 0.4 : 0) : 0.4;
    const room = roomToRun(zones, price, c.dir), roomOk = !Number.isFinite(move) || room >= cfg.ROOM_FACTOR * move;
    const timing = !Number.isFinite(move) ? 0.5 : Math.min(1, Number.isFinite(room) ? room / (2 * Math.max(move, 1e-12)) : 1);
    c.flowS = flowS; c.roomOk = roomOk; c.timing = timing;
    c.score = W.location * c.loc + W.structure * (c.str - (h1Slope === -c.dir ? 0.15 : 0)) + W.trigger * c.trig + W.flow * flowS + W.timing * timing;
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0], dir = top.dir, vetoes = [];
  const ag = agreeCount(factors, dir);

  if (top.playbook !== 'breakout' && top.playbook !== 'range fade' && m15.trend === -dir && a15.adx >= cfg.ADX_TREND) {
    const htf = near.some((z) => z.tf !== 'M5' || z.overlap > 0);
    if (!(top.playbook === 'fakeout reversal' || (m5.choch === dir && htf))) vetoes.push('M15 strongly opposes');
  }
  const m5d = frames.M5.at(-1);
  if (m5d.patternOk && PATTERNS.doji(frames.M5, frames.M5.length - 1, cfg).present && !near.length) vetoes.push('mid-range doji');
  if (!top.roomOk) vetoes.push('no room to run vs expected 3-minute move');
  if (ep && Math.abs(ep.dist) > cfg.MAX_CHASE_ATR && Math.sign(ep.dist) === dir) vetoes.push(`chasing: ${Math.abs(ep.dist).toFixed(1)} ATR from EMA20`);
  const zone = near.find((z) => supportiveKinds(dir).includes(z.kind));
  if (zone && Number.isFinite(noise1m)) { const inval = dir > 0 ? price - zone.low : zone.high - price; if (inval >= 0 && inval < cfg.NOISE_FACTOR * noise1m) vetoes.push('invalidation inside one-minute noise'); }
  if (spikeInfo?.due && spikeInfo.spikeDir && dir === -spikeInfo.spikeDir) vetoes.push('spike due against trade direction');
  if (brk.state === 'fakeout' && brk.direction === -dir && top.playbook === 'breakout') vetoes.push('fakeout/trap against break');
  if (top.playbook === 'trending pullback' && flowF?.absorption) vetoes.push('absorption against continuation');
  if (ag.total && (dir > 0 ? ag.up : ag.down) < cfg.AGREE_MIN) vetoes.push(`only ${dir > 0 ? ag.up : ag.down} factors agree (need ${cfg.AGREE_MIN})`);
  if (top.score < cfg.SCORE_MIN) vetoes.push(`score ${top.score.toFixed(2)} < ${cfg.SCORE_MIN}`);

  Object.assign(out, { direction: dir, strength: Math.min(1, top.score), up: ag.up, down: ag.down, total: ag.total, drivers: ag.drivers.slice(0, 4), playbook: top.playbook, provisional: top.prov, vetoes, reasons: [top.why, ...top.trigR], score: top.score, parts: { location: top.loc, structure: top.str, trigger: top.trig, flow: top.flowS, timing: top.timing } });
  out.wait = vetoes.length > 0;
  out.reason = out.wait ? vetoes.join('; ') : `${top.playbook}: ${top.why}`;
  return out;
}
