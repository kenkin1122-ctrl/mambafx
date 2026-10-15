/**
 * src/bazu/corrections3m.js
 * Versioned estimator correction factors (P3). Fitted OFFLINE on the training period only and kept only where they
 * reduced the error on the chronological holdout (src/bazu/recalib3m.js). Applied to FUTURE predictions only, and only
 * when ESTIMATOR_CORRECTION is true (default false). Historical records are never modified.
 *
 * factor = realised KM median / predicted median (per playbook, per estimator).
 * Fit: 1,363 real-tick signals, 8 Deriv synthetic indices, 70/30 chronological split, 1,200 s embargo.
 *   E1 breakout 0.799: holdout error 0.415 -> 0.191 (n=348 events)
 *   E5 breakout 0.692: holdout error 1.074 -> 0.705 (n=348 events)
 * Not applied, with reason: E3 breakout (factor hit the 4x clamp, holdout error rose 0.543 -> 0.843); every other
 * playbook (fewer than 30 training events).
 */
export const CORRECTIONS = Object.freeze({
  version: 'p3-2026-10-15',
  factors: Object.freeze({ breakout: Object.freeze({ E1: 0.799, E5: 0.692 }) }),
});
