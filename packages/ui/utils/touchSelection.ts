/**
 * The touch selection bridge. A long press and its handles send no mouseup, so
 * a selection made with a finger is read from `selectionchange` once it rests:
 * in the Markdown viewer (useAnnotationHighlighter) and in the HTML viewer's
 * bridge (bridge-script.ts). The bridge is vendored whole and imports nothing,
 * so it writes these out; bridgeTouchSelection.test.tsx fails if they drift.
 */

/** A screen whose main pointer is a finger. */
export const TOUCH_PRIMARY_QUERY = '(pointer: coarse)';

/** How long a selection rests before the HTML viewer's bridge reports it (it changes nothing on the page). */
export const TOUCH_SELECTION_SETTLE_MS = 400;

/*
 * The Markdown viewer paints its highlight INTO the text (marks around the
 * selected words), under the system's live selection. Done while the person is
 * still selecting, that took the selection away mid-drag: iOS's handles and
 * magnifier went, the drag stopped selecting, and a later highlight replacing
 * the first moved the selection's ends onto other words. So the highlight
 * comes only once the selection is finished, by these rules
 * (`touchHighlightDueAt`):
 *
 * - While a finger is known to be on the screen, never. iOS Safari sends
 *   touchstart/touchmove/touchend (and pointer events) through a long press
 *   that becomes a selection and through a handle drag, and ends them with
 *   touchend when the finger lifts (WebKit's touch recognizer keeps running
 *   beside the text-selection gestures; it cancels touches only for a context
 *   menu preview, scrolling or zooming).
 * - After the finger lifts, a short wait (TOUCH_HIGHLIGHT_LIFT_MS) for the
 *   selection's last change at the lift.
 * - With no lift seen for the selection's changes (a selection changed with no
 *   touch at all, a touch that ended in touchcancel), once it has not changed
 *   for TOUCH_HIGHLIGHT_REST_MS.
 * - A finger whose lift never comes (iOS 27.0 drops the rest of a touch that
 *   starts on a selection handle: the page sees touchstart and nothing more)
 *   stops counting after TOUCH_FINGER_STALE_MS without any touch event.
 */

/**
 * How long a finger's selection stays the same, with no lift seen, before it
 * is highlighted. Long enough to mean "done": in a screen recording of a
 * handle drag on an iPad the finger paused for about 0.4 s between moves
 * while still selecting, so 400 ms took half-made selections. Twice that
 * clears those pauses; a person who has stopped waits under a second.
 */
export const TOUCH_HIGHLIGHT_REST_MS = 800;

/** After a lift, how long the selection stays the same before it is highlighted (iOS settles the selection at the lift). */
export const TOUCH_HIGHLIGHT_LIFT_MS = 150;

/** A finger seen going down, with no touch event since, stops holding the highlight back after this long. */
export const TOUCH_FINGER_STALE_MS = 2000;

export interface TouchHighlightTiming {
  /** A finger is on the screen (a touch or pointer went down and has not ended). */
  fingerDown: boolean;
  /** When a touch or pointer event was last seen (ms, any clock shared with `now`). */
  lastTouchAt: number;
  /** When a finger last lifted (touchend / pointerup leaving none on the screen); null for never. */
  liftAt: number | null;
  /** When the selection last changed. */
  lastChangeAt: number;
}

/**
 * Pure: when the selection may be highlighted, given what the fingers and the
 * selection last did. A time at or before `now` means now.
 */
export function touchHighlightDueAt(state: TouchHighlightTiming): number {
  const { fingerDown, lastTouchAt, liftAt, lastChangeAt } = state;
  const rest = lastChangeAt + TOUCH_HIGHLIGHT_REST_MS;
  if (fingerDown) return Math.max(rest, lastTouchAt + TOUCH_FINGER_STALE_MS);
  // A lift counts for the changes that ended with it: the selection stopped
  // changing no later than just after the finger came up.
  if (liftAt !== null && lastChangeAt <= liftAt + TOUCH_HIGHLIGHT_LIFT_MS) {
    return Math.max(lastChangeAt, liftAt) + TOUCH_HIGHLIGHT_LIFT_MS;
  }
  return rest;
}
