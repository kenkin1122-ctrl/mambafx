/**
 * research/src/discovery/searchEngine.js
 *
 * Purpose:
 *   Implement Phase 9 Requirement 1 — the Adaptive Scientific Search
 *   Engine compared and recommended in
 *   MambaFX_NextGen_Discovery_Engine_Architecture.md Section 3: multi-armed
 *   bandits (cross-family budget allocation), a Bayesian-optimization-style
 *   surrogate (continuous parameters within one feature family), active
 *   learning (interaction-space uncertainty sampling), Monte Carlo Tree
 *   Search (compositional feature generation), and evolutionary search
 *   (open-ended generation / multi-objective exploration).
 *
 * ABSOLUTE GOVERNING RULE (stated once, applies to every export in this
 *   file): every function here produces a RANKING, SCORE, or SELECTION —
 *   "look here next" — and NOTHING ELSE. No function in this module
 *   computes, returns, or resembles a p-value, an FDR wealth debit, a
 *   discovery verdict, or a publication status. That is exclusively
 *   Round 3/4's job (discoveryDecision.js / onlineFdr.js), reached only
 *   through the funnel (discovery/funnel.js). This is the "winner's curse"
 *   boundary named throughout every prior Phase 9 design document: a
 *   method below may rank a region as promising, but the actual statistic
 *   reported for anything that region produces is ALWAYS re-computed fresh
 *   by Round 3 on data this module never conditioned its ranking on.
 *
 * Randomness discipline: every stochastic method here (Thompson sampling,
 *   MCTS rollout, evolutionary mutation/crossover) takes a REQUIRED seed
 *   and reuses statistics/uncertaintyEstimation.js's createSeededRng — the
 *   same "no hidden randomness" rule permutationTest.js already follows,
 *   applied here rather than introducing a second PRNG implementation.
 *
 * Responsibilities:
 *   - computeUcb1Scores / selectNextArmUcb1: UCB1 multi-armed bandit —
 *     Section 3's recommended mechanism for allocating Round 1/2 budget
 *     across Representation Families / Feature Families.
 *   - sampleThompsonBeta / selectNextArmThompson: Beta-Bernoulli Thompson
 *     sampling, an alternative bandit policy with different explore/
 *     exploit behavior (naturally handles a drifting reward signal better
 *     than UCB1's deterministic bound — see architecture doc Section 3's
 *     bandit caveat).
 *   - computeKernelRegressionSurrogate / selectNextPointBayesianOptimization:
 *     a dependency-free Nadaraya-Watson kernel-regression surrogate with a
 *     Gaussian kernel, used as the response-surface model for a UCB
 *     acquisition function over continuous parameters (lookback windows,
 *     lead times, thresholds) — the lightweight, no-external-library
 *     equivalent of a GP-based Bayesian Optimizer the architecture doc
 *     calls for.
 *   - selectNextPointActiveLearning: pure-uncertainty (surrogate variance)
 *     sampling over untested candidates — Section 3's active-learning row,
 *     for the k-way interaction space.
 *   - runMcts / selectChildUcb1 / backpropagate: a generic, domain-agnostic
 *     Monte Carlo Tree Search core for compositional feature generation —
 *     the DSL of "moves" (feature operators) is supplied by the caller
 *     (getLegalMoves/applyMove/simulateRandomPlayout), matching this
 *     codebase's own "caller-supplied signal bundle" pattern
 *     (permutationTest.js's statisticFn is the precedent).
 *   - runEvolutionarySearch: a generic genetic-algorithm core (tournament
 *     selection, caller-supplied crossover/mutation, elitism) for
 *     open-ended feature generation and Section 6's multi-objective
 *     Pareto-style exploration.
 *
 * Inputs/Outputs: plain objects and arrays throughout; every "select"
 *   function returns a ranking or a single selection, never a statistic
 *   that could be mistaken for a test result.
 * Dependencies: statistics/uncertaintyEstimation.js (createSeededRng only).
 *
 * Public API: computeUcb1Scores, selectNextArmUcb1, sampleThompsonBeta,
 *   selectNextArmThompson, computeKernelRegressionSurrogate,
 *   selectNextPointBayesianOptimization, selectNextPointActiveLearning,
 *   selectChildUcb1, expandMctsNode, backpropagateMcts, runMcts,
 *   runEvolutionarySearch, InvalidSearchEngineInputError.
 * Internal API: sampleGamma, sampleBeta (Marsaglia-Tsang gamma sampler
 *   feeding a two-gamma beta sampler), tournamentSelect.
 *
 * Error handling: InvalidSearchEngineInputError for malformed input,
 *   mirroring this codebase's InvalidXInputError convention.
 * Performance notes: bandit functions are O(k) in the number of arms;
 *   the kernel-regression surrogate is O(n) per candidate point (n =
 *   observations so far) — acceptable at Round 1/2 scale per campaign,
 *   consistent with the architecture doc's own framing that these methods
 *   operate on the FILTERED, not raw, candidate stream; MCTS/evolutionary
 *   search costs are bounded by the caller-supplied iteration/generation
 *   counts.
 * Threading model: pure functions throughout; no shared mutable state
 *   outside a single runMcts/runEvolutionarySearch call's own local tree/
 *   population.
 * Storage usage: none — this module is a stateless computation library,
 *   exactly like statistics/permutationTest.js; a caller (e.g.
 *   discovery/campaignPrioritization.js) is responsible for reading
 *   whatever history it feeds in and recording whatever it decides to do
 *   with the output.
 * Complexity analysis: see Performance notes.
 * Future extension notes: a new adaptive method is a new exported function
 *   following the same "pure ranking/selection, seeded randomness via
 *   createSeededRng, no statistical decision" shape — no change to any
 *   existing export.
 */

import { createSeededRng } from '../statistics/uncertaintyEstimation.js';

export class InvalidSearchEngineInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidSearchEngineInputError';
  }
}

// ── Multi-armed bandits (cross-family / cross-region budget allocation) ───

/**
 * UCB1 scores for a set of arms. Each arm: { armId, totalReward, pulls }.
 * An arm with zero pulls always scores Infinity (guarantees every arm is
 * tried at least once before exploitation begins), matching the standard
 * UCB1 algorithm (Auer, Cesa-Bianchi & Fischer, 2002).
 */
export function computeUcb1Scores(arms, { explorationConstant = Math.SQRT2 } = {}) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new InvalidSearchEngineInputError('computeUcb1Scores: "arms" must be a non-empty array.');
  }
  const totalPulls = arms.reduce((sum, a) => sum + (a.pulls || 0), 0);
  return arms.map((a) => {
    if (!a.pulls) return { armId: a.armId, score: Infinity, meanReward: null };
    const meanReward = a.totalReward / a.pulls;
    const bonus = explorationConstant * Math.sqrt(Math.log(Math.max(totalPulls, 1)) / a.pulls);
    return { armId: a.armId, score: meanReward + bonus, meanReward };
  });
}

/** The single highest-UCB1-score arm — "look here next." */
export function selectNextArmUcb1(arms, opts = {}) {
  const scores = computeUcb1Scores(arms, opts);
  return scores.reduce((best, s) => (s.score > best.score ? s : best), scores[0]);
}

// Marsaglia & Tsang (2000) gamma sampler, shape >= 1 (the only regime this
// module needs it for — Beta(successes+1, failures+1) always has both
// shape parameters >= 1). Reuses createSeededRng exclusively for
// randomness — no second PRNG.
function sampleGamma(shape, rng) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box-Muller using the shared seeded uniform source — no separate
      // normal-variate generator introduced elsewhere in this codebase to
      // reuse, so this is the one place a standard-normal draw is derived,
      // strictly local to this sampler.
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      x = z;
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta, rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

/**
 * One Thompson-sampling draw per arm. Each arm: { armId, successes,
 * failures }. Returns a sampled value per arm from Beta(successes+1,
 * failures+1) — the standard Beta-Bernoulli conjugate posterior with a
 * uniform Beta(1,1) prior.
 */
export function sampleThompsonBeta(arms, seed) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new InvalidSearchEngineInputError('sampleThompsonBeta: "arms" must be a non-empty array.');
  }
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new InvalidSearchEngineInputError('sampleThompsonBeta: a numeric "seed" is required.');
  }
  const rng = createSeededRng(seed);
  return arms.map((a) => ({
    armId: a.armId,
    sample: sampleBeta((a.successes || 0) + 1, (a.failures || 0) + 1, rng),
  }));
}

/** The arm with the highest single Thompson draw — "look here next," resampled fresh each call (never reused across calls, matching the algorithm's own re-sampling requirement). */
export function selectNextArmThompson(arms, seed) {
  const samples = sampleThompsonBeta(arms, seed);
  return samples.reduce((best, s) => (s.sample > best.sample ? s : best), samples[0]);
}

// ── Bayesian-optimization-style surrogate (continuous parameters) ─────────

/**
 * Nadaraya-Watson kernel regression with a Gaussian kernel: for each
 * candidate point, a weighted mean of observed rewards (weights = Gaussian
 * kernel of distance in a single continuous dimension) and a weighted
 * variance, used as the (mean, variance) surrogate a GP would otherwise
 * supply. `observations`: [{ x, reward }]. `candidatePoints`: [x, x, ...].
 */
export function computeKernelRegressionSurrogate(observations, candidatePoints, { bandwidth } = {}) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new InvalidSearchEngineInputError('computeKernelRegressionSurrogate: "observations" must be a non-empty array.');
  }
  if (!Array.isArray(candidatePoints) || candidatePoints.length === 0) {
    throw new InvalidSearchEngineInputError('computeKernelRegressionSurrogate: "candidatePoints" must be a non-empty array.');
  }
  const xs = observations.map((o) => o.x);
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Number.EPSILON);
  const h = Number.isFinite(bandwidth) && bandwidth > 0 ? bandwidth : spread / Math.sqrt(observations.length);

  return candidatePoints.map((x) => {
    let weightSum = 0;
    let weightedRewardSum = 0;
    for (const obs of observations) {
      const w = Math.exp(-0.5 * ((x - obs.x) / h) ** 2);
      weightSum += w;
      weightedRewardSum += w * obs.reward;
    }
    if (weightSum === 0) return { x, mean: null, variance: null };
    const mean = weightedRewardSum / weightSum;
    let weightedVarSum = 0;
    for (const obs of observations) {
      const w = Math.exp(-0.5 * ((x - obs.x) / h) ** 2);
      weightedVarSum += w * (obs.reward - mean) ** 2;
    }
    const variance = weightedVarSum / weightSum;
    return { x, mean, variance };
  });
}

/**
 * Upper-Confidence-Bound acquisition over the kernel-regression surrogate:
 * argmax(mean + kappa * sqrt(variance)). A point far from any observation
 * has near-zero surrogate weight everywhere (variance underestimated by
 * this simple estimator in truly unexplored regions) — callers wanting
 * pure exploration of unobserved regions should combine this with
 * selectNextPointActiveLearning below rather than relying on this
 * acquisition alone, exactly as the architecture doc's Section 3
 * recommendation composes bandits + BO + active learning rather than using
 * any one method in isolation.
 */
export function selectNextPointBayesianOptimization(observations, candidatePoints, { kappa = 1.96, bandwidth } = {}) {
  const surrogate = computeKernelRegressionSurrogate(observations, candidatePoints, { bandwidth });
  const scored = surrogate
    .filter((s) => s.mean !== null)
    .map((s) => ({ ...s, acquisition: s.mean + kappa * Math.sqrt(s.variance) }));
  if (scored.length === 0) {
    throw new InvalidSearchEngineInputError('selectNextPointBayesianOptimization: no candidate point had any surrogate support (all weights zero).');
  }
  return scored.reduce((best, s) => (s.acquisition > best.acquisition ? s : best), scored[0]);
}

// ── Active learning (interaction-space uncertainty sampling) ──────────────

/**
 * Pure exploration by surrogate variance (uncertainty sampling): argmax
 * variance, ignoring mean entirely — the architecture doc's Section 3
 * active-learning row, for deciding which UNTESTED k-way interaction to
 * evaluate next. Intended to be called only on candidates that already
 * passed strong-heredity pruning (Requirement 4) — this function has no
 * way to enforce that itself, since pruning is a property of which
 * candidates the caller includes in `candidatePoints`.
 */
export function selectNextPointActiveLearning(observations, candidatePoints, { bandwidth } = {}) {
  const surrogate = computeKernelRegressionSurrogate(observations, candidatePoints, { bandwidth });
  const scored = surrogate.filter((s) => s.variance !== null);
  if (scored.length === 0) {
    throw new InvalidSearchEngineInputError('selectNextPointActiveLearning: no candidate point had any surrogate support (all weights zero).');
  }
  return scored.reduce((best, s) => (s.variance > best.variance ? s : best), scored[0]);
}

// ── Monte Carlo Tree Search (compositional feature generation) ────────────

/**
 * UCB1 applied to MCTS child selection (identical formula to
 * computeUcb1Scores above, applied to a tree node's children rather than a
 * flat arm set — kept as a separate, tree-shaped function rather than
 * reusing computeUcb1Scores directly, since a tree node's children carry a
 * `node` reference the flat bandit case does not need).
 */
export function selectChildUcb1(node, { explorationConstant = Math.SQRT2 } = {}) {
  if (!node.children || node.children.length === 0) {
    throw new InvalidSearchEngineInputError('selectChildUcb1: node has no children to select among.');
  }
  const totalVisits = node.visits || 1;
  let best = null;
  let bestScore = -Infinity;
  for (const child of node.children) {
    const score = child.visits === 0
      ? Infinity
      : (child.totalReward / child.visits) + explorationConstant * Math.sqrt(Math.log(totalVisits) / child.visits);
    if (score > bestScore) { bestScore = score; best = child; }
  }
  return best;
}

/** Expands one untried move into a new child node, via caller-supplied applyMove(state, move) -> newState. */
export function expandMctsNode(node, move, applyMove) {
  const childState = applyMove(node.state, move);
  const child = { state: childState, move, parent: node, children: [], visits: 0, totalReward: 0, untriedMoves: null };
  node.children.push(child);
  return child;
}

/** Propagates a simulated reward up the path from a leaf to the root, incrementing visits/totalReward at every ancestor. */
export function backpropagateMcts(leafNode, reward) {
  let node = leafNode;
  while (node) {
    node.visits += 1;
    node.totalReward += reward;
    node = node.parent;
  }
}

/**
 * A generic, domain-agnostic MCTS core. The feature-generation DSL itself
 * is entirely caller-supplied (matches this codebase's "caller-supplied
 * signal bundle" pattern):
 *   - getLegalMoves(state) -> array of moves (e.g., "append operator X")
 *   - applyMove(state, move) -> new state
 *   - simulateRandomPlayout(state, rng) -> a reward in [0,1] from a random
 *     rollout to some terminal/depth-limited state (a cheap proxy reward
 *     for Round-1-style screening — e.g., a fast correlation estimate —
 *     never a real Round-3 statistic)
 *   - isTerminal(state) -> boolean
 * Returns the best child of the root by visit count (the standard MCTS
 * "most robust child" selection rule) — the node representing the
 * compositional feature MCTS recommends testing next, NOT a discovery.
 */
export function runMcts({ rootState, getLegalMoves, applyMove, simulateRandomPlayout, isTerminal, iterations = 100, seed, explorationConstant = Math.SQRT2 } = {}) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new InvalidSearchEngineInputError('runMcts: a numeric "seed" is required.');
  }
  const rng = createSeededRng(seed);
  const root = { state: rootState, move: null, parent: null, children: [], visits: 0, totalReward: 0, untriedMoves: getLegalMoves(rootState) };

  for (let i = 0; i < iterations; i++) {
    let node = root;
    // Selection: descend via UCB1 while fully expanded and non-terminal.
    while (node.untriedMoves && node.untriedMoves.length === 0 && node.children.length > 0 && !isTerminal(node.state)) {
      node = selectChildUcb1(node, { explorationConstant });
      if (node.untriedMoves === null) node.untriedMoves = getLegalMoves(node.state);
    }
    // Expansion.
    if (node.untriedMoves === null) node.untriedMoves = getLegalMoves(node.state);
    if (node.untriedMoves.length > 0 && !isTerminal(node.state)) {
      const moveIdx = Math.floor(rng() * node.untriedMoves.length);
      const move = node.untriedMoves.splice(moveIdx, 1)[0];
      node = expandMctsNode(node, move, applyMove);
      node.untriedMoves = getLegalMoves(node.state);
    }
    // Simulation.
    const reward = simulateRandomPlayout(node.state, rng);
    // Backpropagation.
    backpropagateMcts(node, reward);
  }

  if (root.children.length === 0) {
    return { root, bestChild: null };
  }
  const bestChild = root.children.reduce((best, c) => (c.visits > best.visits ? c : best), root.children[0]);
  return { root, bestChild };
}

// ── Evolutionary search (open-ended generation, multi-objective) ──────────

function tournamentSelect(population, fitnesses, tournamentSize, rng) {
  let bestIdx = Math.floor(rng() * population.length);
  let bestFitness = fitnesses[bestIdx];
  for (let i = 1; i < tournamentSize; i++) {
    const idx = Math.floor(rng() * population.length);
    if (fitnesses[idx] > bestFitness) { bestFitness = fitnesses[idx]; bestIdx = idx; }
  }
  return population[bestIdx];
}

/**
 * A generic genetic-algorithm core. Genome representation, crossover, and
 * mutation are entirely caller-supplied (same "caller-supplied signal
 * bundle" pattern as runMcts above):
 *   - fitnessFn(individual) -> a number (higher is better); a cheap proxy
 *     score for Round-1-style screening, never a real Round-3 statistic.
 *   - crossoverFn(parentA, parentB, rng) -> child individual
 *   - mutateFn(individual, rng) -> mutated individual
 * Elitism keeps the top `elitismCount` individuals unchanged each
 * generation. Returns the full fitness history (for monitoring
 * convergence) and the single best individual found across all
 * generations — a RANKING result, not a discovery.
 */
export function runEvolutionarySearch({
  initialPopulation,
  fitnessFn,
  crossoverFn,
  mutateFn,
  generations = 20,
  tournamentSize = 3,
  elitismCount = 1,
  seed,
} = {}) {
  if (!Array.isArray(initialPopulation) || initialPopulation.length < 2) {
    throw new InvalidSearchEngineInputError('runEvolutionarySearch: "initialPopulation" must have at least 2 individuals.');
  }
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new InvalidSearchEngineInputError('runEvolutionarySearch: a numeric "seed" is required.');
  }
  const rng = createSeededRng(seed);
  let population = initialPopulation.slice();
  const fitnessHistory = [];
  let bestIndividual = null;
  let bestFitness = -Infinity;

  for (let gen = 0; gen < generations; gen++) {
    const fitnesses = population.map(fitnessFn);
    const genBestIdx = fitnesses.reduce((bi, f, i) => (f > fitnesses[bi] ? i : bi), 0);
    if (fitnesses[genBestIdx] > bestFitness) {
      bestFitness = fitnesses[genBestIdx];
      bestIndividual = population[genBestIdx];
    }
    fitnessHistory.push({ generation: gen, bestFitness: fitnesses[genBestIdx], meanFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length });

    const ranked = population
      .map((ind, i) => ({ ind, fitness: fitnesses[i] }))
      .sort((a, b) => b.fitness - a.fitness);
    const nextPopulation = ranked.slice(0, elitismCount).map((r) => r.ind);

    while (nextPopulation.length < population.length) {
      const parentA = tournamentSelect(population, fitnesses, tournamentSize, rng);
      const parentB = tournamentSelect(population, fitnesses, tournamentSize, rng);
      const child = mutateFn(crossoverFn(parentA, parentB, rng), rng);
      nextPopulation.push(child);
    }
    population = nextPopulation;
  }

  return { finalPopulation: population, bestIndividual, bestFitness, fitnessHistory };
}
