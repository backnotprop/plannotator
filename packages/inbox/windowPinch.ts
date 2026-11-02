/**
 * Pinching over an HTML page on a phone zooms the whole Inbox window: the frame
 * sits in the window, and the browser keeps pinch for itself (approval
 * "inbox-html-attachments-phone": one finger is the page's, pinch the window's).
 * So the toolbar, the pill and the card grow with the window and slide out of
 * the view, and they tuck while it is zoomed.
 *
 * The scale is read here, in the parent: the page in the frame has no way to
 * set it, and no message of its own is involved.
 *
 * The web has no call that sets a window's zoom back. The one lever is the
 * viewport meta: a `maximum-scale` of 1 makes a browser that honors it clamp the
 * zoom, and the meta goes back at once so pinch keeps working. Chromium honors
 * it. iOS Safari lets people zoom past a page's limits on purpose, so there it
 * is expected to do nothing, and a zoom can stay on the next file; the tools stay
 * tucked there until the person pinches out.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Over this the window counts as zoomed (a pinch that barely moved does not). */
export const PINCH_TUCK_SCALE = 1.05;

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener('resize', onChange);
  viewport.addEventListener('scroll', onChange);
  return () => {
    viewport.removeEventListener('resize', onChange);
    viewport.removeEventListener('scroll', onChange);
  };
}

export function isWindowPinched(): boolean {
  return (window.visualViewport?.scale ?? 1) > PINCH_TUCK_SCALE;
}

const never = () => () => {};

/** Whether the window is zoomed now, and again whenever that changes. Off (`enabled` false): always false, with no listener. */
export function useWindowPinched(enabled: boolean): boolean {
  const read = useCallback(() => enabled && isWindowPinched(), [enabled]);
  return useSyncExternalStore(enabled ? subscribe : never, read, () => false);
}

/** Ask the browser to take a zoomed window back to its full view (see the header for how far that goes). */
export function releaseWindowZoom(): void {
  if (!isWindowPinched()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.content;
  meta.content = `${content}, maximum-scale=1`;
  // Two frames: the browser reads the clamp at its next layout, and pinch comes back right after.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      meta.content = content;
    }),
  );
}
