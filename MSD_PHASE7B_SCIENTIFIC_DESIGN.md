# MSD Phase 7B — Deliverable 6: Scientific Design

**Status:** DESIGN ONLY — no implementation  
**Authorization:** Phase 7A declared READY (Deliverable 5)  
**Date:** 2026-07-21

---

## 1. Scientific Framing

Phase 5 established a valid scientific null for classical indicators: 45 pre-registered candidates evaluated under mutual information + BH correction + circular-shift null model produced no practically meaningful discoveries.

Phase 7B asks a distinct question about a different feature family: **Do non-classical representations of the 20-tick price path preceding a qualified event carry statistically significant and practically meaningful mutual information with the binary outcome?**

This is a falsifiable scientific hypothesis. The null result from Phase 5 does not predict the Phase 7B result — the feature families are mathematically independent.

---

## 2. Candidate Family

### 2.1 Feature universe

From the Phase 7A mathematical audit, two features are exact linear multiples of others for fixed n=20:
- `ncf_meanFirstDiff` ≡ `ncf_netDisplacement / 19`
- `ncf_meanAbsFirstDiff` ≡ `ncf_absPathLength / 19`

Including both members of each pair would waste 2 test slots from the family budget on features that carry zero additional information beyond their linear partner. Under BH correction, a larger family with redundant members produces a more conservative threshold without increasing power.

**Decision:** Exclude `ncf_meanFirstDiff` and `ncf_meanAbsFirstDiff` from the candidate family.

### 2.2 Phase 7B candidate family (16 features)

| ID | Feature key | Family |
|----|------------|--------|
| C01 | `ncf_netDisplacement` | Path Geometry |
| C02 | `ncf_absPathLength` | Path Geometry |
| C03 | `ncf_pathEfficiency` | Path Geometry |
| C04 | `ncf_mfe` | Path Geometry |
| C05 | `ncf_mae` | Path Geometry |
| C06 | `ncf_upTickCount` | Directional Structure |
| C07 | `ncf_downTickCount` | Directional Structure |
| C08 | `ncf_dirImbalance` | Directional Structure |
| C09 | `ncf_currentRunLen` | Directional Structure |
| C10 | `ncf_maxRunLen` | Directional Structure |
| C11 | `ncf_reversalCount` | Directional Structure |
| C12 | `ncf_stdFirstDiff` | Price Dynamics |
| C13 | `ncf_meanSecondDiff` | Price Dynamics |
| C14 | `ncf_dirEntropy` | Complexity / Entropy |
| C15 | `ncf_runEntropy` | Complexity / Entropy |
| C16 | `ncf_permEntropy3` | Complexity / Entropy |

**Family size: 16 candidates**

---

## 3. Search Space Definition

The search space must be frozen via `msdFreezeSearchSpace` with `schemaVersion: MSD_SEARCH_SPACE_SPEC_VERSION_V2` before any data is examined.

### 3.1 Required search space fields (v2 schema)

```javascript
{
  // Part 1: Identity
  name: 'NCF-v1-Single-Feature-Discovery',
  version: '1.0',
  searchSpaceVersion: MSD_SEARCH_SPACE_SPEC_VERSION_V2,
  description: 'Single-feature mutual information discovery across the 16-candidate ncf_v1 non-classical feature family. Excludes ncf_meanFirstDiff and ncf_meanAbsFirstDiff as exact linear multiples of ncf_netDisplacement and ncf_absPathLength respectively.',
  createdAt: <epoch at freeze time>,
  owner: <researcher identifier>,

  // Part 2: Scope
  symbols: ['R_100'],           // Volatility 100 (1s) — same as Phase 5
  observationWindows: [20],     // Fixed: MSD_NC_REQUIRED_WINDOW_LENGTH
  leadTimes: 'all',             // All lookback positions — same as Phase 5
  featureVersion: 'v1',         // Stored schema version on the records

  // Part 3: Feature definition
  featureFamilies: ['ncf_v1'],
  individualFeatures: [
    'ncf_netDisplacement', 'ncf_absPathLength', 'ncf_pathEfficiency',
    'ncf_mfe', 'ncf_mae',
    'ncf_upTickCount', 'ncf_downTickCount', 'ncf_dirImbalance',
    'ncf_currentRunLen', 'ncf_maxRunLen', 'ncf_reversalCount',
    'ncf_stdFirstDiff', 'ncf_meanSecondDiff',
    'ncf_dirEntropy', 'ncf_runEntropy', 'ncf_permEntropy3',
  ],
  lagOperators: [],             // None: NC features already encode temporal structure
  rollingOperators: [],         // None: features computed from fixed 20-tick window
  interactionDepth: 1,          // Single-feature analysis only (Phase 5 precedent)

  // Part 4: Cardinality and limits
  maxCandidateCount: 16,        // Matches individualFeatures.length exactly

  // Part 5: Exclusion rules
  exclusionRules: [
    'ncf_meanFirstDiff is excluded: algebraically identical to ncf_netDisplacement/19 for n=20',
    'ncf_meanAbsFirstDiff is excluded: algebraically identical to ncf_absPathLength/19 for n=20',
  ],

  // Part 6: Data handling
  missingDataRules: 'exclude: records with rawHistoryValid !== true are excluded by msdEnrichWithNonClassicalFeatures before dataset construction',
  uncertaintyLabelPolicy: 'same as Phase 5: positive=confirmed 5-tick rise, negative=confirmed non-qualifying tick, no uncertain labels',
}
```

### 3.2 Cardinality

- Single-feature analysis, depth=1
- 16 features × 1 (no lag, no rolling) = **16 candidates exactly**
- Maximum candidate count: 16
- No interaction terms in Phase 7B (consistent with Phase 5 protocol)

---

## 4. Dataset Construction Protocol

### 4.1 Entry point

```javascript
// All states fetched fresh from IndexedDB
const allStates = await msdGetAllMarketStates();

// NC enrichment + eligibility filter + existing holdout/split machinery
const dataset = msdBuildNcExperimentDataset(allStates, {
  featureVersion: 'v1',         // MUST be 'v1', not 'ncf_v1'
  symbol: 'R_100',
  leadTime: 'all',
  randomSeed: <frozen at registration>,
  trainingSplit: 0.7,
  validationSplit: 0.5,
  samplingRatio: 1.0,           // 1:1 class balance (same as Phase 5)
});
```

### 4.2 Eligibility filter applied

Before the dataset builder runs, `msdEnrichWithNonClassicalFeatures` marks each record:
- `ncf_eligible: true` ← `rawHistoryValid === true` AND `rawHistoryWindowLength === 20` AND all 16 NC features compute to finite values
- `ncf_eligible: false` ← warm-up records (pre-Phase 6B) or other ineligible records

Ineligible records are excluded from the discovery pool entirely. Their exclusion is recorded in `dataset.ncEnrichmentReport`.

### 4.3 Production holdout

`msdPartitionProductionHoldout` reserves the chronologically latest 15% of eligible records **before** any experiment is run. This holdout is never seen during discovery, validation, or walk-forward analysis. It is used only in Phase 7B production validation.

### 4.4 Minimum eligibility gate

Before proceeding to statistical testing, verify:
- Total eligible records ≥ 500 (minimum for meaningful MI estimation)
- Positive records ≥ 100
- Negative records ≥ 100
- Discovery pool (after holdout exclusion) ≥ 300

If any gate fails, the experiment must be postponed and the Phase 6B capture must continue.

---

## 5. Statistical Protocol

### 5.1 Hypothesis

**Primary hypothesis (pre-registered, one-sided):**
At least one feature in the 16-candidate `ncf_v1` family has a mutual information with the binary outcome (positive/negative) that exceeds the null distribution at the BH-corrected significance threshold α=0.05, with a practical effect size (absolute positivity rate difference) ≥ the threshold established in Phase 5.

**Null hypothesis:**
No feature in the `ncf_v1` family has MI exceeding the circular-shift null distribution at the BH-corrected threshold. Observed MI differences are attributable to chance temporal structure in the training set.

### 5.2 Statistical test: Mutual Information

Identical to Phase 5:
- Measure: pointwise mutual information between feature value and binary outcome
- Discretization: same binning strategy as Phase 5 (must be frozen in the search space or experiment registration)
- Estimation: same MI estimator used in Phase 5

### 5.3 Null model: Circular shift

Identical to Phase 5:
- Generate null distribution by circularly shifting the outcome vector relative to features
- n_shifts = 1000 (same as Phase 5)
- Empirical p-value for each candidate: fraction of shifts where null MI ≥ observed MI

### 5.4 Multiple-testing correction: Benjamini-Hochberg

- Family size m = 16 candidates
- α = 0.05 (FDR target)
- BH procedure: applied over the full family of 16 empirical p-values simultaneously
- No post-hoc subsetting of the family

### 5.5 Practical significance gate

A feature that clears the BH threshold is **not automatically a discovery.** It must also clear the same practical effect size threshold used in Phase 5. Effect size is defined as the absolute difference in positivity rates between the "condition met" and "condition not met" groups under the best-threshold rule.

A feature that clears BH but fails the practical significance gate is reported as **statistically significant but not practically meaningful** — a valid scientific result, not suppressed.

### 5.6 Evaluation sequence

```
Training set  → MI estimation, BH correction, threshold optimization
               (full statistical analysis)
               
Validation set → Replicate: does the best-threshold rule hold on unseen data?
                (required before reporting any discovery)
                
Test set       → Out-of-sample evaluation of replicated discoveries only
                (not used for threshold optimization)
                
Production holdout → Final production validation via msdRunNcProductionValidation
                     (implemented in Phase 7B before this step runs)
```

No feature that fails validation-set replication is reported as a discovery, regardless of training-set results.

---

## 6. Reproducibility Requirements

### 6.1 Pre-registration (mandatory before data examination)

Using `msdRegisterExperiment`, write an immutable experiment registration BEFORE calling `msdBuildNcExperimentDataset` or examining any output. The registration must include:

```javascript
{
  objectives: 'Evaluate whether any feature in the ncf_v1 non-classical family carries statistically significant and practically meaningful MI with the binary outcome.',
  hypotheses: 'H1: at least one ncf_v1 feature has BH-corrected p < 0.05 and effect size >= Phase5 threshold. H0: no such feature exists.',
  hypothesisFeatures: [/* the 16 feature keys */],
  outcomeDefinition: MSD_RESEARCH_HYPOTHESIS,
  featureVersion: 'v1',
  inclusionCriteria: 'rawHistoryValid=true, rawHistoryWindowLength=20, all 16 NC features compute to finite values, featureVersion=v1, symbol=R_100',
  exclusionCriteria: 'warm-up records (rawHistoryValid=false), pre-Phase-6B records, records where msdComputeNonClassicalFeatures returns null',
  searchSpaceHash: <hash from msdFreezeSearchSpace>,
  randomSeed: <frozen value>,
}
```

### 6.2 Dataset freeze

After building the dataset, call `msdFreezeDataset` or equivalent to record the exact set of records used in the experiment. The enrichment report (`ncEnrichmentReport`) must be recorded: total input, eligible, ineligible counts.

### 6.3 Null result handling

A null result — no feature clears BH-corrected significance with practical effect — is a valid, complete scientific outcome. It must be reported and written to the KnowledgeBase via `msdWriteFinding`. It must NOT trigger re-running with modified parameters, a wider feature family, or different statistical thresholds. Any such changes constitute a new, separately pre-registered experiment.

---

## 7. Walk-Forward Validation

For any feature that clears training + validation + test, apply `msdRunWalkForwardValidation` in rolling mode with `MSD_WALKFORWARD_WINDOW_COUNT = 5` windows. A discovery is reported as **temporally stable** only if the condition shows significant effect in ≥ 3 of 5 windows. Temporal instability is not a grounds for suppression — it is reported as part of the discovery's characterization.

---

## 8. Production Validation Entry Point (Phase 7B implementation requirement)

Before the production validation step runs, implement `msdRunNcProductionValidation`:

```javascript
async function msdRunNcProductionValidation(feature, threshold, direction, symbol) {
  const allStates = await msdGetAllMarketStates();
  const { enriched } = msdEnrichWithNonClassicalFeatures(allStates);
  const ncEligible = enriched.filter(s => s.ncf_eligible === true);
  const { productionHoldout } = msdPartitionProductionHoldout(ncEligible, 'v1', symbol);
  // ... same logic as msdRunProductionValidation but on nc-enriched holdout
}
```

This wrapper enriches the production holdout before feature access. Without it, `s[ncf_feature]` returns undefined on stored records.

---

## 9. Authorization Chain

| Step | Requirement | Status |
|------|-------------|--------|
| Phase 7A complete | All 6 deliverables produced | ✅ |
| Phase 7A defects fixed | Tasks 1–6 from Readiness Report | ✅ Implemented |
| Validation suite passes | msd-nc-validation.html: 0 failures | ⏳ Run required |
| Sufficient data accumulated | Phase 7 audit: msd-phase7-audit.html | ⏳ Check required |
| Search space frozen | msdFreezeSearchSpace called | 🔜 Phase 7B step 1 |
| Experiment registered | msdRegisterExperiment called | 🔜 Phase 7B step 2 |
| Discovery run | msdBuildNcExperimentDataset + MI | 🔜 Phase 7B step 3 |
| Replication checked | Validation set evaluation | 🔜 Phase 7B step 4 |
| Finding written | msdWriteFinding (null or discovery) | 🔜 Phase 7B step 5 |

---

## 10. Scientific Conduct Principles

These apply without exception:

1. **Pre-registration before data.** The search space and experiment are frozen before `msdBuildNcExperimentDataset` is called.
2. **No post-hoc family modification.** The 16-feature family is fixed at registration. Adding features after seeing results is HARKing.
3. **Full family correction.** All 16 candidates are BH-corrected together. Subsetting the family post-hoc is not permitted.
4. **Null results written.** A null result is written to the KnowledgeBase as a positive scientific outcome, not abandoned.
5. **No threshold shopping.** The practical effect size threshold is adopted from Phase 5 (the existing frozen precedent). A new threshold requires a separately pre-registered experiment.
6. **Production holdout is final.** The holdout is not examined until training + validation + test + walk-forward are complete. If the holdout result fails, the discovery is reported as not replicating in production — it is not re-tested with different parameters.
