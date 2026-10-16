/**
 * src/bazu/reports3m.js
 * Report calculations and browser exports. Performance tables contain outcomes only, never profit or equity data.
 */
import { wilson } from './stats.js?v=16';
import { zipStoreAsync, sha256Hex, utf8 } from './zip3m.js?v=16';
import { SCHEMA_VERSION, validateRecord } from './siglog3m.js?v=18';

const fin = Number.isFinite;
const csvCell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const ciObj = (w) => ({ n: w.n, wins: w.k, rate: w.p, ci95: [w.lo, w.hi] });
const pctText = (x) => x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;

export function outcomeOfTrade(t) {
  if (t.entry != null && t.exit != null && Number(t.entry) === Number(t.exit)) return 'tie';
  if (t.result === 'win' || t.result === 'loss' || t.result === 'tie') return t.result;
  if (t.derivStatus === 'won') return 'win';
  if (t.derivStatus === 'lost') return 'loss';
  return null;
}

export function durationBucket(key, durationSeconds = null) {
  const m = /^(\d+)([tsmhd])$/.exec(String(key || ''));
  if (!m) return 'unknown';
  const secs = fin(durationSeconds) ? durationSeconds : m[2] === 't' ? null : Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
  if (secs == null) return 'tick-duration';
  return secs < 60 ? '<1m' : secs < 300 ? '1–5m' : secs < 900 ? '5–15m' : secs < 3600 ? '15–60m' : '>=1h';
}

function signalMap(records) {
  const m = new Map();
  for (const r of records || []) if (r.signal_id) {
    if (r.A?.signal_book_id) m.set(r.A.signal_book_id, r);
    if (r.contract_id) m.set(String(r.contract_id), r);
  }
  return m;
}

/** Build the requested date-/market-/duration-/playbook-filtered rows for the selected view. */
export function performanceRows({ trades = [], signals = [], view = 'market', filters = {}, minN = 30, sort = 'rate' } = {}) {
  const bySignal = signalMap(signals), groups = new Map();
  const inRange = (ts) => (!filters.from || ts >= Date.parse(`${filters.from}T00:00:00Z`)) &&
    (!filters.to || ts < Date.parse(`${filters.to}T00:00:00Z`) + 86400000);
  const add = (x) => {
    if (!x.outcome || !inRange(x.ts)) return;
    if (filters.marketClass && filters.marketClass !== 'all' && x.marketClass !== filters.marketClass) return;
    if (filters.durationBucket && filters.durationBucket !== 'all' && durationBucket(x.duration, x.durationSeconds) !== filters.durationBucket) return;
    if (filters.playbook && filters.playbook !== 'all' && x.playbook !== filters.playbook) return;
    if (filters.accountType && filters.accountType !== 'all' && x.accountType !== filters.accountType) return;
    if (filters.outcomeType === 'traded' && !x.traded) return;
    if (filters.outcomeType === 'shadow' && x.traded) return;
    const label = view === 'playbook' ? x.playbook : view === 'market-playbook' ? `${x.market} · ${x.playbook}` : x.market;
    const key = `${label}\u0000${x.accountType}`;
    if (!groups.has(key)) groups.set(key, { key: label, market: view === 'playbook' ? null : x.market, playbook: view === 'market' ? null : x.playbook, accountType: x.accountType, outcomes: [], durations: new Map() });
    const g = groups.get(key); g.outcomes.push(x.outcome); g.durations.set(x.duration, (g.durations.get(x.duration) || 0) + 1);
  };
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    const r = bySignal.get(t.signalId) || bySignal.get(String(t.id));
    add({ market: t.market, marketClass: r?.market_class || t.marketClass || marketClassOf(t.market), playbook: r?.A?.playbook || t.playbook || 'manual', duration: t.duration, durationSeconds: r?.A?.duration?.seconds, ts: t.settledAt || t.ts, outcome: outcomeOfTrade(t), traded: true, accountType: t.isReal ? 'real' : 'demo' });
  }
  for (const r of signals) {
    if (!r.F?.finalised) continue;
    const duration = r.A?.duration?.key;
    const shadow = r.traded
      ? r.F.hypothetical_outcomes?.find((x) => x.duration === duration)?.traded_direction
      : r.F.result;
    if (!shadow) continue;
    add({ market: r.market, marketClass: r.market_class, playbook: r.A?.playbook || 'unknown', duration, durationSeconds: r.A?.duration?.seconds, ts: r.decision_time_epoch_ms, outcome: String(shadow).toLowerCase(), traded: false, accountType: 'shadow' });
  }
  const rows = [...groups.values()].map((g) => {
    const wins = g.outcomes.filter((x) => x === 'win').length, losses = g.outcomes.filter((x) => x === 'loss').length, ties = g.outcomes.filter((x) => x === 'tie').length;
    const n = wins + losses + ties, ci = wilson(wins, n), topDuration = [...g.durations].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
    return { key: g.key, market: g.market, playbook: g.playbook, accountType: g.accountType, n, wins, losses, ties, rate: n ? wins / n : null, ci95: [ci.lo, ci.hi], commonDuration: topDuration, lowSample: n < minN, rank: null };
  });
  rows.sort((a, b) => a.accountType.localeCompare(b.accountType) || (sort === 'lower' ? b.ci95[0] - a.ci95[0] : b.rate - a.rate) || b.n - a.n || a.key.localeCompare(b.key));
  let rank = 0, account = null;
  for (const r of rows) {
    if (r.accountType !== account) { account = r.accountType; rank = 0; }
    if (!r.lowSample) r.rank = ++rank;
  }
  return rows;
}
function marketClassOf(s) {
  if (/^BOOM|^CRASH/i.test(s || '')) return 'boomcrash';
  if (/^JD/i.test(s || '')) return 'jump';
  if (/^stpRNG/i.test(s || '')) return 'step';
  if (/^RB\d/i.test(s || '')) return 'rangebreak';
  if (/^RDBULL|^RDBEAR/i.test(s || '')) return 'bullbear';
  return 'volatility';
}

const PERF_FIELDS = ['rank', 'account_type', 'market', 'playbook', 'contracts_n', 'wins', 'losses', 'ties', 'win_rate', 'wilson_95_low', 'wilson_95_high', 'most_common_duration', 'sample_status'];
export function performanceReport(rows, view, filters = {}) {
  const fields = PERF_FIELDS;
  const out = rows.map((r) => ({
    rank: r.rank, account_type: r.accountType, market: r.market ?? (view === 'playbook' ? '' : r.key), playbook: r.playbook ?? (view === 'playbook' ? r.key : ''),
    contracts_n: r.n, wins: r.wins, losses: r.losses, ties: r.ties, win_rate: r.rate,
    wilson_95_low: r.ci95[0], wilson_95_high: r.ci95[1], most_common_duration: r.commonDuration, sample_status: r.lowSample ? 'low sample' : 'ranked',
  }));
  return { report: 'BAZU Performance log', view, filters, columns: fields, rows: out, note: 'Win rate = wins / (wins + losses + ties). Ties count as non-wins. Low-sample rows are unranked. Demo, real, and shadow outcomes remain separate.' };
}

export function reportCsv(report) {
  const rows = report.rows || [];
  return [report.columns.map(csvCell).join(','), ...rows.map((r) => report.columns.map((k) => csvCell(r[k])).join(','))].join('\r\n');
}
export function printableHtml(title, report) {
  const cols = report.columns || [], rows = report.rows || [];
  const meta = `${report.filters ? `<p>Filters: ${escapeHtml(JSON.stringify(report.filters))}</p>` : ''}${report.note ? `<p>${escapeHtml(report.note)}</p>` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui,sans-serif;margin:2rem;color:#15202b}h1{font-size:1.4rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #aaa;padding:.35rem;text-align:left}th{background:#eee}.low{color:#777}@media print{body{margin:10mm}button{display:none}table{font-size:9pt}tr{break-inside:avoid}thead{display:table-header-group}}</style></head><body><h1>${escapeHtml(title)}</h1><p>Generated ${new Date().toISOString()}. Rates are Wilson 95% intervals; low-sample rows are not ranked.</p>${meta}<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr class="${Object.hasOwn(r, 'rank') && r.rank == null ? 'low' : ''}">${cols.map((c) => `<td>${escapeHtml(r[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table><script>window.print()</script></body></html>`;
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bootstrapMedianCI(values, reps = 1000, seed = 0x4d424658) {
  const sorted = values.filter(fin).sort((a, b) => a - b), med = (a) => a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
  if (!sorted.length) return { n: 0, median: null, ci95: [null, null] };
  let x = seed >>> 0; const rand = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const bs = [];
  for (let b = 0; b < reps; b++) { const a = Array.from({ length: sorted.length }, () => sorted[Math.floor(rand() * sorted.length)]); bs.push(med(a)); }
  bs.sort((a, b) => a - b);
  return { n: sorted.length, median: med(sorted), ci95: [bs[Math.floor(.025 * reps)], bs[Math.floor(.975 * reps)]] };
}
function bootstrapMeanCI(values, reps = 1000, seed = 0x4d424658) {
  const x = values.filter(fin);
  if (!x.length) return { n: 0, mean: null, ci95: [null, null] };
  const mean = (a) => a.reduce((sum, value) => sum + value, 0) / a.length;
  let state = seed >>> 0;
  const rand = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const bs = [];
  for (let b = 0; b < reps; b++) bs.push(mean(Array.from({ length: x.length }, () => x[Math.floor(rand() * x.length)])));
  bs.sort((a, b) => a - b);
  return { n: x.length, mean: mean(x), ci95: [bs[Math.floor(.025 * reps)], bs[Math.floor(.975 * reps)]] };
}
function rateGroup(items) {
  const n = items.length, wins = items.filter((x) => x === 'win').length;
  return ciObj(wilson(wins, n));
}

/** Full calibration report source. */
export function calibrationReport({ records = [], signalRecords = [], trades = [], expiryCurve = null } = {}) {
  const completed = records.filter((r) => r.realised?.kind != null), errors = (items, prediction, actual) => {
    const usable = items.filter((r) => fin(prediction(r)) && fin(actual(r)) && actual(r) > 0);
    const censored = items.filter((r) => r.realised?.kind == null || r.realised?.kind === 'none').length;
    const e = bootstrapMedianCI(usable.map((r) => prediction(r) - actual(r)));
    return { n: usable.length, median_error_s: e.median, median_error_ci95: e.ci95, censored_n: censored };
  };
  const byPlaybook = {};
  for (const k of new Set(completed.map((r) => r.playbook))) {
    const a = completed.filter((r) => r.playbook === k);
    byPlaybook[k] = errors(a, (r) => r.predicted, (r) => r.realised.secs);
  }
  const byEstimator = {};
  for (const k of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6']) byEstimator[k] = errors(completed, (r) => r.estimators?.[k], (r) => r.realised.secs);
  const resolvedSignals = signalRecords.filter((r) => r.F?.finalised && r.F.result);
  const grouped = (keyFn, pred = (r) => r.F.result.toLowerCase()) => {
    const g = new Map();
    for (const r of resolvedSignals) {
      const label = keyFn(r); if (!label) continue;
      const k = `${r.traded ? r.account_type : 'shadow'} · ${label}`;
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(pred(r));
    }
    return Object.fromEntries([...g].map(([k, v]) => [k, rateGroup(v)]));
  };
  const vetoSamples = (wait) => records.filter((r) => r.features?.wait === wait).map((r) => r.shadow?.[r.durKey]).filter(Boolean);
  const veto = {
    vetoed: rateGroup(vetoSamples(true)),
    allowed: rateGroup(vetoSamples(false)),
    definition: 'Hypothetical chosen-duration outcomes from the existing calibration records, grouped by features.wait. Records are sampled under the existing logging cadence; this is descriptive, not a counterfactual causal estimate.',
  };
  const dissent = aggregateDissent(resolvedSignals);
  const byAccountMeasure = (field) => Object.fromEntries(['demo', 'real'].map((kind) => [kind, bootstrapMedianCI(signalRecords.filter((r) => r.account_type === kind).map((r) => r.F?.[field]).filter(fin))]));
  const expiry = expiryCurve ? (() => {
    const summarize = (data) => {
      const { samples = [], curve = [], ...meta } = data;
      const bins = curve.map((bin) => {
        const interval = bin.n ? wilson(Math.round(bin.observed * bin.n), bin.n) : null;
        return { ...bin, observed_ci95: interval ? [interval.lo, interval.hi] : [null, null] };
      });
      const losses = samples.map((s) => (s.probability - s.outcome) ** 2);
      const baselineLosses = samples.map((s) => (0.5 - s.outcome) ** 2);
      return { ...meta, curve: bins, brier_ci95: bootstrapMeanCI(losses), brier50_ci95: bootstrapMeanCI(baselineLosses) };
    };
    const { by_account_type = {}, ...overall } = expiryCurve;
    return {
      ...summarize(overall),
      by_account_type: Object.fromEntries(Object.entries(by_account_type).map(([type, data]) => [type, summarize(data)])),
      source: 'existing analytic live-contract estimator; probability snapshotted at half-time and compared with Deriv result',
    };
  })() : { status: 'not implemented: expiry-probability calibration data was not supplied' };
  return {
    report: 'BAZU Calibration', generated_utc: new Date().toISOString(),
    lifetime_by_playbook: byPlaybook, lifetime_by_estimator: byEstimator,
    target_touched_but_contract_lost: { n: records.filter((r) => r.realised?.kind === 'target' && r.realised.secs <= r.durSec && r.shadow?.[r.durKey] === 'loss').length, target_touched_in_duration_n: records.filter((r) => r.realised?.kind === 'target' && r.realised.secs <= r.durSec).length },
    hit_rate_by_duration: grouped((r) => r.A?.duration?.key, (r) => r.F.result.toLowerCase()),
    hit_rate_by_momentum_state: grouped((r) => r.C?.immediate_momentum?.state || 'not available'),
    hit_rate_by_trigger_type: grouped((r) => r.A?.trigger || 'not available'),
    family_agreement_level: grouped((r) => `${(r.E?.prediction?.families_agree || []).length} agreeing families`),
    veto_audit: veto, expiry_probability_curve: expiry,
    decision_to_entry_latency_s_by_account_type: byAccountMeasure('decision_to_entry_delay_s'), slippage_points_by_account_type: byAccountMeasure('slippage_points'),
    data_quality: { stale_or_missing_tick_field_occurrences: countReasons(signalRecords, /stale|tick|data unavailable/i), censored_outcomes: signalRecords.filter((r) => r.F?.censored).length, missing_or_unimplemented_field_occurrences: countReasons(signalRecords, /not available|not implemented/i), counts_are_reasoned_field_occurrences: true },
    aggregate_dissent: dissent,
    limitations: ['The sample may be small and overlapping signals are not independent.', 'Demo and real outcomes are identified separately; one account type is not evidence of live performance.', 'Shadow results use first tick after decision, duration-specific tick exit rules, and ties as losses.', 'A per-trade attribution is anecdotal; aggregate group rates with small N are not evidence.'],
    meta: { signal_records: signalRecords.length, resolved_signal_records: resolvedSignals.length, calibration_records: records.length, closed_contracts: trades.filter((t) => t.status === 'closed').length },
  };
}

function countReasons(records, re) {
  let n = 0;
  for (const r of records) {
    const walk = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.forEach(walk);
      for (const [k, x] of Object.entries(v)) {
        if (k === 'null_reasons') {
          for (const s of Object.values(x || {})) if (re.test(s)) n++;
        } else if (x && typeof x === 'object') walk(x);
      }
    };
    walk(r);
  }
  return n;
}

/** Aggregate retrospective correctness by factor/family and vote class, plus same-duration opposite shadow result. */
export function aggregateDissent(records, minN = 30) {
  const bins = new Map();
  const add = (key, group, accountType, outcomeType, outcome, opposite) => {
    const id = `${accountType}|${key}|${group}`; if (!bins.has(id)) bins.set(id, { factor_or_family: key, vote_group: group, account_type: accountType, outcome_type: outcomeType, outcomes: [], opposite: [] });
    const x = bins.get(id); if (outcome) x.outcomes.push(outcome); if (opposite) x.opposite.push(opposite);
  };
  for (const r of records) {
    const y = r.F?.result?.toLowerCase(), opp = r.F?.hypothetical_outcomes?.find((x) => x.duration === r.A?.duration?.key)?.opposite_direction;
    if (!y) continue;
    const accountType = r.traded ? r.account_type : 'shadow', outcomeType = r.traded ? 'traded' : 'shadow';
    for (const v of r.F?.hindsight?.factors || []) add(v.factor, v.class.startsWith('agreed') ? 'agreed' : v.class.startsWith('dissented') ? 'dissented' : 'neutral', accountType, outcomeType, y, opp);
    for (const v of r.F?.hindsight?.families || []) add('family:' + v.family, v.class.startsWith('agreed') ? 'agreed' : v.class.startsWith('dissented') ? 'dissented' : 'neutral', accountType, outcomeType, y, opp);
  }
  return [...bins.values()].map((x) => {
    const actual = rateGroup(x.outcomes), opposite = rateGroup(x.opposite);
    return { factor_or_family: x.factor_or_family, vote_group: x.vote_group, account_type: x.account_type, outcome_type: x.outcome_type, actual, opposite_direction_hypothetical: opposite, insufficient_sample: actual.n < minN || opposite.n < minN, note: actual.n < minN || opposite.n < minN ? `insufficient sample (MIN_N_FOR_RANK=${minN}); differences are not evidence` : 'observational comparison; not causal' };
  });
}

export async function buildSignalPackage(records, { from, to, schema, readme, dataDictionary, buildId = null, configHash = null, signalSummary = null, yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}) {
  const selected = records.filter((r) => r.traded && (!from || r.decision_time_epoch_ms >= Date.parse(`${from}T00:00:00Z`)) && (!to || r.decision_time_epoch_ms < Date.parse(`${to}T00:00:00Z`) + 86400000));
  const entries = [], manifestFiles = [];
  const summaryHeader = ['signal_id', 'timestamp', 'market', 'playbook', 'direction', 'state', 'score', 'duration', 'adx', 'atr', 'candle_range_atr', 'room_ratio', 'veto_reasons', 'families_agree', 'families_oppose', 'expiry_probability', 'outcome', 'first_touch', 'price_change', 'adverse_excursion', 'break_even', 'win_flag'];
  const rows = [], ndjsonLines = [], skipped = [];
  for (const r of selected) {
    const errors = validateRecord(r);
    if (errors.length) { skipped.push({ signal_id: r.signal_id, errors: errors.slice(0, 5) }); continue; }
    const day = utcDate(r.decision_time_epoch_ms), market = String(r.market).replace(/[^A-Za-z0-9_.-]/g, '_');
    const path = `logs/signals/${day}/${market}/signal_${r.signal_id}.json`, text = JSON.stringify(r, null, 2);
    entries.push({ name: path, data: text }); manifestFiles.push({ path, sha256: await sha256Hex(utf8(text)) });
    ndjsonLines.push(JSON.stringify(r));
    rows.push({
      signal_id: r.signal_id, timestamp: r.decision_time_iso, market: r.market, playbook: r.A.playbook, direction: r.A.direction,
      state: r.A.state_transitions.at(-1)?.to || 'TRIGGERED', score: r.A.score?.value ?? '', duration: r.A.duration?.key ?? '',
      adx: r.B.indicators.adx_14 ?? '', atr: r.B.indicators.atr_14 ?? '', candle_range_atr: r.C.current_candle?.range_atr ?? '',
      room_ratio: r.D.room_ratio ?? '', veto_reasons: (r.D.checks || []).filter((x) => x.result !== 'PASS').map((x) => x.name).join('|'),
      families_agree: (r.E.prediction.families_agree || []).join('|'), families_oppose: (r.E.prediction.families_oppose || []).join('|'),
      expiry_probability: r.E.prediction.expiry_probability ?? '', outcome: r.F.result ?? '', first_touch: r.F.first_touch ?? '',
      price_change: r.F.price_change ?? '', adverse_excursion: r.F.max_adverse_atr ?? '', break_even: r.E.prediction.break_even ?? '',
      win_flag: r.F.result === 'Win' ? 1 : r.F.result === 'Loss' || r.F.result === 'Tie' ? 0 : '',
    });
    await yieldControl();
  }
  const csv = [summaryHeader.map(csvCell).join(','), ...rows.map((r) => summaryHeader.map((k) => csvCell(r[k])).join(','))].join('\r\n');
  entries.push({ name: 'signals_summary.csv', data: csv });
  const ndjson = ndjsonLines.join('\n') + (rows.length ? '\n' : '');
  entries.push({ name: 'signals.ndjson', data: ndjson });
  entries.push({ name: 'schema/signal.schema.json', data: JSON.stringify(schema, null, 2) });
  entries.push({ name: 'README.md', data: readme });
  entries.push({ name: 'data_dictionary.md', data: dataDictionary });
  for (const f of entries) if (!manifestFiles.some((x) => x.path === f.name)) manifestFiles.push({ path: f.name, sha256: await sha256Hex(utf8(f.data)) });
  const meta = {
    schema_version: SCHEMA_VERSION, build_id: buildId ?? selected[0]?.software?.build_id ?? null,
    config_hash: configHash ?? selected[0]?.config_hash ?? null, record_count: rows.length, skipped_invalid_records: skipped,
    date_range_utc: { from: from || null, to: to || null }, file_hashes_sha256: manifestFiles,
  };
  entries.push({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });
  return { zip: await zipStoreAsync(entries, Date.now(), { yieldControl }), summaryCsv: csv, ndjson, manifest: meta, count: rows.length, skipped, entries };
}

export function downloadBlob(name, mime, data) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function saveBlob(name, mime, data) {
  if (typeof window.showSaveFilePicker !== 'function') { downloadBlob(name, mime, data); return 'download'; }
  const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: mime, accept: { [mime]: [`.${name.split('.').pop()}`] } }] });
  const w = await handle.createWritable();
  try { await w.write(data); await w.close(); } catch (e) { await w.abort(); throw e; }
  return 'file-system';
}

export async function savePackageToFolder(entries) {
  if (typeof window.showDirectoryPicker !== 'function') {
    downloadBlob('bazu-signal-package.zip', 'application/zip', await zipStoreAsync(entries));
    return 'download';
  }
  const root = await window.showDirectoryPicker({ mode: 'readwrite' });
  for (const entry of entries) {
    const parts = entry.name.split('/'), filename = parts.pop();
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const file = await dir.getFileHandle(filename, { create: true }), w = await file.createWritable();
    try { await w.write(entry.data); await w.close(); }
    catch (e) { await w.abort(); throw e; }
  }
  return 'directory';
}
