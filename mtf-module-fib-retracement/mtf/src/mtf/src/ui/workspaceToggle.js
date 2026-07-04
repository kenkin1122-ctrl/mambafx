/**
 * ui/workspaceToggle.js
 *
 * Named toggle between the two workspaces:
 *   - "Professional Analysis Workspace" — the original 2-panel view
 *     (htf/ltf), with Drawing Manager, decomposition, Smart Market
 *     Intelligence, Probability Engine, pattern findings.
 *   - "Multi-Timeframe Dashboard" — the 11-row stacked live chart view.
 *
 * This is PURELY a presentation toggle — it shows/hides the two chart-area
 * sections (#mtfAnalysisWrap / #mtfDashSection) and nothing else. The
 * shared toolbar (drawing tool selector, zone presets, replay controls,
 * workspace save/load) stays visible regardless of which one is active,
 * because both workspaces already read from the exact same AppState,
 * drawing engine, analysis engines, and WebSocket connection — there is
 * nothing here to duplicate or keep in sync, because there was never a
 * second copy of any of it to begin with. Confirmed directly (not
 * assumed) that a drawing made on either workspace's panels already
 * appears on the other's, for the same symbol, via the existing
 * coordinate-based visibleOnPanel() mechanism every panel already shares.
 */

import { $ } from '../utils/dom.js';

const STORAGE_KEY = 'mtf_active_workspace';

function applyWorkspace(name) {
  const analysisWrap = $('mtfAnalysisWrap');
  const dashSection = $('mtfDashSection');
  const analysisBtn = $('mtfWorkspaceToggleAnalysis');
  const dashBtn = $('mtfWorkspaceToggleDashboard');

  if (analysisWrap) analysisWrap.style.display = name === 'analysis' ? '' : 'none';
  if (dashSection) dashSection.style.display = name === 'dashboard' ? '' : 'none';
  if (analysisBtn) analysisBtn.classList.toggle('active', name === 'analysis');
  if (dashBtn) dashBtn.classList.toggle('active', name === 'dashboard');

  try { localStorage.setItem(STORAGE_KEY, name); } catch { /* non-fatal */ }
}

export function initWorkspaceToggle() {
  const analysisBtn = $('mtfWorkspaceToggleAnalysis');
  const dashBtn = $('mtfWorkspaceToggleDashboard');
  if (analysisBtn) analysisBtn.addEventListener('click', () => applyWorkspace('analysis'));
  if (dashBtn) dashBtn.addEventListener('click', () => applyWorkspace('dashboard'));

  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* non-fatal */ }
  applyWorkspace(saved === 'dashboard' ? 'dashboard' : 'analysis');
}
