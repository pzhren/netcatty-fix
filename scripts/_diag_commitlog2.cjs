// Sample React commit counter over time (hook injected pre-boot) to see whether
// the freeze is a commit storm, and which components sit at the tree's top level.
// Usage: DIAG_DATA=<dir> node scripts/_diag_commitlog2.cjs [seconds]
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');

const EXE = 'D:/APP/Netcatty/Netcatty-秒开/Netcatty.exe';
const DATA = process.env.DIAG_DATA;
const SECONDS = Number(process.argv[2] || 40);
const PORT = Number(process.env.DIAG_PORT || 9504);
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

const HOOK_SRC = `(function(){
  window.__c = 0; window.__top = ''; window.__nodes = 0;
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  function topNames(root) {
    var names = [], f = root.current && root.current.child, guard = 0;
    while (f && guard < 14) {
      var t = f.type;
      names.push(typeof t === 'string' ? t : ((t && (t.displayName || t.name)) || ('tag' + f.tag)));
      f = f.sibling; guard++;
    }
    return names.join('|');
  }
  if (hook && hook.__mine) return 'already';
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    __mine: true, renderers: new Map(), supportsFiber: true,
    inject(i) { this.renderers.set(1, i); return 1; },
    onCommitFiberRoot(rid, root) {
      window.__c += 1;
      window.__lastRoot = root;
      try { window.__top = topNames(root); } catch (e) {}
    },
    onScheduleFiberRoot() {}, onCommitFiberMount() {},
  };
  return 'hooked';
})()`;

(async () => {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
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
  const send = (method, params = {}, ms = 4000) => new Promise((res) => {
    const id = idSeq++;
    const timer = setTimeout(() => { pending.delete(id); res(null); }, ms);
    pending.set(id, (m) => { clearTimeout(timer); res(m); });
    try { ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); res(null); }
  });

  await send('Page.enable', {}, 3000);
  // Inject immediately on the live page: React has not mounted yet (~4s), so the
  // hook is still read at boot. Reloading would shorten the freeze window.
  const injected = await send('Runtime.evaluate', { expression: HOOK_SRC, returnByValue: true }, 4000);
  console.log('hook injected:', injected?.result?.result?.value || '(no answer)');

  let prev = null;
  while (Date.now() - t0 < SECONDS * 1000) {
    const at = ((Date.now() - t0) / 1000).toFixed(1);
    const t = Date.now();
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const attrs = new Set();
        document.querySelectorAll('*').forEach(el => {
          for (const a of el.getAttributeNames()) {
            if (a.startsWith('data-supervisor') || a.startsWith('data-monitor')) attrs.add(a);
          }
        });
        return {c: window.__c||0, pending: attrs.size, names: [...attrs].join(','),
                n: document.getElementsByTagName('*').length,
                txt: (document.body.innerText||'').replace(/\s+/g,' ').slice(0,90)};
      })()`,
      returnByValue: true,
    }, 2500);
    const lat = Date.now() - t;
    if (!r) { console.log(`${at}s TIMEOUT (frozen)`); break; }
    const v = r.result?.result?.value || {};
    const d = prev === null ? '-' : (v.c - prev);
    console.log(`${at}s commits=${v.c} (+${d}) nodes=${v.n} lat=${lat}ms pending=${v.pending} names=${String(v.names).slice(0,200)} txt=${String(v.txt||'').slice(0,60)}`);
    prev = v.c;
    await sleep(400);
  }
  cleanup();
  process.exit(0);
})().catch((e) => { console.log('FAIL', e.message); cleanup(); process.exit(1); });
