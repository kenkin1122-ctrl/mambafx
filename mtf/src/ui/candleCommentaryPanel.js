/**
 * ui/candleCommentaryPanel.js
 *
 * Renders the 5-Minute AI Market Commentary into the Njanja Analysis page.
 * Watches specifically the 'm5' dashboard panel (not "whichever timeframe
 * is active" — this commentary is explicitly scoped to 5 minutes, per the
 * request) and regenerates on every panel:dataUpdated for that panel,
 * which covers both the initial history load and every live tick/candle
 * update — "the current candle forming" language in the report only makes
 * sense if it's genuinely re-derived every time that candle changes.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { generateCandleCommentary } from '../ai/candleCommentary.js';
import { decimalsFor } from '../utils/geometry.js';

function render() {
  const wrap = $('mtfCandleCommentary');
  if (!wrap) return;

  const panel = AppState.timeframePanels['m5'];
  if (!panel) return;
  const report = generateCandleCommentary(panel.candles);

  if (!report) {
    wrap.innerHTML = `<div class="manager-empty">Waiting for enough 5-minute candle history to load before generating commentary.</div>`;
    return;
  }

  const dec = decimalsFor(report.support?.price ?? report.resistance?.price ?? 1);
  const list = arr => `<ul class="smi-list">${arr.map(i => `<li>${i}</li>`).join('')}</ul>`;

  wrap.innerHTML = `
    <div class="smi-section">
      <div class="smi-title">Current Trend: ${report.trendLabel}</div>
      <p class="smi-prose">${report.trendNarrative}</p>
    </div>
    <div class="smi-section">
      <div class="smi-title">Candle Psychology</div>
      <p class="smi-prose">${report.candlePsychology}</p>
    </div>
    <div class="smi-section">
      <div class="smi-title">Momentum Analysis</div>
      <p class="smi-prose">Momentum remains ${report.momentumLabel}.</p>
      ${list(report.momentumObservations)}
    </div>
    <div class="smi-section">
      <div class="smi-title">Institutional Order Flow</div>
      <p class="smi-prose">Institutional activity suggests ${report.orderFlowControl} remain in control.</p>
      ${list(report.orderFlowObservations)}
    </div>
    <div class="smi-section">
      <div class="smi-title">Support and Resistance</div>
      <p class="smi-prose"><b>Nearest Support:</b> ${report.support ? `${report.support.label} at ${report.support.price.toFixed(dec)}` : 'Not yet established in the loaded history.'}</p>
      <p class="smi-prose"><b>Nearest Resistance:</b> ${report.resistance ? `${report.resistance.label} at ${report.resistance.price.toFixed(dec)}. If broken, further continuation becomes more probable.` : 'Not yet established in the loaded history.'}</p>
    </div>
    <div class="smi-section">
      <div class="smi-title">Potential Warning Signs</div>
      ${list(report.warningSigns)}
    </div>
    <div class="smi-disclaimer">Deterministic, rule-based synthesis of this module's own analysis engines (statistics, order flow, structure breaks, swing labeling) — not a prediction, not financial advice.</div>
  `;
}

export function initCandleCommentaryPanel() {
  eventBus.on('panel:dataUpdated', ({ panel }) => { if (panel.side === 'm5') render(); });
  eventBus.on('symbol:changed', render);
  render();
}
