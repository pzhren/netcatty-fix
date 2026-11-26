import React, { Suspense, lazy, useEffect, useState } from 'react';
import type { useSettingsState } from '../application/state/useSettingsState';
import type { useAppLockState } from '../application/state/useAppLockState';
import { useSyncExternalStore } from 'react';
import {
  isSettingsOverlayOpen,
  subscribeSettingsOverlay,
} from '../application/state/settingsOverlay';

const LazySettingsPage = lazy(() => import('./SettingsPage'));

type SettingsState = ReturnType<typeof useSettingsState>;
type AppLockState = ReturnType<typeof useAppLockState>;

/** Bottom edge of the top chrome (tab bar / OS titlebar row) when present. */
function measureTopChromeOffset(): number {
  let top = 0;
  const titlebar = document.querySelector('[data-tab-window-titlebar]');
  if (titlebar && titlebar.clientHeight > 0) {
    top = titlebar.getBoundingClientRect().bottom;
  }
  const tabsRoot = document.querySelector('[data-top-tabs-root]');
  if (tabsRoot) {
    const rect = tabsRoot.getBoundingClientRect();
    // Only counts when the tab bar is docked at the top of the window.
    if (rect.top <= 1 && rect.bottom > top) top = rect.bottom;
  }
  return Math.max(0, Math.round(top));
}

/**
 * A render error in the in-app settings panel must never blank the main
 * window — show a recoverable card instead (same pattern as the settings
 * window route in index.tsx).
 */
class SettingsOverlayErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center bg-background text-foreground">
        <div className="max-w-[560px] rounded-xl border border-border bg-card p-7 leading-relaxed">
          <div className="mb-2.5 text-lg font-semibold">设置加载失败 / Settings failed to load</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{error.message}</pre>
          <button
            type="button"
            className="mt-3 rounded-lg border-0 bg-primary px-4 py-2 text-primary-foreground"
            onClick={() => this.setState({ error: null })}
          >
            重试 / Retry
          </button>
        </div>
      </div>
    );
  }
}

function SettingsOverlayFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground/70" />
    </div>
  );
}

interface SettingsOverlayHostProps {
  settings: SettingsState;
  appLock: AppLockState;
}

/**
 * In-app settings panel for the main window. Mounts the real SettingsPage
 * (same component the separate settings window renders) filling the whole
 * window below the top chrome, so the top bar stays visible and clickable.
 * The settings gear toggles the panel; the page itself has no close button
 * (hideClose), so open/close is driven entirely by the gear entry points.
 */
export const SettingsOverlayHost: React.FC<SettingsOverlayHostProps> = ({ settings, appLock }) => {
  const open = useSyncExternalStore(subscribeSettingsOverlay, isSettingsOverlayOpen, isSettingsOverlayOpen);
  const [topOffset, setTopOffset] = useState(0);

  // Keep the panel below the top chrome (tab bar / OS titlebar row).
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const next = measureTopChromeOffset();
      setTopOffset((current) => (next === current ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const tabsRoot = document.querySelector('[data-top-tabs-root]');
    const observer = typeof ResizeObserver !== 'undefined' && tabsRoot
      ? new ResizeObserver(measure)
      : null;
    if (observer && tabsRoot) observer.observe(tabsRoot);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [open]);

  // Never show settings above the app lock screen.
  if (!open || appLock.locked) return null;
  return (
    <div
      className="fixed inset-x-0 z-[9999] overflow-hidden bg-background"
      style={{ top: topOffset, bottom: 0 }}
      data-settings-overlay="open"
    >
      <SettingsOverlayErrorBoundary>
        <Suspense fallback={<SettingsOverlayFallback />}>
          <LazySettingsPage settings={settings} appLock={appLock} hideClose />
        </Suspense>
      </SettingsOverlayErrorBoundary>
    </div>
  );
};
