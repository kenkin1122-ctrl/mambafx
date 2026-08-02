/**
 * research/src/eventProcess/coreEventFeatures.js
 *
 * Purpose:
 *   The real, initial roster of event-local feature plugins for
 *   EventFeatureRegistry.js. Every plugin here computes exactly one value
 *   from exactly one event and its immediate predecessor (or null,
 *   returned honestly, if there is no predecessor in the same session --
 *   never a fabricated default). No plugin here computes a rolling,
 *   windowed, or smoothed statistic (refinement #1) -- those belong at
 *   Confirmation/Feature-Resolution time, as parameterized queries, same
 *   as indicator plugins' `period` parameter already works.
 *
 * Reuses createMathDefinition (plugin/MachineReadableMathematics.js,
 *   unmodified) for the same LaTeX/executable-formula discipline every
 *   other plugin family already has.
 *
 * Dependencies: plugin/MachineReadableMathematics.js.
 * Public API: TimeGapPlugin, TickGapPlugin, AlternatingRunPlugin,
 *   CORE_EVENT_FEATURE_PLUGINS, registerCoreEventFeatures.
 * Complexity: O(1) per plugin per call (event-local by construction).
 */

import { createMathDefinition } from '../plugin/MachineReadableMathematics.js';

const DISCLAIMER = 'Event-local observation only -- no statistical inference, no significance claim. This is a measurement, not a hypothesis test.';

function makeEventFeaturePlugin({ name, displayName, description, assumptions, mathDef, computeFn, testInputs }) {
  return Object.freeze({
    metadata() {
      return Object.freeze({
        name, displayName, description,
        version: '1.0.0',
        scientificAssumptions: assumptions,
        dependencies: [],
        complexity: 'O(1)',
        validationStatus: 'THEORETICAL', // a raw measurement, not yet an empirically-validated predictor of anything
        maxLookahead: 0,
        disclaimer: DISCLAIMER,
      });
    },
    validate() { return { valid: true, errors: [] }; },
    compute(inputs) { return computeFn(inputs); },
    version() { return '1.0.0'; },
    dependencies() { return []; },
    tests() { return [{ name: `${name} computes without throwing`, inputs: testInputs, expectedOutputShape: { signal: 'number' } }]; },
    documentation() { return `${description} ${DISCLAIMER} LaTeX: ${mathDef.symbolicExpression}`; },
    scientificAssumptions() { return [...assumptions]; },
    mathDefinition: mathDef,
  });
}

const SAMPLE_EVENT = { eventId: 'evt-2', timestamp: 1000, tickIndex: 200, runDirection: 'RISE' };
const SAMPLE_PREVIOUS = { eventId: 'evt-1', timestamp: 700, tickIndex: 150, runDirection: 'FALL' };

export const TimeGapPlugin = makeEventFeaturePlugin({
  name: 'TimeGap', displayName: 'Time Gap',
  description: 'Elapsed wall-clock time between this event and the immediately preceding event in the same session.',
  assumptions: ['event.timestamp and previousEvent.timestamp are drawn from the same monotonic clock.'],
  mathDef: createMathDefinition({
    humanReadable: 'timeGap = event.timestamp - previousEvent.timestamp',
    symbolicExpression: String.raw`\Delta t = t_i - t_{i-1}`,
    executableFormula: (event, previousEvent) => event.timestamp - previousEvent.timestamp,
    units: 'milliseconds', domain: 'event pairs within one session', range: 'positive reals or null',
  }),
  computeFn: ({ event, previousEvent } = {}) => ({
    signal: previousEvent ? event.timestamp - previousEvent.timestamp : null,
  }),
  testInputs: { event: SAMPLE_EVENT, previousEvent: SAMPLE_PREVIOUS },
});

export const TickGapPlugin = makeEventFeaturePlugin({
  name: 'TickGap', displayName: 'Tick Gap',
  description: 'Elapsed tick count between this event and the immediately preceding event in the same session.',
  assumptions: ['event.tickIndex and previousEvent.tickIndex are drawn from the same monotonically increasing tick counter.'],
  mathDef: createMathDefinition({
    humanReadable: 'tickGap = event.tickIndex - previousEvent.tickIndex',
    symbolicExpression: String.raw`\Delta n = n_i - n_{i-1}`,
    executableFormula: (event, previousEvent) => event.tickIndex - previousEvent.tickIndex,
    units: 'ticks', domain: 'event pairs within one session', range: 'positive integers or null',
  }),
  computeFn: ({ event, previousEvent } = {}) => ({
    signal: previousEvent ? event.tickIndex - previousEvent.tickIndex : null,
  }),
  testInputs: { event: SAMPLE_EVENT, previousEvent: SAMPLE_PREVIOUS },
});

export const AlternatingRunPlugin = makeEventFeaturePlugin({
  name: 'AlternatingRun', displayName: 'Alternating Run Indicator',
  description: 'Whether this event\'s run direction differs from the immediately preceding event\'s run direction (1 = alternated, 0 = repeated, null = no predecessor).',
  assumptions: ['runDirection is one of a small, fixed set of labels (e.g. RISE/FALL) comparable by strict equality.'],
  mathDef: createMathDefinition({
    humanReadable: 'alternatingRun = 1 if event.runDirection != previousEvent.runDirection else 0',
    symbolicExpression: String.raw`a_i = \mathbb{1}[d_i \neq d_{i-1}]`,
    executableFormula: (event, previousEvent) => (event.runDirection !== previousEvent.runDirection ? 1 : 0),
    units: 'dimensionless (indicator)', domain: 'event pairs within one session', range: '{0, 1} or null',
  }),
  computeFn: ({ event, previousEvent } = {}) => ({
    signal: previousEvent ? (event.runDirection !== previousEvent.runDirection ? 1 : 0) : null,
  }),
  testInputs: { event: SAMPLE_EVENT, previousEvent: SAMPLE_PREVIOUS },
});

/** All core event-local feature plugins, in registration order. */
export const CORE_EVENT_FEATURE_PLUGINS = Object.freeze([TimeGapPlugin, TickGapPlugin, AlternatingRunPlugin]);

/**
 * Registers every core event-local feature plugin into the given registry.
 * @param {import('./EventFeatureRegistry.js').EventFeatureRegistry} registry
 */
export function registerCoreEventFeatures(registry) {
  for (const plugin of CORE_EVENT_FEATURE_PLUGINS) registry.register(plugin);
  return registry;
}
