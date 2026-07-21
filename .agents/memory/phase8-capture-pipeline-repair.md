---
name: Phase 8 Capture Pipeline Repair
description: Root cause and fix for 0 usable NC observations; integrity checklist architecture
---

## The Root-Cause Defect

`msdBuildLabeledSnapshot(raw, meta)` returned an object picking only named meta fields.
Both call sites correctly assembled `meta` via `Object.assign({...}, msdCaptureRawPriceHistory(i, MSD_RAW_HISTORY_WINDOW_LENGTH))`,
so `meta` contained all four raw-history fields — but the function never forwarded them.
Every stored MarketState had `rawHistoryValid = undefined` → `ncf_eligible = false` → 0 usable observations.

## Fix (2026-07)

Added four explicit fields to `msdBuildLabeledSnapshot` return object:
```
rawHistoryValid, rawHistoryVersion, rawHistoryWindowLength, rawPriceHistory
```
`rawPriceHistory` is defensively `.slice()`-copied; null fallback for legacy records.

**Why:** Legacy states (23,459+) cannot be retroactively updated (append-only IDB store).
Only new captures post-repair will be NC-compatible. The two populations coexist in the same IDB store.

## Laboratory Integrity Checklist Architecture

20-check checklist in a second IIFE (`Phase 8 Integrity Module`, after the main Phase 8 IIFE).
State shared via `window._ph8GetSeal()` and `window._ph8GetResult()` getters exposed by the main module.

- `window.ph8RunChecklistUI()` — renders all 20 checks, returns allPass boolean
- `window.ph8ChecklistGate()` — called by ph8Execute before any data is read; blocks if any check fails
- `window.ph8VerifyCaptureRepair()` — field-level verification of stored states (legacy vs NC-compatible counts)
- `window.ph8RefreshReadiness` — wrapped to add dataset composition breakdown

**Why gate:** Campaign must not run if seal is missing, sample size < 30, or capture pipeline integrity is in question.

## Known Pre-existing Issue

`/api/phase8/seal` returns `Script execution failed: Unexpected token '<'` — this is an HTML-entity issue
in `phase8-engine.js` vm parsing (known, predates this sprint). Checks 12-14 and 20 will FAIL until resolved.
The seal fix is a separate task (requires modifying the frozen phase8-engine.js).
