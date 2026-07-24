/**
 * research/src/statistics/normalDistribution.js
 *
 * Purpose:
 *   Single shared source of truth for the two standard-normal-distribution
 *   approximations this codebase needs (the forward CDF and its inverse),
 *   so every module that needs one (uncertaintyEstimation.js's Wald
 *   interval, powerEngine.js's achieved-power calculation, and any future
 *   caller) computes against the exact same numerical approximation.
 *   Extracted from uncertaintyEstimation.js specifically to avoid two
 *   independently-maintained copies of an inverse-normal-CDF approximation
 *   silently drifting apart — a real risk in a codebase this dependent on
 *   numerical reproducibility, and a direct application of Volume III's
 *   Principle 2 ("one authoritative process per scientific function") to
 *   a shared numerical primitive, not just to statistical *procedures*.
 *
 * Responsibilities:
 *   - normalCDF(z): the standard normal CDF, Phi(z), via the Abramowitz &
 *     Stegun 7.1.26 rational approximation to the error function (accurate
 *     to ~1.5e-7 absolute error).
 *   - inverseNormalCDF(p): the standard normal quantile function,
 *     Phi^-1(p), via Acklam's algorithm (accurate to ~1.15e-9 relative
 *     error across the full domain).
 *
 * Inputs: a real number (normalCDF) or a probability in (0, 1)
 *   (inverseNormalCDF).
 * Outputs: a real number in each case.
 * Dependencies: none (a leaf module — no imports).
 *
 * Public API: normalCDF, inverseNormalCDF.
 * Internal API: none.
 *
 * Error handling: neither function validates its input range itself
 *   (inverseNormalCDF(p) is only mathematically defined for 0 < p < 1) --
 *   callers are expected to validate their own domain-specific inputs
 *   BEFORE calling in, exactly as uncertaintyEstimation.js and
 *   powerEngine.js already do for their own public functions. This module
 *   stays a pure, unopinionated numerical leaf with no policy of its own.
 * Performance notes: both functions are O(1), closed-form rational
 *   approximations -- no iteration, no allocation beyond a few locals.
 * Threading model: pure, synchronous, side-effect-free -- safe anywhere.
 * Storage usage: none.
 * Complexity analysis: O(1).
 * Future extension notes: if a future statistical procedure needs a
 *   Student's t, chi-squared, or F-distribution approximation, add it here
 *   rather than inline in the calling module, for the same reason this
 *   module exists at all.
 */

/** Standard normal CDF, Phi(z), via the Abramowitz & Stegun 7.1.26 approximation to erf. */
export function normalCDF(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  // Abramowitz & Stegun 7.1.26 approximation to erf(x), x >= 0.
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  const erf = sign * y;

  return 0.5 * (1 + erf);
}

/**
 * Rational approximation of the inverse standard normal CDF (Acklam's
 * algorithm), accurate to roughly 1.15e-9 relative error across the full
 * domain.
 */
export function inverseNormalCDF(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
