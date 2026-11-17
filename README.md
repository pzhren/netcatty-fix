# Netcatty — fixes and packaging (maintained fork)

> 中文版：[README.zh-CN.md](README.zh-CN.md) · Based on [binaricat/Netcatty](https://github.com/binaricat/Netcatty) (GPL-3.0).
> This repo records **behavioural differences from upstream** and **bug fixes**, focused on the
> "window freezes ~10 s after launch" defect fixed on 2026-11-17.

## What this repo is

Not a mirror, not a redistributable build tree. Only three things:

| Path | Contents |
| --- | --- |
| `docs/` | Technical post-mortem and diagnostic method |
| `changed-files/` | The source files touched by the fixes, kept at their original repo-relative paths |
| `scripts/` | Packaging and diagnostic tooling (one-shot repack, heartbeat probe) |

The full application source is not uploaded here; diff against upstream at the same paths when comparing.

## Differences from upstream

### 1. Whole-window freeze (the main fix)

**Symptom** — about 10 seconds after launch the UI looks intact but nothing responds to clicks, while the renderer keeps one CPU core busy. Reproducible on every restart.

**Root cause** — the "auto-generate a run summary when the run finishes" effect in `SupervisorSidePanel` fed itself. A failed summary write sets `error` and clears `generating`; `generateRunSummary` is a `useCallback` whose dependency list contains exactly those fields, so the callback is recreated → the effect's dependency changes → it runs again → the guard `!runSummary?.error` lets it through → infinite retry at roughly **127 commits/second**, saturating the main thread so queued click events never run.

**Fix** (`changed-files/components/ai/SupervisorSidePanel.tsx`):

1. a latch inside the effect (`autoSummaryKeyRef`) so a given `finishedAt` auto-generates at most once;
2. `generateRunSummary`'s guard simplified to "any existing record for this run means no auto-run"; retries must go through the explicit **Regenerate** button, which passes `force`.

**Why it is not render volume or big data** — see [docs/freeze-fix.md](docs/freeze-fix.md). Ruled out one by one: Tooltip/Popper counts, timeline event count, post-dispatch message size, markdown parsing, regex backtracking, localStorage write volume. Only a non-empty `rounds` array ignites it.

### 2. AI panel rendering and streaming

| File | Change |
| --- | --- |
| `components/ai/SupervisorTranscript.tsx` | Timeline renders only the newest 60 events, older ones collapse behind a "show earlier N" button; event rows and bubbles are `React.memo`ised; task output is capped at the newest 10 items; scroll writes are de-duplicated so `scrollTop` is not reassigned every frame |
| `components/ai/SupervisorAdvicePanel.tsx` | The 60 ms streaming buffer only calls `setState` when content actually changed; message list memoised via `useMemo` plus memoised row components; scroll effect dependencies narrowed |
| `components/AIChatSidePanel.tsx` | Model-catalog retry condition changed to `!catalog \|\| catalog.models.length === 0`, so a successfully fetched but empty catalog no longer triggers endless retries |

### 3. Text and tests

- New `supervisor.showEarlier` string in five locales (zh-CN, zh-TW, en, es, ru);
- `supervisorLocales.test.ts` baseline raised from 198 to 199 strings.

### 4. Packaging and diagnostics tooling (not present upstream)

- `scripts/update-sokai.cjs` — build → repack using the installed `app.asar` as the base → back up → replace, and refuse to replace while the app is running (hot-swapping the asar crashes the live renderer).
- `scripts/_repack-asar-dist-v2.cjs` — swaps only `dist/` inside the asar plus main-process sources, infers the unpacked subtree from the base archive and verifies every unpack flag.
- `scripts/_diag_heartbeat.cjs` — **the only trustworthy way to decide "is it frozen"**: continuous sampling every 2 s.
- `scripts/_diag-probe.cjs`, `_diag_commitlog2.cjs`, `_diag_stats.cjs` — single-shot probe, React commit sampling, storage/DOM size census.

> ⚠️ Lesson learned: a single probe that fires once around t≈9 s and exits produces **false positives** — it lands just before the freeze. Use a continuous heartbeat for at least 40 s.

## Portable build

The release ships a Windows x64 portable archive (~183 MB, ~490 MB extracted):

1. extract anywhere, double-click `Netcatty.exe`;
2. no installer, no administrator rights;
3. data goes to `%APPDATA%\Netcatty` by default; create an empty `data` folder next to the exe to make it portable.

The archive excludes the user-data directory (`data/`) and historical backups (`resources/*.bak`). This is an Electron directory layout — **do not copy `Netcatty.exe` alone**.

## Limitations

- Verified on Windows x64 only; the binary is unsigned, so some AV products may warn.
- This branch is not guaranteed to track upstream; re-verify against upstream `main` before proposing any fix upstream.
- Distributing the binary under GPL-3.0 requires the complete corresponding source. This repo carries only the changed files and docs; ask for the full tree if you need it.

## License

Upstream is GPL-3.0-or-later; these modifications are released under the same terms. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
