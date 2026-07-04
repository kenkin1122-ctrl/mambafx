/**
 * charts/replayManager.js
 *
 * Historical replay: step or auto-play through the candles the HTF panel
 * already has loaded, with the LTF panel's candles filtered to the same
 * cutoff point — "synchronize every timeframe during replay" from the
 * Phase 15 spec, satisfied by having both panels' rendering respect one
 * shared cutoff epoch computed from the HTF cursor position, rather than
 * two independently-advanced cursors that could drift apart.
 *
 * Scope, stated plainly: this replays whatever history is ALREADY loaded
 * (the same ~200 HTF candles / ~800 LTF candles the app normally keeps in
 * memory for live viewing) — it does not fetch a separate, deeper
 * historical archive. It also does not pause the live WebSocket feed;
 * ticks keep arriving and get appended to panel.candles in the background
 * exactly as during normal live viewing. Replay only controls what's
 * VISUALLY revealed (via replayCutoffEpoch(), read by charts/render.js's
 * drawCandles()/drawTickLine()) — exiting replay is instant and lossless,
 * since nothing was ever deleted or paused, just hidden.
 *
 * Also stated plainly: this makes the two CHART PANELS synchronized during
 * replay, which is the literal Phase 15 requirement. The Analysis panel's
 * stats/order-flow/rule-engine sections (Phases 12-14) are NOT cutoff-aware
 * — they still read the full visible/selected range regardless of replay
 * position. Making every downstream panel replay-aware was judged out of
 * scope for this phase; flagging it here rather than silently leaving a
 * half-correct implementation that looks complete.
 */

import { AppState } from '../core/AppState.js';
import { eventBus } from '../core/EventBus.js';

const SPEED_INTERVALS = { 0.5: 1600, 1: 800, 2: 400, 4: 200, 8: 100 };

const state = {
  active: false,
  playing: false,
  cursorIndex: 0,
  speed: 1,
  timer: null,
};

export function isReplayActive() {
  return state.active;
}

/**
 * The epoch beyond which candles should be hidden during replay, or null
 * when replay is off. Always derived from the HTF panel's cursor, so
 * calling this while rendering EITHER panel yields the same cutoff — that
 * shared-source-of-truth property is what keeps the two panels in sync.
 */
export function replayCutoffEpoch() {
  if (!state.active) return null;
  const { htf } = AppState.panels;
  if (!htf || !htf.candles.length) return null;
  const idx = Math.min(state.cursorIndex, htf.candles.length - 1);
  return htf.candles[idx].epoch + htf.granSeconds();
}

function followCursor() {
  const { htf } = AppState.panels;
  if (!htf || !htf.candles[state.cursorIndex]) return;
  const cursorEpoch = htf.candles[state.cursorIndex].epoch;
  const gran = htf.granSeconds();
  if (cursorEpoch + gran > htf.viewT1 - gran * 3 || cursorEpoch < htf.viewT0) {
    const span = htf.viewT1 - htf.viewT0;
    htf.viewT0 = cursorEpoch - span * 0.8;
    htf.viewT1 = cursorEpoch + span * 0.2;
  }
}

function emitChange() {
  eventBus.emit('replay:changed', getState());
}

/** Enter replay mode, starting partway through loaded HTF history. @returns {boolean} whether replay actually started */
export function startReplay() {
  const { htf } = AppState.panels;
  if (!htf || htf.candles.length < 10) return false;
  state.active = true;
  state.playing = false;
  state.cursorIndex = Math.max(5, Math.floor(htf.candles.length * 0.5));
  followCursor();
  emitChange();
  return true;
}

/** Exit replay mode — instant, since nothing was ever deleted. */
export function exitReplay() {
  stopAutoPlay();
  state.active = false;
  emitChange();
}

function stopAutoPlay() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.playing = false;
}

export function play() {
  if (!state.active || state.playing) return;
  const { htf } = AppState.panels;
  if (!htf) return;
  state.playing = true;
  state.timer = setInterval(() => {
    if (state.cursorIndex >= htf.candles.length - 1) { pause(); return; }
    state.cursorIndex++;
    followCursor();
    emitChange();
  }, SPEED_INTERVALS[state.speed] || 800);
  emitChange();
}

export function pause() {
  stopAutoPlay();
  emitChange();
}

export function stepForward() {
  if (!state.active) return;
  pause();
  const { htf } = AppState.panels;
  if (!htf) return;
  state.cursorIndex = Math.min(htf.candles.length - 1, state.cursorIndex + 1);
  followCursor();
  emitChange();
}

export function stepBack() {
  if (!state.active) return;
  pause();
  state.cursorIndex = Math.max(0, state.cursorIndex - 1);
  followCursor();
  emitChange();
}

export function setSpeed(speed) {
  state.speed = speed;
  if (state.playing) { stopAutoPlay(); play(); }
  else emitChange();
}

export function getState() {
  const { htf } = AppState.panels;
  const cursorCandle = htf ? htf.candles[state.cursorIndex] : null;
  return {
    active: state.active, playing: state.playing, speed: state.speed,
    cursorIndex: state.cursorIndex, total: htf ? htf.candles.length : 0,
    cursorEpoch: cursorCandle ? cursorCandle.epoch : null,
    atEnd: htf ? state.cursorIndex >= htf.candles.length - 1 : false,
    atStart: state.cursorIndex <= 0,
  };
}
