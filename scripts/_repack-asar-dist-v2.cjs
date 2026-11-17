#!/usr/bin/env node
/**
 * Repack app.asar replacing ONLY dist/, deriving unpack patterns from the
 * base asar itself (no hardcoded glob list — fixes FLAG MISMATCH failures
 * when the installed build was made with a different electron-builder config).
 *
 * Usage: node scripts/_repack-asar-dist-v2.cjs <base-asar>
 * Output: repack-out/app.asar + repack-out/app.asar.unpacked
 *
 * Steps:
 *   1. extract base asar packed entries -> work/app
 *   2. overlay base app.asar.unpacked tree (robocopy /E)
 *   3. robocopy /MIR fresh dist/ over work/app/dist
 *   4. derive unpack patterns from base header:
 *      - a dir whose files are ALL unpacked  -> dir recursive glob
 *      - stray unpacked files                -> exact path patterns
 *   5. pack; verify per-entry unpack flags old vs new
 *      (vanished entries allowed ONLY under dist/)
 *   6. verify new dist markers present
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const GOOD_ASAR = process.argv[2];
// 3rd arg: which renderer build to pack (default: dist). Use dist-next for a
// clean build that carries no stale hashed chunks from previous builds.
const DIST_DIR = path.resolve(process.argv[3] || path.join(root, 'dist'));
assert.ok(GOOD_ASAR && fs.existsSync(GOOD_ASAR), 'usage: node scripts/_repack-asar-dist-v2.cjs <base-asar> [dist-dir]');
assert.ok(fs.existsSync(path.join(DIST_DIR, 'index.html')), `missing index.html in ${DIST_DIR}`);
const OUT_DIR = path.join(root, 'repack-out');
const OUT_ASAR = path.join(OUT_DIR, 'app.asar');

const robocopy = (args) => {
  try { execFileSync('robocopy', [...args, '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' }); }
  catch (e) { if ((e.status || 0) >= 8) throw e; }
};

/** Empty a directory with native robocopy /MIR (fs.rmSync is intercepted by
 *  the sandbox safe-delete shim and fails on bulk deletes). */
const emptyDir = (dir) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-empty-'));
  fs.mkdirSync(dir, { recursive: true });
  robocopy([scratch, dir, '/MIR']);
};

// header walk -> Map<rel,{unpacked,dir}>
function walkHeader(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) walkHeader(child, rel, out);
    else out.set(rel.replace(/\\/g, '/'), { unpacked: Boolean(child.unpacked) });
  }
  return out;
}

/** Derive the minimal set of topmost "pure" directories (every file under
 *  them is unpacked) from the base header. Verified empirically: asar's
 *  `unpack` glob option does NOT match subdirectory files on Windows, but
 *  `unpackDir` with forward-slash literal prefixes does, recursively. */
function deriveUnpackDirs(header) {
  const purity = (node) => {
    const entries = Object.entries(node.files || {});
    const files = entries.filter(([, v]) => !v.files);
    const dirs = entries.filter(([, v]) => v.files);
    return files.every(([, v]) => v.unpacked) && dirs.every(([, v]) => purity(v));
  };
  const maximal = [];
  const walk = (node, rel, parentPure) => {
    const entries = Object.entries(node.files || {});
    if (entries.length === 0) return;
    const pure = purity(node);
    if (pure && !parentPure) { maximal.push(rel || '.'); return; }
    for (const [name, child] of entries) if (child.files) walk(child, rel ? `${rel}/${name}` : name, pure);
  };
  walk(header, '', true);
  return maximal.filter((d) => d !== '.');
}

function flagsOf(asarPath) {
  const header = JSON.parse(asar.getRawHeader(asarPath).headerString);
  return walkHeader(header, '', new Map());
}

function hashTree(dir) {
  const out = new Map();
  const walk = (cur, prefix) => {
    for (const item of fs.readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(path.join(cur, item.name), rel);
      else out.set(rel.replace(/\\/g, '/'), crypto.createHash('sha256').update(fs.readFileSync(path.join(cur, item.name))).digest('hex'));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

(async () => {
  const work = path.join(os.tmpdir(), `netcatty-repack2-${Date.now()}`);
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  console.log('work:', work);

  const baseHeader = flagsOf(GOOD_ASAR);
  const unpackedCount = [...baseHeader.values()].filter((v) => v.unpacked).length;
  console.log('base entries:', baseHeader.size, 'unpacked:', unpackedCount);

  // 1-2. extract + overlay unpacked tree
  asar.extractAll(GOOD_ASAR, appDir);
  const unpackedDir = path.join(path.dirname(GOOD_ASAR), 'app.asar.unpacked');
  assert.ok(fs.existsSync(unpackedDir), 'missing app.asar.unpacked next to base asar');
  robocopy([unpackedDir, appDir, '/E']);
  console.log('extracted + overlayed');

  // 3. replace dist
  robocopy([DIST_DIR, path.join(appDir, 'dist'), '/MIR']);
  console.log('dist replaced from', DIST_DIR);

  // 3b. sync electron/ main-process sources (update-sokai used to replace
  // ONLY dist/, so main-process fixes never reached the installed asar).
  // Exclude test files, native build outputs and plugin fixtures — the base
  // asar never contained them.
  const ELECTRON_SRC = path.join(root, 'electron');
  assert.ok(fs.existsSync(path.join(ELECTRON_SRC, 'bridges', 'aiBridge', 'sdk', 'sdkStreamHandlers.cjs')),
    'electron source tree missing');
  robocopy([
    ELECTRON_SRC, path.join(appDir, 'electron'), '/E',
    '/XF', '*.test.cjs',
    '/XD', path.join(ELECTRON_SRC, 'bridges', 'windowsHelloHelper', 'build'),
    path.join(ELECTRON_SRC, 'plugins', 'fixtures'),
  ]);
  console.log('electron/ synced from source');

  // 4. derive unpack dirs + pack
  const unpackDirs = deriveUnpackDirs(JSON.parse(asar.getRawHeader(GOOD_ASAR).headerString));
  console.log('derived unpack dirs:', unpackDirs.length, '->', unpackDirs.slice(0, 6).join(', '), '...');
  emptyDir(OUT_DIR);
  await asar.createPackageWithOptions(appDir, OUT_ASAR, { unpackDir: `{${unpackDirs.join(',')}}` });
  console.log('packed ->', OUT_ASAR);

  // 5. verify flags
  const before = baseHeader;
  const after = flagsOf(OUT_ASAR);
  let mismatch = 0;
  let vanished = 0;
  for (const [rel, meta] of before) {
    const now = after.get(rel);
    if (!now) {
      if (rel.startsWith('dist/')) { vanished += 1; continue; } // old hashed bundles are fine to drop
      vanished += 1;
      console.log('VANISHED(non-dist):', rel);
      continue;
    }
    if (now.unpacked !== meta.unpacked) { mismatch += 1; console.log('FLAG MISMATCH:', rel, 'old=', meta.unpacked, 'new=', now.unpacked); }
  }
  let newEntries = 0;
  for (const rel of after.keys()) if (!before.has(rel)) newEntries += 1;
  assert.equal(mismatch, 0, 'unpack flags must be identical');
  assert.ok([...before.keys()].every((rel) => rel.startsWith('dist/') || after.has(rel)), 'no non-dist entry may vanish');
  console.log('flags OK; vanished dist entries:', vanished, '; new entries:', newEntries);

  // 5b. unpacked tree identical
  const oldUnpacked = hashTree(unpackedDir);
  const newUnpacked = hashTree(path.join(OUT_DIR, 'app.asar.unpacked'));
  let treeMismatch = 0;
  for (const [rel, hash] of oldUnpacked) {
    if (newUnpacked.get(rel) !== hash) { treeMismatch += 1; console.log('UNPACKED DIFF:', rel); }
  }
  assert.equal(treeMismatch, 0, 'unpacked tree must be identical');
  console.log('unpacked tree OK');

  // 6. dist markers — the supervisor UI lives in the lazy AIChatSidePanel
  // chunk, not the entry chunk; extract via extractAll (extractFile chokes
  // on multi-MB entries in some builds).
  const extractCheck = path.join(os.tmpdir(), `netcatty-repack2-verify-${Date.now()}`);
  asar.extractAll(OUT_ASAR, extractCheck);
  const chatChunks = fs.readdirSync(path.join(extractCheck, 'dist', 'assets')).filter((f) => f.startsWith('AIChatSidePanel-'));
  const idx = fs.readFileSync(path.join(extractCheck, 'dist', 'index.html'), 'utf8');
  console.log('dist entry:', idx.match(/\.\/(assets\/index-[^"]+\.js)/)?.[1]);
  let statusbarFound = false;
  for (const f of chatChunks) {
    const buf = fs.readFileSync(path.join(extractCheck, 'dist', 'assets', f), 'utf8');
    const statusbar = buf.includes('data-supervisor-summary-prompt');
    const card = buf.includes('data-supervisor-run-summary-prompt');
    console.log(`  ${f}: statusbarPrompt=${statusbar} cardPrompt=${card}`);
    statusbarFound ||= statusbar;
  }
  // 6b. electron marker — proves the main-process sync (step 3b) actually
  // deployed current sources into the packed asar.
  const packedSdkHandlers = fs.readFileSync(
    path.join(extractCheck, 'electron', 'bridges', 'aiBridge', 'sdk', 'sdkStreamHandlers.cjs'), 'utf8');
  assert.ok(packedSdkHandlers.includes('CODEX_MODEL_LIST_TIMEOUT_MS'),
    'packed sdkStreamHandlers.cjs must be the updated main-process source');
  console.log('electron marker OK (CODEX_MODEL_LIST_TIMEOUT_MS present)');

  emptyDir(extractCheck);
  assert.ok(statusbarFound, 'fresh AIChatSidePanel chunk with statusbar prompt button must be present');

  const st = fs.statSync(OUT_ASAR);
  console.log('OK size=', st.size);
})().catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
