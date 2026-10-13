/**
 * src/bazu/predict.js  (pure) — PREDICTION layer.
 * Combines the directional analysis features (indicators, structure, tick-delta proxies) into one
 * Rise/Fall call. The strength is a vote consensus (0..1), NOT a probability.
 */

const WINDOW = 400;

function zNow(values, i) {
  const v = values[i];
  if (!Number.isFinite(v)) return null;
  let n = 0, s = 0, s2 = 0;
  for (let j = Math.max(0, i - WINDOW + 1); j <= i; j++) { const x = values[j]; if (Number.isFinite(x)) { n++; s += x; s2 += x * x; } }
  if (n < 30) return null;
  const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  return sd > 0 ? (v - mean) / sd : 0;
}

/** Vote of one feature at index i: -1..1 (positive = Rise). */
export function featureVote(f, i) {
  const v = f.values[i];
  if (!Number.isFinite(v)) return null;
  if (f.discrete) return v > 0 ? 1 : v < 0 ? -1 : 0;
  const z = zNow(f.values, i);
  return z == null ? null : Math.max(-1, Math.min(1, z / 2));
}

export const MIN_STRENGTH = 0.2;

export function predictDirection(feats, prices) {
  const last = prices.length - 1;
  let sum = 0, n = 0, up = 0, down = 0, proxy = false;
  const votes = [];
  for (const [id, f] of Object.entries(feats)) {
    if (!f.directional) continue;
    const v = featureVote(f, last);
    if (v == null) continue;
    sum += v; n++;
    if (v > 0.05) up++; else if (v < -0.05) down++;
    votes.push({ id, vote: v, proxy: !!f.proxy });
  }
  if (!n) return null;
  const score = sum / n;
  const tieBreak = last > 0 && prices[last] !== prices[last - 1] ? Math.sign(prices[last] - prices[last - 1]) : 1;
  const direction = score > 0 ? 1 : score < 0 ? -1 : tieBreak;
  const drivers = votes.filter((x) => Math.sign(x.vote) === direction).sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote)).slice(0, 4);
  proxy = drivers.some((d) => d.proxy);
  return { direction, strength: Math.abs(score), up, down, total: n, drivers: drivers.map((d) => d.id), proxy };
}
