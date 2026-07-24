/**
 * research/src/governance/scientificDashboard.js
 *
 * Purpose:
 *   Implement the backend-appropriate slice of Volume IV v3.0 Part 15
 *   (Scientific Dashboard): its enforcement rules, not its visual
 *   presentation. Part 15 states two structural requirements — "every
 *   metric shown must be scientifically meaningful and shown with its
 *   denominator, time window, and Family or Scientific Question scope"
 *   and a permanently forbidden metric list — both of which are testable
 *   backend guards, unlike the dashboard's actual rendering, which
 *   requires a browser/UI execution context this Node-only sandbox
 *   cannot build or verify (the same class of deferral already applied
 *   to the Historical Tick Engine's live acquisition adapter and the
 *   Discovery Engine's real legacy wiring).
 *
 * Responsibilities:
 *   - assertPermittedDashboardMetric(metricName): throws
 *     ForbiddenDashboardMetricError for any of Part 15's permanently
 *     forbidden metric names (win rate, profit factor, any return
 *     metric, a raw-effect-size leaderboard, a signal-strength score
 *     with no stated evidence tier, or a metric computed over a
 *     resettable counter) — a direct, literal enforcement of the
 *     Constitution's own list, not a judgment call.
 *   - assertHasRequiredDisplayContext({denominator, scope}): throws
 *     MissingDisplayContextError if a metric is about to be shown
 *     without both a denominator and a Family/Scientific-Question scope
 *     — Part 15's "any metric shown without its denominator" rule and
 *     its scope requirement, applied together since both are structural
 *     preconditions for the same sentence in Part 15.
 *
 * Explicitly out of scope: the actual dashboard UI (rendering, layout,
 *   the specific permitted-category list of what MAY be shown) requires
 *   a browser/UI context and real connector-fed data this sandbox has
 *   neither of — these two guard functions are meant to be called by
 *   whatever future UI layer assembles dashboard views, not a
 *   replacement for building that layer.
 *
 * Inputs: a metric name string, or a {denominator, scope} display-context
 *   bundle.
 * Outputs: throws on violation; otherwise returns true.
 * Dependencies: none.
 *
 * Public API: FORBIDDEN_DASHBOARD_METRICS, ForbiddenDashboardMetricError,
 *   MissingDisplayContextError, assertPermittedDashboardMetric,
 *   assertHasRequiredDisplayContext.
 * Internal API: none.
 *
 * Error handling: both functions throw a dedicated, named error
 *   synchronously on violation, before any rendering would occur.
 * Performance notes: O(1) — a fixed-size list membership check and a
 *   handful of presence checks.
 * Threading model: pure, synchronous, side-effect-free.
 * Storage usage: none.
 * Complexity analysis: O(1).
 * Future extension notes: a future UI layer would call
 *   assertPermittedDashboardMetric() and
 *   assertHasRequiredDisplayContext() at the point it assembles each
 *   dashboard panel, using the Meta-Science Engine's own computed
 *   {value, ..., n} / {..., insufficientData} shapes (see metaScience.js)
 *   as the natural source of a metric's denominator.
 */

// Part 15's own list, verbatim: "win rate, profit factor, return metrics
// of any kind, 'signal strength' scores without a stated evidence tier,
// leaderboards ranking hypotheses by raw effect size, any metric computed
// over a resettable counter."
export const FORBIDDEN_DASHBOARD_METRICS = Object.freeze([
  'win_rate',
  'profit_factor',
  'return_metric',
  'signal_strength_without_evidence_tier',
  'raw_effect_size_leaderboard',
  'resettable_counter_metric',
]);

export class ForbiddenDashboardMetricError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenDashboardMetricError';
  }
}

export class MissingDisplayContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingDisplayContextError';
  }
}

/** Direct enforcement of Part 15's "Forbidden, permanently" metric list. */
export function assertPermittedDashboardMetric(metricName) {
  if (!metricName || typeof metricName !== 'string') {
    throw new ForbiddenDashboardMetricError('assertPermittedDashboardMetric: "metricName" must be a non-empty string');
  }
  if (FORBIDDEN_DASHBOARD_METRICS.includes(metricName)) {
    throw new ForbiddenDashboardMetricError(
      `assertPermittedDashboardMetric: "${metricName}" is permanently forbidden from the Scientific Dashboard (Part 15)`
    );
  }
  return true;
}

/** Part 15: "every metric shown must be... shown with its denominator, time window, and Family or Scientific Question scope." */
export function assertHasRequiredDisplayContext({ denominator, scope } = {}) {
  if (denominator === undefined || denominator === null) {
    throw new MissingDisplayContextError('assertHasRequiredDisplayContext: a metric may never be shown without its denominator (Part 15)');
  }
  if (!scope || typeof scope !== 'string' || scope.length === 0) {
    throw new MissingDisplayContextError('assertHasRequiredDisplayContext: a metric may never be shown without a Family or Scientific Question scope (Part 15)');
  }
  return true;
}
