// Continuous heartbeat: spawn instance, evaluate every 2s for 90s, log latency timeline.
// Usage: DIAG_DATA=<dir> DIAG_PORT=<port> node scripts/_diag_heartbeat.cjs [durationSec]
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');

const EXE = 'D:/APP/Netcatty/Netcatty-秒开/Netcatty.exe';
const PORT = Number(process.env.DIAG_PORT || 9496);
const DATA = process.env.DIAG_DATA;
const DURATION = Number(process.argv[2] || 90);
if (!DATA) { console.error('DIAG_DATA required'); process.exit(1); }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PORTABLE_EXECUTABLE_DIR = DATA;
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, detached: true, stdio: 'ignore' });
child.unref();
const t0 = Date.now();
const cleanup = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  let page = null;
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    try {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) break;
    } catch {}
  }
  if (!page) { console.log('NO PAGE'); cleanup(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let idSeq = 1; const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const ev = (expr, ms) => new Promise((res) => {
    const id = idSeq++;
    const timer = setTimeout(() => { pending.delete(id); res(null); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    try { ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); }
    catch { clearTimeout(timer); res(null); }
  });

  const timeline = [];
  while (Date.now() - t0 < DURATION * 1000) {
    const at = Math.round((Date.now() - t0) / 100) / 10;
    const t = Date.now();
    const r = await ev('({n: document.getElementsByTagName("*").length})', 3500);
    const lat = Date.now() - t;
    let extra = '';
    if (r) {
      const nodes = r.result?.result?.value?.n;
      const t2 = Date.now();
      const r2 = await ev('1+1', 3500);
      extra = ` nodes=${nodes} secondLat=${Date.now() - t2}ms${r2 ? '' : ' SECOND_TIMEOUT'}`;
    }
    timeline.push(`${at}s lat=${r ? lat + 'ms' : 'TIMEOUT'}${extra}`);
    console.log(timeline[timeline.length - 1]);
    if (!r) {
      console.log('--- frozen, stop sampling ---');
      break;
    }
    await sleep(2000);
  }
  console.log('SAMPLES=' + timeline.length);
  cleanup();
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message); cleanup(); process.exit(1); });
