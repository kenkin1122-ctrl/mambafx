---
name: Phase 8 Campaign
description: Phase 8 — First Official NC Discovery Campaign runner page; uses existing infrastructure with zero new index.html functions
---

## Phase 8: First Official Non-Classical Discovery Campaign

### What Was Built

Single runner page: `msd-phase8-campaign.html` (~1 100 lines, no new index.html additions).

### Design

All computation delegated to existing Phase 7B infrastructure — zero new functions added to index.html. The page is a scientific document renderer.

**Two-phase UI:**
1. **Protocol Seal** — shown on load before any data access. Builds and freezes the search space, renders all 12 pre-registration fields + search-space hash/ID. User must confirm before data is read.
2. **Campaign Execution** — triggered by "Begin Phase 8 Campaign". Calls `msdRunPhase7bDiscovery` with `onProgress` callback for candidate-level progress.

**Why zero new functions:** Phase 8 rules explicitly prohibit feature additions, schema changes, or infrastructure expansion. `msdRunPhase7bDiscovery` already handles pre-registration (Step 1 — records search space before building dataset), dataset snapshot (Step 3), evaluation (Step 5), BH correction (Step 6), and hypothesis record creation (Step 7) internally.

### 8-Step Report Structure

| Step | Content |
|---|---|
| 1 | Pre-registration record — confirms IDB write before data read |
| 2 | Dataset snapshot — fingerprint, uncertainty filtering, usable row count |
| 3 | Discovery evaluation — 80/80 confirmed, permutations=1000, seed=42 |
| 4 | Multiplicity correction chain — 80→80→80→80 invariant verification |
| 5 | Full scientific report (rankings table, family breakdown, lead-time dist, integrity checks, contamination audit) |
| 6 | Scientific interpretation (supported/not-supported/limitations/alternatives) |
| 7 | Discovery decisions — 4 categories: DISCOVERY CANDIDATE / STAT-SIG ONLY / PRAC-SIG ONLY / NOT SIGNIFICANT |
| 8 | Next phase authorization (Phase 9 if discoveries; next representation family recommendations if null result) |

### Discovery Decision Logic (pre-registered)
- **DISCOVERY CANDIDATE**: BH adj-p < 0.05 AND MI ≥ 0.01 nats
- **STAT-SIG ONLY**: adj-p < 0.05 but MI < 0.01 nats
- **PRAC-SIG ONLY**: MI ≥ 0.01 nats but adj-p ≥ 0.05
- **NOT SIGNIFICANT**: neither criterion met

**Why:** practical threshold 0.01 nats is hardcoded inside `msdRunPhase7bDiscovery` at line 9915 and must be matched exactly in the runner page.

### Entry Points
- Phase 7C runner (`msd-phase7c-verification.html`) shows "Open Phase 8" button only after READY_FOR_PHASE8_DISCOVERY verdict
- Phase 7B runner (`msd-phase7b-discovery.html`) has "Open Phase 7C Verification" → chain leads naturally to Phase 8

### MOP References (11 unique, all verified)
msdValidateNonClassicalFeatures, msdBuildPhase7bSearchSpaceDefinition, msdFreezeSearchSpace, MSD_SEARCH_SPACE_SPEC_VERSION_V2, msdComputeSearchSpaceCardinality, MSD_PHASE7B_INDIVIDUAL_FEATURES, MSD_NC_FEATURE_VERSION, msdRunPhase7bDiscovery, MSD_PHASE7B_SYMBOL, MSD_PHASE7B_MAX_CANDIDATES, msdDryRunEnumerateCandidates.
