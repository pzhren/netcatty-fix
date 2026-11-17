# 复盘：启动约 10 秒后整窗冻结

> 2026-11-17 · Netcatty（Electron + React 18 + TypeScript）· Windows x64

## 1. 现象与误判

用户反馈分两阶段：先点「研讨」按钮无响应，随后升级为**整个窗口点击全无反应**，但界面像素完整、不白屏、不崩溃。

第一轮排查得出的三个错误结论，值得先记下来：

| 误判 | 为什么错 |
| --- | --- |
| 「热替换 asar 炸了旧 renderer」 | 进程 PID 已变，说明用户重启过；新 asar 仍然冻结 |
| 「Radix Tooltip/Popper 太多，渲染量爆炸」 | 冻结瞬间 DOM 只有 1661 个节点，fiber 树深 92，属正常 |
| 「localStorage 里 1.48 MB 的会话数据压垮了主线程」 | 真数据完整保留时也会冻，但把 `rounds` 清掉就不冻 |

第三条尤其要警惕：那个 1.48 MB 的键里确实有 7 个会话、1007 条消息，看起来非常像凶手。

## 2. 关键方法论：单点探测会说谎

最初的探针脚本是「启动 → 等约 6 秒 → 发一次 `Runtime.evaluate` → 退出」。加上寻找 page 目标的耗时，这次探测实际落在 **t≈9 秒**。而冻结发生在 **t≈10.3 秒**。

于是「探测返回 3 ms」被当成「已修复」，连续骗过两轮验证。

**改用连续心跳**（每 2 秒采样一次，`scripts/_diag_heartbeat.cjs`）之后，时间线立刻清楚：

```
6.4s  lat=3ms  nodes=1513
8.4s  lat=4ms  nodes=1641   ← 一切正常
10.5s TIMEOUT               ← 一次性锁死
```

结论：判断「是否冻结」只能用 ≥40 秒的连续采样，任何单点探测结论都不可采信。

## 3. 数据二分：锁定 `rounds`

用真实数据目录的副本做隔离实例（`PORTABLE_EXECUTABLE_DIR` 指向副本，不与用户实例抢单实例锁），逐个变量做对照，全部串行执行（并行会因单实例锁互相干扰而给出假结果）：

| 副本 | `localStorage` | `supervisor-session.json` | 结果 |
| --- | --- | --- | --- |
| 全新 | 无 | 无 | 正常，全程 3 ms |
| v10 | 完整 | 无 | 正常，2–6 ms |
| v21 | 完整 | `events=[] rounds=[]` | 正常，2–7 ms |
| v13 | 完整 | `events=[]`、`rounds` 保留 | **10.3 s 冻结** |
| v12 | 完整 | `events` 裁到 20 条 | **冻结** |
| v14 | 完整 | 只留 1 条 27 字符的 `finish` 事件 | **冻结** |
| v8 | 完整 | 完整（240 事件 / 8 轮） | **10.3 s 冻结** |

事件条数、事件文本长度、dispatch 与否都不影响结论——**只要 `rounds` 非空就冻结**。

顺带证伪的其他方向：markdown 表格解析（最长一条正文仅 2262 字符）、编号列表正则回溯、`localStorage.setItem` 频率（leveldb `MANIFEST` 里 451 次命中是 sstable 键范围元数据，不是写入次数；冻结前后计数完全一致，说明根本没写回）。

## 4. 抓现行：commit 风暴

在冻结过程中注入 React DevTools hook，接管 `onCommitFiberRoot` 计数：

```
6.9s  commits=61
7.7s  commits=73
8.4s  commits=121  (+48)
9.2s  TIMEOUT
```

同时采样「有 pending lanes 的 fiber 列表」返回 **0 个**，DOM 节点数几乎不变。**没有待更新的组件、DOM 不增长，却在持续 commit**——这是典型的空转渲染循环，而不是「渲染太多」。

另有一条重要线索：冻结时页面上没有任何 `data-supervisor-*` 属性，说明研讨面板根本没挂载。循环不在渲染树里，它是被数据变化驱动的全局逻辑。

## 5. 根因

`components/ai/SupervisorSidePanel.tsx`：

```tsx
// 修复前
useEffect(() => {
  if (!RUN_TERMINAL_STATUSES.includes(state.status)) return;
  if (!state.finishedAt || completedRounds === 0) return;
  generateRunSummary(state.finishedAt);
}, [state.status, state.finishedAt, completedRounds, generateRunSummary]);
```

而 `generateRunSummary` 是 `useCallback`，依赖里包含 `runSummary`，其内部：

```tsx
// 修复前：失败时写入 error 并清 generating
setSupervisorRunSummaryRecord({ key, text: '', error: <message>, generating: false });
```

于是形成闭环：

```
effect 调用 generateRunSummary
  → 生成失败，写入 error / 清 generating
    → useCallback 依赖变化，函数身份重建
      → effect 依赖 generateRunSummary 变化，重新执行
        → 守卫 `!runSummary?.error` 恰好放行（因为此时 error 非空）
          → 再次调用 …… 127 次/秒
```

`completedRounds > 0` 作为前置条件，正好解释了「只有已有完成轮次的历史数据才会冻」。

## 6. 修复

```tsx
// 修复后：同一个 finishedAt 只自动生成一次
const autoSummaryKeyRef = useRef<number | null>(null);
useEffect(() => {
  if (!RUN_TERMINAL_STATUSES.includes(state.status)) return;
  if (!state.finishedAt || completedRounds === 0) return;
  if (autoSummaryKeyRef.current === state.finishedAt) return;
  autoSummaryKeyRef.current = state.finishedAt;
  generateRunSummary(state.finishedAt);
}, [state.status, state.finishedAt, completedRounds, generateRunSummary]);
```

```tsx
// 守卫：同一运行只要有过记录就不再自动跑；重试必须显式 force
if (!opts?.force && runSummary?.key === finishedKey) return;
```

手动「重新生成」按钮本来就传 `force: true`，因此人工重试路径不受影响。

## 7. 验证

用**完整的原始数据**（240 条事件 / 8 个轮次 / 1448 KB 会话）连续心跳 55 秒，25 次采样：

```
全部 1–9 ms，DOM 从 1661 增长到 4324（时间线正常渲染），无冻结
```

对照：修复前同一份数据稳定在 10.3 秒 `TIMEOUT`。

## 8. 可复用的检查清单

排查 Electron 应用「界面在、点击无响应」时：

1. **先看 `render-process-gone` 日志**——`reason=crashed` 说明 renderer 已死，画面只是最后一帧；
2. 用 `Get-Process` 采 CPU 增量，确认是忙循环还是死锁；
3. 用 `PORTABLE_EXECUTABLE_DIR` 起隔离副本，别在用户实例上做实验；
4. 数据二分时**必须串行**，并行会被单实例锁污染；
5. 任何「已修复」结论都要用连续心跳复核，单点探测会假阳性；
6. 看到「commit 持续增长 + pending lanes 为 0 + DOM 不增长」，直接去查 effect 与 `useCallback` 的依赖闭环，不要继续怀疑渲染量。
