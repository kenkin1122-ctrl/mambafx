// IndexedDB store for BAZU signal records (database `bazu_siglog`).
// The existing research DB extension is scoped to `mfx_msd_experiments`; this isolated store uses the same guarded versioned-upgrade pattern without coupling BAZU to research data.
// Falls back to memory when IndexedDB is unavailable. Writes are batched and never throw into the caller (quota errors are swallowed and counted).

export const DB_NAME = 'bazu_siglog', DB_VERSION = 1, STORE = 'records';

const idle = (fn) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
};

export function openStore({ idb = globalThis.indexedDB, flushDelay = null } = {}) {
  const mem = new Map(), dirty = new Set(), dead = new Set();
  const stat = { mode: 'memory', writeErrors: 0, lastError: null, flushes: 0 };
  let db = null, flushing = false, scheduled = false;
  const sched = flushDelay == null ? idle : (fn) => setTimeout(fn, flushDelay);

  const ready = new Promise((resolve) => {
    if (!idb) return resolve();
    try {
      const rq = idb.open(DB_NAME, DB_VERSION);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        const os = d.objectStoreNames.contains(STORE) ? rq.transaction.objectStore(STORE) : d.createObjectStore(STORE, { keyPath: 'signal_id' });
        if (!os.indexNames.contains('decision_time_epoch_ms')) os.createIndex('decision_time_epoch_ms', 'decision_time_epoch_ms');
      };
      rq.onsuccess = () => { db = rq.result; stat.mode = 'indexeddb'; stat.lastError = null; db.onversionchange = () => { try { db.close(); } catch { /* closing */ } db = null; stat.mode = 'memory'; }; load().then(resolve); };
      rq.onerror = () => { stat.writeErrors++; stat.lastError = String(rq.error || 'IndexedDB open failed'); resolve(); };
      rq.onblocked = () => { stat.writeErrors++; stat.lastError = 'IndexedDB open was blocked'; resolve(); };
    } catch (e) { stat.writeErrors++; stat.lastError = String(e); resolve(); }
  });

  function load() {
    return new Promise((res) => {
      try {
        const r = db.transaction(STORE).objectStore(STORE).getAll();
        r.onsuccess = () => { for (const rec of r.result || []) if (!mem.has(rec.signal_id)) mem.set(rec.signal_id, rec); res(); };
        r.onerror = () => { stat.writeErrors++; stat.lastError = String(r.error || 'read failed'); res(); };
      } catch (e) { stat.writeErrors++; stat.lastError = String(e); res(); }
    });
  }

  function schedule() { if (scheduled) return; scheduled = true; sched(() => { scheduled = false; flush(); }); }

  async function flush() {
    if (flushing) return; flushing = true;
    try {
      await ready;
      if (!db || (!dirty.size && !dead.size)) return;
      const puts = [...dirty].map((id) => mem.get(id)).filter(Boolean), dels = [...dead];
      dirty.clear(); dead.clear();
      await new Promise((res) => {
        try {
          const tx = db.transaction(STORE, 'readwrite'), os = tx.objectStore(STORE);
          for (const r of puts) os.put(r);
          for (const id of dels) os.delete(id);
          tx.oncomplete = () => { stat.flushes++; res(); };
          tx.onerror = tx.onabort = () => {
            stat.writeErrors++; stat.lastError = String(tx.error || 'write failed');
            for (const r of puts) dirty.add(r.signal_id);
            for (const id of dels) dead.add(id);
            setTimeout(schedule, 5000);
            res();
          };
        } catch (e) {
          stat.writeErrors++; stat.lastError = String(e);
          for (const r of puts) dirty.add(r.signal_id);
          for (const id of dels) dead.add(id);
          setTimeout(schedule, 5000);
          res();
        }
      });
    } finally { flushing = false; }
  }

  return {
    ready, stat, flush,
    put(rec) { mem.set(rec.signal_id, rec); dirty.add(rec.signal_id); dead.delete(rec.signal_id); schedule(); },
    get: (id) => mem.get(id) || null,
    all: () => [...mem.values()],
    pendingRecords: () => [...mem.values()].filter((r) => !r.F?.finalised || r.G?.pending),
    count: () => mem.size,
    remove(ids) { for (const id of ids) { mem.delete(id); dirty.delete(id); dead.add(id); } schedule(); },
    clear() { const ids = [...mem.keys()]; this.remove(ids); },
    /** Expire old records and enforce a hard total-record cap, preserving the newest pending windows where possible. */
    prune({ maxRecords = 5000, retentionDays = 60, now = Date.now() } = {}) {
      const all = [...mem.values()].sort((a, b) => a.decision_time_epoch_ms - b.decision_time_epoch_ms), drop = [];
      const cut = now - retentionDays * 86400e3;
      for (const r of all) if (r.decision_time_epoch_ms < cut && r.F?.finalised && !r.G?.pending) drop.push(r.signal_id);
      const pendingCut = now - 2 * 86400e3;
      for (const r of all) if (r.decision_time_epoch_ms < pendingCut && (!r.F?.finalised || r.G?.pending)) drop.push(r.signal_id);
      const removed = new Set(drop), keep = all.filter((r) => !removed.has(r.signal_id));
      const excess = keep.length - Math.max(0, maxRecords);
      if (excess > 0) {
        const completed = keep.filter((r) => r.F?.finalised && !r.G?.pending);
        const remaining = Math.max(0, excess - completed.length);
        drop.push(...completed.slice(0, excess).map((r) => r.signal_id));
        if (remaining) drop.push(...keep.filter((r) => !r.F?.finalised || r.G?.pending).slice(0, remaining).map((r) => r.signal_id));
      }
      const unique = [...new Set(drop)];
      if (unique.length) this.remove(unique);
      return unique.length;
    },
  };
}
