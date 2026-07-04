/**
 * ai/marketIntelligence.js
 *
 * Smart Market Intelligence: reads the outputs of every analysis engine
 * already built (pattern recognition, structure/liquidity detection, order
 * flow, statistics, the rule engine, historical similarity) and composes
 * them into a natural-language report — bias, narrative, a synchronized
 * Daily→H4→H1→M15→M5→M1 cascade, a trade assessment, evidence, risks, and
 * historical context. Nothing here computes anything new; it's a
 * composition layer over Phases 11-16's existing, tested logic.
 *
 * No external AI API, matching Phase 14's constraint and this app's
 * philosophy throughout: every sentence below is chosen deterministically
 * from a fixed set of templates, keyed to real computed facts. This is
 * template-based natural-language composition, not a language model —
 * stated plainly here and in the UI, since "reads like an analyst's
 * report" could otherwise be mistaken for something it deliberately isn't.
 *
 * The Daily→H4→H1→M15→M5→M1 cascade needs real candles for four
 * timeframes neither panel currently displays. charts/socket.js's
 * fetchCandlesOnce() gets a one-shot snapshot (no live subscription) for
 * each; results are cached briefly (CACHE_TTL_MS) so re-triggering the
 * report on every minor UI event doesn't refetch four timeframes each time.
 */

import { AppState } from '../core/AppState.js';
import { fetchCandlesOnce } from '../charts/socket.js';
import { computeStats } from '../analysis/statistics.js';
import { computeOrderFlow } from '../orderflow/proxy.js';
import { runPatternScan } from '../analysis/patternEngine.js';
import { runRuleEngine } from './ruleEngine.js';
import { inferOverallTrend, detectStructureBreaks, detectLiquiditySweep } from '../analysis/structurePatterns.js';
import { findSimilarHistoricalWindows } from '../analysis/similarity.js';
import { replayCutoffEpoch } from '../charts/replayManager.js';

const CASCADE_TIMEFRAMES = [
  { key: 'daily', label: 'Daily', granularity: 86400 },
  { key: 'h4', label: 'H4', granularity: 14400 },
  { key: 'h1', label: 'H1', granularity: 3600 },
  { key: 'm15', label: 'M15', granularity: 900 },
  { key: 'm5', label: 'M5', granularity: 300 },
  { key: 'm1', label: 'M1', granularity: 60 },
];

const CACHE_TTL_MS = 60000;
let cascadeCache = { symbol: null, timestamp: 0, data: null };

async function fetchCascadeData(symbol) {
  const now = Date.now();
  if (cascadeCache.symbol === symbol && (now - cascadeCache.timestamp) < CACHE_TTL_MS) {
    return cascadeCache.data;
  }
  const results = await Promise.all(
    CASCADE_TIMEFRAMES.map(tf => fetchCandlesOnce(symbol, tf.granularity, 60).catch(() => null))
  );
  const data = {};
  CASCADE_TIMEFRAMES.forEach((tf, i) => { data[tf.key] = results[i]; });
  cascadeCache = { symbol, timestamp: now, data };
  return data;
}

/** One short verdict phrase per cascade level, each emphasizing what a trader looks for at that zoom level. */
function verdictFor(tfKey, candles) {
  if (!candles || candles.length < 15) return 'Not enough data loaded for this timeframe.';

  const trend = inferOverallTrend(candles);
  const { bos, choch } = detectStructureBreaks(candles);
  const sweeps = detectLiquiditySweep(candles);
  const lastBOS = bos[bos.length - 1];
  const lastCHoCH = choch[choch.length - 1];
  const lastSweep = sweeps[sweeps.length - 1];
  const lastIndex = candles.length - 1;
  const isRecent = idx => idx >= lastIndex - 6;

  if (tfKey === 'daily' || tfKey === 'h4') {
    const recentMomentum = computeStats(candles.slice(-6))?.momentumPct ?? 0;
    if (trend === 'up') {
      return tfKey === 'daily' ? 'Bullish trend remains intact.'
        : (recentMomentum < 0 ? 'Healthy pullback into demand.' : 'Trend continuing, no signs of exhaustion.');
    }
    if (trend === 'down') {
      return tfKey === 'daily' ? 'Bearish trend remains intact.'
        : (recentMomentum > 0 ? 'Corrective bounce into supply.' : 'Trend continuing, sellers in control.');
    }
    return 'No clear directional bias — range-bound conditions.';
  }

  if (tfKey === 'h1') {
    if (lastCHoCH && isRecent(lastCHoCH.index)) return `${lastCHoCH.direction === 'bullish' ? 'Bullish' : 'Bearish'} change of character — control may be shifting.`;
    if (lastBOS && isRecent(lastBOS.index)) return `${lastBOS.direction === 'bullish' ? 'Bullish' : 'Bearish'} BOS confirms ${lastBOS.direction === 'bullish' ? 'buyers' : 'sellers'} remain in control.`;
    return trend ? `${trend === 'up' ? 'Bullish' : 'Bearish'} structure intact, no fresh break yet.` : 'Structure unclear at this level.';
  }

  if (tfKey === 'm15') {
    if (lastSweep && isRecent(lastSweep.index)) return 'Liquidity grab completed.';
    return trend ? `${trend === 'up' ? 'Bullish' : 'Bearish'} bias, watching for a liquidity reaction.` : 'No liquidity event detected recently.';
  }

  if (tfKey === 'm5') {
    const earlier = computeStats(candles.slice(-15, -6));
    const recent = computeStats(candles.slice(-6));
    if (!earlier || !recent) return 'Momentum unclear.';
    const magNow = Math.abs(recent.momentumPct), magEarlier = Math.abs(earlier.momentumPct) || 0.01;
    if (magNow > magEarlier * 1.3) return 'Momentum expanding.';
    if (magNow < magEarlier * 0.7) return 'Momentum contracting.';
    return 'Momentum steady.';
  }

  if (tfKey === 'm1') {
    const findings = runPatternScan(candles);
    const latest = findings.find(f => isRecent(f.index));
    return latest ? `Execution trigger confirmed — ${latest.label.toLowerCase()} on the latest candle.` : 'No immediate execution trigger yet — waiting for confirmation.';
  }

  return 'No data.';
}

function deriveBias(trend, ruleResults) {
  const bullishCont = ruleResults.find(r => r.type === 'bullishContinuation');
  const bearishCont = ruleResults.find(r => r.type === 'bearishContinuation');
  const reversal = ruleResults.find(r => r.type === 'reversal');
  const rangebound = ruleResults.find(r => r.type === 'accumulation' || r.type === 'distribution');

  if (bullishCont && bullishCont.confidence > 60) return 'Bullish';
  if (bearishCont && bearishCont.confidence > 60) return 'Bearish';
  if (reversal && reversal.confidence > 65) return reversal.direction === 'bullish' ? 'Bullish' : 'Bearish';
  if (rangebound) return 'Ranging';
  if (trend === 'up') return 'Bullish';
  if (trend === 'down') return 'Bearish';
  return 'Neutral';
}

function composeNarrative(candles, findings, ruleResults, flow, trend) {
  const sentences = [];
  const sweep = [...findings].reverse().find(f => f.type === 'liquiditySweep');
  const choch = [...findings].reverse().find(f => f.type === 'choch');
  const bos = [...findings].reverse().find(f => f.type === 'bos');
  const first = candles[0], last = candles[candles.length - 1];
  const openedDirection = last.close >= first.open ? 'higher' : 'lower';

  if (sweep) {
    sentences.push(`Price initially moved ${sweep.direction === 'bullish' ? 'lower, sweeping sell-side liquidity' : 'higher, sweeping buy-side liquidity'} before reversing.`);
  } else {
    sentences.push(`Price moved ${openedDirection} across the period without a clearly defined liquidity sweep.`);
  }

  if (choch) {
    sentences.push(`${choch.direction === 'bullish' ? 'Buyers absorbed the selling pressure and regained control' : 'Sellers absorbed the buying pressure and regained control'}, producing a ${choch.direction} Change of Character${bos ? ' followed by a Break of Structure' : ''}.`);
  } else if (bos) {
    sentences.push(`A ${bos.direction} Break of Structure confirmed the prevailing trend.`);
  }

  const continuation = ruleResults.find(r => r.type === 'bullishContinuation' || r.type === 'bearishContinuation');
  const rangebound = ruleResults.find(r => r.type === 'accumulation' || r.type === 'distribution');
  if (continuation) {
    sentences.push(`Momentum expanded with shallow pullbacks, indicating sustained ${continuation.direction === 'bullish' ? 'buying' : 'selling'} pressure.`);
  } else if (rangebound) {
    sentences.push(`Price has been ${rangebound.type === 'accumulation' ? 'basing, absorbing supply' : 'stalling under distribution'} with little net progress despite real range being traversed.`);
  }

  if (trend) {
    const flowSupports = trend === 'up' ? flow?.buyingPressurePct > 55 : flow?.sellingPressurePct > 55;
    sentences.push(`The higher-timeframe trend remains ${trend === 'up' ? 'bullish' : 'bearish'}${flowSupports ? ', and order flow continues to support the move' : ''}.`);
  } else {
    sentences.push('No clear higher-timeframe trend is established at this time.');
  }

  return sentences.join(' ');
}

function composeTradeAssessment(bias, ruleResults) {
  let direction = 'Wait';
  if (bias === 'Bullish') direction = 'Rise';
  else if (bias === 'Bearish') direction = 'Fall';

  const exhaustion = ruleResults.find(r => r.type === 'distribution' || r.type === 'accumulation');
  const reasoning = [];
  if (direction === 'Rise' || direction === 'Fall') {
    reasoning.push(`Current evidence suggests ${direction === 'Rise' ? 'buyers' : 'sellers'} remain in control.`);
    reasoning.push(exhaustion ? 'Early signs of stalling are present — worth watching closely.' : 'No significant signs of exhaustion are detected.');
    reasoning.push('The probability currently favors continuation rather than reversal.');
  } else {
    reasoning.push('Evidence is mixed, with no clear directional edge.');
    reasoning.push('Waiting for a clearer structural signal is preferable to forcing a position.');
  }
  return { direction, reasoning };
}

function composeEvidence(ruleResults, flow, findings, trend) {
  const items = [];
  if (trend === 'up') items.push('Buyers are defending higher prices.');
  else if (trend === 'down') items.push('Sellers are defending lower prices.');

  const continuation = ruleResults.find(r => r.type === 'bullishContinuation' || r.type === 'bearishContinuation');
  if (continuation) items.push('Pullbacks remain shallow.');

  const lastChoch = [...findings].reverse().find(f => f.type === 'choch');
  const opposingChoch = lastChoch && ((trend === 'up' && lastChoch.direction === 'bearish') || (trend === 'down' && lastChoch.direction === 'bullish'));
  items.push(opposingChoch ? 'A change of character against the current bias has been detected — treat with caution.' : 'No significant market structure break against the current bias detected.');

  const trendStrength = ruleResults.find(r => r.type === 'trendStrength');
  if (trendStrength && trendStrength.confidence > 50) items.push('Momentum is increasing.');

  if (flow) {
    if (flow.buyingPressurePct > 55) items.push('Order-flow proxy favors buyers.');
    else if (flow.sellingPressurePct > 55) items.push('Order-flow proxy favors sellers.');
    else items.push('Order-flow proxy is balanced between buyers and sellers.');
  }
  return items;
}

function composeRisks(bias) {
  if (bias === 'Bullish') {
    return ['A bearish change of character forms.', 'Momentum begins contracting.', 'Buyers fail to defend the most recent higher low.'];
  }
  if (bias === 'Bearish') {
    return ['A bullish change of character forms.', 'Momentum begins contracting.', 'Sellers fail to defend the most recent lower high.'];
  }
  return ['Price breaks decisively out of the current range without a clear liquidity reaction preceding it.'];
}

/** Deliberately no numbers in the returned text — see this module's docblock on avoiding raw metrics in the displayed report. */
function composeHistoricalContext(similarity, trend) {
  if (!similarity.available) return 'Not enough historical structure loaded yet to draw a meaningful comparison.';
  const dirWord = trend === 'up' ? 'bullish continuation' : 'bearish continuation';
  if (similarity.continuedCount > similarity.reversedCount) {
    return `The current structure closely resembles previous ${dirWord} structures. Historically, similar structures in the loaded history more often continued in the same direction than reversed.`;
  }
  if (similarity.reversedCount > similarity.continuedCount) {
    return `The current structure resembles past setups that more often reversed than continued in the loaded history — worth treating the current bias with extra caution.`;
  }
  return `Similar historical structures in the loaded history show a mixed record, offering no strong historical lean either way.`;
}

/**
 * Generate the full report. Async because the cascade needs a WebSocket
 * round-trip for timeframes not currently loaded.
 * @returns {Promise<object>}
 */
export async function generateMarketIntelligence() {
  const { htf } = AppState.panels;
  if (!htf || !htf.candles.length) return { available: false, reason: 'No chart data loaded yet.' };

  const cutoff = replayCutoffEpoch();
  const htfCandles = cutoff !== null ? htf.candles.filter(c => c.epoch < cutoff) : htf.candles;
  if (htfCandles.length < 15) return { available: false, reason: 'Not enough candles loaded yet to analyze.' };

  const flow = computeOrderFlow(htfCandles.slice(-20));
  const findings = runPatternScan(htfCandles);
  const ruleResults = runRuleEngine(htfCandles);
  const trend = inferOverallTrend(htfCandles);
  const similarity = findSimilarHistoricalWindows(htfCandles);

  const bias = deriveBias(trend, ruleResults);
  const narrative = composeNarrative(htfCandles, findings, ruleResults, flow, trend);
  const tradeAssessment = composeTradeAssessment(bias, ruleResults);
  const evidence = composeEvidence(ruleResults, flow, findings, trend);
  const risks = composeRisks(bias);
  const historicalContext = composeHistoricalContext(similarity, trend);

  let cascade = [];
  try {
    const cascadeData = await fetchCascadeData(AppState.symbol);
    cascade = CASCADE_TIMEFRAMES.map(tf => ({ label: tf.label, verdict: verdictFor(tf.key, cascadeData[tf.key]) }));
  } catch (err) {
    cascade = [];
  }

  return { available: true, bias, narrative, cascade, tradeAssessment, evidence, risks, historicalContext, isReplay: cutoff !== null };
}
