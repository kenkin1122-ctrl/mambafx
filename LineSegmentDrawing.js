/**
 * drawing/candleMarking.js
 *
 * Right-click a candle to tag one of its components with a color/label,
 * or double-click / "decompose" to zoom the LTF panel to exactly the
 * candles that formed it (Phase 9 extends decomposition further).
 *
 * Phase 8: extended from 3 markable components (Body, Upper Wick, Lower
 * Wick — REGIONS, i.e. a price range) to 7 (adding Open, High, Low, Close
 * — LEVELS, i.e. a single exact price). No new drawing class was needed
 * for the four new ones: a "level" is just a RectangleDrawing with
 * p1 === p2 (zero height), spanning the same candle-time-width as a
 * region does — it reuses render()/hitTest()/getHandles()/persistence/
 * cross-panel projection unchanged. That's the DrawingObject hierarchy
 * from Phase 3 paying off again: a new visual concept didn't need a new
 * class, just a different geometry passed into an existing one.
 */

import { AppState } from '../core/AppState.js';
import { $ } from '../utils/dom.js';
import { makeDrawing } from './model.js';
import { requestPanelData } from '../charts/socket.js';
import { historyManager } from '../core/HistoryManager.js';
import { CreateDrawingCommand } from '../core/commands/DrawingCommands.js';
import { decimalsFor } from '../utils/geometry.js';

/** Semantic label presets — only offered for the three REGION components, where "why does this matter" has a natural, meaningful preset list. A single price level (Open/High/Low/Close) doesn't have an equivalent — it's just "exactly where the price was", so those skip the prompt. */
export const SEMANTIC = {
  upper: ["Buy-side Liquidity", "Rejection", "Distribution"],
  lower: ["Sell-side Liquidity", "Reversal", "Absorption"],
  body: ["Aggressive Buying", "Aggressive Selling", "Accumulation"],
};

/** @param {import('../charts/Panel.js').Panel} panel */
export function openCandleMenu(panel, candle, clientX, clientY) {
  const menu = $(panel.id + "CandleMenu");
  if (!menu) return;
  const wrapRect = panel.ovCanvas.parentElement.getBoundingClientRect();
  const left = clientX - wrapRect.left, top = clientY - wrapRect.top;
  const bodyTop = Math.max(candle.open, candle.close), bodyBot = Math.min(candle.open, candle.close);

  const regions = [
    { key: "upper", label: "Upper Wick", p1: candle.high, p2: bodyTop, color: "#ff4d6a" },
    { key: "body", label: "Body", p1: bodyTop, p2: bodyBot, color: "#4fb2ff" },
    { key: "lower", label: "Lower Wick", p1: bodyBot, p2: candle.low, color: "#1fdf9b" },
  ];
  // Levels: p1 === p2 — a zero-height RectangleDrawing, i.e. an exact price line bounded to this candle's time width.
  const levels = [
    { key: "open", label: "Open", p1: candle.open, p2: candle.open, color: "#a78bfa" },
    { key: "high", label: "High", p1: candle.high, p2: candle.high, color: "#fb923c" },
    { key: "low", label: "Low", p1: candle.low, p2: candle.low, color: "#f472b6" },
    { key: "close", label: "Close", p1: candle.close, p2: candle.close, color: "#ffc857" },
  ];

  const buttonsFor = parts => parts.map(part => {
    const cfg = { panel: panel.id, epoch: candle.epoch, gran: panel.granSeconds(), key: part.key, p1: part.p1, p2: part.p2, color: part.color, label: part.label };
    return `<button onclick='mtfMarkCandlePart(${JSON.stringify(cfg).replace(/'/g, "&#39;")})'>
      <span class="dot" style="background:${part.color}"></span> ${part.label}
    </button>`;
  }).join("");

  let html = `<div class="cm-title">Mark region</div>${buttonsFor(regions)}`;
  html += `<hr><div class="cm-title">Mark exact level (OHLC)</div>${buttonsFor(levels)}`;
  const decompCfg = { epoch: candle.epoch, gran: panel.granSeconds(), open: candle.open, high: candle.high, low: candle.low, close: candle.close };
  html += `<hr><div class="cm-title">Or decompose</div><button onclick='mtfDecomposeCandleFromMenu(${JSON.stringify(decompCfg).replace(/'/g, "&#39;")})'>Show inside on LTF</button>`;
  menu.innerHTML = html;
  menu.style.left = left + "px"; menu.style.top = top + "px"; menu.style.display = "block";
  const closer = ev => {
    if (!menu.contains(ev.target)) { menu.style.display = "none"; document.removeEventListener("mousedown", closer); }
  };
  setTimeout(() => document.addEventListener("mousedown", closer), 10);
}

export function markCandlePart(cfg) {
  const semOptions = SEMANTIC[cfg.key]; // undefined for open/high/low/close — no prompt for those, see file header
  const sem = semOptions ? prompt(`Semantic label for this ${cfg.label.toLowerCase()}?\n(${semOptions.join(" / ")}, or leave blank)`, semOptions[0]) : null;
  const d = makeDrawing("wick", cfg.epoch, cfg.p1, cfg.epoch + cfg.gran, cfg.p2, {
    color: cfg.color, label: `${cfg.label}${sem ? " — " + sem : ""}`, opacity: 0.9, borderWidth: 1.5,
    wickPart: cfg.key, semanticLabel: sem || null, _fromPanel: cfg.panel,
  });
  historyManager.execute(new CreateDrawingCommand(d));
  document.querySelectorAll(".candle-menu").forEach(m => m.style.display = "none");
}

export function decomposeCandleFromMenu(cfg) {
  decomposeCandle({ epoch: cfg.epoch, open: cfg.open, high: cfg.high, low: cfg.low, close: cfg.close }, cfg.gran);
  document.querySelectorAll(".candle-menu").forEach(m => m.style.display = "none");
}

export function decomposeCandle(candle, gran) {
  const { htf, ltf } = AppState.panels;
  const t0 = candle.epoch, t1 = candle.epoch + gran;
  ltf.decompRange = { t0, t1 };
  const banner = $("mtfLtfDecompBanner");
  if (banner) banner.style.display = "block";
  const textEl = $("mtfLtfDecompText");
  if (textEl) {
    const timeStr = new Date(candle.epoch * 1000).toLocaleString([], { hour12: false });
    let ohlcStr = "";
    if (candle.open != null && candle.high != null && candle.low != null && candle.close != null) {
      const dec = decimalsFor(candle.close);
      ohlcStr = ` · O ${candle.open.toFixed(dec)} H ${candle.high.toFixed(dec)} L ${candle.low.toFixed(dec)} C ${candle.close.toFixed(dec)}`;
    }
    textEl.textContent = `Decomposed: candle @ ${timeStr}${ohlcStr}`;
  }
  const bodyEl = $("mtfLtfDecompBody");
  if (bodyEl) {
    const startStr = new Date(t0 * 1000).toLocaleString([], { hour12: false });
    const endStr = new Date(t1 * 1000).toLocaleString([], { hour12: false });
    bodyEl.innerHTML = `Range start: ${startStr}<br>Range end: ${endStr}<br>Duration: ${gran >= 3600 ? (gran / 3600) + 'h' : (gran / 60) + 'm'}`;
  }
  requestPanelData(ltf, { start: t0 - 5, end: t1 + 5 });
  htf.zoomToRange(t0 - gran * 3, t1 + gran * 3, 0.1);
}

export function exitDecomposition() {
  const { ltf } = AppState.panels;
  ltf.decompRange = null;
  const banner = $("mtfLtfDecompBanner");
  if (banner) banner.style.display = "none";
  requestPanelData(ltf);
}
