import type { PaneId } from './model';

export interface PaneOnScreen {
  threadId: string;
  covered: boolean;
}

export interface PanesOnScreen {
  set(paneId: PaneId, state: PaneOnScreen | null): void;
  /** `threadId` is drawn in a pane with nothing over it. */
  shows(threadId: string): boolean;
}

/** Each pane's thread on screen and whether anything covers it (ThreadPane's `onScreenChange`), by pane. */
export function createPanesOnScreen(): PanesOnScreen {
  const byPane = new Map<PaneId, PaneOnScreen>();
  return {
    set(paneId, state) {
      if (state) byPane.set(paneId, state);
      else byPane.delete(paneId);
    },
    shows(threadId) {
      for (const pane of byPane.values()) if (pane.threadId === threadId && !pane.covered) return true;
      return false;
    },
  };
}
