/**
 * ui/analysisPanel.js
 *
 * Wires the Analysis tab: a button-triggered pattern scan (Phase 11) and
 * region-aware statistics (Phase 12).
 *
 * Deliberately NOT auto-run on every tick — these are retrospective study
 * tools, not live signals (that's what the Aggression Bot / 5-Tick Engine
 * elsewhere in Mamba FX are for). Re-scanning on every candle close would
 * be wasted work for a panel the person may not even have open.
 *
 * "Selected region" for statistics (Phase 12) is deliberately NOT a new
 * mouse-drag selection tool — it reuses what already exists: if a
 * rectangle/zone is currently selected, stats compute for the candles
 * within its time bounds; otherwise stats compute for the HTF chart's
 * current visible range. This avoids building a whole new interaction
 * mode for something the app can already express.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { decimalsFor } from '../utils/geometry.js';
import { runPatternScan } from '../analysis/patternEngine.js';
import { computeStats } from '../analysis/statistics.js';
import { renderRegionOrderFlow } from '../orderflow/proxy.js';
import { runRuleEngine } from '../ai/ruleEngine.js';
import { drawAll } from '../charts/render.js';

const TYPE_COLORS = {
  engulfing: '#4fb2ff', outsideBar: '#a78bfa', insideBar: '#94a3b8', pinBar: '#ffc857', doji: '#94a3b8',
  bos: '#1fdf9b', choch: '#ff4d6a', liquiditySweep: '#fb923c', fvg: '#f472b6', orderBlock: '#2dd4bf',
};

const RULE_COLORS = {
  trendStrength: '#4fb2ff', bullishContinuation: '#1fdf9b', bearishContinuation: '#ff4d6a',
  reversal: '#ffc857', liquidityGrab: '#fb923c', accumulation: '#2dd4bf', distribution: '#f472b6', absorption: '#a78bfa',
};

let lastFindings = [];

const TABS = [
  { key: 'drawings', tabId: 'mtfTabDrawings', paneId: 'mtfManagerTabDrawings' },
  { key: 'analysis', tabId: 'mtfTabAnalysis', paneId: 'mtfManagerTabAnalysis' },
  { key: 'intelligence', tabId: 'mtfTabIntelligence', paneId: 'mtfManagerTabIntelligence' },
];

function switchTab(tab) {
  TABS.forEach(t => {
    const tabEl = $(t.tabId), paneEl = $(t.paneId);
    if (tabEl) tabEl.classList.toggle('active', t.key === tab);
    if (paneEl) paneEl.style.display = t.key === tab ? '' : 'none';
  });
}

/** Candles for "the selected region" — see file header for the two ways this resolves. */
function getRegionCandles() {
  const { htf } = AppState.panels;
  if (!htf) return [];
  const sel = AppState.selectedDrawing;
  if (sel && (sel.type === 'rect' || sel.type === 'wick')) {
    const t0 = Math.min(sel.t1, sel.t2), t1 = Math.max(sel.t1, sel.t2);
    return htf.candles.filter(c => c.epoch >= t0 && c.epoch <= t1);
  }
  return htf.candles.filter(c => c.epoch + htf.granSeconds() >= htf.viewT0 && c.epoch <= htf.viewT1);
}

function formatDuration(seconds) {
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  if (seconds < 86400) return (seconds / 3600).toFixed(1) + 'h';
  return (seconds / 86400).toFixed(1) + 'd';
}

function renderRuleEngine(candles) {
  const wrap = $("mtfRuleEngineResults");
  if (!wrap) return;
  const results = runRuleEngine(candles);
  if (!results.length) {
    wrap.innerHTML = `<div class="manager-empty">No classifications for this region — not enough candles, or no rule's conditions were met.</div>`;
    return;
  }
  wrap.innerHTML = results.map(r => `
    <div class="finding-row" style="cursor:default">
      <div class="f-head"><span class="finding-dot" style="background:${RULE_COLORS[r.type] || '#94a3b8'}"></span>${r.label}${r.direction ? ' · ' + r.direction : ''} <span style="margin-left:auto;color:var(--mtf-muted);font-weight:400">${r.confidence}%</span></div>
      <div class="f-desc">${r.description}</div>
    </div>`).join('');
}

function renderStats() {
  const wrap = $("mtfAnalysisStats");
  const sourceEl = $("mtfStatsSource");
  if (!wrap) return;

  const sel = AppState.selectedDrawing;
  const isZoneSelected = sel && (sel.type === 'rect' || sel.type === 'wick');
  if (sourceEl) {
    sourceEl.textContent = isZoneSelected
      ? `Stats for selected zone: "${sel.label}"`
      : `Stats for the HTF chart's current visible range.`;
  }

  const regionCandles = getRegionCandles();
  const stats = computeStats(regionCandles);
  if (!stats) {
    wrap.innerHTML = `<div class="manager-empty">No candles in range.</div>`;
    renderRegionOrderFlow(regionCandles, "mtfAnalysisOrderFlow");
    renderRuleEngine(regionCandles);
    return;
  }
  const dec = decimalsFor(stats.highestHigh);
  const rows = [
    ['Candles', stats.candleCount],
    ['Bullish', stats.bullishCount],
    ['Bearish', stats.bearishCount],
    ['Avg body', stats.avgBodySize.toFixed(dec)],
    ['Avg wick', stats.avgWickSize.toFixed(dec)],
    ['Largest candle', new Date(stats.largestCandle.epoch * 1000).toLocaleString([], { hour12: false })],
    ['Smallest candle', new Date(stats.smallestCandle.epoch * 1000).toLocaleString([], { hour12: false })],
    ['Highest high', stats.highestHigh.toFixed(dec)],
    ['Lowest low', stats.lowestLow.toFixed(dec)],
    ['Duration', formatDuration(stats.durationSeconds)],
    ['Momentum', (stats.momentumPct >= 0 ? '+' : '') + stats.momentumPct.toFixed(2) + '%'],
    ['Volatility', stats.volatilityPct.toFixed(1) + '%'],
  ];
  wrap.innerHTML = rows.map(([k, v]) => `<div class="stat-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  // Order Flow shares the exact same region-selection logic as Statistics —
  // updating it here means every trigger point that refreshes stats
  // (selection change, fresh HTF data, symbol switch) refreshes order flow
  // too, without duplicating those event subscriptions.
  renderRegionOrderFlow(regionCandles, "mtfAnalysisOrderFlow");
  renderRuleEngine(regionCandles);
}

function renderFindings() {
  const wrap = $("mtfAnalysisFindings");
  if (!wrap) return;
  if (!lastFindings.length) {
    wrap.innerHTML = `<div class="manager-empty">No patterns found.<br>Click "Scan" above to analyze the HTF chart's loaded candles.</div>`;
    return;
  }
  wrap.innerHTML = lastFindings.slice(0, 150).map((f, i) => `
    <div class="finding-row" data-idx="${i}">
      <div class="f-head"><span class="finding-dot" style="background:${TYPE_COLORS[f.type] || '#94a3b8'}"></span>${f.label}${f.direction ? ' · ' + f.direction : ''}</div>
      <div class="f-desc">${f.description}</div>
    </div>`).join('');
  wrap.querySelectorAll('.finding-row').forEach(el => {
    el.addEventListener('click', () => jumpToFinding(lastFindings[+el.dataset.idx]));
  });
}

function jumpToFinding(f) {
  const { htf, ltf } = AppState.panels;
  if (!htf) return;
  const gran = htf.granSeconds();
  htf.zoomToRange(f.epoch - gran * 5, f.epoch + gran * 5, 0.3);
  if (ltf) ltf.zoomToRange(f.epoch - gran * 5, f.epoch + gran * 5, 0.3);
  drawAll();
}

function runScan() {
  const { htf } = AppState.panels;
  if (!htf) return;
  const btn = $("mtfRunAnalysisBtn");
  if (btn) { btn.disabled = true; btn.textContent = "🔎 Scanning…"; }
  // Synchronous, but candle counts here (hundreds, not millions) keep this
  // well under a frame budget — a setTimeout(0) would just add complexity
  // without a real UX benefit at this data scale.
  lastFindings = runPatternScan(htf.candles);
  renderFindings();
  renderStats();
  if (btn) { btn.disabled = false; btn.textContent = "🔎 Scan HTF chart for patterns"; }
}

export function initAnalysisPanel() {
  TABS.forEach(t => {
    const tabEl = $(t.tabId);
    if (tabEl) tabEl.addEventListener('click', () => switchTab(t.key));
  });

  const scanBtn = $("mtfRunAnalysisBtn");
  if (scanBtn) scanBtn.addEventListener('click', runScan);

  // Stats react to selection changes (a different zone selected) and to
  // fresh HTF data (so "visible range" stats aren't stale after a pan/
  // zoom or a symbol switch) — but the pattern SCAN stays button-triggered.
  eventBus.on('selection:changed', renderStats);
  eventBus.on('panel:dataUpdated', ({ panel }) => { if (panel.side === 'htf') renderStats(); });
  eventBus.on('symbol:changed', () => { lastFindings = []; renderFindings(); renderStats(); });

  renderStats();
  renderFindings();
}
