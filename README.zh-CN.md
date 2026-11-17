# Netcatty 修复分支（中文本地维护版）

> English: [README.md](README.md) · 本仓库基于 [binaricat/Netcatty](https://github.com/binaricat/Netcatty)（GPL-3.0），
> 记录本地维护过程中相对上游的**行为差异**与**缺陷修复**，重点是 2026-11-17 这次「启动后约 10 秒整窗冻结」的定位与修复。

## 这个仓库是什么

不是上游的复刻，也不是二次发行版。它只装三样东西：

| 目录 | 内容 |
| --- | --- |
| `docs/` | 修复的技术复盘、诊断方法 |
| `changed-files/` | 本次改动涉及的源文件，保持原仓库相对路径，便于直接对照或覆盖 |
| `scripts/` | 打包与诊断脚本（一键重打包、连续心跳探针等） |

完整工程不上传；需要对照时，请以上游仓库同路径文件为基线。

## 与上游的差异一览

### 一、整窗冻结（本次核心修复）

**现象**：应用启动约 10 秒后，界面显示正常但任何点击都没有反应，进程仍在持续占用一个 CPU 核。重启后必然复现。

**根因**：`SupervisorSidePanel` 中「运行结束后自动生成运行总结」的 effect 形成了自激循环——
总结生成失败时会写入 `error` 并清空 `generating`，而 `generateRunSummary` 是用 `useCallback` 定义的，依赖列表里恰好包含这两个字段，于是回调重建 → effect 依赖变化 → 再次调用 → 守卫条件 `!runSummary?.error` 反而放行 → 无限重试。commit 频率飙到约 **127 次/秒**，主线程被占满，事件队列里的点击永远排不上。

**修复**（`changed-files/components/ai/SupervisorSidePanel.tsx`）：

1. effect 内加 latch（`autoSummaryKeyRef`），同一个 `finishedAt` 只自动生成一次；
2. `generateRunSummary` 的守卫简化为「同一运行已有记录就不再自动跑」，重试必须走带 `force` 的「重新生成」按钮。

**为什么不是渲染量、不是大数据**：见 [docs/freeze-fix.md](docs/freeze-fix.md) 的完整证据链——已逐一证伪的方向包括 Tooltip/Popper 数量、时间线事件条数、dispatch 后的消息体积、markdown 解析、正则回溯、localStorage 写入次数。唯独 `rounds`（已完成轮次）非空才会点燃。

### 二、AI 面板渲染与流式输出

| 文件 | 变化 |
| --- | --- |
| `components/ai/SupervisorTranscript.tsx` | 时间线默认只渲染最近 60 条，更早的折叠为「显示更早 N 条」按钮；事件行与气泡加 `React.memo`；任务输出只保留最近 10 条；滚动写入去重，避免每帧重复写 `scrollTop` |
| `components/ai/SupervisorAdvicePanel.tsx` | 60ms 流式 buffer 改为「内容不变则不 setState」；消息列表 `useMemo` + memo 化行组件；滚动 effect 依赖收敛 |
| `components/AIChatSidePanel.tsx` | 模型目录的重试条件改为 `!catalog || catalog.models.length === 0`，避免把「目录已拉到但为空」误判为需要无限重试 |

### 三、文案与测试

- 5 种语言（zh-CN / zh-TW / en / es / ru）新增 `supervisor.showEarlier` 文案；
- `supervisorLocales.test.ts` 的文案条数基线由 198 调整为 199。

### 四、打包与诊断工具链（上游没有）

- `scripts/update-sokai.cjs`：一键「构建 → 以现有 asar 为基座重打包 → 备份 → 替换」，并在应用运行中时拒绝替换（热替换会让运行中的 renderer 崩溃）。
- `scripts/_repack-asar-dist-v2.cjs`：只替换 asar 内的 `dist/` 并同步主进程源码，unpack 目录从基座反推后逐项比对标志位。
- `scripts/_diag_heartbeat.cjs`：**判断「是否冻结」的唯一可靠方法**，每 2 秒连续采样。
- `scripts/_diag-probe.cjs` / `_diag_commitlog2.cjs` / `_diag_stats.cjs`：单点探测、React commit 采样、存储与 DOM 规模统计。

> ⚠️ 经验教训：单点探测（启动约 9 秒探一次即退出）会给出**假阳性**——它正好落在冻结发生之前。判断冻结必须用连续心跳 ≥ 40 秒。

## 便携版

Release 中提供 Windows x64 便携包（约 183 MB，解压后约 490 MB）：

1. 解压到任意目录，双击 `Netcatty.exe`；
2. 无需安装、无需管理员权限；
3. 数据默认写入 `%APPDATA%\Netcatty`；若想在 exe 同级建一个空的 `data` 文件夹，则会改为便携模式，数据跟着文件夹走。

包内已排除用户数据目录（`data/`）与历史备份文件（`resources/*.bak`）。程序为 Electron 目录式布局，**不能只拷贝 `Netcatty.exe`**。

## 已知限制

- 仅针对 Windows x64 验证；未做代码签名，部分杀毒软件可能报警。
- 本分支不保证与上游持续同步；合入上游前请以上游 `main` 为基线重新验证。
- 依 GPL-3.0 分发二进制时应同时提供完整对应源码。本仓库只包含改动文件与文档，若需完整源码请另行索取或在本地仓库导出。

## 许可证

上游为 GPL-3.0-or-later，本仓库的修改同样遵循 GPL-3.0-or-later，见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。
