---
name: Phase 7B Implementation
description: Phase 7B non-classical discovery — search space, orchestrator, runner page, and validation test fixes applied
---

## Phase 7B: First Non-Classical Discovery Experiment — Implementation Complete

### What Was Built (additive only to index.html)

1. `msdBuildNcSnapshotRows(allStates, uncertaintyHandling)` — after msdBuildRealSnapshotRows (line ~9307)
   - Enriches allStates with NC features on-demand, pairs with labels, returns rows with ncf_* fields
   - Never reads/writes ncf_* fields to IDB

2. `msdBuildPhase7bSearchSpaceDefinition()` — Part 12 (line ~9723)
   - 16 features × 5 leadTimes × 1^N other dimensions = 80 candidates
   - Symbol: 1HZ100V, missingDataRules: {maxMissingRate: 0.1}

3. Constants: MSD_PHASE7B_INDIVIDUAL_FEATURES (16), MSD_PHASE7B_MAX_CANDIDATES (80), MSD_PHASE7B_SYMBOL ('1HZ100V')

4. `msdRunPhase7bDiscovery(allStates, frozenSearchSpace, options)` — Part 12 (line ~9768)
   - Full pipeline: NC rows → 80 candidates → circular-shift null (1000 perms, seed=42) → BH → hypothesis records
   - Practical gate: effectSize ≥ 0.01 nats
   - options.onProgress callback supported for UI progress

5. `msd-phase7b-discovery.html` — runner page
   - Must be opened via window.open() from main app (uses window.opener for all MSD functions)
   - Opens mfx_msd_states IDB directly for MarketStates
   - Prereq check → NC validation suite → search space display → run → 80-row results table

### Test Fixes (Step 1, Phase 7B)
- **G11**: 10 runs not 9; formula -(6/10·ln(6/10)+2/10·ln(2/10)+1/10·ln(1/10)+1/10·ln(1/10)) ≈ 1.089 nats
- **G17**: g17d changed [119..100]→[100..81] — mfe/mae divide by |p0|, symmetry needs same p0
- **G9**: snap_ok missing rawHistoryWindowLength:20 (Phase 7A fix 3 gate added check but fixture not updated)

**Result: 115/115 assertions, 0 failures, 19 groups ✓**

### Candidate Family (16 of 18)
Excluded: ncf_meanFirstDiff (= ncf_netDisplacement/19 for n=20) and ncf_meanAbsFirstDiff (= ncf_absPathLength/19 for n=20)

**Why:** exact linear collinearity at fixed n=20 — no independent information.

### Usage
1. Main app open in browser (MSD Phase 7+7B code loaded)
2. `window.open('msd-phase7b-discovery.html')` — or add a button in the main app UI
3. Run discovery — results written to DiscoveryLedger, displayed in table
