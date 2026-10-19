import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const groups = {
  R1: ["msdexplorer", "msdfeatures", "msdevents", "msdinspector", "msdcorrelation", "msdsearch"],
  R2: ["msdexperiment", "msdknowledge", "msdvalidation", "msdworkbench"],
  R3: ["msdphase8", "msdphase9", "msdphase11", "msdphase11validation"],
};

assert.ok(fs.existsSync(chromePath), "Chrome is required; set CHROME_PATH to a headless-capable Chrome executable.");

const appPrefix = `
<script>
window.__mfxSmokeErrors = [];
const __smokeConsoleError = console.error.bind(console);
console.error = (...args) => {
  window.__mfxSmokeErrors.push(args.map((arg) => String(arg)).join(" "));
  __smokeConsoleError(...args);
};
window.addEventListener("error", (event) => window.__mfxSmokeErrors.push(event.message || "window error"));
window.addEventListener("unhandledrejection", (event) => window.__mfxSmokeErrors.push(String(event.reason)));
window.WebSocket = class SmokeWebSocket {
  constructor() { this.readyState = 0; }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() { this.readyState = 3; }
};
window.WebSocket.CONNECTING = 0;
window.WebSocket.OPEN = 1;
window.WebSocket.CLOSING = 2;
window.WebSocket.CLOSED = 3;
</script>`;

const smokePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Modules smoke test</title></head>
<body><pre id="modules-smoke-result">RUNNING</pre><iframe id="app" src="/index.html?modules=off&amp;smoke=1"></iframe>
<script>
function waitForFrameLoad(frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (frame.contentWindow.location.href !== "about:blank" && frame.contentDocument && frame.contentDocument.readyState === "complete") {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Application frame did not load")), timeoutMs);
    frame.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}
function waitForNextFrameLoad(frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Application frame did not reload")), timeoutMs);
    frame.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
  });
}
(async () => {
  const output = document.getElementById("modules-smoke-result");
  const frame = document.getElementById("app");
  await waitForFrameLoad(frame, 15000);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const app = frame.contentWindow;
  const doc = frame.contentDocument;
  const checks = [];
  function check(condition, message) {
    if (!condition) throw new Error(message);
    checks.push(message);
  }

  check(JSON.stringify(app.mfxModuleSwitches.getSnapshot().groups) === '{"R1":false,"R2":false,"R3":false}', "all groups start off");
  check(doc.getElementById("modulesOffBadge").textContent.trim() === "3 OFF" && !doc.getElementById("modulesOffBadge").hidden, "off badge is visible (ready=" + doc.readyState + ", text=" + JSON.stringify(doc.getElementById("modulesOffBadge").textContent) + ", hidden=" + doc.getElementById("modulesOffBadge").hidden + ", status=" + doc.getElementById("moduleSettingsStatus").textContent + ")");
  check(doc.getElementById("moduleSettingsPanel"), "Modules panel is present");
  doc.getElementById("moduleSettingsButton").click();
  check(!doc.getElementById("moduleSettingsPanel").hidden, "Modules panel opens from its button");
  doc.getElementById("moduleSettingsButton").click();
  let stateReads = 0;
  let eventReads = 0;
  const originalStates = app.msdGetAllMarketStates;
  const originalEvents = app.msdGetAllEvents;
  app.msdGetAllMarketStates = async () => { stateReads++; return []; };
  app.msdGetAllEvents = async () => { eventReads++; return []; };
  let pageBootCalls = 0;
  const pageEntrypoints = [
    "msdExplorerRefresh", "msdFeaturesRefresh", "msdEventsRefresh", "msdInspectorRefresh",
    "msdCorrelationRefresh", "msdExperimentHistoryRefresh", "msdKnowledgeRefresh",
    "msdValidationSuiteRefresh", "msdWorkbenchRefresh", "ph8Boot", "ph9Boot",
    "ph11Boot", "ph11ValBoot",
  ];
  for (const name of pageEntrypoints) {
    const original = app[name];
    if (typeof original !== "function") continue;
    app[name] = (...args) => {
      pageBootCalls++;
      return original(...args);
    };
  }

  const groups = ${JSON.stringify(groups)};
  for (const [group, pages] of Object.entries(groups)) {
    for (const page of pages) {
      app.showPage(page);
      const active = doc.getElementById("page-" + page);
      check(active.classList.contains("active"), page + " route remains navigable");
      check(active.querySelector(".modules-disabled-placeholder")?.textContent.includes("Disabled in Modules settings"), page + " shows the disabled notice");
      const placeholder = active.querySelector(".modules-disabled-placeholder");
      check(Array.from(active.children).every((child) => child === placeholder || child.hidden), page + " keeps its page content hidden while disabled");
      check(active.querySelectorAll("[onclick], [onfocus], [onchange], [oninput]").length === 0, page + " has no inline data-action handlers while disabled");
    }
  }
  check(stateReads === 0 && eventReads === 0, "disabled-page navigation opens no page-owned state/event reads");
  check(pageBootCalls === 0, "disabled-page navigation does not boot Phase 8/9/11 pages");

  app.showPage("msddistribution");
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(!doc.getElementById("page-msddistribution").querySelector(".modules-disabled-placeholder"), "Feature Distribution remains enabled");
  check(stateReads === 1, "Feature Distribution still performs its normal page refresh");
  app.showPage("diag");
  check(doc.getElementById("diagModulesReport").textContent.includes('"gapMarkers"'), "Diagnostics report includes module interval markers");
  check(doc.getElementById("diagModulesReport").textContent.includes('"sharedCollection"'), "Diagnostics report states shared collection remains active");
  app.showPage("bazu");
  check(doc.getElementById("page-bazu").classList.contains("active"), "BAZU remains enabled");
  check(app.mfxModuleSwitches.getDiagnosticsSnapshot().sharedCollection.status === "active", "diagnostics report shared collection as active");
  check(app.mfxModuleSwitches.getDiagnosticsSnapshot().gapMarkers.every((marker) => marker.reason === "module switch"), "disabled intervals carry the module-switch reason");
  check(app.__mfxSmokeErrors.length === 0, "application emits no JavaScript or console errors");
  check(originalStates && originalEvents, "shared DB helpers remain wired");

  app.mfxModuleSwitches.setGroupEnabled("R1", true);
  const reloadWait = waitForNextFrameLoad(frame, 15000);
  frame.contentWindow.location.reload();
  await reloadWait;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reloaded = frame.contentWindow;
  const reloadedDoc = frame.contentDocument;
  check(reloaded.mfxModuleSwitches.isGroupActive("R1"), "enabled groups activate after reload");
  check(!reloadedDoc.getElementById("page-msdfeatures").querySelector(".modules-disabled-placeholder"), "enabled R1 page has no disabled placeholder");
  let enabledPageReads = 0;
  reloaded.msdGetAllMarketStates = async () => { enabledPageReads++; return []; };
  reloaded.showPage("msdfeatures");
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(enabledPageReads === 1, "enabled R1 page retains its normal data refresh");
  check(reloaded.mfxModuleSwitches.isGroupActive("R2") === false && reloaded.mfxModuleSwitches.isGroupActive("R3") === false, "R2 and R3 remain independently off");
  check(reloaded.__mfxSmokeErrors.length === 0, "reloaded application emits no JavaScript or console errors");
  reloaded.mfxModuleSwitches.setGroupEnabled("R1", false);
  check(reloadedDoc.getElementById("page-msdfeatures").querySelector(".modules-disabled-placeholder"), "turning R1 off disables the active page immediately");
  reloaded.showPage("msdfeatures");
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(enabledPageReads === 1, "turning R1 off stops subsequent page refreshes");
  const finalReloadWait = waitForNextFrameLoad(frame, 15000);
  frame.contentWindow.location.reload();
  await finalReloadWait;
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(frame.contentWindow.mfxModuleSwitches.isGroupActive("R1") === false, "turning R1 off persists across reload");
  check(frame.contentWindow.__mfxSmokeErrors.length === 0, "application emits no JavaScript or console errors after turning a group off");
  output.textContent = "MODULES_SMOKE_PASS " + checks.length + " checks: " + checks.join("; ");
})().catch((error) => {
  document.getElementById("modules-smoke-result").textContent = "MODULES_SMOKE_FAIL " + (error && error.stack || error);
});
</script></body></html>`;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function runChrome(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(chromePath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__modules_smoke__") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(smokePage);
    return;
  }
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = path.resolve(repoRoot, relativePath);
  if (!filePath.startsWith(repoRoot + path.sep) && filePath !== path.join(repoRoot, "index.html")) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    const body = filePath === path.join(repoRoot, "index.html") && url.searchParams.has("smoke")
      ? content.toString("utf8").replace("<head>", "<head>" + appPrefix)
      : content;
    response.end(body);
  });
});

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mfx-modules-smoke-"));
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const smokeUrl = `http://127.0.0.1:${address.port}/__modules_smoke__`;
  const result = await runChrome([
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-extensions",
    "--user-data-dir=" + userDataDir,
    "--virtual-time-budget=4000",
    "--timeout=20000",
    "--dump-dom",
    smokeUrl,
  ]);
  assert.equal(result.status, 0, result.stderr || "Headless Chrome exited unsuccessfully.");
  const html = result.stdout || "";
  const match = html.match(/id="modules-smoke-result">([\s\S]*?)<\/pre>/);
  assert.ok(match, "Headless browser did not return a smoke-test result. " + (result.stdout || "").slice(-2000) + result.stderr);
  assert.ok(match[1].startsWith("MODULES_SMOKE_PASS"), match[1]);
  console.log(match[1]);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
