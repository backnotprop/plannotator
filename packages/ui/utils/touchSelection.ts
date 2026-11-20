/**
 * The touch selection bridge. A long press and its handles send no mouseup, so
 * a selection made with a finger is read from `selectionchange` once it rests:
 * in the Markdown viewer (useAnnotationHighlighter) and in the HTML viewer's
 * bridge (bridge-script.ts). The bridge is vendored whole and imports nothing,
 * so it writes these out; bridgeTouchSelection.test.tsx fails if they drift.
 *
 * What the Markdown viewer does with a selection that rests differs from what
 * the bridge does. It paints nothing: the system selection, its handles and its
 * edit menu stay the person's until they tap a button of the selection toolbar
 * shown under it (components/TouchSelectionToolbar), which is what takes the
 * selection.
 */

/** A screen whose main pointer is a finger. */
export const TOUCH_PRIMARY_QUERY = '(pointer: coarse)';

/** How long a selection rests before it is taken (HTML viewer) or offered (Markdown viewer). */
export const TOUCH_SELECTION_SETTLE_MS = 400;

/** The selection toolbar of a resting touch selection: a press on it is not the person changing the selection. */
export const TOUCH_SELECTION_OFFER_SELECTOR = '[data-pn-touch-selection-offer]';
