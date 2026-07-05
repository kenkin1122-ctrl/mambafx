/**
 * orderflow/proxy.js
 *
 * Tick-derived order-flow proxies for a set of candles. Synthetic indices
 * have no real order book, so these are estimates derived from each
 * candle's close position within its own range — same honest framing used
 * elsewhere in Mamba FX, not a claim of real institutional order-flow data.
 *
 * Phase 13 split this into a pure computation core (computeOrderFlow) used
 * by two renderers:
 *   - renderOrderFlow(panel)      — the existing live header-strip display,
 *                                    always the panel's current visible range.
 *   - renderRegionOrderFlow(...)  — new: the Analysis panel's order-flow
 *                                    section, for "the selected region"
 *                                    (same selected-zone-or-visible-range
 *                                    concept Phase 12 established).
 *
 * Buying/Selling Pressure (new in Phase 13) split CVD into its two
 * directional components instead of just netting them — a region can have
 * CVD ≈ 0 with either very HIGH pressure on both sides (heavy two-way
 * volume, real indecision) or very LOW pressure on both sides (genuinely
 * quiet). CVD alone can't distinguish those; this can.
 */

import { $ } from '../utils/dom.js';
import { decimalsFor } from '../utils/geometry.js';

/**
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @returns {object|null} null for an empty region — there's no meaningful order flow for nothing
 */
export function computeOrderFlow(candles) {
  if (!candles || candles.length === 0) return null;

  let cvd = 0, lastDelta = 0, ups = 0, downs = 0, sumRange = 0;
  let buySum = 0, sellSum = 0;
  candles.forEach(c => {
    const range = (c.high - c.low) || 1e-9;
    const pos = (c.close - c.low) / range;
    const delta = (pos - 0.5) * 2 * range;
    cvd += delta;
    lastDelta = delta;
    if (delta > 0) buySum += delta; else sellSum += -delta;
    if (c.close >= c.open) ups++; else downs++;
    sumRange += range;
  });

  const imbalancePct = Math.round((ups / (ups + downs || 1)) * 100);
  const net = candles[candles.length - 1].close - candles[0].open;
  const absorption = sumRange > 0 ? Math.abs(net) / sumRange : 0;
  const pressureTotal = buySum + sellSum;
  const buyingPressurePct = pressureTotal > 0 ? (buySum / pressureTotal) * 100 : 50;
  const sellingPressurePct = 100 - buyingPressurePct;

  return {
    delta: lastDelta, cvd, imbalancePct, volume: candles.length, absorption,
    buyingPressurePct, sellingPressurePct,
    decimals: decimalsFor(candles[candles.length - 1].close),
  };
}

/** Live header-strip display — always the panel's current visible range. Unchanged behavior from Phase 1, now built on the shared computeOrderFlow() core. */
export function renderOrderFlow(panel) {
  const wrap = $(panel.id + "OF");
  if (!wrap) return;
  const cells = [
    ["Delta", "—", "of-neu"], ["CVD", "—", "of-neu"], ["Imbalance", "—", "of-neu"], ["Volume", "—", "of-neu"], ["Absorption", "—", "of-neu"],
  ];
  if (!panel.isTick()) {
    const of = computeOrderFlow(panel.visibleData());
    if (of) {
      cells[0] = ["Delta", (of.delta >= 0 ? "+" : "") + of.delta.toFixed(of.decimals), of.delta >= 0 ? "of-up" : "of-dn"];
      cells[1] = ["CVD", (of.cvd >= 0 ? "+" : "") + of.cvd.toFixed(Math.min(of.decimals, 2)), of.cvd >= 0 ? "of-up" : "of-dn"];
      cells[2] = ["Imbalance", of.imbalancePct + "%", of.imbalancePct >= 55 ? "of-up" : of.imbalancePct <= 45 ? "of-dn" : "of-neu"];
      cells[3] = ["Volume (ticks)", String(of.volume), "of-neu"];
      const label = of.absorption < 0.15 ? "HIGH" : of.absorption < 0.35 ? "MILD" : "LOW";
      cells[4] = ["Absorption", label, label === "HIGH" ? "of-warn" : "of-neu"];
    }
  }
  wrap.innerHTML = cells.map(([lab, val, cls]) =>
    `<div class="of-cell"><div class="lab">${lab}</div><div class="val ${cls}">${val}</div></div>`).join("");
}

/**
 * Phase 13: order-flow for an arbitrary candle set (the Analysis panel's
 * "selected region"), rendered into an arbitrary container — decoupled
 * from any specific Panel instance, unlike renderOrderFlow() above.
 * Includes all 7 metrics from the spec, including the two new pressure ones.
 */
export function renderRegionOrderFlow(candles, containerId) {
  const wrap = $(containerId);
  if (!wrap) return;
  const of = computeOrderFlow(candles);
  if (!of) {
    wrap.innerHTML = `<div class="manager-empty">No candles in range.</div>`;
    return;
  }
  const rows = [
    ["Delta", (of.delta >= 0 ? "+" : "") + of.delta.toFixed(of.decimals)],
    ["CVD", (of.cvd >= 0 ? "+" : "") + of.cvd.toFixed(Math.min(of.decimals, 2))],
    ["Imbalance", of.imbalancePct + "%"],
    ["Tick Volume", String(of.volume)],
    ["Absorption", of.absorption < 0.15 ? "HIGH" : of.absorption < 0.35 ? "MILD" : "LOW"],
    ["Buying Pressure", of.buyingPressurePct.toFixed(1) + "%"],
    ["Selling Pressure", of.sellingPressurePct.toFixed(1) + "%"],
  ];
  wrap.innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("");
}
