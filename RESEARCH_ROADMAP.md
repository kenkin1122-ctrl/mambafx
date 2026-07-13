# MambaFX — Scientific Research Roadmap

*Maintained alongside `index.html`. Append-only in spirit: when a planned phase changes, add a dated note rather than silently rewriting history — the same discipline the codebase itself applies to KnowledgeBase.*

Last updated: Phase 2 (Scientific Infrastructure & Research Integrity Foundation).

## Where things stand

- **Phase 0/1 (prior sessions):** Raw-tick Information Discovery Framework (1A–1E) through Scientific Validation are implemented and gated, awaiting real Volatility 100 (1s) data. Baseline finding stands: no reproducible predictive information in raw tick direction alone.
- **Statistical Research Workbench:** Four analyzers fully implemented and registered — Single Feature, Threshold, Feature Combination, Market-State Pattern — each writing evidence through the generic `discoveryKey` / Maturity Engine / whole-repository FDR machinery.
- **Phase 2 (this phase):** Pipeline-Level Negative Control, immutable Generation Registry, unified Feature Lifecycle (translation + action layer over the existing Maturity Engine), Experiment Manifest, and the first reproducibility field (execution environment) are implemented and unit-tested in isolation. See `RESEARCH_DEBT_REGISTER.md` for what remains before these are exercised on real data.

## Immediate next step (before any new feature engineering)

Run `msdRunPipelineNegativeControl` against a real experiment's dataset, for all three relabeling methods, and confirm `calibration.passFail` is PASS for each. **This is a hard gate**, not a formality: Phase 3 should not begin until it passes, per the same "no downstream phase begins without upstream evidence" principle already enforced elsewhere in this codebase. If it fails, the accumulation pipeline (not the underlying market) is the suspect, and that must be fixed before anything built on top of it can be trusted.

Immediately after a passing calibration run, register **Generation 1** (the classical indicators already in production — ADX, RSI, MACD, ATR, ±DI, and whatever else `featureVersion: 'v1'` currently covers) via `msdRegisterGeneration`. Every existing feature is technically un-registered under the new lifecycle until this happens — see Debt Register item R-009.

## Planned Generation sequence

This numbering is a plan, not a commitment to build all of it — each generation is gated behind the previous one's own validation, same as every other phase in this project.

| Gen | Label | Status | Depends on |
|---|---|---|---|
| 1 | Classical Indicators | Exists in code (`v1`), not yet formally registered | — |
| 2 | Transition Dynamics | Partially exists in the raw-tick pipeline (Phase 1C Markov work); not yet in the Workbench line | Gen 1 |
| 3 | Persistence (partial-run-length conditioning) | Not started | Gen 1 |
| 4 | Exhaustion | Not started | Gen 2, 3 |
| 5 | Stability / Compression-Expansion | Not started | Gen 1 |
| 6 | Interaction Features | Exists as the Feature Combination analyzer's runtime combinatorics; not yet a named, versioned generation | Gen 1–5 |
| 7 | Latent States | Exists as the Market-State Pattern analyzer (k-means + fingerprinting); null-model testing for cluster existence itself is still owed (Debt Register item R-011, carried over from Phase 1's review) | Gen 1–6 |
| 8 | Automatically Discovered Features | Not started — depends on the Feature Discovery Engine design still being scoped | Gen 1–7 |

Note: several "generations" already have *some* code behind them, scattered across the raw-tick pipeline and the Workbench analyzers. Part of registering each generation is an honest audit of what already exists versus what's genuinely new — do not assume a generation number implies net-new code.

## Phase sequence going forward

Each phase below follows the standing rule: state objectives, rationale, math, algorithm, leakage prevention, reproducibility, validation, risks, deliverables, audit, Go/No-Go — and stops for approval before the next begins.

- **Phase 3 — Generation 1 registration + first real calibration run.** Small, deliberately: register Generation 1, run the negative control for real, fix anything it surfaces. No new feature engineering yet.
- **Phase 4 — Feature Engineering Engine (Generations 2–3).** Transition Dynamics and Persistence, built as new analyzer types plugged into the existing registry — not a new engine.
- **Phase 5 — Latent Market State null-model testing.** Closes the gap flagged at the end of Phase 1: a permutation/null-model check for whether k-means cluster structure exceeds chance, before any further latent-state work is trusted.
- **Phase 6 — Redundancy Elimination extension.** Extends the existing Unique/Redundant/Proxy audit to cover whatever new Generation 2–5 features exist by then.
- **Phase 7 — Production Feature Selection.** First real uses of `msdPromoteToProduction` / `msdDeprecateFeature`, on whatever has reached Verified and survived redundancy elimination.
- **Phase 8+ — Continuous Scientific Learning.** Only after the above has run at least once against real data; scope to be defined then, not now, since it depends heavily on what Phases 3–7 actually find (including "nothing," which per the project's own stop rules is a valid, publishable outcome).

## Explicitly deferred (not scope creep — logged intent)

- A full generative/simulated matched-null price and indicator model (see Debt Register R-005) — genuinely separate research effort, larger than a Phase 2 add-on.
- Cross-browser empirical reproducibility testing (R-006) — the capture mechanism exists now; the actual multi-browser run is an operational task for whoever runs experiments day-to-day.
- A proper binomial-test-based calibration tolerance (R-008), replacing the current stated 3× nominal-alpha heuristic, once enough control runs exist to estimate variance.
