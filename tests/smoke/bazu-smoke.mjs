import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// BAZU/CRT browser smoke: loads the app with a stubbed WebSocket, opens the BAZU page, imports the engine
// module the page uses and checks the CRT switches/status shape. Fails on any console or script error.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromePath = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
assert.ok(fs.existsSync(chromePath), "Chrome is required; set CHROME_PATH.");

const appPrefix = `<script>
window.__errs = [];
const __ce = console.error.bind(console);
console.error = (...a) => { window.__errs.push(a.map(String).join(" ")); __ce(...a); };
window.addEventListener("error", (e) => window.__errs.push(e.message || "window error"));
window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason)));
window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() { this.readyState = 3; } };
</script>`;

const smokePage = `<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="r">RUNNING</pre><iframe id="app" src="/index.html?smoke=1"></iframe>
<script>
(async () => {
  const out = document.getElementById("r"), frame = document.getElementById("app"), checks = [];
  const check = (c, m) => { if (!c) throw new Error(m); checks.push(m); };
  await new Promise((res) => frame.addEventListener("load", res, { once: true }));
  await new Promise((res) => setTimeout(res, 800));
  const app = frame.contentWindow, doc = frame.contentDocument;
  app.showPage("bazu");
  await new Promise((res) => setTimeout(res, 500));
  check(doc.getElementById("page-bazu").classList.contains("active"), "BAZU page opens");
  const scripts = [...doc.querySelectorAll("script[type=module]")].map((s) => s.src + s.textContent);
  const page = scripts.join(" ").match(/bazu\\/page\\.js\\?v=\\d+/);
  check(page, "BAZU page module is referenced");
  const engine = await app.eval("import('/src/bazu/engine.js?v=29')");
  const st = engine.crtStatus("R_75");
  check(st.switches.crt_enabled === true, "crt_enabled defaults to true");
  check(st.switches.crt_trade_enabled === false, "crt_trade_enabled defaults to false");
  check(Array.isArray(st.signals) && st.signals.length === 0, "no mapped CRT signals before any scan");
  check(st.executionEligible === false, "CRT execution is not eligible");
  check(st.enabled === true && st.demoOnly === true, "CRT stays shadow and demo-only");
  check(app.__errs.length === 0, "no JavaScript or console errors: " + app.__errs.join(" | "));
  out.textContent = "BAZU_SMOKE_PASS " + checks.length + " checks: " + checks.join("; ");
})().catch((e) => { document.getElementById("r").textContent = "BAZU_SMOKE_FAIL " + (e && e.stack || e); });
</script></body></html>`;

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__bazu_smoke__") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(smokePage); return; }
  const file = path.resolve(repoRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  if (!file.startsWith(repoRoot + path.sep)) { res.writeHead(403).end("Forbidden"); return; }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(file === path.join(repoRoot, "index.html") && url.searchParams.has("smoke") ? content.toString("utf8").replace("<head>", "<head>" + appPrefix) : content);
  });
});

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bazu-smoke-"));
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}/__bazu_smoke__`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-extensions", "--user-data-dir=" + userDataDir, "--virtual-time-budget=6000", "--timeout=25000", "--dump-dom", url], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; });
    child.once("error", reject); child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(result.status, 0, result.stderr);
  const m = result.stdout.match(/id="r">([\s\S]*?)<\/pre>/);
  assert.ok(m, "no result returned: " + result.stdout.slice(-1500));
  assert.ok(m[1].startsWith("BAZU_SMOKE_PASS"), m[1]);
  console.log(m[1]);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
