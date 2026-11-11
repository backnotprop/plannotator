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

export type FileSwipeMode = 'follow' | 'none';

export function fileSwipeMode(kind: InboxAttachmentKind, tooLarge: boolean): FileSwipeMode {
  if (tooLarge) return 'follow';
  switch (kind) {
    case 'markdown':
    case 'text':
    case 'code':
    case 'pdf':
    case 'file':
    case 'image':
      return 'follow';
    case 'html':
    case 'mermaid':
    case 'graphviz':
    case 'video':
    case 'audio':
      return 'none';
  }
}

export type FileSwipe = SwipeStep;
export type FileSwipeOptions = Omit<SwipeStepOptions, 'owners'>;

const FILE_TOUCH_OWNERS = '[data-diagram-canvas], .ib-apanel';

export function sidewaysOwner(path: readonly EventTarget[], dir: SwipeDir): 'owner' | 'sideways' | null {
  return uiSidewaysOwner(path, dir, FILE_TOUCH_OWNERS);
}

export function useFileSwipe(area: Parameters<typeof useSwipeStep>[0], options: FileSwipeOptions): FileSwipe {
  return useSwipeStep(area, { ...options, owners: FILE_TOUCH_OWNERS });
}
