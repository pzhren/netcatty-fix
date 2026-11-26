import { useCallback } from "react";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  closeSettingsOverlay,
  isSettingsOverlayOpen,
  openSettingsOverlay,
} from "./settingsOverlay";

export function subscribeWindowFullscreenChanged(
  cb: (isFullscreen: boolean) => void,
): () => void {
  try {
    return netcattyBridge.get()?.onWindowFullScreenChanged?.(cb) ?? (() => {});
  } catch {
    return () => {};
  }
}

export const useWindowControls = () => {
  const notifyRendererReady = useCallback(() => {
    try {
      netcattyBridge.get()?.rendererReady?.();
    } catch {
      // ignore
    }
  }, []);

  const closeSettingsWindow = useCallback(async () => {
    // In-app overlay: the settings page rendered inside the main window closes
    // through this same hook — close the overlay instead of the IPC window.
    if (isSettingsOverlayOpen()) {
      closeSettingsOverlay();
      return;
    }
    const bridge = netcattyBridge.get();
    await bridge?.closeSettingsWindow?.();
  }, []);

  const openSettingsWindow = useCallback(async () => {
    // Toggle the in-app settings overlay: the gear opens it when closed and
    // collapses it when already open. Only the main window renders the overlay
    // host; no other window calls this hook for settings, so this is safe.
    // Both branches resolve `true` — the request was handled in-window. A
    // `false` here would trip AppSideEffects' "platform can't open settings"
    // toast on the close path.
    if (isSettingsOverlayOpen()) {
      closeSettingsOverlay();
      return true;
    }
    return openSettingsOverlay();
  }, []);

  const minimize = useCallback(async () => {
    const bridge = netcattyBridge.get();
    await bridge?.windowMinimize?.();
  }, []);

  const maximize = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowMaximize?.();
  }, []);

  const close = useCallback(async () => {
    const bridge = netcattyBridge.get();
    await bridge?.windowClose?.();
  }, []);

  const isMaximized = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowIsMaximized?.();
  }, []);

  const isFullscreen = useCallback(async () => {
    const bridge = netcattyBridge.get();
    return bridge?.windowIsFullscreen?.() ?? false;
  }, []);

  const onFullscreenChanged = useCallback(subscribeWindowFullscreenChanged, []);

  const onWindowCommandCloseRequested = useCallback((cb: () => void) => {
    const bridge = netcattyBridge.get();
    return bridge?.onWindowCommandCloseRequested?.(cb) ?? (() => {});
  }, []);

  return {
    notifyRendererReady,
    closeSettingsWindow,
    openSettingsWindow,
    minimize,
    maximize,
    close,
    isMaximized,
    isFullscreen,
    onFullscreenChanged,
    onWindowCommandCloseRequested,
  };
};
