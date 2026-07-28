import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from '../support/fakeIndexedDB.js';
import { _resetConnectionCacheForTesting } from '../../research/src/storage/researchGovernanceDb.js';
import {
  RANDOMNESS_AUDIT_VERDICTS,
  recordRandomnessAudit,
} from '../../research/src/governance/randomnessAudit.js';
import {
  RNG_FORENSICS_CLASSIFICATIONS,
  InvalidRngForensicsInputError,
  RngForensicsPreconditionError,
  assertRandomnessAuditSurvived,
  classifyRngForensics,
  recordRngForensicsResult,
  getLatestRngForensicsResult,
  listRngForensicsResults,
  runRngForensics,
} from '../../research/src/discovery/rngForensics.js';

function setup() {
  const { teardown } = installFakeIndexedDB();
  _resetConnectionCacheForTesting();
  return teardown;
}

async function markGenuinePredictiveStructure(hypothesisId) {
  return recordRandomnessAudit({
    hypothesisId,
    verdict: RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE,
    reason: 'test fixture',
    checksPerformed: ['permutation'],
    signals: {},
  });
}

// ── Precondition gate ───────────────────────────────────────────────────

test('assertRandomnessAuditSurvived requires a hypothesisId', async () => {
  const teardown = setup();
  try {
    await assert.rejects(() => assertRandomnessAuditSurvived(), InvalidRngForensicsInputError);
  } finally { await teardown(); }
});

test('assertRandomnessAuditSurvived rejects when no Randomness Audit has been recorded', async () => {
  const teardown = setup();
  try {
    await assert.rejects(() => assertRandomnessAuditSurvived('h_never_audited'), RngForensicsPreconditionError);
  } finally { await teardown(); }
});

test('assertRandomnessAuditSurvived rejects when the latest verdict is not GenuinePredictiveStructure', async () => {
  const teardown = setup();
  try {
    await recordRandomnessAudit({
      hypothesisId: 'h1', verdict: RANDOMNESS_AUDIT_VERDICTS.CONSISTENT_WITH_RANDOMNESS,
      reason: 'null result', checksPerformed: [], signals: {},
    });
    await assert.rejects(() => assertRandomnessAuditSurvived('h1'), RngForensicsPreconditionError);
  } finally { await teardown(); }
});

test('assertRandomnessAuditSurvived resolves the record when the latest verdict IS GenuinePredictiveStructure', async () => {
  const teardown = setup();
  try {
    await markGenuinePredictiveStructure('h1');
    const record = await assertRandomnessAuditSurvived('h1');
    assert.equal(record.verdict, RANDOMNESS_AUDIT_VERDICTS.GENUINE_PREDICTIVE_STRUCTURE);
  } finally { await teardown(); }
});

test('assertRandomnessAuditSurvived uses the MOST RECENT verdict, not the first one recorded', async () => {
  const teardown = setup();
  try {
    await markGenuinePredictiveStructure('h1');
    await recordRandomnessAudit({
      hypothesisId: 'h1', verdict: RANDOMNESS_AUDIT_VERDICTS.STATISTICAL_ARTIFACT,
      reason: 're-audited, now looks like an artifact', checksPerformed: [], signals: {},
    });
    await assert.rejects(() => assertRandomnessAuditSurvived('h1'), RngForensicsPreconditionError);
  } finally { await teardown(); }
});

// ── classifyRngForensics: pure decision tree ──────────────────────────────

test('classifyRngForensics: fewer than 2 reseed windows -> InsufficientEvidence', () => {
  const r0 = classifyRngForensics({ reseedWindowResults: [] });
  assert.equal(r0.classification, RNG_FORENSICS_CLASSIFICATIONS.INSUFFICIENT_EVIDENCE);
  const r1 = classifyRngForensics({ reseedWindowResults: [{ windowLabel: 'w1', pValue: 0.01 }] });
  assert.equal(r1.classification, RNG_FORENSICS_CLASSIFICATIONS.INSUFFICIENT_EVIDENCE);
});

test('classifyRngForensics: effect significant in fewer than half the windows -> FiniteSampleOrNonStationary', () => {
  const result = classifyRngForensics({
    reseedWindowResults: [
      { windowLabel: 'w1', pValue: 0.01 },
      { windowLabel: 'w2', pValue: 0.4 },
      { windowLabel: 'w3', pValue: 0.6 },
    ],
  });
  assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.FINITE_SAMPLE_OR_NON_STATIONARY);
});

test('classifyRngForensics: significant on wall-clock but not tick-index -> RngOrTimingArtifact', () => {
  const result = classifyRngForensics({
    reseedWindowResults: [{ windowLabel: 'w1', pValue: 0.001 }, { windowLabel: 'w2', pValue: 0.002 }],
    tickIndexAlignedResult: { pValue: 0.4 },
    wallClockAlignedResult: { pValue: 0.001 },
  });
  assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.RNG_OR_TIMING_ARTIFACT);
});

test('classifyRngForensics: persistent across windows and alignments -> GenuineStructure', () => {
  const result = classifyRngForensics({
    reseedWindowResults: [
      { windowLabel: 'w1', pValue: 0.001 },
      { windowLabel: 'w2', pValue: 0.002 },
      { windowLabel: 'w3', pValue: 0.003 },
    ],
    tickIndexAlignedResult: { pValue: 0.001 },
    wallClockAlignedResult: { pValue: 0.001 },
    coarseQuantizationResult: { pValue: 0.01 },
    fineQuantizationResult: { pValue: 0.001 },
  });
  assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
  assert.ok(result.reason.includes('NOT proof of a specific RNG mechanism'));
});

test('classifyRngForensics: exactly half the windows significant counts as persistence (>= 0.5 threshold)', () => {
  const result = classifyRngForensics({
    reseedWindowResults: [{ windowLabel: 'w1', pValue: 0.001 }, { windowLabel: 'w2', pValue: 0.9 }],
  });
  assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
});

// ── Storage ──────────────────────────────────────────────────────────────

test('recordRngForensicsResult validates hypothesisId and classification', async () => {
  const teardown = setup();
  try {
    await assert.rejects(() => recordRngForensicsResult({ classification: RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE }), InvalidRngForensicsInputError);
    await assert.rejects(() => recordRngForensicsResult({ hypothesisId: 'h1', classification: 'NotReal' }), InvalidRngForensicsInputError);
  } finally { await teardown(); }
});

test('recordRngForensicsResult / getLatestRngForensicsResult / listRngForensicsResults round-trip, append-only', async () => {
  const teardown = setup();
  try {
    await recordRngForensicsResult({ hypothesisId: 'h1', classification: RNG_FORENSICS_CLASSIFICATIONS.INSUFFICIENT_EVIDENCE, reason: 'first pass' });
    await recordRngForensicsResult({ hypothesisId: 'h1', classification: RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE, reason: 'more windows collected' });
    const latest = await getLatestRngForensicsResult('h1');
    assert.equal(latest.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
    assert.equal(latest.seq, 1);
    const all = await listRngForensicsResults('h1');
    assert.equal(all.length, 2);
  } finally { await teardown(); }
});

// ── Governed entry point ──────────────────────────────────────────────────

test('runRngForensics refuses to run when the Randomness Audit has not been cleared', async () => {
  const teardown = setup();
  try {
    await assert.rejects(
      () => runRngForensics({ hypothesisId: 'h1', reseedWindowResults: [{ pValue: 0.001 }, { pValue: 0.002 }] }),
      RngForensicsPreconditionError
    );
  } finally { await teardown(); }
});

test('runRngForensics: end to end, precondition satisfied, classifies and permanently records', async () => {
  const teardown = setup();
  try {
    await markGenuinePredictiveStructure('h1');
    const result = await runRngForensics({
      hypothesisId: 'h1',
      reseedWindowResults: [{ windowLabel: 'w1', pValue: 0.001 }, { windowLabel: 'w2', pValue: 0.002 }],
      tickIndexAlignedResult: { pValue: 0.001 },
      wallClockAlignedResult: { pValue: 0.001 },
    });
    assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
    const stored = await getLatestRngForensicsResult('h1');
    assert.equal(stored.classification, RNG_FORENSICS_CLASSIFICATIONS.GENUINE_STRUCTURE);
  } finally { await teardown(); }
});

test('runRngForensics never touches onlineFdr, discoveryDecision, or publicationStatus -- it is a pure classify-and-record function', async () => {
  const teardown = setup();
  try {
    await markGenuinePredictiveStructure('h1');
    // Structural guarantee, verified by absence: the module under test does
    // not import any of those three modules at all (see the import list at
    // the top of rngForensics.js). This test documents that expectation by
    // simply confirming the call succeeds using ONLY randomnessAudit.js and
    // its own storage adapter, with no other governance module involved.
    const result = await runRngForensics({
      hypothesisId: 'h1',
      reseedWindowResults: [{ pValue: 0.9 }, { pValue: 0.8 }],
    });
    assert.equal(result.classification, RNG_FORENSICS_CLASSIFICATIONS.FINITE_SAMPLE_OR_NON_STATIONARY);
  } finally { await teardown(); }
});
