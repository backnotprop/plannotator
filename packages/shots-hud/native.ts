/**
 * The seam between the HUD page and the native Plannotator Shots app
 * (apps/shots-macos). In a browser there is no native side: every call is a
 * no-op and the page lays itself out bottom-right.
 *
 * Web → native: `window.webkit.messageHandlers.shots.postMessage(message)`.
 *   { type: 'ready' }
 *   { type: 'layout', mode: 'hidden' | 'strip' | 'panel', width, height, focus }
 *   { type: 'capture', kind: 'region' | 'app' }
 *   { type: 'flightTarget', captureId, rect: { x, y, width, height } }   (window coordinates, CSS px)
 *   { type: 'flightLanded', captureId }
 *   { type: 'openSettings', pane: 'screen' | 'accessibility' }
 *   { type: 'clipboard', text?, files? }
 *   { type: 'settings', appShots }
 *
 * Native → web: functions on `window.shotsHud` (see NativeCalls).
 */

declare global {
  interface Window {
    webkit?: { messageHandlers?: { shots?: { postMessage(message: unknown): void } } };
    shotsHud?: NativeCalls;
  }
}

export interface CapturedEvent {
  captureId: string;
  shotId: string;
  collectionId: string;
  /** The collection was empty: open straight into marking. */
  first: boolean;
}

export interface NativeCalls {
  /** A capture was registered with the hub. */
  captured(event: CapturedEvent): void;
  /** ⌥⇧⌘P. */
  toggle(): void;
  /** The capture overlay is opening: tuck the panel into the strip (nothing typed is lost). */
  willCapture(): void;
  /** Permission state, at launch and whenever it changes. */
  permissions(state: { screen: boolean; accessibility: boolean; screenEverGranted?: boolean }): void;
  /** The permission card: `done` closes it. */
  permission(state: { kind: string; state: string }): void;
  /** The app's own icon (what System Settings lists), for the card's picture. */
  appIcon(dataUrl: string): void;
  /** A capture was refused after Screen Recording had worked: it was turned off. */
  screenRecordingOff(): void;
  /** A capture failed (e.g. the image came back as wallpaper only). */
  captureFailed(reason: string): void;
}

export const isNative = !!window.webkit?.messageHandlers?.shots || !!window.__SHOTS__?.native;

export function postNative(message: { type: string } & Record<string, unknown>): void {
  window.webkit?.messageHandlers?.shots?.postMessage(message);
}

export function registerNativeCalls(calls: NativeCalls): () => void {
  window.shotsHud = calls;
  return () => {
    if (window.shotsHud === calls) delete window.shotsHud;
  };
}
