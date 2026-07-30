/**
 * tests/phase11/config.test.mjs
 *
 * Unit tests for Phase 11 configuration layer:
 *   - core/sha256.js  (sha256Canonical, canonicalJson)
 *   - config/VersionSchema.js
 *   - config/ResearchConfiguration.js
 *   - config/StatisticalAnalysisPlan.js
 *   - config/ResearchFreeze.js
 *   - config/ConfigValidator.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256Canonical, canonicalJson } from '../../research/src/core/sha256.js';
import {
  PHASE11_SCHEMA_VERSION,
  PHASE11_GRAMMAR_VERSION,
  PHASE11_GENERATOR_VERSION,
  PHASE11_ONTOLOGY_VERSION,
  isValidVersion,
  parseVersion,
  compareVersions,
  isAtLeastVersion,
  InvalidVersionError,
} from '../../research/src/config/VersionSchema.js';
import {
  ResearchConfiguration,
  InvalidResearchConfigurationError,
} from '../../research/src/config/ResearchConfiguration.js';
import {
  StatisticalAnalysisPlan,
  InvalidStatisticalAnalysisPlanError,
} from '../../research/src/config/StatisticalAnalysisPlan.js';
import {
  ResearchFreeze,
  InvalidResearchFreezeError,
} from '../../research/src/config/ResearchFreeze.js';
import {
  ConfigValidator,
} from '../../research/src/config/ConfigValidator.js';

// ═══════════════════════════════════════════════════════════════════════════
// sha256Canonical
// ═══════════════════════════════════════════════════════════════════════════

test('sha256Canonical: returns 64-char lowercase hex string', async () => {
  const result = await sha256Canonical({ a: 1 });
  assert.equal(typeof result, 'string');
  assert.equal(result.length, 64);
  assert.match(result, /^[0-9a-f]+$/);
});

test('sha256Canonical: same input produces same hash', async () => {
  const a = await sha256Canonical({ x: 1, y: 'hello' });
  const b = await sha256Canonical({ x: 1, y: 'hello' });
  assert.equal(a, b);
});

test('sha256Canonical: different inputs produce different hashes', async () => {
  const a = await sha256Canonical({ x: 1 });
  const b = await sha256Canonical({ x: 2 });
  assert.notEqual(a, b);
});

test('sha256Canonical: key order does not affect hash (canonical JSON)', async () => {
  const a = await sha256Canonical({ x: 1, y: 2 });
  const b = await sha256Canonical({ y: 2, x: 1 });
  assert.equal(a, b, 'canonicalized key order should produce identical hash');
});

test('canonicalJson: sorts keys recursively', () => {
  const result = canonicalJson({ z: 1, a: 2, m: { q: 3, b: 4 } });
  assert.equal(result, '{"a":2,"m":{"b":4,"q":3},"z":1}');
});

// ═══════════════════════════════════════════════════════════════════════════
// VersionSchema
// ═══════════════════════════════════════════════════════════════════════════

test('VersionSchema: constants are semver strings', () => {
  for (const v of [PHASE11_SCHEMA_VERSION, PHASE11_GRAMMAR_VERSION, PHASE11_GENERATOR_VERSION, PHASE11_ONTOLOGY_VERSION]) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `version constant "${v}" should be semver`);
  }
});

test('isValidVersion: accepts valid semver, rejects garbage', () => {
  assert.equal(isValidVersion('1.0.0'), true);
  assert.equal(isValidVersion('11.0.0'), true);
  assert.equal(isValidVersion(''), false);
  assert.equal(isValidVersion('1.0'), false);
  assert.equal(isValidVersion('1.0.0.0'), false);
  assert.equal(isValidVersion(null), false);
});

test('parseVersion: returns { major, minor, patch }', () => {
  const p = parseVersion('3.14.159');
  assert.equal(p.major, 3);
  assert.equal(p.minor, 14);
  assert.equal(p.patch, 159);
});

test('parseVersion: throws InvalidVersionError on bad input', () => {
  assert.throws(() => parseVersion('bad'), InvalidVersionError);
});

test('compareVersions: returns correct ordering', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('isAtLeastVersion: a >= b iff correct', () => {
  assert.equal(isAtLeastVersion('2.0.0', '1.0.0'), true);
  assert.equal(isAtLeastVersion('1.0.0', '1.0.0'), true);
  assert.equal(isAtLeastVersion('1.0.0', '2.0.0'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ResearchConfiguration
// ═══════════════════════════════════════════════════════════════════════════

async function makeRc(overrides = {}) {
  return ResearchConfiguration.create({
    id: 'rc-test-001',
    name: 'Phase 11 Test Campaign',
    description: 'Unit test research configuration',
    grammarVersion: '11.0.0',
    ontologyVersion: '11.0.0',
    generatorVersion: '11.0.0',
    proxyVersions: { msd: '1.0.0', ncf: '1.0.0' },
    ...overrides,
  });
}

test('ResearchConfiguration.create: returns frozen instance with configHash', async () => {
  const rc = await makeRc();
  assert.equal(typeof rc.configHash, 'string');
  assert.equal(rc.configHash.length, 64);
  assert.equal(rc.maxLookahead, 0);   // hard-wired
  assert.throws(() => { rc.id = 'changed'; }, TypeError, 'should be frozen');
});

test('ResearchConfiguration.create: same identity fields produce same configHash', async () => {
  const a = await makeRc();
  const b = await makeRc();
  assert.equal(a.configHash, b.configHash);
});

test('ResearchConfiguration.create: different proxyVersions produce different configHash', async () => {
  const a = await makeRc({ proxyVersions: { msd: '1.0.0' } });
  const b = await makeRc({ proxyVersions: { msd: '2.0.0' } });
  assert.notEqual(a.configHash, b.configHash);
});

test('ResearchConfiguration.create: throws on maxLookahead != 0', async () => {
  await assert.rejects(makeRc({ maxLookahead: 1 }), InvalidResearchConfigurationError);
});

test('ResearchConfiguration.create: throws on missing required fields', async () => {
  await assert.rejects(ResearchConfiguration.create({}), InvalidResearchConfigurationError);
});

test('ResearchConfiguration.create: throws on missing name', async () => {
  await assert.rejects(makeRc({ name: '' }), InvalidResearchConfigurationError);
});

test('ResearchConfiguration.create: throws on invalid grammarVersion semver', async () => {
  await assert.rejects(makeRc({ grammarVersion: 'not-semver' }), InvalidResearchConfigurationError);
});

test('ResearchConfiguration.toJSON: round-trips key fields', async () => {
  const rc = await makeRc();
  const json = rc.toJSON();
  assert.equal(json.id, 'rc-test-001');
  assert.equal(json.name, 'Phase 11 Test Campaign');
  assert.equal(json.configHash, rc.configHash);
  assert.equal(json.maxLookahead, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// StatisticalAnalysisPlan
// ═══════════════════════════════════════════════════════════════════════════

async function makeSap(overrides = {}) {
  return StatisticalAnalysisPlan.create({
    sapId: 'sap-test-001',
    hypothesisFamilies: ['momentum', 'mean_reversion'],
    alphaAllocation: { momentum: 0.03, mean_reversion: 0.02 },
    promotionPolicies: { minRound1Score: 0.6, minEffectSize: 0.05 },
    stoppingRules: [{ maxCandidates: 500, maxRounds: 4 }],
    replicationCriteria: { minReplicationBlocks: 3, decorrelationGapDays: 30 },
    publicationCriteria: { minReproducibilityLevel: 3, minEvidenceTier: 'E3' },
    effectSizeThresholds: { default: 0.05 },
    minimumSampleSizes: { default: 200 },
    requiredDiagnostics: ['stationarity', 'autocorrelation'],
    ...overrides,
  });
}

test('StatisticalAnalysisPlan.create: returns frozen instance with sapHash', async () => {
  const sap = await makeSap();
  assert.equal(typeof sap.sapHash, 'string');
  assert.equal(sap.sapHash.length, 64);
  assert.throws(() => { sap.sapId = 'changed'; }, TypeError);
});

test('StatisticalAnalysisPlan.create: throws on alphaAllocation sum > 1.0', async () => {
  await assert.rejects(
    makeSap({ alphaAllocation: { momentum: 0.8, mean_reversion: 0.8 } }),
    InvalidStatisticalAnalysisPlanError
  );
});

test('StatisticalAnalysisPlan.create: throws on missing required fields', async () => {
  await assert.rejects(StatisticalAnalysisPlan.create({}), InvalidStatisticalAnalysisPlanError);
});

test('StatisticalAnalysisPlan.create: throws on empty hypothesisFamilies', async () => {
  await assert.rejects(makeSap({ hypothesisFamilies: [] }), InvalidStatisticalAnalysisPlanError);
});

test('StatisticalAnalysisPlan.create: same inputs produce same sapHash', async () => {
  const ts = 1700000000000;
  const a = await makeSap({ createdTimestamp: ts });
  const b = await makeSap({ createdTimestamp: ts });
  assert.equal(a.sapHash, b.sapHash);
});

test('StatisticalAnalysisPlan.toJSON: round-trips key fields', async () => {
  const sap = await makeSap();
  const json = sap.toJSON();
  assert.equal(json.sapId, 'sap-test-001');
  assert.equal(json.sapHash, sap.sapHash);
  assert.deepEqual(json.hypothesisFamilies, ['momentum', 'mean_reversion']);
});

// ═══════════════════════════════════════════════════════════════════════════
// ResearchFreeze
// ═══════════════════════════════════════════════════════════════════════════

async function makeFreeze(overrides = {}) {
  const rc = await makeRc();
  return ResearchFreeze.create({
    researchConfigurationId: rc.id,
    configHash: rc.configHash,
    ontologyVersion: rc.ontologyVersion,
    generatorVersion: rc.generatorVersion,
    proxyVersions: { ...rc.proxyVersions },
    candidateFingerprints: ['fp1', 'fp2', 'fp3'],
    researchConfigurationHash: 'b'.repeat(64), // SHA-256 of full config JSON
    ...overrides,
  });
}

test('ResearchFreeze.create: returns frozen instance; id is a SHA-256 content address', async () => {
  const f = await makeFreeze();
  assert.equal(typeof f.id, 'string');
  assert.equal(f.id.length, 64);
  assert.throws(() => { f.id = 'changed'; }, TypeError);
});

test('ResearchFreeze.create: same identity fields produce same id (content-addressed)', async () => {
  const a = await makeFreeze();
  const b = await makeFreeze();
  assert.equal(a.id, b.id);
});

test('ResearchFreeze.create: different fingerprint sets produce different id', async () => {
  const a = await makeFreeze({ candidateFingerprints: ['fp1'] });
  const b = await makeFreeze({ candidateFingerprints: ['fp2'] });
  assert.notEqual(a.id, b.id);
});

test('ResearchFreeze.create: throws on missing required fields', async () => {
  await assert.rejects(ResearchFreeze.create({}), InvalidResearchFreezeError);
});

test('ResearchFreeze.create: fingerprints are sorted for determinism', async () => {
  const a = await makeFreeze({ candidateFingerprints: ['z', 'a', 'm'] });
  const b = await makeFreeze({ candidateFingerprints: ['a', 'm', 'z'] });
  assert.equal(a.id, b.id, 'fingerprint order should not matter for content-address');
  assert.deepEqual([...a.candidateFingerprints], ['a', 'm', 'z']);
});

// ═══════════════════════════════════════════════════════════════════════════
// ConfigValidator
// ═══════════════════════════════════════════════════════════════════════════

test('ConfigValidator.validateResearchConfiguration: valid config returns { valid: true, errors: [] }', async () => {
  const rc = await makeRc();
  const result = ConfigValidator.validateResearchConfiguration(rc);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('ConfigValidator.validateResearchConfiguration: missing id returns error', () => {
  const result = ConfigValidator.validateResearchConfiguration({ grammarVersion: '11.0.0' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('ConfigValidator.validateStatisticalAnalysisPlan: valid SAP returns { valid: true }', async () => {
  const sap = await makeSap();
  const result = ConfigValidator.validateStatisticalAnalysisPlan(sap);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('ConfigValidator.validateStatisticalAnalysisPlan: null input returns error', () => {
  const result = ConfigValidator.validateStatisticalAnalysisPlan(null);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /null|undefined|missing/i.test(e)));
});

test('ConfigValidator.validateResearchFreeze: valid freeze returns { valid: true }', async () => {
  const f = await makeFreeze();
  const result = ConfigValidator.validateResearchFreeze(f);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('ConfigValidator.validateResearchFreeze: object missing required fields returns errors', () => {
  // Missing researchConfigurationId, ontologyVersion, generatorVersion, proxyVersions,
  // researchConfigurationHash, frozenAt — all required by the validator.
  const result = ConfigValidator.validateResearchFreeze({ id: 'x', configHash: 'a'.repeat(64) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
