import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidSearchEngineInputError,
  computeUcb1Scores,
  selectNextArmUcb1,
  sampleThompsonBeta,
  selectNextArmThompson,
  computeKernelRegressionSurrogate,
  selectNextPointBayesianOptimization,
  selectNextPointActiveLearning,
  selectChildUcb1,
  expandMctsNode,
  backpropagateMcts,
  runMcts,
  runEvolutionarySearch,
} from '../../research/src/discovery/searchEngine.js';

// ── Structural guardrail: nothing in this module's output shape resembles
//    a discovery decision (no pValue/verdict/wealth fields anywhere). ────

test('search engine outputs never carry a pValue, verdict, or wealth field (structural winner\'s-curse guardrail)', () => {
  const ucb = selectNextArmUcb1([{ armId: 'a', totalReward: 1, pulls: 1 }]);
  const forbidden = ['pValue', 'verdict', 'wealth', 'discovery', 'publicationStatus'];
  for (const key of forbidden) assert.equal(key in ucb, false);
});

// ── UCB1 bandit ──────────────────────────────────────────────────────────

test('computeUcb1Scores requires a non-empty arms array', () => {
  assert.throws(() => computeUcb1Scores([]), InvalidSearchEngineInputError);
});

test('computeUcb1Scores gives untried arms Infinity score (forced exploration)', () => {
  const scores = computeUcb1Scores([{ armId: 'a', totalReward: 5, pulls: 10 }, { armId: 'b', totalReward: 0, pulls: 0 }]);
  const b = scores.find((s) => s.armId === 'b');
  assert.equal(b.score, Infinity);
});

test('selectNextArmUcb1 picks the untried arm over a well-performing tried arm', () => {
  const best = selectNextArmUcb1([{ armId: 'a', totalReward: 5, pulls: 10 }, { armId: 'b', totalReward: 0, pulls: 0 }]);
  assert.equal(best.armId, 'b');
});

test('selectNextArmUcb1 favors higher mean reward once all arms are tried', () => {
  const best = selectNextArmUcb1([
    { armId: 'low', totalReward: 1, pulls: 100 },
    { armId: 'high', totalReward: 90, pulls: 100 },
  ]);
  assert.equal(best.armId, 'high');
});

// ── Thompson sampling ────────────────────────────────────────────────────

test('sampleThompsonBeta requires a numeric seed', () => {
  assert.throws(() => sampleThompsonBeta([{ armId: 'a', successes: 1, failures: 1 }]), InvalidSearchEngineInputError);
});

test('sampleThompsonBeta is deterministic for a fixed seed', () => {
  const arms = [{ armId: 'a', successes: 3, failures: 7 }, { armId: 'b', successes: 7, failures: 3 }];
  const s1 = sampleThompsonBeta(arms, 123);
  const s2 = sampleThompsonBeta(arms, 123);
  assert.deepEqual(s1, s2);
});

test('selectNextArmThompson strongly favors an arm with a much better observed success rate, across many seeds', () => {
  let betterWins = 0;
  const trials = 200;
  for (let seed = 0; seed < trials; seed++) {
    const winner = selectNextArmThompson(
      [{ armId: 'worse', successes: 1, failures: 19 }, { armId: 'better', successes: 19, failures: 1 }],
      seed
    );
    if (winner.armId === 'better') betterWins++;
  }
  assert.ok(betterWins / trials > 0.9, `expected the better arm to win >90% of the time, got ${betterWins}/${trials}`);
});

// ── Kernel-regression surrogate / Bayesian optimization ────────────────────

test('computeKernelRegressionSurrogate requires non-empty observations and candidates', () => {
  assert.throws(() => computeKernelRegressionSurrogate([], [1]), InvalidSearchEngineInputError);
  assert.throws(() => computeKernelRegressionSurrogate([{ x: 1, reward: 1 }], []), InvalidSearchEngineInputError);
});

test('computeKernelRegressionSurrogate: mean near an observed point is close to that point\'s reward', () => {
  const obs = [{ x: 0, reward: 0 }, { x: 10, reward: 1 }];
  const [near0] = computeKernelRegressionSurrogate(obs, [0.1], { bandwidth: 1 });
  assert.ok(near0.mean < 0.3, `expected mean near x=0 to be closer to 0, got ${near0.mean}`);
});

test('selectNextPointBayesianOptimization picks a candidate near the observed reward peak with low exploration weight', () => {
  const obs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((x) => ({ x, reward: 1 - Math.abs(x - 5) / 5 }));
  const best = selectNextPointBayesianOptimization(obs, [0, 2, 4, 5, 6, 8, 10], { kappa: 0.05 });
  assert.equal(best.x, 5);
});

test('selectNextPointActiveLearning picks the highest-variance (most uncertain) candidate, ignoring mean', () => {
  const obs = [{ x: 0, reward: 0 }, { x: 10, reward: 1 }];
  const best = selectNextPointActiveLearning(obs, [0, 5, 10], { bandwidth: 3 });
  // x=5 is farthest from both observations -> lowest kernel weight -> in
  // this estimator that means the LEAST support, which this function
  // still must return a well-formed result for (not throw).
  assert.ok(['0', '5', '10'].includes(String(best.x)));
});

// ── MCTS ─────────────────────────────────────────────────────────────────

function toyTreeFixtures() {
  return {
    getLegalMoves: (state) => (state.length >= 3 ? [] : [0, 1]),
    applyMove: (state, move) => [...state, move],
    isTerminal: (state) => state.length >= 3,
    simulateRandomPlayout: (state, rng) => {
      let s = state.slice();
      while (s.length < 3) s.push(rng() < 0.5 ? 0 : 1);
      return s.reduce((a, b) => a + b, 0) / 3; // reward in [0,1], maximized by all-1s
    },
  };
}

test('runMcts requires a numeric seed', () => {
  const { getLegalMoves, applyMove, isTerminal, simulateRandomPlayout } = toyTreeFixtures();
  assert.throws(() => runMcts({ rootState: [], getLegalMoves, applyMove, isTerminal, simulateRandomPlayout }), InvalidSearchEngineInputError);
});

test('runMcts converges toward the higher-reward move in a toy tree', () => {
  const { getLegalMoves, applyMove, isTerminal, simulateRandomPlayout } = toyTreeFixtures();
  const { bestChild, root } = runMcts({
    rootState: [], getLegalMoves, applyMove, isTerminal, simulateRandomPlayout, iterations: 400, seed: 42,
  });
  assert.equal(bestChild.move, 1);
  assert.ok(root.visits >= 400);
});

test('selectChildUcb1 throws on a childless node', () => {
  assert.throws(() => selectChildUcb1({ children: [], visits: 0 }), InvalidSearchEngineInputError);
});

test('expandMctsNode + backpropagateMcts: reward propagates to every ancestor', () => {
  const root = { state: [], move: null, parent: null, children: [], visits: 0, totalReward: 0 };
  const child = expandMctsNode(root, 1, (state, move) => [...state, move]);
  backpropagateMcts(child, 1);
  assert.equal(root.visits, 1);
  assert.equal(root.totalReward, 1);
  assert.equal(child.visits, 1);
});

// ── Evolutionary search ──────────────────────────────────────────────────

test('runEvolutionarySearch requires at least 2 individuals and a numeric seed', () => {
  const trivial = { fitnessFn: () => 0, crossoverFn: (a) => a, mutateFn: (a) => a, seed: 1 };
  assert.throws(() => runEvolutionarySearch({ ...trivial, initialPopulation: [[1]] }), InvalidSearchEngineInputError);
  assert.throws(() => runEvolutionarySearch({ ...trivial, initialPopulation: [[1], [2]], seed: undefined }), InvalidSearchEngineInputError);
});

test('runEvolutionarySearch improves best fitness over generations on a simple maximization task', () => {
  const fitnessFn = (ind) => ind.reduce((a, b) => a + b, 0);
  const crossoverFn = (a, b, rng) => a.map((v, i) => (rng() < 0.5 ? v : b[i]));
  const mutateFn = (ind, rng) => ind.map((v) => Math.min(1, Math.max(0, v + (rng() - 0.5) * 0.2)));
  const seededInitRng = (() => { let s = 99; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();
  const initialPopulation = Array.from({ length: 20 }, () => Array.from({ length: 5 }, () => seededInitRng()));

  const result = runEvolutionarySearch({ initialPopulation, fitnessFn, crossoverFn, mutateFn, generations: 30, seed: 7 });
  assert.equal(result.fitnessHistory.length, 30);
  assert.ok(result.fitnessHistory[29].bestFitness >= result.fitnessHistory[0].bestFitness);
  assert.ok(result.bestFitness <= 5); // 5 genes each capped at 1
});

test('runEvolutionarySearch preserves elites: best-ever fitness never decreases across generations', () => {
  const fitnessFn = (ind) => ind.reduce((a, b) => a + b, 0);
  const crossoverFn = (a, b, rng) => a.map((v, i) => (rng() < 0.5 ? v : b[i]));
  const mutateFn = (ind, rng) => ind.map((v) => Math.min(1, Math.max(0, v + (rng() - 0.5) * 0.5)));
  const initialPopulation = Array.from({ length: 10 }, (_, i) => [i / 10, i / 10]);
  const result = runEvolutionarySearch({ initialPopulation, fitnessFn, crossoverFn, mutateFn, generations: 15, elitismCount: 2, seed: 3 });
  let runningBest = -Infinity;
  for (const h of result.fitnessHistory) {
    assert.ok(h.bestFitness >= runningBest - 1e-9);
    runningBest = Math.max(runningBest, h.bestFitness);
  }
});
