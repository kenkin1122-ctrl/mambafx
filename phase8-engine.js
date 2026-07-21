'use strict';
/**
 * phase8-engine.js — Server-side MSD Phase 8 execution engine.
 *
 * Loads the MSD function library (HTML lines 3170–12000) into a Node.js vm
 * context with browser API stubs, then runs msdRunPhase7bDiscovery against
 * caller-supplied MarketState records.
 *
 * Design decisions:
 * - We extract ONLY lines 3170–12000 (all MSD functions + constants, no UI code)
 *   to avoid DOM-throwing initialization code in lines 12001–33260.
 * - A same-script IIFE suffix is appended so that top-level `const` declarations
 *   (which live in the lexical scope, NOT on the context object) are exported
 *   to the vm context as named properties before the script ends.
 * - IDB write functions are replaced with no-op stubs; msdRecordHypothesisRecord's
 *   provenance check is bypassed (it requires KnowledgeBase IDB entries that
 *   don't exist in a Node.js context). The scientific computation is identical.
 */

const fs         = require('fs');
const vm         = require('vm');
const pathMod    = require('path');
const nodeCrypto = require('crypto');

// ─── singleton vm context ────────────────────────────────────────────────────
let _ctx = null;

// Top-level `const` declarations the MSD script defines between lines 3170-12000.
// They live in the lexical scope of the first vm.runInContext call, so they must
// be captured by a SAME-SCRIPT IIFE appended before vm.runInContext runs.
const CONST_EXPORTS = [
  'MSD_FEATURE_SCHEMA_VERSION',
  'msdSessionId',
  'MSD_NC_FEATURE_VERSION',
  'MSD_NC_REQUIRED_WINDOW_LENGTH',
  'MSD_SEARCH_SPACE_SPEC_VERSION_V2',
  'MSD_HYPOTHESIS_RECORD_SCHEMA_VERSION',
  'MSD_HYPOTHESIS_RECORD_REQUIRED_FIELDS',
  'MSD_HYPOTHESIS_RECORD_OPTIONAL_FIELDS',
  'MSD_PHASE7B_INDIVIDUAL_FEATURES',
  'MSD_PHASE7B_MAX_CANDIDATES',
  'MSD_PHASE7B_SYMBOL',
];

// Appended verbatim to the end of the extracted script — runs in the same
// lexical scope so it CAN read the top-level `const` bindings.
const EXPORT_IIFE = `
;(function __msdExportConsts__() {
  var g = this;
  ${CONST_EXPORTS.map(k =>
    `try { if (typeof ${k} !== 'undefined') g[${JSON.stringify(k)}] = ${k}; } catch(e) {}`
  ).join('\n  ')}
}).call(this);
`;

function buildContext() {
  if (_ctx) return _ctx;

  // ── Extract MSD function library ─────────────────────────────────────────
  // Line 4361 (1-based, 0-idx 4360) is the first MSD identifier (msdEventSeq).
  // Lines 3388–4360 are the "Developer AI Mode" instrumentation block that was
  // added after the engine was authored — it must be excluded because it carries
  // non-ASCII box-drawing chars (U+2550, U+2014) in its section headers, which
  // the Node.js vm parser rejects even inside comments.
  // Upper bound 12000 (1-based inclusive) matches the original design intent:
  // "all MSD functions + constants before DOM-dependent UI code at ~12001+".
  // An additional .replace() blanks any stray non-ASCII that appears inside
  // JSDoc comment decorators elsewhere in the range.
  const htmlLines = fs.readFileSync(pathMod.join(__dirname, 'index.html'), 'utf8').split('\n');
  // 4360 (0-idx) = 1-based line 4361 — first MSD identifier (msdEventSeq).
  // 12460 (0-idx exclusive) is the last balanced-block boundary confirmed by
  // binary search; all 13 needed exports are present and vm.runInContext passes.
  const rawSrc    = htmlLines.slice(4360, 12460).join('\n').replace(/[^\x00-\x7F]/g, ' ');
  const scriptSrc = rawSrc + EXPORT_IIFE;

  // ── Browser stubs ────────────────────────────────────────────────────────
  const cryptoStub = {
    getRandomValues(arr) {
      const buf = nodeCrypto.randomBytes(arr.length);
      for (let i = 0; i < arr.length; i++) arr[i] = buf[i];
      return arr;
    },
    randomUUID: () => nodeCrypto.randomUUID(),
  };

  const noopIdb = {
    open() {
      const r = {};
      setImmediate(() => r.onerror && r.onerror({ target: { error: new Error('IDB unavailable') } }));
      return r;
    },
  };

  const docStub = {
    getElementById: () => null,
    querySelector:  () => null,
    querySelectorAll: () => ({ forEach() {}, length: 0, item: () => null, [Symbol.iterator]: function*(){} }),
    createElement:  () => ({
      style: {}, className: '', innerHTML: '', textContent: '',
      setAttribute() {}, getAttribute: () => null,
      appendChild() {}, removeChild() {}, insertBefore() {},
      addEventListener() {}, removeEventListener() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    }),
    createTextNode: (t) => ({ textContent: t }),
    head:  { appendChild() {} },
    body:  { appendChild() {}, addEventListener() {} },
    addEventListener()    {},
    removeEventListener() {},
    dispatchEvent()       {},
  };

  const ctx = vm.createContext({
    // ── Core JS globals ────────────────────────────────────────────────────
    Math, Date, JSON, Array, Object, String, Number, Boolean,
    RegExp, Set, Map, WeakMap, WeakSet, Symbol, Proxy, Reflect, Promise,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    encodeURI, decodeURI,
    Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, ArrayBuffer, DataView, BigInt,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    queueMicrotask: (fn) => setImmediate(fn),
    console,
    // ── Browser stubs ──────────────────────────────────────────────────────
    crypto:      cryptoStub,
    indexedDB:   noopIdb,
    document:    docStub,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    localStorage:   { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    navigator:   { userAgent: 'MSD-Phase8-Engine/1.0', onLine: true },
    location:    { href: 'http://localhost:5000/', hostname: 'localhost', pathname: '/' },
    history:     { pushState() {}, replaceState() {} },
    performance: { now: () => Date.now(), mark() {}, measure() {} },
    screen:      { width: 1920, height: 1080 },
    innerWidth:  1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    WebSocket:   class { constructor() {} addEventListener() {} removeEventListener() {} send() {} close() {} },
    EventSource: class { constructor() {} addEventListener() {} close() {} },
    MutationObserver:     class { observe() {} disconnect() {} },
    ResizeObserver:       class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Event:       class { constructor(t) { this.type = t; } preventDefault() {} stopPropagation() {} },
    EventTarget: class { addEventListener() {} removeEventListener() {} dispatchEvent() {} },
    HTMLElement: class { constructor() { this.style = {}; this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} }; } addEventListener() {} },
    Node:        { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    cancelAnimationFrame:  clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '', setProperty() {} }),
    matchMedia:  () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    alert:       () => {},
    confirm:     () => false,
    prompt:      () => null,
    open:        () => null,
    close:       () => {},
    fetch:       () => Promise.reject(new Error('fetch not available in server context')),
    URL,
    URLSearchParams,
    TextEncoder: require('util').TextEncoder,
    TextDecoder: require('util').TextDecoder,
    undefined,
    Infinity,
    NaN,
    // ── MSD constants defined after our cut point (lines 12672-12673) ────────
    // These are `const` in the file but are used as free-variable references by
    // functions inside our extraction range. Pre-defining them on the context
    // makes them resolvable via the global scope chain.
    MSD_CODE_VERSION:             'mambafx-2026.07-phase7e',
    MSD_STATISTICAL_ENGINE_VERSION: 'msd-engine-7d',
  });

  // Self-reference — window.X === ctx.X
  ctx.window     = ctx;
  ctx.self       = ctx;
  ctx.global     = ctx;
  ctx.globalThis = ctx;

  // window.addEventListener / removeEventListener must exist on ctx itself
  // (because ctx.window === ctx, window.addEventListener resolves to ctx.addEventListener)
  ctx.addEventListener    = () => {};
  ctx.removeEventListener = () => {};
  ctx.dispatchEvent       = () => false;
  ctx.postMessage         = () => {};

  // ── Run the MSD script (lines 3170–12000 + export IIFE) ─────────────────
  try {
    vm.runInContext(scriptSrc, ctx, { timeout: 90000, filename: 'msd-engine' });
  } catch (e) {
    // Any throw here is a real error (there is no UI code in our extraction range)
    throw new Error('[phase8-engine] Script execution failed: ' + (e.message || String(e)));
  }

  // ── Verify critical functions and constants loaded ────────────────────────
  const REQUIRED_FNS = [
    'msdRunPhase7bDiscovery',
    'msdBuildPhase7bSearchSpaceDefinition',
    'msdFreezeSearchSpace',
    'msdComputeSearchSpaceCardinality',
    'msdBuildNcSnapshotRows',
  ];
  const REQUIRED_CONSTS = [
    'MSD_SEARCH_SPACE_SPEC_VERSION_V2',
    'MSD_PHASE7B_MAX_CANDIDATES',
    'MSD_PHASE7B_SYMBOL',
    'MSD_PHASE7B_INDIVIDUAL_FEATURES',
    'MSD_NC_FEATURE_VERSION',
  ];
  const missingFns    = REQUIRED_FNS.filter(k => typeof ctx[k] !== 'function');
  const missingConsts = REQUIRED_CONSTS.filter(k => ctx[k] == null);
  const missing = [...missingFns, ...missingConsts];
  if (missing.length) {
    throw new Error('[phase8-engine] Engine incomplete — missing: ' + missing.join(', '));
  }

  // ── Patch msdBuildPhase7bSearchSpaceDefinition ───────────────────────────
  // The function omits `featureFamilies`, which msdFreezeSearchSpace (v1 schema)
  // requires. The NC family's semantic label is 'non_classical'. We wrap the
  // original to inject the missing field without altering any other behaviour.
  const _origBuildSpace = ctx.msdBuildPhase7bSearchSpaceDefinition;
  ctx.msdBuildPhase7bSearchSpaceDefinition = function() {
    const def = _origBuildSpace();
    if (!def.featureFamilies) def.featureFamilies = ['non_classical'];
    return def;
  };

  // ── Stub all IDB write / read paths ──────────────────────────────────────
  ctx.msdWriteFinding              = async () => ({ ok: true });
  ctx.msdWriteDiscoveryLedgerEntry = async () => ({ ok: true });
  ctx.msdGetAllFindings            = async () => [];
  ctx.msdGetAllDiscoveryLedgerEntries = async () => [];
  ctx.msdGetSearchSpaceSpecifications = async () => [];
  ctx.msdGetDatasetSnapshots          = async () => [];

  // Override msdRecordHypothesisRecord — bypasses IDB provenance check.
  // The browser runner maintains full governance via real IDB. The server
  // produces the identical computation without writing to any store.
  ctx.msdRecordHypothesisRecord = async function(frozenRecord) {
    if (!frozenRecord || !Object.isFrozen(frozenRecord)) {
      throw new Error('Refusing to persist an unfrozen hypothesis record.');
    }
    return {
      ok: true,
      entryId: 'server_' + (frozenRecord.hypothesis_id || ('h' + Date.now())),
      writeResult: { ok: true },
    };
  };

  _ctx = ctx;
  console.log('[phase8-engine] Engine loaded. symbol=%s candidates=%d featureVersion=%s',
    ctx.MSD_PHASE7B_SYMBOL, ctx.MSD_PHASE7B_MAX_CANDIDATES, ctx.MSD_NC_FEATURE_VERSION);
  return ctx;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns frozen search space metadata for the Phase 8 protocol seal.
 * No MarketState data needed.
 */
function getSeal() {
  const ctx         = buildContext();
  const spaceDef    = ctx.msdBuildPhase7bSearchSpaceDefinition();
  const frozen      = ctx.msdFreezeSearchSpace(spaceDef, 'phase8_campaign',
                        { schemaVersion: ctx.MSD_SEARCH_SPACE_SPEC_VERSION_V2 });
  const cardinality = ctx.msdComputeSearchSpaceCardinality(frozen);
  const features    = Array.from(ctx.MSD_PHASE7B_INDIVIDUAL_FEATURES);

  return {
    searchSpaceId:      frozen.searchSpaceId,
    searchSpaceHash:    frozen.searchSpaceHash,
    searchSpaceVersion: frozen.searchSpaceVersion,
    totalCardinality:   cardinality.totalCardinality,
    symbol:             ctx.MSD_PHASE7B_SYMBOL,
    featureVersion:     ctx.MSD_NC_FEATURE_VERSION,
    features,
    leadTimes:          spaceDef.leadTimes,
    permutations:       1000,
    seed:               42,
    alpha:              0.05,
    practicalThreshold: 0.01,
    nullModel:          'circular_shift_permutation',
    correctionMethod:   'benjamini_hochberg',
    discoverySpec:      spaceDef,
  };
}

/**
 * Runs the complete Phase 8 discovery campaign.
 * @param {object[]} states — raw MarketState records from IndexedDB
 * @returns {Promise<object>}
 */
async function runCampaign(states) {
  const ctx = buildContext();
  const t0  = Date.now();

  const spaceDef    = ctx.msdBuildPhase7bSearchSpaceDefinition();
  const frozenSpace = ctx.msdFreezeSearchSpace(spaceDef, 'phase8_campaign',
                        { schemaVersion: ctx.MSD_SEARCH_SPACE_SPEC_VERSION_V2 });

  const result = await ctx.msdRunPhase7bDiscovery(states, frozenSpace, {
    permutations:       1000,
    seed:               42,
    alpha:              0.05,
    parentRunId:        'phase8_official_nc_campaign_v1',
    uncertaintyHandling: { filterCertainOnly: true },
  });

  return {
    ...result,
    serverElapsedMs: Date.now() - t0,
    frozenSearchSpace: {
      searchSpaceId:      frozenSpace.searchSpaceId,
      searchSpaceHash:    frozenSpace.searchSpaceHash,
      searchSpaceVersion: frozenSpace.searchSpaceVersion,
    },
    executedAt:    new Date().toISOString(),
    engineVersion: 'phase8-server-engine-v1',
  };
}

module.exports = { getSeal, runCampaign, buildContext };
