/**
 * research/src/ui/Phase11ValidationApplication.js
 *
 * Purpose:
 *   The ONE public entry point for the isolated Phase 11 Validation
 *   Dashboard — mountPhase11Validation(container, options). Mirrors
 *   Phase11Application.js's own isolation discipline: no legacy
 *   dependency, no direct IndexedDB access, presentation only. The
 *   dashboard starts in an honest empty state ("No validation report
 *   generated yet") rather than fabricating one; a report is only shown
 *   once updateReport()/runValidation() actually produces one.
 *
 * Dependencies: ui/Phase11ValidationDashboard.js (composition root) only.
 * Public API: mountPhase11Validation, Phase11ValidationUIError.
 */

import { createPhase11ValidationDashboard } from './Phase11ValidationDashboard.js';

export class Phase11ValidationUIError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Phase11ValidationUIError';
  }
}

/**
 * @param {Element} container
 * @param {object} [options]
 * @param {Document} [options.document]
 * @returns {{ updateReport: (report: object|null) => void }}
 */
export function mountPhase11Validation(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Phase11ValidationUIError('mountPhase11Validation: "container" must be a DOM element with appendChild()');
  }
  const doc = options.document || container.ownerDocument;
  if (!doc) {
    throw new Phase11ValidationUIError('mountPhase11Validation: no Document available; pass options.document explicitly');
  }

  const dashboard = createPhase11ValidationDashboard(doc);
  container.appendChild(dashboard.element);

  return {
    updateReport: (report) => dashboard.updateReport(report),
    unmount: () => {
      if (dashboard.element.parentNode === container) container.removeChild(dashboard.element);
    },
  };
}
