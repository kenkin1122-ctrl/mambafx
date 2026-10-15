/**
 * src/bazu/reconnect3m.js
 *
 * WebSocket supervisor (pure; timers and clock are injected so it is testable with a fake clock).
 * Implements Deriv's guidance: watch close/error, ping while connected, reconnect with increasing
 * delays, then re-authenticate / restore subscriptions / re-read state through `resync`.
 *
 * Half-open sockets never fire `close`, so a watchdog force-closes a socket that has been silent
 * (no message, including pong) for STALE_MS.
 */

export const LINK_DEFAULTS = Object.freeze({ PING_MS: 15000, STALE_MS: 40000, BASE_MS: 1000, FACTOR: 1.7, MAX_MS: 30000, JITTER: 0.25 });

/** Delay before reconnect attempt number `attempt` (0-based): exponential, capped, with +/- jitter. */
export function backoffDelay(attempt, cfg = LINK_DEFAULTS, rand = Math.random) {
  const raw = Math.min(cfg.MAX_MS, cfg.BASE_MS * Math.pow(cfg.FACTOR, attempt));
  const j = 1 + cfg.JITTER * (2 * rand() - 1);
  return Math.min(cfg.MAX_MS, Math.max(0, Math.round(raw * j)));
}

/**
 * deps: { connect(): Promise<void>  opens the socket and restores everything (auth, subscriptions, state);
 *         ping(): void              sends a ping on the live socket;
 *         forceClose(): void        closes the live socket (its close handler must call notifyClosed);
 *         wanted(): boolean         whether a connection is wanted at all;
 *         now(): ms, schedule(fn, ms) -> id, cancel(id), rand(), cfg, onState(state, info) }
 */
export function createSupervisor(deps) {
  const cfg = { ...LINK_DEFAULTS, ...(deps.cfg || {}) }, rand = deps.rand || Math.random;
  const onState = deps.onState || (() => {});
  let up = false, connecting = false, attempt = 0, retryId = null, hbId = null, lastMsgAt = 0, reconnects = 0, nextAt = null;

  const clearRetry = () => { if (retryId != null) { deps.cancel(retryId); retryId = null; nextAt = null; } };
  const stopHeartbeat = () => { if (hbId != null) { deps.cancel(hbId); hbId = null; } };

  function heartbeat() {
    hbId = null;
    if (!up) return;
    if (deps.now() - lastMsgAt > cfg.STALE_MS) { onState('stale', { silentMs: deps.now() - lastMsgAt }); deps.forceClose(); return; }
    try { deps.ping(); } catch { /* socket may already be closing; close handler takes over */ }
    hbId = deps.schedule(heartbeat, cfg.PING_MS);
  }

  function schedule() {
    if (retryId != null || connecting || up || !deps.wanted()) return;
    const delay = backoffDelay(attempt++, cfg, rand);
    nextAt = deps.now() + delay;
    onState('reconnecting', { attempt, delay });
    retryId = deps.schedule(() => { retryId = null; nextAt = null; run(); }, delay);
  }

  async function run() {
    if (connecting || up || !deps.wanted()) return;
    connecting = true; clearRetry();
    try {
      await deps.connect();
      up = true; lastMsgAt = deps.now();
      if (attempt > 0) reconnects++;
      attempt = 0; onState('up', { reconnects });
      stopHeartbeat(); hbId = deps.schedule(heartbeat, cfg.PING_MS);
    } catch (e) {
      onState('failed', { error: e?.message });
      connecting = false; schedule(); return;
    }
    connecting = false;
  }

  return {
    start: run,
    /** Any inbound frame (including pong) proves the link is alive. */
    touch() { lastMsgAt = deps.now(); },
    /** Call from the socket's close handler. */
    notifyClosed() { const was = up; up = false; stopHeartbeat(); if (was) onState('down', {}); schedule(); },
    /** Network came back / tab became visible: skip the remaining wait. */
    kick() { if (up || connecting || !deps.wanted()) return; clearRetry(); run(); },
    get status() { return { up, connecting, attempt, reconnects, nextAt }; },
  };
}
