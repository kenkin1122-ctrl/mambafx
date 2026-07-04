/**
 * utils/dom.js — small DOM helpers used throughout the module.
 */

/** @param {string} id */
export const $ = id => document.getElementById(id);

/** Escape user-entered text before interpolating into innerHTML. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
