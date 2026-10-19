import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(repoRoot, "src", "modules", "moduleSwitches.js"), "utf8");

function createRuntime(storageValues = new Map(), search = "") {
  const locationUrl = new URL("https://mambafx.test/" + search);
  const errors = [];
  const history = {
    state: null,
    replaceState(_state, _title, nextUrl) {
      locationUrl.href = new URL(nextUrl, locationUrl).href;
    },
  };
  const window = {
    URL,
    URLSearchParams,
    location: {
      get href() { return locationUrl.href; },
      reload() {},
    },
    history,
    localStorage: {
      getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
      setItem(key, value) { storageValues.set(key, value); },
    },
    document: null,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
    dispatchEvent(event) { errors.events.push(event); return true; },
    addEventListener() {},
    console: { error(...args) { errors.push(args); } },
  };
  errors.events = [];
  vm.runInNewContext(source, { window, console: window.console, URL, URLSearchParams });
  return { api: window.mfxModuleSwitches, window, storageValues, errors, locationUrl };
}

test("all research groups default off and page membership excludes non-listed features", () => {
  const { api, storageValues } = createRuntime();
  assert.deepEqual(JSON.parse(JSON.stringify(api.getSnapshot().groups)), { R1: false, R2: false, R3: false });
  assert.deepEqual(JSON.parse(JSON.stringify(api.groups.R1.pages)), ["msdexplorer", "msdfeatures", "msdevents", "msdinspector", "msdcorrelation", "msdsearch"]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.groups.R2.pages)), ["msdexperiment", "msdknowledge", "msdvalidation", "msdworkbench"]);
  assert.deepEqual(JSON.parse(JSON.stringify(api.groups.R3.pages)), ["msdphase8", "msdphase9", "msdphase11", "msdphase11validation"]);
  assert.equal(api.getGroupForPage("msdexplorer"), "R1");
  assert.equal(api.getGroupForPage("msdworkbench"), "R2");
  assert.equal(api.getGroupForPage("msdphase11validation"), "R3");
  for (const page of ["msddistribution", "features", "analysis", "predbot", "oubot", "digits", "bazu", "rfabot", "tracker", "candles", "engine", "grid", "charts", "mtf", "njanja", "aggression", "adxbot", "diag"]) {
    assert.equal(api.getGroupForPage(page), null, page + " must not be gated");
  }
  assert.ok(storageValues.has("mfx_modules_v1"));
  const savedState = new Map([["mfx_modules_v1", JSON.stringify({
    version: 1,
    groups: { R1: true, R2: false, R3: false },
    disabledSince: { R1: "stale-disabled-time" },
  })]]);
  const restored = createRuntime(savedState);
  assert.equal(restored.api.isGroupActive("R1"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(restored.api.getSnapshot().disabledSince, "R1"), false);
});

test("changes persist, off takes effect immediately, and on waits for reload", () => {
  const storage = new Map([["legacy-preference", "preserve-me"]]);
  const first = createRuntime(storage);
  const enabled = first.api.setGroupEnabled("R1", true);
  assert.equal(enabled.persisted, true);
  assert.equal(first.api.isGroupEnabled("R1"), true);
  assert.equal(first.api.isGroupActive("R1"), false);
  assert.equal(first.api.getSnapshot().gapMarkers[0].reason, "module switch");

  const reloaded = createRuntime(storage);
  assert.equal(reloaded.api.isGroupActive("R1"), true);
  reloaded.api.setGroupEnabled("R1", false);
  assert.equal(reloaded.api.isGroupActive("R1"), false);
  assert.equal(storage.get("legacy-preference"), "preserve-me");
  assert.equal(reloaded.api.getSnapshot().disabledSince.R1.length > 0, true);

  const nextReload = createRuntime(storage);
  assert.equal(nextReload.api.isGroupActive("R1"), false);
  nextReload.api.setGroupEnabled("R1", true);
  assert.equal(nextReload.api.isGroupActive("R1"), false);
  assert.equal(nextReload.api.getSnapshot().gapMarkers.length, 2);
  assert.ok(nextReload.api.getSnapshot().gapMarkers.every((marker) => marker.scope === "research page group"));
});

test("?modules=on and ?modules=off override saved groups and consume the URL switch", () => {
  const storage = new Map();
  const forcedOn = createRuntime(storage, "?modules=on&keep=1");
  assert.deepEqual(JSON.parse(JSON.stringify(forcedOn.api.getSnapshot().groups)), { R1: true, R2: true, R3: true });
  assert.equal(forcedOn.api.isGroupActive("R2"), true);
  assert.equal(forcedOn.locationUrl.search, "?keep=1");

  const forcedOff = createRuntime(storage, "?modules=off");
  assert.deepEqual(JSON.parse(JSON.stringify(forcedOff.api.getSnapshot().groups)), { R1: false, R2: false, R3: false });
  assert.equal(forcedOff.api.isGroupActive("R3"), false);
  assert.equal(forcedOff.locationUrl.search, "");
});

test("diagnostics include saved/runtime states, disabled intervals, and shared-capture scope", () => {
  const { api } = createRuntime();
  api.setGroupEnabled("R1", true);
  const report = api.getDiagnosticsSnapshot();
  assert.equal(report.settingsKey, "mfx_modules_v1");
  assert.equal(report.groups.R1, true);
  assert.equal(report.runtimeGroups.R1, false);
  assert.equal(report.gapMarkers[0].group, "R1");
  assert.equal(report.gapMarkers[0].reason, "module switch");
  assert.equal(report.sharedCollection.status, "active");
  assert.ok(report.sharedCollection.stores.includes("mfx_msd_states"));
});

test("unknown groups and non-boolean switch values are rejected", () => {
  const { api } = createRuntime();
  assert.throws(() => api.setGroupEnabled("R4", false), /Unknown MambaFX module group/);
  assert.throws(() => api.setGroupEnabled("R1", "off"), /must be a boolean/);
});
