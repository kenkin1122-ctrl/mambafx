(function (root) {
  "use strict";

  const STORAGE_KEY = "mfx_modules_v1";
  const GROUPS = {
    R1: {
      label: "Research explorers",
      pages: ["msdexplorer", "msdfeatures", "msdevents", "msdinspector", "msdcorrelation", "msdsearch"],
      pageLabels: ["Database Explorer", "Feature Completeness", "Positive Event Browser", "Snapshot Inspector", "Correlation Explorer", "Market State Search"],
    },
    R2: {
      label: "Research tools",
      pages: ["msdexperiment", "msdknowledge", "msdvalidation", "msdworkbench"],
      pageLabels: ["Experiment Runner", "Knowledge Base", "Research Validation Suite", "Research Workbench"],
    },
    R3: {
      label: "Research campaigns",
      pages: ["msdphase8", "msdphase9", "msdphase11", "msdphase11validation"],
      pageLabels: ["Phase 8 Campaign", "Phase 9 Adaptive", "Phase 11", "Ph11 Validation"],
    },
  };
  const PAGE_GROUP = {};
  Object.keys(GROUPS).forEach((group) => {
    GROUPS[group].pages.forEach((page) => { PAGE_GROUP[page] = group; });
  });

  let storageError = null;
  let storage;
  try {
    storage = root.localStorage;
  } catch (error) {
    storageError = error;
    console.error("[Modules] Could not access browser storage.", error);
  }
  const now = () => new Date().toISOString();
  const defaultGroups = () => ({ R1: false, R2: false, R3: false });

  function emptyState() {
    return { version: 1, groups: defaultGroups(), disabledSince: {}, gapMarkers: [] };
  }

  function normalizeState(parsed) {
    const state = emptyState();
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      return state;
    }
    Object.keys(GROUPS).forEach((group) => {
      if (typeof parsed.groups?.[group] === "boolean") state.groups[group] = parsed.groups[group];
      if (!state.groups[group] && typeof parsed.disabledSince?.[group] === "string") {
        state.disabledSince[group] = parsed.disabledSince[group];
      }
    });
    if (Array.isArray(parsed.gapMarkers)) {
      state.gapMarkers = parsed.gapMarkers.filter((marker) =>
        marker && Object.keys(GROUPS).includes(marker.group) &&
        typeof marker.startTime === "string" && typeof marker.endTime === "string" &&
        marker.reason === "module switch"
      );
    }
    return state;
  }

  function loadState() {
    try {
      if (!storage) throw new Error("localStorage is unavailable.");
      const raw = storage.getItem(STORAGE_KEY);
      if (raw == null) return emptyState();
      try {
        return normalizeState(JSON.parse(raw));
      } catch (error) {
        storageError = error;
        console.error("[Modules] Could not parse saved module settings.", error);
        return emptyState();
      }
    } catch (error) {
      storageError = error;
      console.error("[Modules] Could not read saved module settings.", error);
      return emptyState();
    }
  }

  let state = loadState();

  function persistState() {
    try {
      if (!storage) throw new Error("localStorage is unavailable.");
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageError = null;
      return true;
    } catch (error) {
      storageError = error;
      console.error("[Modules] Could not save module settings.", error);
      return false;
    }
  }

  function transitionGroup(group, enabled) {
    const previous = state.groups[group];
    if (previous === enabled) return false;
    const timestamp = now();
    if (enabled) {
      const startTime = state.disabledSince[group] || timestamp;
      state.gapMarkers.push({
        group,
        startTime,
        endTime: timestamp,
        reason: "module switch",
        scope: "research page group",
      });
      delete state.disabledSince[group];
    } else {
      state.disabledSince[group] = timestamp;
    }
    state.groups[group] = enabled;
    return true;
  }

  function applyUrlOverride() {
    if (!root.location || !root.location.href || typeof root.URL !== "function") return;
    const url = new root.URL(root.location.href);
    const override = url.searchParams.get("modules");
    if (override !== "on" && override !== "off") return;

    const enabled = override === "on";
    Object.keys(GROUPS).forEach((group) => transitionGroup(group, enabled));
    persistState();
    url.searchParams.delete("modules");
    try {
      root.history.replaceState(root.history.state, "", url.pathname + url.search + url.hash);
    } catch (error) {
      console.error("[Modules] Could not remove the one-time modules URL override.", error);
    }
  }

  applyUrlOverride();

  Object.keys(GROUPS).forEach((group) => {
    if (!state.groups[group] && !state.disabledSince[group]) state.disabledSince[group] = now();
  });
  persistState();

  const runtimeGroups = Object.assign({}, state.groups);

  function dispatchChange(group, enabled) {
    if (typeof root.dispatchEvent !== "function" || typeof root.CustomEvent !== "function") return;
    root.dispatchEvent(new root.CustomEvent("mfx:modules-changed", { detail: { group, enabled } }));
  }

  function setGroupEnabled(group, enabled) {
    if (!Object.prototype.hasOwnProperty.call(GROUPS, group)) {
      throw new Error("Unknown MambaFX module group: " + group);
    }
    if (typeof enabled !== "boolean") throw new TypeError("Module state must be a boolean.");
    if (!transitionGroup(group, enabled)) return { changed: false, persisted: true };
    if (!enabled) runtimeGroups[group] = false;
    const persisted = persistState();
    dispatchChange(group, enabled);
    return { changed: true, persisted, error: storageError };
  }

  function setAllEnabled(enabled) {
    const results = Object.keys(GROUPS).map((group) => setGroupEnabled(group, enabled));
    return {
      changed: results.some((result) => result.changed),
      persisted: results.every((result) => result.persisted),
      error: storageError,
    };
  }

  function isGroupEnabled(group) {
    return !!state.groups[group];
  }

  function isGroupActive(group) {
    return !!runtimeGroups[group];
  }

  function groupForPage(page) {
    return PAGE_GROUP[page] || null;
  }

  function isPageActive(page) {
    const group = groupForPage(page);
    return !group || isGroupActive(group);
  }

  function getSnapshot() {
    return {
      version: state.version,
      groups: Object.assign({}, state.groups),
      runtimeGroups: Object.assign({}, runtimeGroups),
      disabledSince: Object.assign({}, state.disabledSince),
      gapMarkers: state.gapMarkers.map((marker) => Object.assign({}, marker)),
      storageError: storageError ? String(storageError.message || storageError) : null,
    };
  }

  function getDiagnosticsSnapshot() {
    return {
      generatedAt: now(),
      settingsKey: STORAGE_KEY,
      ...getSnapshot(),
      sharedCollection: {
        status: "active",
        stores: ["mfx_msd_events", "mfx_msd_states"],
        reason: "Feature Distribution and other non-listed consumers use the shared Live Tracker collector.",
      },
    };
  }

  function downloadDiagnostics() {
    const blob = new root.Blob([JSON.stringify(getDiagnosticsSnapshot(), null, 2)], { type: "application/json" });
    const url = root.URL.createObjectURL(blob);
    const link = root.document.createElement("a");
    link.href = url;
    link.download = "mambafx-module-diagnostics.json";
    link.click();
    root.URL.revokeObjectURL(url);
  }

  const hiddenChildren = new WeakMap();

  function renderDisabledPage(pageElement, group) {
    if (!pageElement || !GROUPS[group]) return;
    pageElement.querySelectorAll("*").forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      });
    });
    let placeholder = pageElement.querySelector(".modules-disabled-placeholder");
    if (!placeholder) {
      placeholder = root.document.createElement("div");
      placeholder.className = "grid-card modules-disabled-placeholder";
      placeholder.style.cssText = "margin:16px 0;padding:24px;text-align:center";
      pageElement.prepend(placeholder);
    }
    Array.from(pageElement.children).forEach((child) => {
      if (child === placeholder) return;
      if (!hiddenChildren.has(child)) hiddenChildren.set(child, child.hidden);
      child.hidden = true;
    });
    placeholder.innerHTML =
      '<h2>Disabled in Modules settings</h2>' +
      '<p class="gc-sub" style="margin:10px 0">This page group is off. Enabling it takes effect after reload.</p>' +
      '<button class="gc-btn" type="button">Enable ' + group + ' and reload</button>' +
      '<div class="gc-sub modules-enable-error" role="alert"></div>';
    placeholder.querySelector("button").addEventListener("click", () => {
      const result = setGroupEnabled(group, true);
      if (result.persisted) root.location.reload();
      else placeholder.querySelector(".modules-enable-error").textContent =
        "Could not save the setting; reload was not started. " + String(result.error?.message || result.error || "");
    }, { once: true });
  }

  function restorePage(pageElement) {
    if (!pageElement) return;
    const placeholder = pageElement.querySelector(".modules-disabled-placeholder");
    if (placeholder) placeholder.remove();
    Array.from(pageElement.children).forEach((child) => {
      if (hiddenChildren.has(child)) {
        child.hidden = hiddenChildren.get(child);
        hiddenChildren.delete(child);
      }
    });
  }

  function updatePanel() {
    const panel = root.document.getElementById("moduleSettingsPanel");
    if (!panel) return;
    Object.keys(GROUPS).forEach((group) => {
      const checkbox = root.document.getElementById("moduleSwitch" + group);
      if (checkbox) checkbox.checked = isGroupEnabled(group);
    });
    const offGroups = Object.keys(GROUPS).filter((group) => !isGroupEnabled(group));
    const badge = root.document.getElementById("modulesOffBadge");
    if (badge) {
      badge.textContent = offGroups.length ? offGroups.length + " OFF" : "";
      badge.hidden = offGroups.length === 0;
    }
    const status = root.document.getElementById("moduleSettingsStatus");
    if (status) {
      const needsReload = Object.keys(GROUPS).some((group) => isGroupEnabled(group) && !isGroupActive(group));
      status.textContent = storageError
        ? "Settings could not be saved: " + String(storageError.message || storageError)
        : needsReload
          ? "Enabled groups will start after reload. Disabled groups stop new page work immediately."
          : "Disabled groups stop new page work immediately. Enabling a group requires reload.";
    }
    const markers = root.document.getElementById("moduleGapMarkers");
    if (markers) {
      const report = getDiagnosticsSnapshot();
      markers.textContent = JSON.stringify({
        groups: report.groups,
        runtimeGroups: report.runtimeGroups,
        disabledSince: report.disabledSince,
        gapMarkers: report.gapMarkers,
        sharedCollection: report.sharedCollection,
      }, null, 2);
    }
  }

  function renderDiagnostics(elementId) {
    const element = root.document && root.document.getElementById(elementId);
    if (element) element.textContent = JSON.stringify(getDiagnosticsSnapshot(), null, 2);
  }

  function initializePanel() {
    if (!root.document) return;
    const openButton = root.document.getElementById("moduleSettingsButton");
    const panel = root.document.getElementById("moduleSettingsPanel");
    if (!openButton || !panel) return;
    openButton.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      openButton.setAttribute("aria-expanded", String(!panel.hidden));
    });
    Object.keys(GROUPS).forEach((group) => {
      const checkbox = root.document.getElementById("moduleSwitch" + group);
      if (!checkbox) return;
      checkbox.addEventListener("change", () => {
        setGroupEnabled(group, checkbox.checked);
        updatePanel();
      });
    });
    const applyButton = root.document.getElementById("moduleApplyReload");
    if (applyButton) applyButton.addEventListener("click", () => root.location.reload());
    const allOffButton = root.document.getElementById("moduleAllOff");
    if (allOffButton) allOffButton.addEventListener("click", () => {
      setAllEnabled(false);
      updatePanel();
    });
    const allOnButton = root.document.getElementById("moduleAllOn");
    if (allOnButton) allOnButton.addEventListener("click", () => {
      setAllEnabled(true);
      updatePanel();
    });
    const downloadButton = root.document.getElementById("moduleDiagnosticsDownload");
    if (downloadButton) downloadButton.addEventListener("click", downloadDiagnostics);
    root.addEventListener("mfx:modules-changed", updatePanel);
    Object.keys(GROUPS).forEach((group) => {
      if (!isGroupActive(group)) {
        GROUPS[group].pages.forEach((page) => {
          renderDisabledPage(root.document.getElementById("page-" + page), group);
        });
      }
    });
    updatePanel();
  }

  const api = {
    storageKey: STORAGE_KEY,
    groups: GROUPS,
    getGroupForPage: groupForPage,
    isGroupEnabled,
    isGroupActive,
    isPageActive,
    setGroupEnabled,
    setAllEnabled,
    getSnapshot,
    getDiagnosticsSnapshot,
    downloadDiagnostics,
    renderDiagnostics,
    renderDisabledPage,
    restorePage,
    updatePanel,
  };
  root.mfxModuleSwitches = api;

  if (root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", initializePanel, { once: true });
    } else {
      initializePanel();
    }
  }
})(window);
