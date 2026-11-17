/**
 * SupervisorTranscript — shared transcript renderer for the supervisor ↔ task
 * Agent conversation. Used by the monitor page panel and the AI side-panel
 * "自主模式" console so both surfaces show the exact same events.
 *
 * Purely presentational: no store access, no dispatch logic.
 */

import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, ShieldCheck, Sparkles, UserRound } from 'lucide-react';
import type { AISession, ChatMessage } from '../../infrastructure/ai/types';
import type { SupervisorEvent, SupervisorRoundResult } from '../../infrastructure/ai/supervisorTypes';
import { LazyMessageResponse } from '../ai-elements/LazyMessageResponse';
import { cn } from '../../lib/utils';

const PREVIEW_CHARS = 420;

/**
 * How many trailing events mount by default.
 *
 * A long-lived supervisor session accumulates hundreds of events, and every
 * event bubble parses markdown. Rendering the whole history makes each commit
 * cost tens of milliseconds, so any parent re-render (streaming text, a clock
 * tick, a state push) pins the renderer. Only the tail mounts up front; the
 * user can pull the rest in on demand.
 */
const TRANSCRIPT_INITIAL_WINDOW = 60;
/** Hidden events are revealed in chunks of this size. */
const TRANSCRIPT_WINDOW_STEP = 120;

/**
 * How many trailing live task messages mount.
 *
 * The live block mirrors every assistant/tool message the dispatched agent
 * produced *after* the last dispatch event. In a long run that is the whole
 * tail of a 200+ message conversation, each one parsing markdown and rendering
 * its tool calls. That list used to be unbounded — it is the second reason a
 * weeks-old supervisor session froze the renderer on boot, independent of the
 * event history above.
 */
const LIVE_MESSAGE_WINDOW = 10;

const hasLiveBody = (message: ChatMessage): boolean => Boolean(
  message.content.trim()
  || message.errorInfo
  || (message.agentActivities && message.agentActivities.length > 0)
  || (message.toolCalls && message.toolCalls.length > 0),
);

const RESULT_TONE: Record<SupervisorRoundResult, string> = {
  complete: 'bg-emerald-500/15 text-emerald-600',
  empty: 'bg-amber-500/15 text-amber-600',
  error: 'bg-rose-500/15 text-rose-600',
  failed: 'bg-rose-500/15 text-rose-600',
  stopped: 'bg-rose-500/15 text-rose-600',
  timeout: 'bg-amber-500/15 text-amber-600',
  stale_snapshot: 'bg-amber-500/15 text-amber-600',
  session_missing: 'bg-muted text-muted-foreground',
};

export function formatSupervisorTime(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export function truncateSupervisorText(value: string, limit = PREVIEW_CHARS): string {
  const clean = (value || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/**
 * Task-Agent output is markdown (bold, tables, code fences). Render it with
 * the same lazy Streamdown renderer the chat panel uses so formulas, tables
 * and code render identically. Warmup must NOT be deferred here: the
 * supervisor console never mounts the chat composer, so nothing else would
 * ever trigger the renderer warmup and replies would stay plaintext.
 */
const SupervisorReplyBody = memo<{ text: string; dense?: boolean }>(function SupervisorReplyBody({ text, dense }) {
  return (
    <div
      className={cn('min-w-0 break-words leading-relaxed', dense ? 'text-[11px]' : 'text-xs')}
      data-supervisor-reply-body="true"
    >
      <LazyMessageResponse>{text}</LazyMessageResponse>
    </div>
  );
});

/**
 * Inline numbered points → one point per line.
 *
 * Supervisor dispatches regularly enumerate steps ("…。1. 读取 …；2. 对 16
 * 道题…；3. 逐条…"), and `whitespace-pre-wrap` alone renders them as a single
 * flowing paragraph — a wall of text in a narrow side panel. The strict
 * pattern keeps real content intact:
 *  - marker is 1–25 followed by `、` `.` `．` then whitespace or a CJK char
 *    (so `v3.2`, `15.3`, `99.5%`, `py:164-182` never trigger),
 *  - the digit must not be preceded by another digit/dot/colon/hyphen
 *    (so `2026-11-16`, `19:56:49`, version strings stay put),
 *  - a marker already at line start is left untouched (no blank lines).
 */
const NUMBERED_POINT_RE = /(^|[^\d:.\-])((?:[1-9]|1[0-9]|2[0-5])[、.．])(?=\s|[\u4e00-\u9fff（(["'])/g;

export function breakNumberedPoints(text: string): string {
  return text.replace(NUMBERED_POINT_RE, (full, prefix: string, marker: string) => (
    prefix === '\n' ? full : `${prefix}\n${marker}`
  ));
}

type Translate = (key: string, params?: Record<string, string>) => string;

interface SupervisorTranscriptProps {
  events: readonly SupervisorEvent[];
  t: Translate;
  emptyTitle: string;
  emptyHint: string;
  /** Extra classes for the scroll container. */
  className?: string;
  /** Compact bubbles for the narrow side panel. */
  dense?: boolean;
  /** Live task-Agent session; latest assistant output and tool activity are shown after supervisor events. */
  session?: AISession | null;
}

export const SupervisorTranscript: React.FC<SupervisorTranscriptProps> = ({
  events,
  t,
  emptyTitle,
  emptyHint,
  className,
  dense = false,
  session = null,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);
  const initializedHistoryRef = useRef<string | null>(null);
  const historyKey = events[0]?.id ?? null;
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_INITIAL_WINDOW);
  // Stable identity while `events` and the window are unchanged: the memoised
  // element list below then bails the whole subtree out of unrelated re-renders.
  const visibleEvents = useMemo(
    () => (events.length <= windowSize ? events : events.slice(events.length - windowSize)),
    [events, windowSize],
  );
  const hiddenCount = events.length - visibleEvents.length;
  const lastDispatch = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index].kind === 'dispatch') return events[index];
    }
    return null;
  }, [events]);
  // The dispatcher creates an empty assistant placeholder up front; some turn
  // drivers later append the real reply as a separate message, leaving the
  // placeholder behind as a blank bubble ("任务 Agent" with no body). Blank
  // messages are dropped unless they are still streaming (statusText set) —
  // those instead render as an explicit "working" indicator.
  const sessionMessages = session?.messages;
  const liveMessages = useMemo(() => {
    if (!lastDispatch || !sessionMessages?.length) return [] as ChatMessage[];
    const afterDispatch = sessionMessages.filter(
      (message) => message.timestamp >= lastDispatch.at
        && (message.role === 'assistant' || message.role === 'tool'),
    );
    const withBody = afterDispatch.filter(
      (message) => hasLiveBody(message) || Boolean(message.statusText),
    );
    return withBody.length > LIVE_MESSAGE_WINDOW
      ? withBody.slice(withBody.length - LIVE_MESSAGE_WINDOW)
      : withBody;
  }, [lastDispatch, sessionMessages]);
  const hasLiveOutput = liveMessages.length > 0;
  const renderTaskMessage = (message: ChatMessage) => {
    const hasBody = hasLiveBody(message);
    const waiting = !hasBody && Boolean(message.statusText);
    return (
      <div key={message.id} className="min-w-0 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs" data-supervisor-live-message={message.id} data-supervisor-live-waiting={waiting || undefined}>
        <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground"><Bot size={12} />{t('supervisor.actor.agent')} · {formatSupervisorTime(message.timestamp)}{message.statusText && <span className="animate-pulse">{message.statusText}</span>}</div>
        {message.content && <SupervisorReplyBody text={message.content} />}
        {!message.content && waiting && (
          <div className="flex items-center gap-1.5 text-muted-foreground" data-supervisor-live-waiting-indicator="true">
            <span className="flex gap-0.5" aria-hidden>
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500/70 [animation-delay:-0.2s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500/70 [animation-delay:-0.1s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500/70" />
            </span>
            <span className="animate-pulse text-[11px]">{message.statusText || t('supervisor.liveWaiting')}</span>
          </div>
        )}
        {message.errorInfo && <p className="mt-1 whitespace-pre-wrap break-words text-rose-600">{message.errorInfo.message}</p>}
        {(message.agentActivities ?? []).map((activity) => <pre key={activity.id} className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(activity, null, 2)}</pre>)}
        {(message.toolCalls ?? []).map((call) => (
          <details key={call.id} className="mt-2 rounded border border-border/60 bg-background/60 px-2 py-1">
            <summary className="cursor-pointer font-mono text-[11px]">{call.name}</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[11px]">{JSON.stringify(call.arguments, null, 2)}</pre>
            {(session?.messages ?? []).flatMap((item) => item.toolResults ?? []).filter((result) => result.toolCallId === call.id).map((result, index) => <pre key={index} className={cn('mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px]', result.isError && 'text-rose-600')}>{result.content}</pre>)}
          </details>
        ))}
      </div>
    );
  };

  // Before paint, open a newly loaded history at its newest message. Empty or
  // hidden panels must not consume this initialization before data is visible.
  //
  // Every assignment to `scrollTop` can make an ancestor's scroll handler
  // re-render, which re-runs this effect, which assigns again — a commit storm
  // that pinned the renderer on boot (~120 commits/s, then a hard freeze) for
  // any session that had at least one event. Remember the height we already
  // scrolled to and skip the no-op write that closes the loop.
  const scrollMemoryRef = useRef<{ key: string | null; height: number }>({ key: null, height: -1 });
  const scrollToLatest = (node: HTMLDivElement, key: string | null) => {
    const target = node.scrollHeight;
    const previous = scrollMemoryRef.current;
    if (previous.key === key && previous.height === target) return;
    scrollMemoryRef.current = { key, height: target };
    node.scrollTop = target;
  };
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || !historyKey || node.clientHeight === 0) return;
    if (initializedHistoryRef.current !== historyKey) {
      initializedHistoryRef.current = historyKey;
      followLatestRef.current = true;
    }
    if (followLatestRef.current) scrollToLatest(node, historyKey);
  }, [events, historyKey, session?.messages]);

  // Retained panels can become visible without remounting or receiving another
  // event. Follow layout changes too, but never pull a user out of history.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    };
    const onResize = () => {
      if (!node.clientHeight) return;
      if (initializedHistoryRef.current !== historyKey && historyKey) {
        initializedHistoryRef.current = historyKey;
        followLatestRef.current = true;
      }
      if (followLatestRef.current) scrollToLatest(node, historyKey);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(onResize);
    observer.observe(node);
    return () => {
      node.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [historyKey]);

  const renderEvent = (event: SupervisorEvent) => {
    if (event.kind === 'think') {
      // Supervisor Agent's own reasoning step — surfaced distinctly from the
      // dispatch / reply bubbles so the user can watch it "think".
      return (
        <div key={event.id} className="flex items-center justify-center" data-supervisor-event-kind="think">
          <div className="flex max-w-[82%] items-start gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-[11px] text-violet-600" title={event.text}>
            <Sparkles size={12} className="mt-0.5 shrink-0" />
            <span className="font-semibold">{t('supervisor.kind.think')}：</span>
            <span className="break-words">{truncateSupervisorText(event.text, 240)}</span>
          </div>
        </div>
      );
    }
    // Chat-form rendering for the third party: the human's mid-run
    // instructions (插队/打断) as a right-aligned user bubble.
    if (event.actor === 'user') {
      return (
        <div key={event.id} className="flex w-full justify-end gap-2" data-supervisor-event-kind={event.kind} data-supervisor-actor="user">
          <div className="max-w-[78%] rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs">
            <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="font-semibold text-rose-600">{t('supervisor.actor.user')}</span>
              {event.round ? <span>{t('supervisor.round', { n: String(event.round) })}</span> : null}
              <span>{formatSupervisorTime(event.at)}</span>
            </div>
            <p className={cn('whitespace-pre-wrap break-words leading-relaxed text-foreground', dense && 'text-[11px]')}>{event.text}</p>
          </div>
          <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-500/15 text-rose-600">
            <UserRound size={13} />
          </span>
        </div>
      );
    }
    const systemRow = event.actor === 'system' || event.kind === 'verdict';
    if (systemRow) {
      return (
        <div key={event.id} className="flex items-center justify-center gap-2 py-1" data-supervisor-event-kind={event.kind}>
          <span className="rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {event.kind === 'verdict' && event.result
              ? `${t('supervisor.actor.supervisor')} · ${t(`supervisor.result.${event.result}`)}`
              : `${t(`supervisor.actor.${event.actor}`)} · ${formatSupervisorTime(event.at)}`}
          </span>
          <span className="max-w-[70%] truncate text-[11px] text-muted-foreground" title={event.text}>
            {truncateSupervisorText(event.text, 160)}
          </span>
        </div>
      );
    }
    const isSupervisor = event.actor === 'supervisor';
    // Supervisor and task-Agent bubbles both sit on the left; only the human's
    // own messages are right-aligned.
    return (
      <div
        key={event.id}
        className="flex w-full justify-start gap-2"
        data-supervisor-event-kind={event.kind}
        data-supervisor-actor={event.actor}
      >
        <span className={cn(
          'mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
          isSupervisor ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {isSupervisor ? <ShieldCheck size={13} /> : <Bot size={13} />}
        </span>
        <div className={cn(
          'max-w-[78%] rounded-lg border px-3 py-2 text-xs',
          isSupervisor ? 'border-primary/25 bg-primary/5' : 'border-border bg-muted/40',
        )}>
          <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="font-semibold">
              {isSupervisor ? t('supervisor.actor.supervisor') : t('supervisor.actor.agent')}
            </span>
            {event.round ? <span>{t('supervisor.round', { n: String(event.round) })}</span> : null}
            <span>{formatSupervisorTime(event.at)}</span>
            {event.result && (
              <span className={cn('rounded px-1.5 py-0.5 font-medium', RESULT_TONE[event.result])}>
                {t(`supervisor.result.${event.result}`)}
              </span>
            )}
          </div>
          {(event.actor === 'agent' && event.kind === 'reply')
            ? <SupervisorReplyBody text={event.text} dense={dense} />
            : <p className={cn('whitespace-pre-wrap break-words leading-relaxed text-foreground', dense && 'text-[11px]')}>{breakNumberedPoints(event.text)}</p>}
        </div>
      </div>
    );
  };

  // Re-parsing hundreds of markdown bubbles on every parent render is what made
  // long sessions freeze the renderer. Element identity is stable while the
  // event array is, so React bails out of this subtree entirely.
  const renderedEvents = useMemo(
    () => visibleEvents.map(renderEvent),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleEvents, t, dense],
  );
  const renderedLiveMessages = useMemo(
    () => liveMessages.map(renderTaskMessage),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveMessages, t],
  );

  return (
    <div
      ref={scrollRef}
      className={cn(
        'flex min-h-[160px] flex-col gap-2 overflow-y-auto rounded-lg border border-border/60 bg-muted/10 p-3',
        className,
      )}
      data-supervisor-timeline="true"
    >
      {events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <Sparkles size={26} className="text-muted-foreground/40" />
          <p className="text-xs font-medium text-muted-foreground">{emptyTitle}</p>
          <p className="max-w-sm text-[11px] text-muted-foreground/80">{emptyHint}</p>
        </div>
      ) : (
        <>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setWindowSize((current) => current + TRANSCRIPT_WINDOW_STEP)}
              className="mx-auto rounded-full border border-border bg-background px-2.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              data-supervisor-show-earlier={hiddenCount}
            >
              {t('supervisor.showEarlier', { n: String(hiddenCount) })}
            </button>
          )}
          {renderedEvents}
        </>
      )}
      {hasLiveOutput && (
        <div className="mt-1 flex flex-col gap-2" data-supervisor-live-output="true">
          {liveMessages.map(renderTaskMessage)}
        </div>
      )}
    </div>
  );
};

export default SupervisorTranscript;
