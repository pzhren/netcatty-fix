// Spawn an instance on a given data dir, then dump localStorage shape stats. Kills on exit.
// Usage: DIAG_DATA=<dir> DIAG_PORT=<port> node scripts/_diag_stats.cjs
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');

const EXE = 'D:/APP/Netcatty/Netcatty-秒开/Netcatty.exe';
const PORT = Number(process.env.DIAG_PORT || 9490);
const DATA = process.env.DIAG_DATA;
if (!DATA) { console.error('DIAG_DATA required'); process.exit(1); }

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.PORTABLE_EXECUTABLE_DIR = DATA;
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, detached: true, stdio: 'ignore' });
child.unref();
const cleanup = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpGet = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
  let page = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const ev = (expr) => new Promise((res) => {
    const id = idSeq++; pending.set(id, res);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });

  await sleep(7000);
  const probe = await Promise.race([ev('1+1'), sleep(5000).then(() => null)]);
  if (!probe) { console.log('FROZEN — no stats'); cleanup(); process.exit(0); }

  const out = await ev(`(() => {
    const sizes = {};
    for (const k of Object.keys(localStorage)) sizes[k] = (localStorage.getItem(k) || '').length;
    const top = Object.entries(sizes).sort((a,b)=>b[1]-a[1]).slice(0,12)
      .map(([k,v]) => k + ' = ' + (v/1024).toFixed(0) + 'KB');
    let restore = null;
    try {
      const raw = localStorage.getItem('netcatty_session_restore_v1');
      if (raw) { const d = JSON.parse(raw);
        restore = { topKeys: Object.keys(d), tabs: (d.tabs||[]).length, sessions: (d.sessions||[]).length, windows: (d.windows||[]).length };
      }
    } catch (e) { restore = 'parse-error:' + e.message; }
    let ai = null;
    try {
      const raw = localStorage.getItem('netcatty_ai_sessions_v1');
      if (raw) { const arr = JSON.parse(raw);
        ai = { sessions: arr.length,
               msgs: arr.map(s => (s.messages||[]).length),
               totalMsgs: arr.reduce((t,s)=>t+(s.messages||[]).length,0),
               scopes: arr.map(s => String(s.scope && s.scope.kind || s.scope && s.scope.type || '').slice(0,12)) };
      }
    } catch (e) { ai = 'parse-error:' + e.message; }
    const terminalKeys = Object.keys(localStorage).filter(k => k.startsWith('netcatty_terminal')).length;
    const domNodes = document.getElementsByTagName('*').length;
    const xterms = document.querySelectorAll('.xterm').length;
    return JSON.stringify({ top, restore, ai, terminalKeys, domNodes, xterms, vis: document.visibilityState }, null, 1);
  })()`);
  console.log(out.result?.result?.value || JSON.stringify(out).slice(0, 500));
  ws.close();
  cleanup();
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message); cleanup(); process.exit(1); });
