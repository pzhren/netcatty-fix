/**
 * SupervisorSidePanel — "自主模式" console rendered inside the AI side panel.
 *
 * The side panel normally talks to the task Agent directly ("直接对话"). In
 * 自主模式 the user only talks to the Supervisor Agent: it takes the goal,
 * thinks about the task Agent's replies and dispatches the next instruction.
 * The task Agent executes; every supervisor↔agent exchange is mirrored to the
 * AI monitor page through the same shared supervisor store.
 *
 * Layout mirrors the autonomous chat: transcript in the middle, composer at
 * the bottom. The composer adapts to the run state:
 *   - start:    no run yet → sending the goal starts supervision
 *   - queue:    run in progress → sending queues a user instruction (插队)
 *   - continue: run ended → sending starts a new round (preserveHistory)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bot, ChevronDown, CircleStop, Copy, Eraser, Gauge, History, Info, MessagesSquare, OctagonX, Pause, Play, RefreshCw, Settings2, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import type { AISession } from '../../infrastructure/ai/types';
import { useAISessionsStore } from '../../application/state/aiSessionsStore';
import { useSupervisorSession, supervisorActions, getSupervisorRunSummarizer, useSupervisorRunSummary, useSupervisorRunSummaryHistory, selectSupervisorRunSummaryRecord, setSupervisorRunSummaryRecord, clearSupervisorRunSummaryRecord, clearSupervisorRunSummaries, getSupervisorRunSummaryRecord, type SupervisorRunSummaryRecord } from '../../application/state/supervisorSessionStore';
import type { SupervisorRunSummaryInput } from '../../application/state/supervisorSessionStore';
import { useSupervisorAdviceSnapshot } from '../../application/state/supervisorAdvice';
import { SupervisorAdvicePanel } from './SupervisorAdvicePanel';
import {
  createSupervisorPendingEcho,
  pendingEchoEvents,
  reconcileSupervisorPendingEcho,
  type SupervisorPendingEcho,
} from '../../application/state/supervisorOptimisticEcho';
import { queueSupervisorUserInstruction, requestSupervisorInterrupt, stopSupervisorTargetStreaming } from '../../application/state/supervisorRuntime';
import { toast } from '../ui/toast';
import { cn } from '../../lib/utils';
import { LazyMessageResponse } from '../ai-elements/LazyMessageResponse';
import { SupervisorTranscript } from './SupervisorTranscript';
import { SupervisorExecutionDetails } from './SupervisorExecutionDetails';
import { SupervisorModelPoolCombobox } from './SupervisorModelPoolCombobox';
import type { SupervisorTaskModel } from '../../infrastructure/ai/supervisorTypes';
import type {
  SupervisorModelPoolEntry,
  SupervisorBrainModelChoice,
  SupervisorTaskModelChoice,
} from '../../application/state/supervisorLayoutPrefs';
import {
  readSupervisorBudgetPrefs,
  writeSupervisorBudgetPrefs,
  readSupervisorSummaryPrompt,
  writeSupervisorSummaryPrompt,
  SUPERVISOR_SUMMARY_PROMPT_MAX,
} from '../../application/state/supervisorLayoutPrefs';

type Translate = (key: string, params?: Record<string, string>) => string;

const MAX_TASK_LINES = 40;

type ComposerMode = 'start' | 'queue' | 'continue';

interface SupervisorSidePanelProps {
  t: Translate;
  /** Task Agent session currently open in the side panel. */
  session: AISession | null;
  supervisorModel: SupervisorBrainModelChoice | null;
  onSupervisorModelChange: (choice: SupervisorBrainModelChoice | null) => void;
  /**
   * Shared supervisor/task model pool. Every entry carries the backend that
   * executes it (external CLI agent or Provider API) plus a vendor label, so
   * "model · vendor" is displayed and picking a model just works.
   */
  modelPool: readonly SupervisorModelPoolEntry[];
  /** Run-scoped task Agent model; null = keep the agent's own selection. */
  taskModel: SupervisorTaskModelChoice | null;
  onTaskModelChange: (choice: SupervisorTaskModelChoice | null) => void;
  /** The agent's own (autonomous) model, shown as fallback when no override is set. */
  taskModelFallback?: string;
  /** Agent id used for a freshly created session when none is active yet. */
  taskAgentId?: string;
  /** Returns the active session, or creates one from the current draft. */
  onEnsureSession: () => AISession | null;
}

const STATUS_TONE: Record<string, string> = {
  idle: 'bg-muted text-muted-foreground border-border',
  running: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  stopped: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
  completed: 'bg-primary/15 text-primary border-primary/30',
  budget_exhausted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  stalled: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  error_loop: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
};

const RUN_TERMINAL_STATUSES = ['stopped', 'completed', 'budget_exhausted', 'stalled', 'error_loop'];

/** m:ss (under an hour) / h:mm:ss — matches the wall-clock budget format. */
function formatBudgetClock(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { name?: string }).name === 'AbortError') return true;
  return /abort/i.test(err instanceof Error ? err.message : String(err));
}

/** Reusable editor for the 运行总结 prompt — the user's "总结要求" (summary
 * focus, section emphasis, length, format). Mounted both inside the summary
 * card header and in the settings block so it is reachable before a run ends. */
const SupervisorSummaryPromptEditor: React.FC<{
  t: Translate;
  onChanged?: () => void;
}> = ({ t, onChanged }) => {
  const [draft, setDraft] = useState(() => readSupervisorSummaryPrompt());
  const [saved, setSaved] = useState(() => readSupervisorSummaryPrompt());
  const handleSave = useCallback(() => {
    writeSupervisorSummaryPrompt(draft);
    setSaved(readSupervisorSummaryPrompt());
    onChanged?.();
    toast.success(t('supervisor.runSummaryPromptSaved'));
  }, [draft, onChanged, t]);
  const handleClear = useCallback(() => {
    writeSupervisorSummaryPrompt('');
    setDraft('');
    setSaved('');
    onChanged?.();
    toast.success(t('supervisor.runSummaryPromptCleared'));
  }, [onChanged, t]);
  return (
    <div data-supervisor-summary-prompt-editor="true">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{t('supervisor.runSummaryPromptTitle')}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">
          {draft.length}/{SUPERVISOR_SUMMARY_PROMPT_MAX}
        </span>
      </div>
      <textarea
        value={draft}
        maxLength={SUPERVISOR_SUMMARY_PROMPT_MAX}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('supervisor.runSummaryPromptPlaceholder')}
        rows={4}
        className="mt-1 w-full resize-y rounded border border-border bg-transparent p-1.5 text-[11px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50"
        data-supervisor-summary-prompt-input="true"
      />
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">{t('supervisor.runSummaryPromptHint')}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex items-center rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90"
          data-supervisor-summary-prompt-save="true"
        >
          {t('supervisor.runSummaryPromptSave')}
        </button>
        <button
          type="button"
          onClick={handleClear}
          disabled={!draft.trim() && !saved}
          className="inline-flex items-center rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
        >
          {t('supervisor.runSummaryPromptClear')}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t('supervisor.runSummaryPromptActive')}
          </span>
        )}
      </div>
    </div>
  );
};

/** The end-of-run debrief card. Auto-generated once per finished run and kept
 * in a persisted history; collapsed by default so it never eats half the
 * panel. The 总结提示词 entry lives ONLY in the status bar (single entry). */
const SupervisorRunSummaryCard: React.FC<{
  t: Translate;
  summary: { key: number; text: string; error: string | null };
  generating: boolean;
  meta: string;
  stopReason: string | null;
  history: ReadonlyArray<{ key: number; text: string; error: string | null }>;
  onSelectHistory: (key: number) => void;
  onRegenerate: () => void;
}> = ({ t, summary, generating, meta, stopReason, history, onSelectHistory, onRegenerate }) => {
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Auto-expand once when a fresh summary finishes streaming in — but NOT on
  // mount with a restored record (ref pre-seeded), so a remount stays quiet.
  const autoExpandedKeyRef = useRef<number | null>(summary.text && !generating ? summary.key : null);
  useEffect(() => {
    if (summary.key && summary.text && !generating && autoExpandedKeyRef.current !== summary.key) {
      autoExpandedKeyRef.current = summary.key;
      setExpanded(true);
    }
  }, [summary.key, summary.text, generating]);
  const formatKeyTime = (ms: number) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return (
  <div
    className="flex flex-col overflow-hidden rounded-md border border-sky-500/30 bg-sky-500/[0.05] px-2.5 py-2"
    data-supervisor-run-summary="true"
    data-supervisor-run-summary-expanded={expanded ? 'true' : 'false'}
  >
    <div className="flex items-center gap-1.5">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sky-500/15 text-sky-600">
        <Activity size={11} />
      </span>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex min-w-0 items-center gap-1.5 text-left"
        data-supervisor-run-summary-toggle="true"
        aria-label={t('supervisor.runSummaryToggle')}
        title={t('supervisor.runSummaryToggle')}
      >
        <span className="text-[11px] font-semibold text-sky-600">{t('supervisor.runSummaryTitle')}</span>
        <span className="min-w-0 truncate text-[10px] tabular-nums text-muted-foreground/80" title={meta}>{meta}</span>
        {generating && <Activity size={10} className="shrink-0 animate-pulse text-sky-500" />}
      </button>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            data-supervisor-run-summary-history="true"
            aria-label={t('supervisor.runSummaryHistory')}
            title={t('supervisor.runSummaryHistory')}
          >
            <History size={10} />
            {history.length}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(summary.text || '');
            if (summary.text.trim()) toast.success(t('supervisor.runSummaryCopied'));
          }}
          disabled={!summary.text.trim()}
          className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
          data-supervisor-run-summary-copy="true"
        >
          <Copy size={10} />
          {t('supervisor.runSummaryCopy')}
        </button>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={generating}
          className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent disabled:opacity-40"
          data-supervisor-run-summary-retry="true"
        >
          <RefreshCw size={10} className={cn(generating && 'animate-spin')} />
          {t('supervisor.runSummaryRetry')}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="inline-flex items-center rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          data-supervisor-run-summary-chevron="true"
          aria-label={t('supervisor.runSummaryToggle')}
        >
          <ChevronDown size={10} className={cn('transition-transform', !expanded && '-rotate-90')} />
        </button>
      </div>
    </div>
    {historyOpen && history.length > 0 && (
      <div
        className="mt-1.5 max-h-32 overflow-y-auto rounded border border-border bg-background/60 p-1"
        data-supervisor-run-summary-history-list="true"
      >
        {history.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => { onSelectHistory(entry.key); setExpanded(true); setHistoryOpen(false); }}
            className={cn(
              'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[10px] hover:bg-accent',
              entry.key === summary.key ? 'text-sky-600' : 'text-muted-foreground',
            )}
            data-supervisor-run-summary-history-item={String(entry.key)}
          >
            <span className="shrink-0 tabular-nums">{formatKeyTime(entry.key)}</span>
            <span className="min-w-0 flex-1 truncate">
              {entry.error ? `${t('supervisor.runSummaryFailed')}：${entry.error}` : entry.text.replace(/\s+/g, ' ').trim().slice(0, 60) || '—'}
            </span>
          </button>
        ))}
      </div>
    )}
    {stopReason && (
      <p className="mt-1 text-[10px] leading-relaxed text-amber-600/90">{stopReason}</p>
    )}
    {expanded && (
      <div className="mt-1 max-h-[38vh] min-w-0 shrink overflow-y-auto" data-supervisor-run-summary-body="true">
        {summary.error ? (
          <p className="text-[11px] leading-relaxed text-rose-600">
            {t('supervisor.runSummaryFailed')}{summary.error ? `：${summary.error}` : ''}
          </p>
        ) : summary.text.trim() ? (
          <div className="min-w-0 break-words text-[11px] leading-relaxed text-foreground">
            <LazyMessageResponse>{summary.text}</LazyMessageResponse>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground" data-supervisor-run-summary-generating="true">
            <Activity size={11} className="animate-pulse" />
            {t('supervisor.runSummaryGenerating')}
          </p>
        )}
      </div>
    )}
  </div>
  );
};

export const SupervisorSidePanel: React.FC<SupervisorSidePanelProps> = ({
  t,
  session,
  supervisorModel,
  onSupervisorModelChange,
  modelPool,
  taskModel,
  onTaskModelChange,
  taskModelFallback,
  taskAgentId,
  onEnsureSession,
}) => {
  const state = useSupervisorSession();
  const { sessions: sessionSnapshots } = useAISessionsStore();
  const liveTaskSession = state.targetSessionId
    ? sessionSnapshots.find((item) => item.id === state.targetSessionId) ?? session
    : session;
  // Single composer draft shared by all three composer modes (start / queue /
  // continue) — like the autonomous chat, exactly one input at the bottom.
  const [draft, setDraft] = useState('');
  const [plan, setPlan] = useState('');
  // Budget inputs start from the user's last saved settings (persisted across
  // sessions / restarts) instead of hardcoded defaults.
  const [maxRounds, setMaxRounds] = useState(() => readSupervisorBudgetPrefs().maxRounds);
  const [maxMinutes, setMaxMinutes] = useState(() => readSupervisorBudgetPrefs().maxMinutes);
  const [stallLimit, setStallLimit] = useState(() => readSupervisorBudgetPrefs().stallLimit);
  const [errorLimit, setErrorLimit] = useState(() => readSupervisorBudgetPrefs().errorLimit);
  const [busy, setBusy] = useState(false);
  // Optimistic echo: the just-sent instruction is shown immediately, before the
  // main-process round trip lands. Reconciled away once the real event arrives.
  const [pendingEcho, setPendingEcho] = useState<SupervisorPendingEcho[]>([]);
  // Settings stay collapsed by default and are purely user-controlled — the
  // transcript plus the bottom composer are the primary surfaces.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 研讨室: a separate conversation with the supervisor about the work itself
  // (idea / experiment design), whose distilled brief feeds the next run.
  const [adviceOpen, setAdviceOpen] = useState(false);
  const adviceThread = useSupervisorAdviceSnapshot();

  // Drop echoes the authoritative transcript already contains (same text).
  useEffect(() => {
    setPendingEcho((current) => reconcileSupervisorPendingEcho(current, state.events));
  }, [state.events]);

  const transcriptEvents = useMemo(
    () => (pendingEcho.length ? [...state.events, ...pendingEchoEvents(pendingEcho)] : state.events),
    [state.events, pendingEcho],
  );

  const pushPendingEcho = useCallback((text: string): string | null => {
    const echo = createSupervisorPendingEcho(text);
    if (!echo) return null;
    setPendingEcho((current) => [...current, echo]);
    return echo.id;
  }, []);

  const dropPendingEcho = useCallback((id: string | null) => {
    if (!id) return;
    setPendingEcho((current) => current.filter((echo) => echo.id !== id));
  }, []);

  // Every budget edit (and the run-budget sync below) is remembered, so the
  // next session starts with the same 轮次/时长/阈值 without retyping them.
  useEffect(() => {
    writeSupervisorBudgetPrefs({ maxRounds, maxMinutes, stallLimit, errorLimit });
  }, [maxRounds, maxMinutes, stallLimit, errorLimit]);

  // Reuse the active run's budget when it first lands on this session. The
  // old version re-ran on every `state.budget` change, which silently wiped
  // edits typed while the run was live. Now the inputs are editable mid-run,
  // so only adopt the authoritative budget when a run is (re)attached — never
  // while it is actively running. Live edits are sent explicitly via 应用.
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'running') return;
    if (!state.targetSessionId || !session || state.targetSessionId !== session.id) return;
    setMaxRounds(state.budget.maxRounds);
    setMaxMinutes(Math.max(1, Math.round(state.budget.maxWallClockSec / 60)));
    setStallLimit(state.budget.stallLimit);
    setErrorLimit(state.budget.errorLimit);
  }, [state.status, state.targetSessionId, state.budget, session]);

  const running = state.status === 'running' && !state.halted;
  const runningHere = running && !!session && state.targetSessionId === session.id;
  const runningElsewhere = running && (!session || state.targetSessionId !== session.id);
  const canStop = runningHere;
  const canPause = running;
  const completedRounds = state.rounds.filter((round) => !!round.completedAt).length;

  // Budget usage — a live clock only while running; after the run the frozen
  // finishedAt gives the final elapsed time.
  const [budgetClock, setBudgetClock] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setBudgetClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsedSec = state.startedAt
    ? Math.max(0, Math.floor(((state.finishedAt ?? budgetClock) - state.startedAt) / 1000))
    : null;
  const timeTotalSec = Math.max(1, state.budget.maxWallClockSec);
  const budgetNear = elapsedSec != null
    && Math.max(elapsedSec / timeTotalSec, completedRounds / Math.max(1, state.budget.maxRounds)) >= 0.8;

  // 运行总结：auto-generated once per finished run (keyed by finishedAt).
  // The record lives in the module-level store, so closing the panel / switching
  // modes does NOT lose it — reopening shows the stored summary instead of
  // regenerating it from scratch on every mount.
  const runSummary = useSupervisorRunSummary();
  const runSummaryHistory = useSupervisorRunSummaryHistory();
  const runSummaryAbortRef = useRef<AbortController | null>(null);

  // 总结提示词：常驻入口（状态栏 ⚙）。卡片头部的入口只在运行结束后才存在，
  // 这里保证任何状态都能提前写"总结要求"。
  const [summaryPromptOpen, setSummaryPromptOpen] = useState(false);
  const [summaryPromptVersion, setSummaryPromptVersion] = useState(0);
  // promptVersion 只是"重新读取 localStorage"的触发器。
  const savedSummaryPrompt = summaryPromptVersion >= 0 ? readSupervisorSummaryPrompt() : '';

  const generateRunSummary = useCallback((finishedKey: number, opts?: { force?: boolean }) => {
    const summarizer = getSupervisorRunSummarizer();
    if (!summarizer) return;
    // A finished run gets at most one automatic attempt. Retrying is explicit
    // (force) — otherwise a summary that fails for any reason re-arms itself
    // through this callback's dependencies and loops forever.
    if (!opts?.force && runSummary?.key === finishedKey) return;
    runSummaryAbortRef.current?.abort();
    const controller = new AbortController();
    runSummaryAbortRef.current = controller;
    const input: SupervisorRunSummaryInput = {
      status: state.status,
      goal: state.goal,
      stopReason: state.stopReason,
      rounds: state.rounds.map((round) => ({
        n: round.n,
        result: round.result,
        digest: round.digest,
        text: round.text,
      })),
      elapsedSec: state.startedAt
        ? Math.max(0, Math.floor(((state.finishedAt ?? Date.now()) - state.startedAt) / 1000))
        : 0,
    };
    setSupervisorRunSummaryRecord({ key: finishedKey, text: '', error: null, generating: true });
    void (async () => {
      const patch = (updater: (current: SupervisorRunSummaryRecord) => SupervisorRunSummaryRecord) => {
        const current = getSupervisorRunSummaryRecord();
        if (current && current.key === finishedKey) setSupervisorRunSummaryRecord(updater(current));
      };
      try {
        const text = await summarizer(input, (delta) => {
          patch((current) => ({ ...current, text: current.text + delta }));
        }, controller.signal);
        patch((current) => ({ ...current, text: text.trim() || current.text, error: text.trim() ? null : current.error, generating: false }));
        if (!text.trim()) {
          patch((current) => ({ ...current, error: current.error ?? 'empty response', generating: false }));
        }
      } catch (err) {
        if (!isAbortLikeError(err)) {
          const reason = err instanceof Error ? err.message : String(err);
          patch((current) => ({ ...current, error: reason, generating: false }));
        } else {
          patch((current) => ({ ...current, generating: false }));
        }
      } finally {
        if (runSummaryAbortRef.current === controller) {
          runSummaryAbortRef.current = null;
        }
      }
    })();
  }, [runSummary?.key, runSummary?.error, runSummary?.generating, state.status, state.goal, state.stopReason, state.rounds, state.startedAt, state.finishedAt]);

  // Auto-generate the debrief once per finished run. Without this latch the
  // effect was self-feeding: a failed generation sets `error` and clears
  // `generating`, which rebuilds `generateRunSummary`, which re-runs the effect,
  // which starts another generation — a commit storm (~127/s) that froze the
  // renderer about ten seconds after boot on any run with completed rounds.
  const autoSummaryKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!RUN_TERMINAL_STATUSES.includes(state.status)) return;
    if (!state.finishedAt || completedRounds === 0) return;
    if (autoSummaryKeyRef.current === state.finishedAt) return;
    autoSummaryKeyRef.current = state.finishedAt;
    generateRunSummary(state.finishedAt);
  }, [state.status, state.finishedAt, completedRounds, generateRunSummary]);
  // A finished/stopped run on this target: the composer continues supervision.
  const runEndedHere = !running
    && state.status !== 'idle'
    && !!state.targetSessionId
    && (!session || session.id === state.targetSessionId);

  const composerMode: ComposerMode = running ? 'queue' : runEndedHere ? 'continue' : 'start';

  // Supervisor brain model — picked straight from the shared model pool; the
  // pool entry carries its own backend, so no provider dropdown is needed.
  const handleBrainModelChange = useCallback((modelId: string) => {
    const entry = modelPool.find((item) => item.modelId === modelId);
    if (entry) {
      onSupervisorModelChange(entry.backend.kind === 'provider'
        ? { providerId: entry.backend.providerId, modelId: entry.modelId }
        : { providerId: '', modelId: entry.modelId, agentId: entry.backend.agentId });
      return;
    }
    // Free-text model id outside the pool: run on the app's current provider.
    onSupervisorModelChange({ providerId: '', modelId });
  }, [modelPool, onSupervisorModelChange]);

  const routingGroupLabel = t('supervisor.side.modelRoutingGroup');
  // A routing-group entry is NOT pinned to a supplier: append an explicit tag
  // so "DeepSeek V4.1 Flash · routing group" can never be read as a vendor.
  const decorateModelLabel = (entry: SupervisorModelPoolEntry | null, fallback: string): string => {
    const base = entry ? `${entry.label} · ${entry.vendor}` : fallback;
    return entry?.routing ? `${base} · ${routingGroupLabel}` : base;
  };
  const brainModelEntry = supervisorModel?.modelId
    ? modelPool.find((item) => item.modelId === supervisorModel.modelId) ?? null
    : null;
  const brainModelLabel = decorateModelLabel(brainModelEntry, supervisorModel?.modelId || '');
  const brainModelIdValue = supervisorModel?.modelId || '';

  /**
   * 研讨室 model switching — same storage as the console's brain model, so the
   * two surfaces never disagree. Setting an id maps it through the pool (which
   * carries its own backend); null resets to the app default.
   */
  const handleAdviceModelChange = useCallback((modelId: string | null) => {
    if (!modelId) {
      onSupervisorModelChange(null);
      return;
    }
    handleBrainModelChange(modelId);
  }, [handleBrainModelChange, onSupervisorModelChange]);

  // External CLI agents authenticate themselves, so only a bare model id applies.
  // When the run lives in another window, use that target session's agent id.
  const effectiveTaskAgentId = session?.agentId
    ?? liveTaskSession?.agentId
    ?? taskAgentId
    ?? 'catty';
  const externalTaskAgent = effectiveTaskAgentId !== 'catty';
  const taskModelIdValue = taskModel?.modelId || '';
  const taskModelFallbackLabel = taskModelFallback || '';
  // While a run is active, its persisted override wins over the draft settings.
  const summaryTaskModelId = (running ? state.taskModel?.modelId : taskModel?.modelId)
    || (runningHere ? taskModelFallbackLabel : !running ? taskModelFallbackLabel : '');
  const summaryTaskEntry = summaryTaskModelId
    ? modelPool.find((item) => item.modelId === summaryTaskModelId) : null;
  const summaryTaskLabel = decorateModelLabel(summaryTaskEntry, summaryTaskModelId || '—');
  const selectedTaskEntry = taskModelIdValue
    ? modelPool.find((item) => item.modelId === taskModelIdValue) : null;

  // Task model — same shared pool: a pool entry carries its backend, so the
  // dispatch override gets the right provider without a separate picker.
  const buildTaskModelPayload = useCallback((choice: SupervisorTaskModelChoice | null): SupervisorTaskModel | null => {
    if (!choice?.modelId) return null;
    if (externalTaskAgent) return { modelId: choice.modelId };
    return choice.providerId
      ? { providerId: choice.providerId, modelId: choice.modelId }
      : { modelId: choice.modelId };
  }, [externalTaskAgent]);

  /**
   * Changing the task model while a run is active updates the authoritative
   * run state as well as the draft. The coordinator reads state.taskModel on
   * every dispatch, so the new model applies from the next round; the round
   * already in flight keeps the model it was launched with.
   */
  const applyTaskModel = useCallback((choice: SupervisorTaskModelChoice | null) => {
    onTaskModelChange(choice);
    if (!running) return;
    void supervisorActions.updateTaskModel(buildTaskModelPayload(choice))
      .then(() => toast.success(t('supervisor.toast.taskModelUpdated')))
      .catch((err) => {
        toast.error(t('supervisor.toast.failed'));
        console.warn('[Supervisor] task model update failed:', err);
      });
  }, [onTaskModelChange, running, buildTaskModelPayload, t]);

  const handleTaskModelIdChange = useCallback((modelId: string) => {
    const entry = modelPool.find((item) => item.modelId === modelId);
    if (entry && entry.backend.kind === 'provider') {
      applyTaskModel({ providerId: entry.backend.providerId, modelId: entry.modelId });
      return;
    }
    // External CLI entries authenticate themselves; free-text ids fall back to
    // the agent's own provider selection.
    applyTaskModel({ providerId: '', modelId });
  }, [modelPool, applyTaskModel]);

  // Live budget tuning while this run is active. The full monitor page exposes
  // the same action; the side panel previously offered no way to apply edits,
  // so changes made here only took effect on the *next* start/continue.
  const handleApplyBudget = useCallback(async () => {
    if (!runningHere) return;
    setBusy(true);
    try {
      await supervisorActions.updateBudget({
        maxRounds,
        maxWallClockSec: Math.max(1, maxMinutes) * 60,
        stallLimit,
        errorLimit,
      });
      toast.success(t('supervisor.toast.budgetUpdated'));
    } catch (err) {
      toast.error(t('supervisor.toast.failed'));
      console.warn('[Supervisor] side-panel budget update failed:', err);
    } finally {
      setBusy(false);
    }
  }, [runningHere, maxRounds, maxMinutes, stallLimit, errorLimit, t]);

  const handleStart = useCallback(async () => {
    // Fresh draft view: create the session on the fly (same path as the first
    // composer send), so the very first goal input can launch supervision.
    const target = session ?? onEnsureSession();
    if (!target) {
      toast.error(t('supervisor.toast.noTarget'));
      return;
    }
    const goal = draft.trim();
    if (!goal) {
      toast.error(t('supervisor.goalRequired'));
      return;
    }
    setBusy(true);
    // Echo the goal immediately — the transcript shows what was asked before
    // the main process answers (start is an IPC round trip plus a persist).
    const echoId = pushPendingEcho(goal);
    try {
      const taskModelPayload = buildTaskModelPayload(taskModel);
      await supervisorActions.start({
        goal,
        targetSessionId: target.id,
        targetLabel: target.title || target.id,
        tasks: plan.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_TASK_LINES),
        mode: 'think',
        taskModel: taskModelPayload,
        budget: {
          maxRounds,
          maxWallClockSec: Math.max(1, maxMinutes) * 60,
          stallLimit,
          errorLimit,
        },
      });
      // A new run invalidates the previous run's debrief card — drop only the
      // active card; the saved summary history survives for later review.
      runSummaryAbortRef.current?.abort();
      runSummaryAbortRef.current = null;
      clearSupervisorRunSummaryRecord();
      setDraft('');
      toast.success(t('supervisor.toast.started'));
    } catch (err) {
      dropPendingEcho(echoId);
      toast.error(t('supervisor.toast.failed'));
      console.warn('[Supervisor] side-panel start failed:', err);
    } finally {
      setBusy(false);
    }
  }, [session, onEnsureSession, draft, plan, maxRounds, maxMinutes, stallLimit, errorLimit, taskModel, buildTaskModelPayload, pushPendingEcho, dropPendingEcho, t]);

  const handleContinue = useCallback(async () => {
    const instruction = draft.trim();
    if (!instruction || !state.targetSessionId) return;
    setBusy(true);
    const echoId = pushPendingEcho(instruction);
    try {
      // Start a fresh supervision round on the same target; the previous
      // transcript is preserved (preserveHistory) so the conversation reads
      // as one continuous thread. Use the CURRENT settings instead of the
      // previous run's snapshot — otherwise a model changed after the run
      // ended (or cleared back to "follow default") is silently ignored.
      await supervisorActions.start({
        goal: instruction,
        targetSessionId: state.targetSessionId,
        targetLabel: state.targetLabel,
        tasks: [],
        mode: state.mode,
        taskModel: buildTaskModelPayload(taskModel),
        budget: {
          maxRounds,
          maxWallClockSec: Math.max(1, maxMinutes) * 60,
          stallLimit,
          errorLimit,
        },
        preserveHistory: true,
      });
      setDraft('');
      toast.success(t('supervisor.toast.started'));
    } catch (err) {
      dropPendingEcho(echoId);
      toast.error(t('supervisor.toast.failed'));
      console.warn('[Supervisor] side-panel continue failed:', err);
    } finally {
      setBusy(false);
    }
  }, [draft, state.targetSessionId, state.targetLabel, state.mode, maxRounds, maxMinutes, stallLimit, errorLimit, taskModel, buildTaskModelPayload, pushPendingEcho, dropPendingEcho, t]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      stopSupervisorTargetStreaming(state.targetSessionId);
      await supervisorActions.stop(t('supervisor.stopReason.manual'));
      toast.success(t('supervisor.toast.stopped'));
    } catch (err) {
      toast.error(t('supervisor.toast.failed'));
      console.warn('[Supervisor] side-panel stop failed:', err);
    } finally {
      setBusy(false);
    }
  }, [state.targetSessionId, t]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    try {
      runSummaryAbortRef.current?.abort();
      runSummaryAbortRef.current = null;
      clearSupervisorRunSummaries();
      await supervisorActions.clear();
      setDraft('');
      setPlan('');
      setPendingEcho([]);
      toast.success(t('supervisor.toast.cleared'));
    } catch (err) {
      toast.error(t('supervisor.toast.failed'));
      console.warn('[Supervisor] side-panel clear failed:', err);
    } finally {
      setBusy(false);
    }
  }, [t]);

  /**
   * 研讨 → 自主模式: fill the goal + initial plan from the distilled brief and
   * return to the console. The brief itself stays in the advice store, where
   * the supervisor brain reads it on every later round.
   */
  const handleApplyAdviceBrief = useCallback((payload: { goal: string; steps: string[]; briefText: string }) => {
    if (payload.goal) setDraft(payload.goal);
    if (payload.steps.length) setPlan(payload.steps.join('\n').slice(0, 4000));
    setAdviceOpen(false);
  }, []);

  const handleComposerSend = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    if (composerMode === 'queue') {
      // Mid-run: queue the instruction ahead of pending tasks (插队). Echo the
      // exact note text main writes so the reconciliation matches it.
      const echoId = pushPendingEcho(`用户插队指令：${text}`);
      if (queueSupervisorUserInstruction(text)) setDraft('');
      else dropPendingEcho(echoId);
      return;
    }
    if (composerMode === 'continue') {
      void handleContinue();
      return;
    }
    void handleStart();
  }, [draft, busy, composerMode, handleContinue, handleStart, pushPendingEcho, dropPendingEcho]);

  const handleInterruptSend = useCallback(() => {
    const text = draft.trim();
    if (!text || busy || !running) return;
    const echoId = pushPendingEcho(`用户打断：中止当前轮并下发新指令：${text}`);
    if (requestSupervisorInterrupt(text)) setDraft('');
    else {
      dropPendingEcho(echoId);
      toast.error(t('supervisor.toast.notRunning'));
    }
  }, [draft, busy, running, pushPendingEcho, dropPendingEcho, t]);

  const composerDisabled = busy;
  const composerSendDisabled = composerDisabled || !draft.trim();
  const composerPlaceholder = composerMode === 'queue'
    ? t('supervisor.interruptPlaceholder')
    : composerMode === 'continue'
      ? t('supervisor.side.followUpPlaceholder')
      : t('supervisor.side.composerStartPlaceholder');
  const composerLabel = composerMode === 'queue'
    ? t('supervisor.queueSend')
    : composerMode === 'continue'
      ? t('supervisor.side.followUpSend')
      : t('supervisor.start');

  // 研讨室 replaces the console body entirely: it is a conversation, not a
  // control surface, and it must not compete with the transcript for height.
  if (adviceOpen) {
    return (
      <SupervisorAdvicePanel
        t={t}
        supervisorState={state}
        modelLabel={brainModelLabel}
        modelPool={modelPool}
        currentModelId={brainModelIdValue}
        onModelChange={handleAdviceModelChange}
        onBack={() => setAdviceOpen(false)}
        onApplyBrief={handleApplyAdviceBrief}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-supervisor-side-panel="true">
      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
        <span className={cn(
          'flex h-6 w-6 items-center justify-center rounded-md',
          runningHere ? 'bg-emerald-500/15 text-emerald-600' : 'bg-primary/10 text-primary',
        )}>
          <ShieldCheck size={13} />
        </span>
        <span className="text-xs font-semibold">{t('supervisor.title')}</span>
        <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold', STATUS_TONE[state.status])}
          data-supervisor-status={state.status}>
          {t(`supervisor.status.${state.status}`)}
        </span>
        {elapsedSec != null && (
          <span
            className={cn(
              'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums',
              budgetNear ? 'border-amber-500/40 bg-amber-500/10 text-amber-600' : 'border-border/60 bg-muted/40 text-muted-foreground',
            )}
            data-supervisor-budget-usage="true"
            data-supervisor-budget-near={budgetNear ? 'true' : 'false'}
            title={t('supervisor.budgetUsageTitle')}
          >
            <Gauge size={11} className="shrink-0" />
            <span data-supervisor-budget-rounds>
              {t('supervisor.rounds', { done: String(completedRounds), total: String(state.budget.maxRounds) })}
            </span>
            <span className="opacity-50">·</span>
            <span data-supervisor-budget-time>
              {t('supervisor.budgetTime', {
                elapsed: formatBudgetClock(elapsedSec),
                total: formatBudgetClock(timeTotalSec),
              })}
            </span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {/* 总结提示词：常驻入口。运行结束后卡片头部也有一个同名入口，
              但那个只有跑完一轮才出现，这里保证随时可写。 */}
          <button
            type="button"
            onClick={() => setSummaryPromptOpen((open) => !open)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium',
              savedSummaryPrompt
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'
                : 'border-border text-muted-foreground hover:bg-accent',
              summaryPromptOpen && 'ring-1 ring-primary/40',
            )}
            data-supervisor-summary-prompt="true"
            data-supervisor-summary-prompt-open={summaryPromptOpen ? 'true' : 'false'}
            aria-label={t('supervisor.runSummaryPrompt')}
            title={`${t('supervisor.runSummaryPrompt')}${savedSummaryPrompt ? ` · ${t('supervisor.runSummaryPromptActive')}` : ''}`}
          >
            <Settings2 size={12} />
            {t('supervisor.runSummaryPrompt')}
            {savedSummaryPrompt && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />}
          </button>
          {/* 研讨: a separate discussion channel with the supervisor. Placed
              first so it is reachable before starting any run. */}
          <button
            type="button"
            onClick={() => setAdviceOpen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[11px] font-semibold text-violet-600 hover:bg-violet-500/20"
            data-supervisor-advice-open="true"
            data-supervisor-advice-has-brief={adviceThread.brief ? 'true' : 'false'}
          >
            <MessagesSquare size={12} />
            {t('supervisor.side.advice')}
            {adviceThread.brief && (
              <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            )}
          </button>
          {canStop && (
            <button
              type="button"
              onClick={handleStop}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 disabled:opacity-50"
              data-supervisor-stop="true"
            >
              <CircleStop size={12} />
              {t('supervisor.stop')}
            </button>
          )}
          <button
            type="button"
            onClick={handleClear}
            disabled={busy || state.status === 'idle'}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            data-supervisor-clear="true"
          >
            <Eraser size={12} />
            {t('supervisor.clear')}
          </button>
        </div>
      </div>

      {/* 总结要求编辑器：常驻在状态栏下方，任何运行阶段都可写。 */}
      {summaryPromptOpen && (
        <div
          className="border-b border-border/50 bg-muted/20 px-3 py-2"
          data-supervisor-summary-prompt-panel="true"
        >
          <SupervisorSummaryPromptEditor
            t={t}
            onChanged={() => setSummaryPromptVersion((v) => v + 1)}
          />
        </div>
      )}

      {/* overflow-y-auto: the summary card + open settings + transcript
          minimums can exceed the available height; without it the middle
          content would paint straight over the fixed bottom composer. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-1.5 pt-2">
        {runningElsewhere && (
          <p className="mb-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-600" data-supervisor-busy-elsewhere="true">
            {t('supervisor.side.busyElsewhere')}
          </p>
        )}

        {/* 运行总结: auto-generated debrief once the run reaches a terminal
            status (completed / stopped / budget exhausted / stalled / loop). */}
        {runSummary && (
          <div className="mb-2">
            <SupervisorRunSummaryCard
              t={t}
              summary={runSummary}
              generating={!!runSummary?.generating}
              history={runSummaryHistory}
              onSelectHistory={(key) => selectSupervisorRunSummaryRecord(key)}
              meta={[
                t(`supervisor.status.${state.status}`),
                t('supervisor.rounds', { done: String(completedRounds), total: String(state.budget.maxRounds) }),
                elapsedSec != null ? formatBudgetClock(elapsedSec) : '',
              ].filter(Boolean).join(' · ')}
              stopReason={state.stopReason}
              onRegenerate={() => generateRunSummary(runSummary.key, { force: true })}
            />
          </div>
        )}

        {/* Fresh draft view: starting will create the session automatically.
            Deliberately muted — a quiet hint, not a banner. */}
        {!session && (
          <p
            className="mb-2 flex items-start gap-1 text-[10px] leading-relaxed text-muted-foreground"
            data-supervisor-no-session="true"
          >
            <Info size={11} className="mt-0.5 shrink-0 opacity-70" />
            <span>{t('supervisor.side.noSession')}</span>
          </p>
        )}

        {/* Collapsible settings section (default collapsed, muted): plan /
            models / budget. The goal lives in the bottom composer. */}
        <div
          className="rounded-md border border-border/40"
          data-supervisor-settings="true"
          data-supervisor-settings-open={settingsOpen ? 'true' : 'false'}
        >
          <button
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent/40"
            data-supervisor-settings-toggle="true"
          >
            <ChevronDown
              size={12}
              className={cn('shrink-0 transition-transform', !settingsOpen && '-rotate-90')}
            />
            {t('supervisor.side.settings')}
            {!settingsOpen && (
              <span className="ml-auto flex min-w-0 max-w-[70%] flex-col items-end gap-0.5 text-[10px] font-normal text-muted-foreground/70">
                <span className="max-w-full truncate" title={brainModelLabel || '—'}>{t('supervisor.side.brainModel')}: {brainModelLabel || '—'}</span>
                <span className="max-w-full truncate" title={summaryTaskLabel}>{t('supervisor.side.taskModel')}: {summaryTaskLabel}</span>
              </span>
            )}
          </button>
          {settingsOpen && (
            <div className="flex flex-col gap-2.5 border-t border-border/40 px-2 py-2" data-supervisor-settings-body="true">
        <label className="block text-[11px] text-muted-foreground">
          {t('supervisor.tasksOptional')}
          <textarea
            value={plan}
            onChange={(event) => setPlan(event.target.value)}
            placeholder={t('supervisor.tasksPlaceholderThink')}
            rows={3}
            disabled={runningHere}
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary/50 disabled:opacity-60"
            data-supervisor-plan="true"
          />
        </label>

        {/* Supervisor brain model — picked straight from the shared pool; the
            pool entry carries its own backend ("model · vendor"), so the
            provider dropdown is gone for good. */}
        <div className="rounded-md border border-border/70 px-2 py-1.5" data-supervisor-brain-model="true">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <Sparkles size={11} className="text-violet-500" />
            {t('supervisor.side.brainModel')}
          </div>
          <div className="mt-1 flex gap-1.5">
            <SupervisorModelPoolCombobox
              t={t}
              value={supervisorModel?.modelId || ''}
              pool={modelPool}
              disabled={runningHere}
              placeholder="model-id"
              onChange={handleBrainModelChange}
              testId="brain"
            />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {supervisorModel?.modelId
              ? t('supervisor.side.brainModelSelected', { model: brainModelLabel })
              : t('supervisor.side.brainModelHint')}
          </p>
          {brainModelEntry?.routing && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-600/90">
              {t('supervisor.side.routingGroupHint')}
            </p>
          )}
        </div>

        {/* Task agent model — independent of the autonomous-mode selection */}
        <div className="rounded-md border border-border/70 px-2 py-1.5" data-supervisor-task-model="true">
          <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
            <Bot size={11} className="text-sky-500" />
            <span>{t('supervisor.side.taskModel')}</span>
            <button
              type="button"
              onClick={() => applyTaskModel(null)}
              disabled={!taskModel}
              className="ml-auto rounded border border-border px-1.5 py-px text-[10px] font-normal text-muted-foreground hover:bg-accent disabled:opacity-40"
              data-supervisor-task-model-reset="true"
            >
              {t('supervisor.side.taskModelReset')}
            </button>
          </div>
          <div className="mt-1 flex gap-1.5">
            <SupervisorModelPoolCombobox
              t={t}
              value={taskModelIdValue}
              pool={modelPool}
              placeholder={taskModelFallbackLabel || 'model-id'}
              onChange={handleTaskModelIdChange}
              testId="task"
            />
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {taskModel?.modelId
              ? (running ? t('supervisor.side.taskModelHintLive') : t('supervisor.side.taskModelHint'))
              : t('supervisor.side.taskModelInherit', { model: taskModelFallbackLabel || '—' })}
          </p>
          {selectedTaskEntry?.routing && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-600/90">
              {t('supervisor.side.routingGroupHint')}
            </p>
          )}
        </div>

        {/* Termination budget: rounds / wall clock / stall / errors */}
        <div className="grid grid-cols-2 gap-1.5" data-supervisor-budget="true">
          <label className="block text-[11px] text-muted-foreground">
            {t('supervisor.maxRounds')}
            <input type="number" min={1} max={50} value={maxRounds}
              onChange={(event) => setMaxRounds(Number(event.target.value) || 1)}
              className="mt-0.5 h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary/50" />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            {t('supervisor.side.timeLimit')}
            <input type="number" min={1} max={720} value={maxMinutes}
              onChange={(event) => setMaxMinutes(Number(event.target.value) || 1)}
              className="mt-0.5 h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary/50" />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            {t('supervisor.stallLimit')}
            <input type="number" min={0} max={20} value={stallLimit}
              onChange={(event) => setStallLimit(Number(event.target.value) || 0)}
              className="mt-0.5 h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary/50" />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            {t('supervisor.errorLimit')}
            <input type="number" min={0} max={20} value={errorLimit}
              onChange={(event) => setErrorLimit(Number(event.target.value) || 0)}
              className="mt-0.5 h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary/50" />
          </label>
        </div>

        {/* Live budget tuning: the monitor page has had this since day one, but
            the side panel used to disable its inputs during a run with no way
            to apply edits. Apply now calls the same runtime IPC as that page. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleApplyBudget}
            disabled={!runningHere || busy}
            data-supervisor-budget-apply="true"
            className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Zap size={11} className="shrink-0" />
            {t('supervisor.budgetApply')}
          </button>
          <span className="text-[10px] leading-relaxed text-muted-foreground/80">
            {runningHere ? t('supervisor.budgetHint') : t('supervisor.side.budgetNextRunHint')}
          </span>
        </div>

        <p className="text-[10px] leading-relaxed text-muted-foreground/80">
          {t('supervisor.side.dispatchHint')}
        </p>
            </div>
          )}
        </div>

        {/* Live supervisor ↔ task Agent transcript (same events as the monitor page) */}
        <div className="mt-2 flex min-h-[140px] flex-1 flex-col">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold">
            <Activity size={12} className="text-primary" />
            {t('supervisor.transcript')}
            <span className="font-normal text-muted-foreground">
              ({t('supervisor.eventCount', { count: String(state.events.length) })})
            </span>
          </div>
          <SupervisorTranscript
            events={transcriptEvents}
            t={t}
            emptyTitle={t('supervisor.noEvents')}
            emptyHint={t('supervisor.noEventsHint')}
            dense
            session={liveTaskSession}
            className="flex-1"
          />
        </div>

        {/* Tool calls / code execution audit — collapsed by default. */}
        {session && (
          <SupervisorExecutionDetails messages={session.messages} t={t} />
        )}
      </div>

      {/* Bottom composer — mirrors the autonomous chat composer. One input,
          three behaviours depending on the supervision state. */}
      <div
        className="flex-none border-t border-border/60 px-3 py-2.5"
        data-supervisor-composer="true"
        data-supervisor-composer-mode={composerMode}
      >
        <div className="flex flex-wrap items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleComposerSend();
              }
            }}
            placeholder={composerPlaceholder}
            rows={2}
            disabled={composerDisabled}
            className="w-full min-w-0 basis-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary/50 disabled:opacity-60"
            data-supervisor-composer-input={draft}
          />
          {running && (
            <>
              <button
                type="button"
                onClick={handleInterruptSend}
                disabled={!draft.trim() || busy}
                title={t('supervisor.interruptSend')}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20 disabled:opacity-50"
                data-supervisor-interrupt="true"
              >
                <OctagonX size={12} />
                {t('supervisor.interruptSend')}
              </button>
              <button
                type="button"
                onClick={handleComposerSend}
                disabled={!draft.trim() || busy}
                title={t('supervisor.queueSend')}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60"
                data-supervisor-queue="true"
              >
                <Zap size={12} />
                {t('supervisor.queueSend')}
              </button>
            </>
          )}
          {canPause && (
            <button
              type="button"
              onClick={handleStop}
              disabled={busy}
              title={t('supervisor.stopHint')}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-500/20 disabled:opacity-50"
              data-supervisor-pause="true"
            >
              <Pause size={12} />
              {t('supervisor.pause')}
            </button>
          )}
          {!running && <button
            type="button"
            onClick={handleComposerSend}
            disabled={composerSendDisabled}
            className={cn(
              'flex-shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-semibold',
              composerSendDisabled
                ? 'cursor-not-allowed bg-muted text-muted-foreground/60'
                : 'bg-primary text-primary-foreground hover:opacity-90',
            )}
            data-supervisor-composer-send={composerMode}
          >
            <span className="inline-flex items-center gap-1">
              <Play size={11} />
              {composerLabel}
            </span>
          </button>}
        </div>
        {composerMode === 'continue' && (
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {t('supervisor.side.followUpHint')}
          </p>
        )}
      </div>
    </div>
  );
};

export default SupervisorSidePanel;
