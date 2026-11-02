/**
 * The touch selection bridge. A long press and its handles send no mouseup, so
 * a selection made with a finger is read from `selectionchange` once it rests:
 * in the Markdown viewer (useAnnotationHighlighter) and in the HTML viewer's
 * bridge (bridge-script.ts). The bridge is vendored whole and imports nothing,
 * so it writes these out; bridgeTouchSelection.test.tsx fails if they drift.
 */

/** A screen whose main pointer is a finger. */
export const TOUCH_PRIMARY_QUERY = '(pointer: coarse)';

/** How long a selection rests before it is taken. */
export const TOUCH_SELECTION_SETTLE_MS = 400;
