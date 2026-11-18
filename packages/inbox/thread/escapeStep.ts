/**
 * Escape on an open thread, once nothing inside it used the key (App.tsx's window ladder reads the window's state
 * and acts on the step named here): one layer per press, the top one first, and only then does the thread close.
 *
 *  1. The full-window review holds a Shape board (over it, or as its corner card): Escape closes the board and the
 *     review stays. A review not drawn yet (its thread still reading) closes first, back to the board.
 *  2. The thread canvas (while config.json `inboxCanvas` is on), as an open file's full screen does: full screen goes
 *     back beside the thread, then the canvas closes. On a phone the canvas is a screen of its own: it closes.
 *  3. An open guided review closes, back to its thread; then the Artifacts view, back to the messages (approval
 *     "inbox-thread-artifacts": one more rung before Escape closes the thread).
 *  4. A thread in full screen leaves it (the sidebar and the list come back, the thread stays).
 *  5. The thread closes.
 */
import type { Route } from '../app/route';

export interface ThreadEscapeState {
  /** The full-window review is drawn. */
  reviewPaneOpen: boolean;
  /** The thread is in full screen. */
  threadFull: boolean;
  /** The thread canvas is on (config.json `inboxCanvas`); off, `&canvas` opens the thread alone. */
  canvasOn: boolean;
  /** One screen at a time (phone.ts): the canvas is never beside the thread. */
  phone: boolean;
}

/** A route to go to, or `leave-full`: the thread's own way out of full screen. */
export type ThreadEscapeStep = Route | 'leave-full';

export function threadEscapeStep(now: Route, state: ThreadEscapeState): ThreadEscapeStep {
  if (now.shape && now.guide && !state.reviewPaneOpen) return { ...now, guide: null, guideAt: null };
  if (now.shape) return { ...now, shape: null };
  if (state.canvasOn && now.canvas) return now.canvas.view === 'full' && !state.phone ? { ...now, canvas: { ...now.canvas, view: 'side' } } : { ...now, canvas: null };
  if (!now.guide && !now.artifacts && state.threadFull) return 'leave-full';
  return now.guide ? { ...now, guide: null } : now.artifacts ? { ...now, artifacts: false } : { ...now, thread: null };
}
