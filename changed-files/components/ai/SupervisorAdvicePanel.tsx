/**
 * SupervisorAdvicePanel — the 研讨室: talk to the Supervisor Agent *about* the
 * work instead of *through* it.
 *
 * 自主模式's console is an operations surface (dispatch / queue / interrupt).
 * Planning an idea or an experiment needs a conversation surface: no dispatch,
 * no round bookkeeping, just a thread that converges on a plan. Whatever comes
 * out of it is distilled into an 「执行简报」 which can be applied to the
 * autonomous run as its goal + initial plan, and which the supervisor brain
 * keeps in context on every later round.
 *
 * The panel never touches the task Agent or the run state: it is read-only
 * context plus a local, persisted thread.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronLeft,
  Eraser,
  FileText,
  GitBranch,
  GripHorizontal,
  Loader2,
  MessagesSquare,
  Pencil,
  Quote,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  UserRound,
} from 'lucide-react';
import type { SupervisorSessionState } from '../../infrastructure/ai/supervisorTypes';
import type { SupervisorModelPoolEntry } from '../../application/state/supervisorLayoutPrefs';
import {
  normalizeSupervisorCustomPrompt,
  readSupervisorCustomPrompt,
  writeSupervisorCustomPrompt,
  readAdviceComposerHeight,
  writeAdviceComposerHeight,
  ADVICE_COMPOSER_MAX_HEIGHT,
  ADVICE_COMPOSER_MIN_HEIGHT,
  SUPERVISOR_CUSTOM_PROMPT_MAX,
} from '../../application/state/supervisorLayoutPrefs';
import {
  ADVICE_BRIEF_INSTRUCTION,
  adviceBriefMarkdown,
  adviceBriefToPlanLines,
  buildAdviceContextMessages,
  buildAdviceSystemPrompt,
  parseAdviceBrief,
  runSupervisorAdviceTurn,
  summarizeSupervisorRunForAdvice,
  supervisorAdviceStore,
  useSupervisorAdviceSnapshot,
  type AdviceBrief,
  type AdviceMessage,
} from '../../application/state/supervisorAdvice';
import { toast } from '../ui/toast';
import { cn } from '../../lib/utils';
import { LazyMessageResponse } from '../ai-elements/LazyMessageResponse';

type Translate = (key: string, params?: Record<string, string>) => string;

interface SupervisorAdvicePanelProps {
  t: Translate;
  /** Live supervision state; summarized into the prompt so the discussion sees
   * what the task Agent actually did. */
  supervisorState: SupervisorSessionState;
  /** Human-readable supervisor model label ("model · vendor"). */
  modelLabel: string;
  /** Shared supervisor model pool: the 研讨模型 can be switched freely. */
  modelPool: readonly SupervisorModelPoolEntry[];
  /** Currently selected model id ('' = follow the app default). */
  currentModelId: string;
  /** Switch the discussion model; null = follow the app default. Applies from
   * the very next turn (the advice runner re-reads the choice per call). */
  onModelChange: (modelId: string | null) => void;
  onBack: () => void;
  /** Hand the distilled brief back to the console (goal + plan). */
  onApplyBrief: (payload: { goal: string; steps: string[]; briefText: string }) => void;
}

const STARTER_KEYS = [
  'supervisor.side.adviceStarter1',
  'supervisor.side.adviceStarter2',
  'supervisor.side.adviceStarter3',
] as const;

/** Abort surfaces as a DOMException whose message is localized; match on name. */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  if (name === 'AbortError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /abort/i.test(message);
}

/** Streaming text is buffered and flushed on a timer: one setState per token
 * would re-parse the markdown on every delta. */
function useStreamBuffer() {
  const bufferRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Last value handed to setText — lets an idle tick skip the re-render. */
  const flushedRef = useRef('');
  const [text, setText] = useState('');

  const stop = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    stop();
    bufferRef.current = '';
    flushedRef.current = '';
    setText('');
  }, [stop]);

  const start = useCallback(() => {
    stop();
    bufferRef.current = '';
    flushedRef.current = '';
    setText('');
    // A timer that re-renders on every tick keeps the whole side panel busy
    // even when no token arrived (the panel re-parses its whole thread). Skip
    // unchanged flushes so an idle tick costs nothing.
    timerRef.current = setInterval(() => {
      const next = bufferRef.current;
      if (next === flushedRef.current) return;
      flushedRef.current = next;
      setText(next);
    }, 60);
  }, [stop]);

  const push = useCallback((delta: string) => {
    bufferRef.current += delta;
  }, []);

  const flush = useCallback(() => {
    stop();
    const final = bufferRef.current;
    flushedRef.current = final;
    setText(final);
    return final;
  }, [stop]);

  useEffect(() => stop, [stop]);

  return useMemo(() => ({ text, start, push, flush, reset }), [text, start, push, flush, reset]);
}

const AdviceBody = React.memo<{ text: string }>(function AdviceBody({ text }) {
  // `anywhere` (not just `break-words`) matters here: overflow-wrap only
  // shrinks the *min-content* width with `anywhere`, and min-content is what
  // flex items use as their automatic minimum. Without it a long unbreakable
  // token (audit paths, tables) inflates the bubble past the panel width and
  // the whole thread gets clipped by the shell in narrow windows.
  return (
    <div
      className="min-w-0 break-words [overflow-wrap:anywhere] text-[11px] leading-relaxed text-foreground"
      data-supervisor-advice-body="true"
    >
      <LazyMessageResponse>{text}</LazyMessageResponse>
    </div>
  );
});

const BriefCard: React.FC<{
  brief: AdviceBrief;
  t: Translate;
  onApply: () => void;
  applied: boolean;
}> = ({ brief, t, onApply, applied }) => {
  const rows: Array<{ label: string; items: string[] }> = [
    { label: t('supervisor.side.adviceBriefSteps'), items: brief.steps },
    { label: t('supervisor.side.adviceBriefConstraints'), items: brief.constraints },
    { label: t('supervisor.side.adviceBriefAcceptance'), items: brief.acceptance },
    { label: t('supervisor.side.adviceBriefRisks'), items: brief.risks },
  ];
  return (
    <div
      className="mt-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1.5"
      data-supervisor-advice-brief="true"
    >
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-emerald-600">
        <FileText size={11} />
        {t('supervisor.side.adviceBrief')}
      </div>
      {brief.goal && (
        <p className="text-[11px] leading-relaxed text-foreground">
          <span className="font-semibold">{t('supervisor.side.adviceBriefGoal')}：</span>
          {brief.goal}
        </p>
      )}
      {brief.approach && (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">{t('supervisor.side.adviceBriefApproach')}：</span>
          {brief.approach}
        </p>
      )}
      {rows.filter((row) => row.items.length > 0).map((row) => (
        <div key={row.label} className="mt-1">
          <p className="text-[10px] font-semibold text-muted-foreground">{row.label}</p>
          <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-relaxed text-foreground">
            {row.items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ))}
      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold',
            applied
              ? 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
              : 'bg-primary text-primary-foreground hover:opacity-90',
          )}
          data-supervisor-advice-apply="true"
        >
          <Sparkles size={11} />
          {applied ? t('supervisor.side.adviceApplied') : t('supervisor.side.adviceApply')}
        </button>
        <span className="text-[10px] leading-relaxed text-muted-foreground">
          {t('supervisor.side.adviceApplyHint')}
        </span>
      </div>
    </div>
  );
};

const MessageRow: React.FC<{
  message: AdviceMessage;
  t: Translate;
  appliedBriefId: string | null;
  onApplyBrief: (message: AdviceMessage) => void;
  onEdit: (message: AdviceMessage) => void;
  onBranch: (message: AdviceMessage) => void;
  onQuote: (text: string) => void;
  /** Hover actions are suppressed while a turn is streaming. */
  actionsEnabled: boolean;
}> = ({ message, t, appliedBriefId, onApplyBrief, onEdit, onBranch, onQuote, actionsEnabled }) => {
  if (message.hidden) return null;
  const isUser = message.role === 'user';
  const failed = message.status === 'error';
  return (
    <div
      className={cn('group relative flex w-full gap-2', isUser ? 'justify-end' : 'justify-start')}
      data-supervisor-advice-message={message.id}
      data-supervisor-advice-role={message.role}
    >
      {!isUser && (
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-600">
          <ShieldCheck size={13} />
        </span>
      )}
      <div
        className={cn(
          // min-w-0 + overflow-hidden keep the automatic flex minimum from
          // blowing the bubble wider than the thread in narrow windows.
          'min-w-0 max-w-[86%] overflow-hidden rounded-lg border px-2.5 py-1.5',
          isUser
            ? 'border-primary/25 bg-primary/[0.07]'
            : failed
              ? 'border-rose-500/30 bg-rose-500/5'
              : 'border-border/70 bg-muted/30',
        )}
      >
        {failed ? (
          <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[11px] leading-relaxed text-rose-600">{message.text}</p>
        ) : (
          <AdviceBody text={message.text} />
        )}
        {message.brief && (
          <BriefCard
            brief={message.brief}
            t={t}
            applied={appliedBriefId === message.id}
            onApply={() => onApplyBrief(message)}
          />
        )}
      </div>
      {actionsEnabled && !failed && (
        <div
          className={cn(
            'absolute z-10 flex items-center gap-0.5 rounded-md border border-border/70 bg-background px-0.5 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100',
            isUser ? '-top-1.5 right-9' : '-top-1.5 left-9',
          )}
          data-supervisor-advice-actions="true"
        >
          {isUser ? (
            <button
              type="button"
              onClick={() => onEdit(message)}
              title={t('supervisor.side.adviceMsgEdit')}
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              data-supervisor-advice-edit="true"
            >
              <Pencil size={10} />
              {t('supervisor.side.adviceMsgEdit')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onBranch(message)}
              title={t('supervisor.side.adviceMsgBranch')}
              className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              data-supervisor-advice-branch="true"
            >
              <GitBranch size={10} />
              {t('supervisor.side.adviceMsgBranch')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onQuote(message.text)}
            title={t('supervisor.side.adviceMsgQuote')}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            data-supervisor-advice-quote-msg="true"
          >
            <Quote size={10} />
            {t('supervisor.side.adviceMsgQuote')}
          </button>
        </div>
      )}
      {isUser && (
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <UserRound size={13} />
        </span>
      )}
    </div>
  );
};

/**
 * 选中引用 — branch a fragment of the thread into the next turn.
 *
 * Reading a long answer usually produces a follow-up about *one sentence* of
 * it. Selecting inside the thread pops a small 「添加到对话」 action; picking it
 * quotes the fragment into the composer, so the next turn carries the exact
 * excerpt (a markdown blockquote the model reads as quoted context) instead of
 * the user retyping it.
 *
 * The button is portaled to <body> and positioned from the selection's viewport
 * rect — the thread is a scroll container, so an in-flow bubble would be
 * clipped. `mousedown` is prevented so the click does not collapse the very
 * selection it is about (the excerpt is already captured in state anyway).
 */
const QUOTE_MIN_CHARS = 2;
/** One drag must not smuggle a whole wall of text into the next turn. */
const QUOTE_MAX_CHARS = 1500;

interface QuoteSelection {
  text: string;
  top: number;
  left: number;
  bottom: number;
}

const AdviceQuoteBubble: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  t: Translate;
  onAdd: (text: string) => void;
}> = ({ containerRef, t, onAdd }) => {
  const [selection, setSelection] = useState<QuoteSelection | null>(null);

  useEffect(() => {
    const read = () => {
      const dom = window.getSelection();
      if (!dom || dom.isCollapsed || dom.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const text = dom.toString().trim();
      if (text.length < QUOTE_MIN_CHARS) {
        setSelection(null);
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const range = dom.getRangeAt(0);
      const anchor = range.commonAncestorContainer;
      const anchorEl = anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement;
      // Selections in the composer / header must not raise the bubble.
      if (!anchorEl || !container.contains(anchorEl)) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        setSelection(null);
        return;
      }
      setSelection({
        text: text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text,
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
      });
    };

    const hide = () => setSelection(null);
    const container = containerRef.current;
    document.addEventListener('selectionchange', read);
    container?.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('selectionchange', read);
      container?.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [containerRef]);

  if (!selection) return null;

  const openAbove = selection.top > 48;
  const left = Math.min(Math.max(6, selection.left), Math.max(6, window.innerWidth - 132));

  return createPortal(
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onAdd(selection.text);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }}
      style={{ top: openAbove ? selection.top - 30 : selection.bottom + 6, left }}
      className="fixed z-[90] inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-popover px-1.5 py-1 text-[10px] font-semibold text-violet-600 shadow-lg transition-colors hover:bg-violet-500/10"
      title={t('supervisor.side.adviceQuoteHint')}
      data-supervisor-advice-quote-add="true"
    >
      <Quote size={10} />
      {t('supervisor.side.adviceQuoteAdd')}
    </button>,
    document.body,
  );
};

/**
 * 研讨模型切换器 — the footer label doubles as the picker trigger.
 *
 * The discussion turn re-reads the supervisor model choice on every call, so a
 * pick here applies to the very next message without restarting anything. The
 * popup is portaled to <body> and opens *upward*: the trigger sits in the
 * bottom bar of the side panel, where a downward popup would fall off-screen.
 */
const AdviceModelPicker: React.FC<{
  t: Translate;
  modelLabel: string;
  pool: readonly SupervisorModelPoolEntry[];
  currentModelId: string;
  disabled?: boolean;
  onChange: (modelId: string | null) => void;
}> = ({ t, modelLabel, pool, currentModelId, disabled, onChange }) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    setPos({
      bottom: Math.max(8, window.innerHeight - box.top + 4),
      left: Math.min(box.left, Math.max(8, window.innerWidth - 260)),
      width: Math.max(box.width, 220),
    });
  }, []);

  const openPopup = useCallback(() => {
    if (disabled || pool.length === 0) return;
    updatePos();
    setOpen(true);
  }, [disabled, pool.length, updatePos]);

  const closePopup = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePos();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closePopup();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePopup();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, closePopup]);

  const pick = useCallback((modelId: string | null) => {
    onChange(modelId);
    closePopup();
  }, [onChange, closePopup]);

  const routingLabel = t('supervisor.side.modelRoutingGroup');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePopup() : openPopup())}
        disabled={disabled || pool.length === 0}
        title={pool.length === 0 ? modelLabel : t('supervisor.side.adviceModelSwitchHint')}
        className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-px text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
        data-supervisor-advice-model-trigger="true"
      >
        <span className="truncate">{modelLabel || '—'}</span>
        <ChevronDown size={10} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="fixed z-[80] max-h-[320px] w-max overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
          style={{ bottom: pos.bottom, left: pos.left, width: pos.width }}
          data-supervisor-advice-model-popup="true"
        >
          {pool.map((entry) => {
            const selected = !!currentModelId && entry.modelId === currentModelId;
            return (
              <button
                key={`${entry.backend.kind}:${entry.backend.kind === 'agent' ? entry.backend.agentId : entry.backend.providerId}:${entry.modelId}`}
                type="button"
                onClick={() => pick(entry.modelId)}
                title={entry.routing ? `${entry.label} · ${routingLabel}` : `${entry.label} · ${entry.vendor}`}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-accent/60',
                  selected && 'bg-accent/50',
                )}
                data-supervisor-advice-model-option={entry.modelId}
              >
                <span className={cn('min-w-0 flex-1 truncate', selected ? 'font-semibold text-foreground' : 'text-foreground')}>
                  {entry.modelId}
                </span>
                {entry.routing && (
                  <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 text-[9px] text-amber-600">
                    {routingLabel}
                  </span>
                )}
                <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">
                  {entry.label !== entry.modelId ? entry.label : entry.vendor}
                </span>
              </button>
            );
          })}
          <div className="my-1 border-t border-border/60" />
          <button
            type="button"
            onClick={() => pick(null)}
            className={cn(
              'flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-accent/60',
              !currentModelId && 'bg-accent/50 font-semibold',
            )}
            data-supervisor-advice-model-option="__app_default__"
          >
            <span className="min-w-0 flex-1 truncate text-foreground">
              {t('supervisor.side.adviceModelFollowDefault')}
            </span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
};

export const SupervisorAdvicePanel: React.FC<SupervisorAdvicePanelProps> = ({
  t,
  supervisorState,
  modelLabel,
  // Defensive defaults: older harnesses / hosts render the panel without a
  // pool, in which case the footer degrades to the previous read-only label.
  modelPool = [],
  currentModelId = '',
  onModelChange = () => {},
  onBack,
  onApplyBrief,
}) => {
  const thread = useSupervisorAdviceSnapshot();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [briefBusy, setBriefBusy] = useState(false);
  const [appliedBriefId, setAppliedBriefId] = useState<string | null>(null);
  /** 编辑重发: the user message being edited; send truncates the thread here. */
  const [editTargetId, setEditTargetId] = useState<string | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Set when a quote just landed in the draft: the caret follows the tail. */
  const caretToEndRef = useRef(false);
  const stream = useStreamBuffer();

  // 自定义提示词：已生效的值 + 编辑中的草稿（保存前互不影响）。
  const [customPrompt, setCustomPrompt] = useState<string>(() => readSupervisorCustomPrompt());
  const [promptDraft, setPromptDraft] = useState<string>(() => readSupervisorCustomPrompt());
  const [promptOpen, setPromptOpen] = useState(false);

  // 输入区高度：拖动分隔条调整；0 = 未设置（默认两行）。mouseup 落盘。
  const [composerHeight, setComposerHeight] = useState<number>(() => readAdviceComposerHeight());
  const composerHeightRef = useRef(composerHeight);
  composerHeightRef.current = composerHeight;
  const composerDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleComposerDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const current = composerHeightRef.current > 0
      ? composerHeightRef.current
      : (inputRef.current?.offsetHeight || 56);
    composerDragRef.current = { startY: event.clientY, startHeight: current };
    setComposerHeight(current);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = composerDragRef.current;
      if (!drag) return;
      // Dragging up grows the composer (it hangs off the bottom edge).
      const delta = drag.startY - event.clientY;
      const max = Math.min(ADVICE_COMPOSER_MAX_HEIGHT, Math.floor(window.innerHeight * 0.6));
      setComposerHeight(Math.max(ADVICE_COMPOSER_MIN_HEIGHT, Math.min(max, drag.startHeight + delta)));
    };
    const onUp = () => {
      if (!composerDragRef.current) return;
      composerDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      writeAdviceComposerHeight(composerHeightRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const runContext = useMemo(
    () => summarizeSupervisorRunForAdvice(supervisorState),
    [supervisorState],
  );
  const streamText = stream.text;
  const streaming = busy || briefBusy;

  // Follow the newest turn (including mid-stream growth). Writing scrollTop on
  // every flush forces a synchronous layout mid-commit; only move when the
  // content actually grew.
  const lastScrollHeightRef = useRef(0);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (node.scrollHeight === lastScrollHeightRef.current) return;
    lastScrollHeightRef.current = node.scrollHeight;
    node.scrollTop = node.scrollHeight;
  }, [thread.messages.length, streamText]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Leaving the panel (or closing the side panel) must not leave a turn running.
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy || briefBusy) return;
    // 编辑重发: everything from the edited message onward is dropped first,
    // so the edited instruction replays as if it were just asked.
    if (editTargetId) {
      supervisorAdviceStore.truncateFrom(editTargetId);
      setEditTargetId(null);
    }
    setDraft('');
    supervisorAdviceStore.append('user', text);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    stream.start();
    try {
      const messages = buildAdviceContextMessages(supervisorAdviceStore.getSnapshot().messages);
      const reply = await runSupervisorAdviceTurn({
        messages,
        systemPrompt: buildAdviceSystemPrompt({
          brief: supervisorAdviceStore.getSnapshot().brief,
          runContext,
          customPrompt,
        }),
        onDelta: stream.push,
        abortSignal: controller.signal,
      });
      stream.flush();
      supervisorAdviceStore.append('assistant', reply);
    } catch (err) {
      const partial = stream.flush();
      if (partial.trim()) {
        supervisorAdviceStore.append('assistant', partial);
      } else if (!isAbortError(err)) {
        const reason = err instanceof Error ? err.message : String(err);
        supervisorAdviceStore.append('assistant', `${t('supervisor.side.adviceFailed')}：${reason}`, { status: 'error' });
        toast.error(t('supervisor.side.adviceFailed'));
      }
    } finally {
      abortRef.current = null;
      stream.reset();
      setBusy(false);
    }
  }, [busy, briefBusy, runContext, stream, t, customPrompt, editTargetId]);

  const generateBrief = useCallback(async () => {
    if (busy || briefBusy) return;
    const hasDiscussion = supervisorAdviceStore.getSnapshot().messages
      .some((message) => !message.hidden && message.role === 'user' && message.text.trim());
    if (!hasDiscussion) {
      toast.error(t('supervisor.side.adviceBriefEmpty'));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBriefBusy(true);
    stream.start();
    try {
      const messages = [
        ...buildAdviceContextMessages(supervisorAdviceStore.getSnapshot().messages),
        { role: 'user' as const, content: ADVICE_BRIEF_INSTRUCTION },
      ];
      const reply = await runSupervisorAdviceTurn({
        messages,
        systemPrompt: buildAdviceSystemPrompt({ runContext, customPrompt }),
        onDelta: stream.push,
        abortSignal: controller.signal,
      });
      stream.flush();
      const brief = parseAdviceBrief(reply);
      if (!brief) {
        supervisorAdviceStore.append('assistant', reply, { status: 'error' });
        toast.error(t('supervisor.side.adviceBriefFailed'));
        return;
      }
      supervisorAdviceStore.setBrief(brief);
      supervisorAdviceStore.append('assistant', adviceBriefMarkdown(brief), { brief });
      toast.success(t('supervisor.side.adviceBriefReady'));
    } catch (err) {
      if (!isAbortError(err)) {
        toast.error(t('supervisor.side.adviceFailed'));
        console.warn('[Supervisor] advice brief failed:', err);
      }
    } finally {
      abortRef.current = null;
      stream.reset();
      setBriefBusy(false);
    }
  }, [busy, briefBusy, runContext, stream, t, customPrompt]);

  const handleStop = useCallback(() => {
    abort();
    stream.flush();
    toast.success(t('supervisor.side.adviceStopped'));
  }, [abort, stream, t]);

  const handleClear = useCallback(() => {
    abort();
    stream.reset();
    supervisorAdviceStore.clear();
    setAppliedBriefId(null);
    setEditTargetId(null);
    toast.success(t('supervisor.side.adviceCleared'));
  }, [abort, stream, t]);

  const handleApply = useCallback((message: AdviceMessage) => {
    if (!message.brief) return;
    onApplyBrief({
      goal: message.brief.goal,
      steps: adviceBriefToPlanLines(message.brief),
      briefText: adviceBriefMarkdown(message.brief),
    });
    setAppliedBriefId(message.id);
    toast.success(t('supervisor.side.adviceAppliedToast'));
  }, [onApplyBrief, t]);

  const handleSavePrompt = useCallback(() => {
    const next = normalizeSupervisorCustomPrompt(promptDraft);
    writeSupervisorCustomPrompt(next);
    setCustomPrompt(next);
    setPromptDraft(next);
    toast.success(t('supervisor.side.advicePromptSaved'));
  }, [promptDraft, t]);

  const handleResetPrompt = useCallback(() => {
    writeSupervisorCustomPrompt('');
    setCustomPrompt('');
    setPromptDraft('');
    toast.success(t('supervisor.side.advicePromptCleared'));
  }, [t]);

  /** 选中引用：quote the excerpt as a markdown blockquote at the head of the
   * draft, leaving the caret at the tail for the actual question. */
  const addQuoteToDraft = useCallback((text: string) => {
    const clipped = text.length > QUOTE_MAX_CHARS ? `${text.slice(0, QUOTE_MAX_CHARS)}…` : text;
    const quoted = clipped
      .split('\n')
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n');
    const block = `${t('supervisor.side.adviceQuoteLabel')}：\n${quoted}`;
    setDraft((prev) => (prev.trim() ? `${block}\n\n${prev}` : `${block}\n\n`));
    caretToEndRef.current = true;
  }, [t]);

  /** 编辑已发送指令: prefill the composer with the original text; nothing is
   * truncated until the user actually sends (banner + cancel = safe). */
  const handleEditMessage = useCallback((message: AdviceMessage) => {
    if (streaming) return;
    setEditTargetId(message.id);
    setDraft(message.text);
    caretToEndRef.current = true;
    inputRef.current?.focus();
  }, [streaming]);

  /** 分支对话: fork the discussion at an assistant reply; the current thread
   * is parked (nothing is lost) and the fork becomes active. */
  const handleBranchMessage = useCallback((message: AdviceMessage) => {
    if (streaming) return;
    const currentLabel = thread.activeLabel ?? t('supervisor.side.adviceBranchMain');
    const nextNumber = (thread.branches?.length ?? 0) + 1;
    const branch = supervisorAdviceStore.branchFrom(
      message.id,
      currentLabel,
      t('supervisor.side.adviceBranchName', { n: String(nextNumber) }),
    );
    if (branch) toast.success(t('supervisor.side.adviceBranchCreated'));
  }, [streaming, thread, t]);

  /** 消息级引用: hover 「添加到对话」 quotes the whole message into the draft. */
  const handleQuoteMessage = useCallback((text: string) => {
    addQuoteToDraft(text);
  }, [addQuoteToDraft]);

  const handleSwitchBranch = useCallback((id: string | null) => {
    if (streaming) return;
    const currentLabel = thread.activeLabel ?? t('supervisor.side.adviceBranchMain');
    supervisorAdviceStore.switchBranch(id, currentLabel);
  }, [streaming, thread, t]);

  // Focus + caret at the tail once React has committed the quoted draft.
  useEffect(() => {
    if (!caretToEndRef.current) return;
    const el = inputRef.current;
    if (!el) return;
    caretToEndRef.current = false;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [draft]);

  const visibleMessages = useMemo(
    () => thread.messages.filter((message) => !message.hidden),
    [thread.messages],
  );
  const canSend = !!draft.trim() && !streaming;
  // Streaming text updates ~16x/s while a turn runs. Re-rendering every past
  // turn (each one parses markdown) on every flush is what pins the renderer on
  // long threads, so the committed rows are memoised by identity.
  const renderedThread = useMemo(() => visibleMessages.map((message) => (
    <MessageRow
      key={message.id}
      message={message}
      t={t}
      appliedBriefId={appliedBriefId}
      onApplyBrief={handleApply}
      onEdit={handleEditMessage}
      onBranch={handleBranchMessage}
      onQuote={handleQuoteMessage}
      actionsEnabled={!streaming}
    />
  )), [
    visibleMessages,
    t,
    appliedBriefId,
    handleApply,
    handleEditMessage,
    handleBranchMessage,
    handleQuoteMessage,
    streaming,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-supervisor-advice="true">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-2 py-1.5" data-supervisor-advice-header="true">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent"
          data-supervisor-advice-back="true"
        >
          <ChevronLeft size={12} />
          {t('supervisor.side.adviceBack')}
        </button>
        <span className="ml-0.5 flex items-center gap-1 text-xs font-semibold">
          <MessagesSquare size={13} className="text-violet-500" />
          {t('supervisor.side.adviceTitle')}
        </span>
        {/* 分支切换: shows the active thread label; opens a list of parked
            branches + 主线 to swap with the active one. */}
        {(thread.activeLabel || (thread.branches?.length ?? 0) > 0) && (
          <span className="relative">
            <button
              type="button"
              onClick={() => setBranchMenuOpen((open) => !open)}
              disabled={streaming}
              title={t('supervisor.side.adviceBranchSwitchHint')}
              className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
              data-supervisor-advice-branch-switch="true"
            >
              <GitBranch size={10} />
              {thread.activeLabel || t('supervisor.side.adviceBranchMain')}
              <ChevronDown size={10} />
            </button>
            {branchMenuOpen && (
              <div
                className="absolute left-0 top-full z-20 mt-1 min-w-[120px] rounded-md border border-border bg-background py-1 shadow-md"
                data-supervisor-advice-branch-menu="true"
              >
                {thread.activeBranchId != null && (
                  <button
                    type="button"
                    onClick={() => {
                      handleSwitchBranch(null);
                      setBranchMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {t('supervisor.side.adviceBranchMain')}
                  </button>
                )}
                {(thread.branches ?? []).map((branch) => (
                  <button
                    key={branch.id}
                    type="button"
                    onClick={() => {
                      handleSwitchBranch(branch.id);
                      setBranchMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <GitBranch size={10} />
                    {branch.label}
                  </button>
                ))}
              </div>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setPromptOpen((open) => !open)}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] font-medium',
              promptOpen
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
            title={t('supervisor.side.advicePromptTitle')}
            data-supervisor-advice-prompt-toggle="true"
          >
            <Settings2 size={11} />
            {t('supervisor.side.advicePrompt')}
            {customPrompt && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => void generateBrief()}
            disabled={streaming}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold disabled:opacity-50',
              thread.brief
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
            data-supervisor-advice-brief-generate="true"
          >
            {briefBusy ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
            {thread.brief ? t('supervisor.side.adviceBriefBadge') : t('supervisor.side.adviceBrief')}
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={streaming || visibleMessages.length === 0}
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
            data-supervisor-advice-clear="true"
          >
            <Eraser size={11} />
            {t('supervisor.side.adviceClear')}
          </button>
        </div>
      </div>

      {promptOpen && (
        <div className="border-b border-border/50 bg-muted/[0.05] px-2 py-1.5" data-supervisor-advice-prompt="true">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[10px] font-semibold text-foreground">
              <Settings2 size={10} className="text-primary" />
              {t('supervisor.side.advicePromptTitle')}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              {promptDraft.trim().length}/{SUPERVISOR_CUSTOM_PROMPT_MAX}
            </span>
          </div>
          <textarea
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
            rows={4}
            maxLength={SUPERVISOR_CUSTOM_PROMPT_MAX}
            placeholder={t('supervisor.side.advicePromptPlaceholder')}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-relaxed text-foreground outline-none focus:border-primary/50"
            data-supervisor-advice-prompt-input="true"
          />
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            {t('supervisor.side.advicePromptHint')}
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleSavePrompt}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
              data-supervisor-advice-prompt-save="true"
            >
              {t('supervisor.side.advicePromptSave')}
            </button>
            <button
              type="button"
              onClick={handleResetPrompt}
              disabled={!customPrompt && !promptDraft.trim()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-40"
              data-supervisor-advice-prompt-reset="true"
            >
              <Eraser size={10} />
              {t('supervisor.side.advicePromptClear')}
            </button>
            {customPrompt && (
              <span className="text-[10px] font-medium text-emerald-600" data-supervisor-advice-prompt-active="true">
                {t('supervisor.side.advicePromptActive')}
              </span>
            )}
          </div>
        </div>
      )}

      <p className="flex items-center gap-1 px-3 pt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
        <Sparkles size={10} className="shrink-0" />
        {t('supervisor.side.adviceHint')}
        {runContext && <span className="ml-0.5" data-supervisor-advice-run-context="true">· {t('supervisor.side.adviceRunContext')}</span>}
      </p>

      <div
        ref={scrollRef}
        className="mt-1 mb-3 flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto rounded-md border border-border/40 bg-muted/[0.06] mx-2 p-2"
        data-supervisor-advice-thread="true"
      >
        {visibleMessages.length === 0 && !streamedSoFar(streamText) ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 text-center" data-supervisor-advice-empty="true">
            <MessagesSquare size={24} className="text-muted-foreground/40" />
            <p className="text-xs font-medium text-muted-foreground">{t('supervisor.side.adviceEmptyTitle')}</p>
            <p className="max-w-[92%] text-[10px] leading-relaxed text-muted-foreground/80">
              {t('supervisor.side.adviceEmptyHint')}
            </p>
            <div className="mt-1 flex flex-col gap-1">
              {STARTER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => void send(t(key))}
                  className="rounded-md border border-border/70 bg-background px-2 py-1 text-left text-[10px] leading-relaxed text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  data-supervisor-advice-starter={key}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {renderedThread}
            {streamedSoFar(streamText) && (
              <div className="flex w-full justify-start gap-2" data-supervisor-advice-streaming="true">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-600">
                  <ShieldCheck size={13} />
                </span>
                <div className="min-w-0 max-w-[86%] overflow-hidden rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
                  <AdviceBody text={streamText} />
                </div>
              </div>
            )}
            {streaming && !streamedSoFar(streamText) && (
              <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground" data-supervisor-advice-thinking="true">
                <Loader2 size={11} className="animate-spin" />
                {briefBusy ? t('supervisor.side.adviceBriefRunning') : t('supervisor.side.adviceThinking')}
              </div>
            )}
          </>
        )}
      </div>

      <div className="relative flex-none border-t border-border/60 px-2 py-2" data-supervisor-advice-composer="true">
        {/* Drag handle: a thin strip riding on the top border — grabbing it
            resizes the composer; the grip shows on hover only. */}
        <div
          className="absolute inset-x-0 -top-2 z-10 flex h-4 cursor-row-resize items-center justify-center text-muted-foreground/0 transition-colors hover:text-muted-foreground/70"
          onMouseDown={handleComposerDragStart}
          title={t('supervisor.side.adviceComposerResizeHint')}
          data-supervisor-advice-composer-resize="true"
        >
          <GripHorizontal size={12} className="opacity-60" />
        </div>
        <div className="flex items-end gap-1.5">
          <div className="flex min-w-0 flex-1 flex-col">
            {editTargetId && (
              <div
                className="mb-1 flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-600"
                data-supervisor-advice-edit-banner="true"
              >
                <Pencil size={10} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('supervisor.side.adviceEditHint')}</span>
                <button
                  type="button"
                  onClick={() => {
                    setEditTargetId(null);
                    setDraft('');
                  }}
                  className="shrink-0 rounded border border-amber-500/40 px-1 py-px font-medium hover:bg-amber-500/15"
                  data-supervisor-advice-edit-cancel="true"
                >
                  {t('supervisor.side.adviceEditCancel')}
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              placeholder={t('supervisor.side.advicePlaceholder')}
              rows={2}
              disabled={streaming}
              style={composerHeight > 0 ? { height: composerHeight } : undefined}
              className="w-full min-w-0 resize-none overflow-y-auto rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-relaxed text-foreground outline-none focus:border-primary/50 disabled:opacity-60"
              data-supervisor-advice-input="true"
            />
          </div>
          {streaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/20"
              data-supervisor-advice-stop="true"
            >
              <Square size={11} />
              {t('supervisor.side.adviceStop')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send(draft)}
              disabled={!canSend}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold',
                canSend ? 'bg-primary text-primary-foreground hover:opacity-90' : 'cursor-not-allowed bg-muted text-muted-foreground/60',
              )}
              data-supervisor-advice-send="true"
            >
              <Send size={11} />
              {t('supervisor.side.adviceSend')}
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
          <span className="flex min-w-0 items-center gap-0.5" data-supervisor-advice-model="true">
            <span className="shrink-0">{t('supervisor.side.adviceModel')}：</span>
            <AdviceModelPicker
              t={t}
              modelLabel={modelLabel}
              pool={modelPool}
              currentModelId={currentModelId}
              disabled={streaming}
              onChange={(modelId) => onModelChange(modelId)}
            />
          </span>
          <span className="shrink-0">{t('supervisor.side.adviceNoDispatch')}</span>
        </div>
      </div>

      <AdviceQuoteBubble containerRef={scrollRef} t={t} onAdd={addQuoteToDraft} />
    </div>
  );
};

function streamedSoFar(text: string): boolean {
  return !!text.trim();
}

export default SupervisorAdvicePanel;
