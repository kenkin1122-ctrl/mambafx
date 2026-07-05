/**
 * ui/replayControls.js
 *
 * Wires the Replay bar: enter/exit toggle, Play/Pause, Step Back/Forward,
 * a speed selector, and a status readout showing the current cursor
 * position and timestamp. All actual state lives in charts/replayManager.js
 * — this module is purely the DOM binding layer, same separation used
 * throughout (toolbar.js/zonePresets.js are UI bindings over AppState;
 * this is the UI binding over replayManager's own small state module).
 */

import { $ } from '../utils/dom.js';
import { eventBus } from '../core/EventBus.js';
import { startReplay, exitReplay, play, pause, stepForward, stepBack, setSpeed, getState } from '../charts/replayManager.js';

function render(state) {
  const bar = $("mtfReplayBar");
  const toggleBtn = $("mtfReplayToggle");
  const controls = $("mtfReplayControls");
  if (!bar || !toggleBtn || !controls) return;

  toggleBtn.classList.toggle("active", state.active);
  controls.style.display = state.active ? "flex" : "none";
  if (!state.active) return;

  const playBtn = $("mtfReplayPlayPause");
  if (playBtn) playBtn.textContent = state.playing ? "⏸" : "▶";

  const stepFwdBtn = $("mtfReplayStepForward");
  if (stepFwdBtn) stepFwdBtn.disabled = state.atEnd;
  const stepBackBtn = $("mtfReplayStepBack");
  if (stepBackBtn) stepBackBtn.disabled = state.atStart;

  const status = $("mtfReplayStatus");
  if (status) {
    const timeStr = state.cursorEpoch != null ? new Date(state.cursorEpoch * 1000).toLocaleString([], { hour12: false }) : "—";
    status.textContent = `Candle ${state.cursorIndex + 1} / ${state.total} · ${timeStr}`;
  }
}

export function initReplayControls() {
  const toggleBtn = $("mtfReplayToggle");
  if (toggleBtn) toggleBtn.addEventListener("click", () => {
    const state = getState();
    if (state.active) exitReplay();
    else startReplay();
  });

  const playBtn = $("mtfReplayPlayPause");
  if (playBtn) playBtn.addEventListener("click", () => {
    const state = getState();
    if (state.playing) pause(); else play();
  });

  const stepBackBtn = $("mtfReplayStepBack");
  if (stepBackBtn) stepBackBtn.addEventListener("click", stepBack);

  const stepFwdBtn = $("mtfReplayStepForward");
  if (stepFwdBtn) stepFwdBtn.addEventListener("click", stepForward);

  const speedSel = $("mtfReplaySpeedSel");
  if (speedSel) speedSel.addEventListener("change", e => setSpeed(parseFloat(e.target.value)));

  const exitBtn = $("mtfReplayExit");
  if (exitBtn) exitBtn.addEventListener("click", exitReplay);

  eventBus.on('replay:changed', render);
  render(getState());
}
