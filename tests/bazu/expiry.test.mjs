import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normCdf, expiryProbBaseline, sigmaPerTick, fitPlatt, applyPlatt, reliabilityCurve, compareModels, brier, logLoss, liveContractText, tickFlowProxy, fitLogistic, predictLogistic, featuresComplete } from '../../src/bazu/expiry3m.js';
import { EXPIRY_MODEL } from '../../src/bazu/expiryModel3m.js';
import { configFor } from '../../src/bazu/config3m.js';

const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('normal CDF matches known values', () => { near(normCdf(0), 0.5); near(normCdf(1), 0.841345); near(normCdf(-1.96), 0.024998); near(normCdf(0.5), 0.691462); });

test('analytic expiry probability matches hand-computed values', () => {
  // lead 1, sigma 1, tau 4 -> Phi(1 / (1*2)) = Phi(0.5)
  near(expiryProbBaseline({ dir: 1, spot: 101, entry: 100, tau: 4, sigma: 1 }), 0.691462);
  near(expiryProbBaseline({ dir: -1, spot: 101, entry: 100, tau: 4, sigma: 1 }), 0.308538); // Fall mirrors
  near(expiryProbBaseline({ dir: 1, spot: 100, entry: 100, tau: 10, sigma: 2 }), 0.5); // about 50% at entry
  near(expiryProbBaseline({ dir: 1, spot: 100, entry: 100, tau: 4, sigma: 1, mu: 0.5 }), normCdf(1)); // with drift: (0 + 0.5*4)/2
  assert.equal(expiryProbBaseline({ dir: 1, spot: 100, entry: 100, tau: 0, sigma: 1 }), 0); // a tie loses
  assert.equal(expiryProbBaseline({ dir: 1, spot: 100.1, entry: 100, tau: 0, sigma: 1 }), 1);
});

test('missing or invalid inputs return null, never a made-up probability', () => {
  assert.equal(expiryProbBaseline({ dir: 1, spot: 1, entry: 1, tau: 3, sigma: null }), null);
  assert.equal(expiryProbBaseline({ dir: 1, spot: NaN, entry: 1, tau: 3, sigma: 1 }), null);
  assert.equal(expiryProbBaseline({ dir: 1, spot: 1, entry: 1, tau: 3, sigma: 0 }), null);
  assert.equal(sigmaPerTick([1, 2, 3]), null);
});

test('sigmaPerTick equals the standard deviation of the tick changes', () => {
  const p = [100]; for (let i = 1; i <= 100; i++) p.push(p[i - 1] + (i % 2 ? 1 : -1));
  near(sigmaPerTick(p, 100), 1, 0.02);
});

test('reliability curve counts every observation and keeps empty bins visible', () => {
  const probs = [0.05, 0.1, 0.55, 0.58, 0.95], ys = [0, 0, 1, 0, 1];
  const c = reliabilityCurve(probs, ys, 5);
  assert.equal(c.length, 5); assert.equal(c.reduce((s, r) => s + r.n, 0), 5);
  assert.equal(c[1].n, 0); assert.equal(c[1].observed, null);
  assert.equal(c[2].n, 2); near(c[2].observed, 0.5);
  assert.equal(c[4].n, 1);
});

test('Platt scaling recovers a known miscalibration on constructed data', () => {
  let s = 7; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const probs = [], ys = [];
  for (let i = 0; i < 6000; i++) { const p = 0.1 + 0.8 * rnd(), lg = Math.log(p / (1 - p)), truth = 1 / (1 + Math.exp(-2 * lg)); probs.push(p); ys.push(rnd() < truth ? 1 : 0); }
  const pl = fitPlatt(probs, ys);
  assert.ok(pl.a > 1.7 && pl.a < 2.3, `slope ${pl.a}`); assert.ok(Math.abs(pl.c) < 0.2);
  assert.ok(brier(probs.map((p) => applyPlatt(pl, p)), ys) < brier(probs, ys));
});

test('Brier and log loss on constructed data; model comparison flags a better candidate', () => {
  near(brier([0.5, 0.5], [1, 0]), 0.25); near(logLoss([0.5, 0.5], [1, 0]), Math.log(2));
  const ys = [1, 1, 0, 0, 1, 0];
  const good = compareModels({ candidate: [0.9, 0.8, 0.2, 0.1, 0.7, 0.3], baseline: ys.map(() => 0.5), ys });
  assert.equal(good.beatsBaseline, true);
  const bad = compareModels({ candidate: [0.1, 0.2, 0.8, 0.9, 0.3, 0.7], baseline: ys.map(() => 0.5), ys });
  assert.equal(bad.beatsBaseline, false);
});

test('logistic regression separates a linearly separable toy set', () => {
  const X = [], y = []; for (let i = 0; i < 200; i++) { const v = (i - 100) / 50; X.push([v, 0]); y.push(v > 0 ? 1 : 0); }
  const m = fitLogistic(X, y, { l2: 0.1 }); assert.ok(predictLogistic(m, [1.5, 0]) > 0.9 && predictLogistic(m, [-1.5, 0]) < 0.1);
});

test('live contract wording is neutral: no advice, no Weak Signal, no High Accuracy; uncalibrated until N_MIN', () => {
  const a = liveContractText(0.62, { n: 10, nMin: 200 }), b = liveContractText(0.62, { n: 250, nMin: 200 }), c = liveContractText(null, null);
  assert.match(a, /^Live contract\. Expiry probability: 62% \(model estimate, uncalibrated/);
  assert.match(b, /calibrated on 250 outcomes/); assert.doesNotMatch(b, /uncalibrated/);
  for (const t of [a, b, c]) assert.doesNotMatch(t, /weak signal|high accuracy|hold|exit|close early|sell/i);
  for (const f of ['page.js', 'engine.js', 'decision.js']) assert.doesNotMatch(fs.readFileSync(new URL('../../src/bazu/' + f, import.meta.url), 'utf8').replace(/WEAK: 'weak signal'/, ''), /Weak Signal|High Accuracy/);
});

test('the learned model is behind a flag that is OFF by default and no model is shipped unless it beat the baseline', () => {
  assert.equal(configFor('R_100').EXPIRY_LEARNED, false); assert.equal(EXPIRY_MODEL, null);
});

test('tick-flow proxy is signed by direction and null without moves', () => {
  const up = [1, 2, 3, 4, 3, 4]; near(tickFlowProxy(up, 1), (4 - 1) / 5 === 0.6 ? 0.6 : 0.6); near(tickFlowProxy(up, -1), -0.6); assert.equal(tickFlowProxy([1, 1, 1], 1), null);
  assert.equal(featuresComplete({ atr: 1, price: 100, emaDist: 0, adx: 20, wickAgainst: 0.1, flowProxy: 0.1, momentum: 0, tauTicks: 5 }), true);
  assert.equal(featuresComplete({ atr: 1, price: 100, emaDist: null, adx: 20, wickAgainst: 0.1, flowProxy: 0.1, momentum: 0, tauTicks: 5 }), false);
});
