// Probe-only: launch instance against given data dir, report ALIVE/FROZEN, exit.
// Env: DIAG_DATA (required), DIAG_PORT (default: 9460 + pid%500, avoids port reuse).
// Always kills the spawned instance tree on exit.
const { spawn } = require('node:child_process');
const { execSync } = require('node:child_process');
const http = require('node:http');

const EXE = 'D:/APP/Netcatty/Netcatty-秒开/Netcatty.exe';
const PORT = Number(process.env.DIAG_PORT || (9460 + (process.pid % 500)));
const DATA = process.env.DIAG_DATA;
if (!DATA) { console.error('DIAG_DATA required'); process.exit(1); }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PORTABLE_EXECUTABLE_DIR = DATA;
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, detached: true, stdio: 'ignore' });
child.unref();

const cleanup = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} };
const done = (msg, code) => { console.log(msg); cleanup(); process.exit(code); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    try {
      const list = await httpGet(`http://127.0.0.1:${PORT}/json/list`);
      page = list.find((t) => t.type === 'page' && !/devtools/.test(t.url));
      if (page && /index\.html/.test(page.url)) break;
    } catch {}
  }
  if (!page) done('NO PAGE', 1);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let idSeq = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = idSeq++;
    pending.set(id, res);
    try { ws.send(JSON.stringify({ id, method, params })); } catch { pending.delete(id); res(null); }
  });
  await sleep(6000); // mount window
  const t0 = Date.now();
  const probe = await Promise.race([
    send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
    sleep(120000).then(() => null),
  ]);
  done(probe ? `RESPONDED after ${Date.now() - t0}ms (1+1=${probe.result?.result?.value})` : 'STUCK >120s', 0);
})().catch((e) => { console.error('ERR', e.message); cleanup(); process.exit(1); });
