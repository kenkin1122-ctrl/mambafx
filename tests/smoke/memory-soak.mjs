// Memory soak (Edge/Chrome via CDP). Needs the static server: node server.js
//   node tests/smoke/memory-soak.mjs [seconds=180] [baseUrl]
// Opens BAZU, presses Start, samples JS heap / DOM nodes / listeners, and fails if the heap keeps growing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const secs = Number(process.argv[2] || 180), base = process.argv[3] || 'http://localhost:5000/';
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!exe) { console.log('SOAK: no browser found - not run'); process.exit(2); }
const port = 9344, dir = fs.mkdtempSync((process.env.TEMP || '/tmp') + '/soak-');
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
try {
  let targets;
  for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  await call('Runtime.enable'); await call('Page.enable'); await call('Performance.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>null;' });
  if (process.env.SEED) {
    await call('Page.navigate', { url: base + 'tests/smoke/fakeAccount.js' }); await sleep(2500);
    console.log('seeded', await evalJs(`(async () => {
      const recs = await (await fetch('/seed.json')).json();
      const db = await new Promise((res, rej) => { const rq = indexedDB.open('bazu_siglog', 1); rq.onupgradeneeded = () => { const os = rq.result.createObjectStore('records', { keyPath: 'signal_id' }); os.createIndex('decision_time_epoch_ms', 'decision_time_epoch_ms'); }; rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
      await new Promise((res) => { const tx = db.transaction('records', 'readwrite'); recs.forEach((r) => tx.objectStore('records').put(r)); tx.oncomplete = res; });
      db.close(); return recs.length; })()`));
  }
  await call('Page.navigate', { url: base });
  await sleep(4000);
  for (let i = 0; i < 80 && (await evalJs('typeof window.bazuPageInit')) !== 'function'; i++) await sleep(250);
  await evalJs("showPage('bazu')"); await sleep(1500);
  await evalJs("(document.getElementById('bzStart')||{click(){}}).click()");
  if (process.env.LOGIN) {
    await evalJs(fs.readFileSync(new URL('./fakeAccount.js', import.meta.url), 'utf8'));
    await evalJs("import('/src/bazu/engine.js?v=20').then((E) => { window.__E = E; E.setMode('auto'); E.setRunning(true); return 1; })");
  }
  await call('HeapProfiler.startSampling',{samplingInterval:8192});
  const samples = [];
  for (let t = 0; t <= secs; t += 10) {
    await call('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await call('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]));
    const s = { t, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners };
    if (process.env.LOGIN) Object.assign(s, JSON.parse(await evalJs("JSON.stringify({trades: __E.state.trades.length, open: __E.state.trades.filter(t=>t.status==='open').length, logRecs: __E.signalLogRecords().length, mode: __E.state.mode, running: __E.state.running})")));
    samples.push(s); console.log(JSON.stringify(s));
    if (process.env.TABS) { const tabs = ['live', 'accuracy', 'perf', 'exec', 'calib', 'signal', 'dist']; await evalJs(`document.querySelector('#bzTabs [data-t=${tabs[(t / 10) % tabs.length]}]').click()`); }
    await sleep(10000);
  }
  const prof=(await call('HeapProfiler.stopSampling')).result.profile; const agg=new Map(); (function w(n){ const k=n.callFrame.functionName+' '+n.callFrame.url.split('/').pop()+':'+n.callFrame.lineNumber; agg.set(k,(agg.get(k)||0)+n.selfSize); n.children.forEach(w); })(prof.head); if(process.env.PROF) console.log([...agg].sort((x,y)=>y[1]-x[1]).slice(0,15).map(([k,v])=>(v/1048576).toFixed(1)+'MB '+k).join('\n'));
  if (process.env.PROF) console.log(JSON.stringify(await evalJs('(()=>{const s=window.__bzPerf();return {longTasks:s.longTasks,longMs:s.longMs,worst:s.worstLong,lagMax:s.lagMax,top:Object.entries(s.stages).sort((a,b)=>b[1].total-a[1].total).slice(0,8).map(([k,v])=>k+" n="+v.n+" avg="+v.avg+" max="+v.max),markets:window.bazuState?1:0}})()')));
  console.log('LS', await evalJs('JSON.stringify(Object.keys(localStorage).map(k=>[k,localStorage[k].length]).filter(x=>x[1]>2000))'));
  const a = samples[Math.floor(samples.length / 3)], b = samples.at(-1);
  const perMin = (b.heapMB - a.heapMB) / ((b.t - a.t) / 60);
  console.log(`growth after warm-up: ${perMin.toFixed(2)} MB/min, nodes ${a.nodes}->${b.nodes}`);
  const bad = perMin > 5 || b.nodes > a.nodes * 1.5;
  console.log(bad ? 'SOAK FAIL' : 'SOAK PASS');
  process.exitCode = bad ? 1 : 0;
} finally { try { ws?.close(); } catch {} proc.kill(); }
