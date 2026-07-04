/**
 * ui/decompPanel.js
 *
 * Applies the generic floating-panel behavior (ui/floatingPanel.js) to the
 * LTF decomposition banner specifically. Kept as its own small module
 * rather than folded into drawing/candleMarking.js, since candleMarking.js
 * is about the analytical side (which candle, which range) and this is
 * purely presentational — same separation used throughout the app between
 * logic modules and their UI bindings.
 */

import { $ } from '../utils/dom.js';
import { makeFloatingPanel } from './floatingPanel.js';

export function initDecompPanel() {
  const el = $("mtfLtfDecompBanner");
  if (!el) return;
  makeFloatingPanel(el, {
    id: 'ltf-decomp-banner',
    titleBarSelector: '#mtfLtfDecompTitlebar',
    collapseBtnSelector: '#mtfLtfDecompCollapse',
    defaultPos: { x: 12, y: 10 },
    defaultSize: { w: 280, h: 90 },
    minWidth: 200,
    minHeight: 50,
  });
}
