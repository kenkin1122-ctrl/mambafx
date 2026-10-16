// Signal logger: connects the engine to the record builder and the store. Logging only - it reads engine state, never changes it.
// Every entry point swallows its own errors so a logger fault can never reach trading.
import { buildRecord, finalizeF, finalizeG, gReady, entryExitIdx } from './siglog3m.js?v=19';
import { openStore } from './siglogStore3m.js?v=16';
import { configFor } from './config3m.js?v=17';

const DUR = /^(\d+)([tsmhd])$/;

export function createLogger({ store = openStore(), getMarket, getTrades = () => [], now = () => Date.now(), buildMeta = () => globalThis.MAMBAFX_BUILD || {}, configForMarket = configFor } = {}) {
  const stat = { errors: 0, lastError: null, written: 0, skipped: 0 };
  const seen = new Set(), pruneAt = { t: 0 }, sweepAt = { t: 0 };
  const queue = [];
  let draining = false;
  const cfgOf = (symbol) => configForMarket(symbol);
  const enabled = (symbol) => cfgOf(symbol || 'R_100').SIGNAL_LOGGING_ENABLED !== false;
  const guard = (fn) => { try { return fn(); } catch (e) { stat.errors++; stat.lastError = String(e && e.message || e); return null; } };

  function scheduleDrain() {
    if (draining || !queue.length) return;
    draining = true;
    const run = (deadline) => {
      try {
        if (queue.length && (!deadline || deadline.timeRemaining() > 2 || deadline.didTimeout)) {
          const job = queue.shift();
          try {
            const r = buildRecord(job.input);
            store.put(r); stat.written++;
            if (job.onBuilt) job.onBuilt(r);
            const t = now(), cfg = job.input.cfg;
            if (t - pruneAt.t > 60000) { pruneAt.t = t; store.prune({ maxRecords: cfg.SIGNAL_LOG_MAX_RECORDS, retentionDays: cfg.SIGNAL_LOG_RETENTION_DAYS, now: t }); }
          } catch (e) { stat.errors++; stat.lastError = String(e && e.message || e); }
        }
      } finally {
        draining = false;
        if (queue.length) scheduleDrain();
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(() => run(null), 0);
  }
  function enqueue(sig, m, { trade = null, rec = null, minStrength = null } = {}) {
    const cfg = cfgOf(sig.market || m.symbol), s = JSON.parse(JSON.stringify(minStrength != null ? { ...sig, minStrength } : sig));
    // Capture only bounded, decision-time market data synchronously; expensive frame/indicator work runs in idle time.
    const prices = m.prices.slice(-6000), epochs = m.epochs.slice(-6000), remote = {};
    for (const [k, candles] of Object.entries(m.remote || {})) remote[k] = candles.map((c) => ({ ...c }));
    queue.push({ input: { sig: s, cfg, symbol: m.symbol, name: m.name, prices, epochs, remote, trade: trade ? { ...trade } : null, rec: rec ? JSON.parse(JSON.stringify(rec)) : null, meta: { ...buildMeta() }, now: now() } });
    scheduleDrain();
  }

  return {
    store, stat, enabled,
    /** A trade was placed from a signal. */
    onBuy(trade, sig, m, opts) {
      return guard(() => {
        if (!sig || !m || !enabled(m.symbol) || !sig.decisionTs || seen.has('c' + trade.id)) return null;
        const pending = queue.find((j) => j.input.sig.signalId === sig.signalId);
        if (pending) {
          pending.input.sig = JSON.parse(JSON.stringify(sig));
          pending.input.trade = { ...trade };
          seen.add('c' + trade.id);
          return true;
        }
        const prior = store.all().find((r) => r.A?.signal_book_id === sig.signalId && !r.traded);
        if (prior && !prior.F?.finalised) {
          const promoted = { ...prior, traded: true, contract_id: String(trade.id), account_type: trade.isReal ? 'real' : 'demo', null_reasons: { ...prior.null_reasons } };
          delete promoted.null_reasons.contract_id;
          store.put(promoted);
          seen.add('c' + trade.id);
          return true;
        }
        if (store.all().some((r) => r.A?.signal_book_id === sig.signalId && r.traded)) return null;
        seen.add('c' + trade.id);
        enqueue(sig, m, { ...opts, trade });
        return true;
      });
    },
    /** A triggered signal that was not traded (only when SIGNAL_LOG_INCLUDE_UNTRADED is on). */
    onSignal(sig, m, opts) {
      return guard(() => {
        if (!sig || !m || !cfgOf(m.symbol).SIGNAL_LOG_INCLUDE_UNTRADED || !enabled(m.symbol) || !sig.signalId || !sig.decisionTs) return null;
        if (seen.has('s' + sig.signalId) || store.all().some((r) => r.A?.signal_book_id === sig.signalId) ||
          getTrades().some((t) => t.signalId === sig.signalId)) return null;
        seen.add('s' + sig.signalId);
        enqueue(sig, m, opts || {});
        return true;
      });
    },
    /** Finalise section F once a contract closed (or an untraded outcome is knowable) and section G once its window passed. */
    sweep(trades = getTrades()) {
      return guard(() => {
        let n = 0;
        const byId = new Map(trades.map((t) => [String(t.id), t]));
        const all = typeof store.pendingRecords === 'function' ? store.pendingRecords() : store.all();
        const ready = all.filter((r) => {
          const m = getMarket(r.market);
          if (!m?.epochs?.length) return false;
          const last = m.epochs.at(-1);
          if (!r.F?.finalised) {
            if (r.traded) return byId.get(String(r.contract_id))?.status === 'closed';
            const dp = DUR.exec(r._decision.durKey || '');
            return !!dp && (!!entryExitIdx(m.epochs, r._decision.epoch, { n: Number(dp[1]), unit: dp[2] }) || last - r._decision.epoch >= 3600);
          }
          return gReady(r, last);
        }).sort((a, b) => a.decision_time_epoch_ms - b.decision_time_epoch_ms).slice(0, 4);
        for (const r of ready) {
          const m = getMarket(r.market);
          const last = m.epochs.at(-1);
          if (!r.F?.finalised) {
            const t = r.contract_id != null ? byId.get(String(r.contract_id)) : null;
            if (r.traded) {
              if (!t || t.status !== 'closed') continue;
              store.put(finalizeF(r, { trade: t, prices: m.prices, epochs: m.epochs, now: now() })); n++;
            } else {
              const dp = DUR.exec(r._decision.durKey || ''); if (!dp) continue;
              const ee = entryExitIdx(m.epochs, r._decision.epoch, { n: Number(dp[1]), unit: dp[2] });
              if (!ee && last - r._decision.epoch < 3600) continue;
              store.put(finalizeF(r, { trade: null, prices: m.prices, epochs: m.epochs, now: now() })); n++;
            }
            continue;
          }
          if (gReady(r, last)) { store.put(finalizeG(r, { prices: m.prices, epochs: m.epochs, remote: m.remote || {}, now: now() })); n++; }
        }
        return n;
      });
    },
    tick() {
      const t = now();
      if (t - sweepAt.t < 1000) return;
      sweepAt.t = t;
      const run = () => { guard(() => this.sweep()); };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
      else setTimeout(run, 50);
    },
    flush() {
      return guard(() => {
        while (queue.length) {
          const job = queue.shift();
          try { store.put(buildRecord(job.input)); stat.written++; }
          catch (e) { stat.errors++; stat.lastError = String(e && e.message || e); }
        }
        return store.flush();
      });
    },
    pendingCount: () => store.all().filter((r) => !r.F?.finalised || r.G?.pending).length + queue.length,
  };
}
