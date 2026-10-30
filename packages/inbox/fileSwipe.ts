/**
 * A phone's swipe between a thread's files (approval "mobile-file-stepping",
 * toolbar-swipe, 2026-10-25; images: approval "inbox-image-swipe",
 * 2026-10-28; neither mock is in this repo): with a file open full screen on
 * a phone, a horizontal one-finger swipe over the file steps to the previous
 * or next file. The file follows the finger and a small "Next · name" card
 * shows where the next file comes from (an image beside an image: the next
 * image itself peeks in, `SWIPE_PEEK_GAP` away); past a third of the width,
 * or on a flick, it steps; short of that it springs back. At the first and
 * last file it resists and, released far enough, says "Last file in this
 * thread" (the pane's end note). Under reduced motion nothing follows the
 * finger: the step happens on release.
 *
 * The gesture itself lives in ui (`@plannotator/ui/hooks/useSwipeStep`,
 * moved there unchanged so ui's lightbox steps the same way); this module
 * keeps the Inbox's names for it and decides which files take it.
 *
 * Which files take the swipe (`fileSwipeMode`): documents, plain text, code,
 * PDFs, the download card and images follow the finger here (an image at
 * Fit; a zoomed image or a panorama pans first, and steps once it is at its
 * edge that way, the pane's `keeps`); HTML pages, diagrams (the canvas pans)
 * and videos (native controls) take every touch themselves, so they get no
 * swipe.
 *
 * What the finger is on decides too (`sidewaysOwner`): a block that still
 * scrolls sideways in the swipe's direction (a wide code line, a table,
 * Pierre's code scroller inside its shadow root), a field, a video, the
 * diagram canvas or a frame keeps the touch. Selected text keeps it, and so
 * does a second finger. The swipe is decided once the finger has moved
 * `SWIPE_DECIDE_PX`, and only when it moves `SWIPE_RATIO` times more sideways
 * than up or down, so scrolling a document is never taken.
 *
 * The files a swipe cannot step (HTML pages, and code that scrolls sideways)
 * step through the sheet the toolbar's pill opens: its ‹ Previous and Next ›
 * (the owner's answer; no floating tabs), shown for every file
 * (AttachmentStepper.tsx `FilePeek`'s `onStep`).
 */

import type { InboxAttachmentKind } from '@plannotator/core/inbox-types';
import { sidewaysOwner as uiSidewaysOwner, useSwipeStep, type SwipeDir, type SwipeStep, type SwipeStepOptions } from '@plannotator/ui/hooks/useSwipeStep';

export {
  SWIPE_COMMIT_SHARE,
  SWIPE_DECIDE_PX,
  SWIPE_DISMISS_FADE_SHARE,
  SWIPE_DISMISS_SHARE,
  SWIPE_END_RESIST,
  SWIPE_FLICK_MIN_PX,
  SWIPE_FLICK_SPEED,
  SWIPE_HANDOFF_MAX_MS,
  SWIPE_PEEK_GAP,
  SWIPE_RATIO,
  SWIPE_SLIDE_MS,
  SWIPE_SPRING_MS,
  decideSwipe,
  dismissCommits,
  isDragDown,
  prefersReducedMotion,
  swipeCommits,
  swipeDirOf,
  useSwipePhase,
  useSwipeProgress,
  type SwipeDir,
  type SwipeProgress,
} from '@plannotator/ui/hooks/useSwipeStep';

/** How a file takes a sideways swipe: follows the finger here, or none. */
export type FileSwipeMode = 'follow' | 'none';

export function fileSwipeMode(kind: InboxAttachmentKind, tooLarge: boolean): FileSwipeMode {
  // A text file too large to show is the download card: it follows the finger like any card.
  if (tooLarge) return 'follow';
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'code':
    case 'pdf':
    case 'file':
    // An image at Fit follows the finger too (approval "inbox-image-swipe"); zoomed, it pans to its edge first.
    case 'image':
      return 'follow';
    // HTML pages take every touch inside their frame; the diagram canvas pans; a video has native controls.
    case 'html':
    case 'mermaid':
    case 'graphviz':
    case 'video':
      return 'none';
  }
}

export type FileSwipe = SwipeStep;
export type FileSwipeOptions = Omit<SwipeStepOptions, 'owners'>;

/**
 * What keeps a touch in the Inbox beyond ui's list: the diagram canvas pans with one finger (ui names no Inbox
 * surface, so the pane adds it), and the comments panel beside the file is its own (the pane's swipe listens on
 * the body around the file).
 */
const FILE_TOUCH_OWNERS = '[data-diagram-canvas], .ib-apanel';

/** Why a touch is not the swipe's (ui's `sidewaysOwner`, the diagram canvas included). */
export function sidewaysOwner(path: readonly EventTarget[], dir: SwipeDir): 'owner' | 'sideways' | null {
  return uiSidewaysOwner(path, dir, FILE_TOUCH_OWNERS);
}

/** The pane's swipe on its `.ib-docarea` (ui's `useSwipeStep`, the diagram canvas keeping its touches). */
export function useFileSwipe(area: Parameters<typeof useSwipeStep>[0], options: FileSwipeOptions): FileSwipe {
  return useSwipeStep(area, { ...options, owners: FILE_TOUCH_OWNERS });
}
