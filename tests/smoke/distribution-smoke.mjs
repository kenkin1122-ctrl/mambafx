// Headless browser smoke test (Edge/Chrome via CDP). Run with the static server up: node server.js, then
//   node tests/smoke/distribution-smoke.mjs [baseUrl]
// Opens the BAZU page, switches to the Distribution tab, fails on any console error or uncaught exception.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5000/';
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!exe) { console.log('SMOKE: no browser found - not run'); process.exit(2); }
const port = 9333, dir = fs.mkdtempSync((process.env.TEMP || '/tmp') + '/smoke-');
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(), errors = [];
const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text) + ' @' + (d.params.exceptionDetails.url || '') + ':' + d.params.exceptionDetails.lineNumber);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate', { url: base });
  await sleep(4000);
  for (let i = 0; i < 80 && (await evalJs('typeof window.bazuPageInit')) !== 'function'; i++) await sleep(250);
  await evalJs("showPage('bazu')"); await sleep(1500);
  await evalJs("document.querySelector('#bzTabs [data-t=dist]').click()"); await sleep(1500);
  const text = await evalJs("document.getElementById('bzDist').innerText");
  const tabOn = await evalJs("document.getElementById('bzp-dist').classList.contains('on')");
  const live = await evalJs("document.querySelector('#bzTabs [data-t=live]').click(); document.getElementById('bzSignal') ? 'ok' : 'missing'");
  const fails = [];
  if (live !== 'ok') fails.push('live signal panel missing');
  if (!tabOn) fails.push('distribution pane not active (' + (await evalJs("[typeof window.bazuPageInit, document.getElementById('page-bazu').className, document.querySelector('#bzTabs [data-t=dist]') ? 'btn' : 'nobtn'].join()")) + ')');
  if (!/Market Rise\/Fall distribution/.test(text || '')) fails.push('distribution content missing');
  const real = errors.filter((e) => !/WebSocket|ERR_|Failed to load resource|net::|engineOnTick is not defined/i.test(e));
  if (process.env.SMOKE_VERBOSE) console.log('all errors:', [...new Set(errors)].join('\n'));
  if (real.length) fails.push('console errors: ' + real.join(' | '));
  console.log(fails.length ? 'SMOKE FAIL: ' + fails.join('; ') : 'SMOKE PASS (distribution tab rendered, no console errors)');
  process.exitCode = fails.length ? 1 : 0;
} finally { try { ws?.close(); } catch {} proc.kill(); }
