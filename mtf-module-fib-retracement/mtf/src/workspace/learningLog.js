/**
 * workspace/learningLog.js
 *
 * Persistent log of trade outcomes paired with the Probability Engine's
 * evidence-dimension scores at the time of the trade — the dataset
 * ai/continuousLearning.js uses to gradually recalibrate which dimensions
 * have actually correlated with real outcomes in THIS user's own trading
 * history, rather than relying solely on the fixed default weights.
 *
 * Capped at MAX_ENTRIES to prevent unbounded localStorage growth over a
 * long trading history — old entries roll off oldest-first once the cap
 * is reached, which is an acceptable trade-off for a client-side log.
 */

const LOG_KEY = 'mtf_learning_log_v1';
const MAX_ENTRIES = 500;

function loadAll() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn('[learningLog] failed to read log:', err);
    return [];
  }
}

function saveAll(list) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('[learningLog] failed to save log (localStorage unavailable or full):', err);
  }
}

/**
 * @param {{symbol:string, dir:1|-1, won:boolean, pnl:number, approximate:boolean, dimensions:Array<{name:string,score:number}>}} entry
 */
export function recordOutcome(entry) {
  const list = loadAll();
  list.push({ ...entry, recordedAt: Date.now() });
  if (list.length > MAX_ENTRIES) list.shift();
  saveAll(list);
}

export function getLog() {
  return loadAll();
}

export function clearLog() {
  saveAll([]);
}

export function getLogSummary() {
  const log = loadAll();
  const won = log.filter(e => e.won).length;
  return { total: log.length, won, lost: log.length - won, winRatePct: log.length ? Math.round((won / log.length) * 100) : 0 };
}
