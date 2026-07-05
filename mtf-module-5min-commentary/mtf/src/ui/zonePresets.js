/**
 * ui/zonePresets.js
 *
 * Renders one button per ZONE_TYPES entry (Supply/Demand/FVG/Order Block/
 * etc). Clicking one arms the rectangle tool AND sets AppState.pendingPreset
 * — drawing/interaction.js reads that when the next rectangle is created,
 * merging the preset's zoneType and color into it, then clears it (unless
 * "keep tool active" is on, letting you draw several zones of the same
 * type in a row without re-clicking the preset each time).
 *
 * Deliberately does NOT introduce a new drawing class or a new tool type —
 * per the Phase 10 spec, every preset is still just a plain rectangle with
 * metadata. This module only decides what metadata gets pre-filled.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';
import { $ } from '../utils/dom.js';
import { ZONE_TYPES } from '../core/constants.js';
import { setTool } from './toolbar.js';

function renderButtons() {
  const wrap = $("mtfZonePresets");
  if (!wrap) return;
  wrap.innerHTML = ZONE_TYPES.map(z => {
    const armed = AppState.pendingPreset?.zoneType === z.key;
    return `<button class="zone-preset-btn ${armed ? 'active' : ''}" data-zone="${z.key}" title="Draw a ${z.label} zone">
      <span class="dot" style="background:${z.color}"></span>${z.label}
    </button>`;
  }).join("");
  wrap.querySelectorAll(".zone-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.zone;
      const zt = ZONE_TYPES.find(z => z.key === key);
      if (!zt) return;
      // Clicking the already-armed preset again disarms it (toggle), same
      // affordance as clicking an already-active tool button.
      if (AppState.pendingPreset?.zoneType === key) {
        AppState.setPendingPreset(null);
      } else {
        AppState.setPendingPreset({ zoneType: zt.key, color: zt.color, label: zt.label });
        setTool("rect", { preservePreset: true });
      }
    });
  });
}

export function initZonePresets() {
  renderButtons();
  eventBus.on('pendingPreset:changed', renderButtons);
}
