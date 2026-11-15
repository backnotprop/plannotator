/**
 * The spike's main pane: App's own ThreadPane (the one open thread, its reply box and all its wiring) drawn into the
 * layout's "main" pane through a portal. App keeps rendering it where it always did, so its state and props are App's;
 * only its DOM lands in the pane. With no layout on screen (below the spike's width, or the spike off) it draws in place.
 */
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ThreadPane } from '../components/Thread';
import type { ThreadPaneProps } from '../thread/paneProps';

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setMainSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMainSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

/** The layout shows from 900 px wide; below that the window is today's (the main pane's thread draws in place). */
const WIDE = '(min-width: 900px)';

export function useSpikeWide(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = matchMedia(WIDE);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => matchMedia(WIDE).matches,
    () => true,
  );
}

export function SpikeMainThread(props: ThreadPaneProps) {
  const target = useMainSlot();
  return target ? createPortal(<ThreadPane {...props} />, target) : <ThreadPane {...props} />;
}
