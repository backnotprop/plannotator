import React from 'react';
import { createPortal } from 'react-dom';
import { useVisibleViewportBounds, hasPrimaryCoarsePointer } from '@plannotator/ui/hooks/useViewportEnvironment';
import { placeChooser, readSelectedLines, type SelectedLinesBox, type SelectionRange } from './selectionChooserPlace';

/** Selected lines, as a host's selection action receives them. */
export interface DiffSelection {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
}

/**
 * A host's choices for selected lines, before the comment box (the Inbox's
 * code review: Comment · Ask · Show me). Absent: a selection opens the comment
 * box at once, as always.
 */
export interface DiffSelectionActions {
  /** Ask about the lines in words. Absent: no Ask. */
  onAsk?: (selection: DiffSelection) => void;
  /** Ask for a picture of the lines (offered on the new side only: added or unchanged lines). Absent: no Show me. */
  onShowMe?: (selection: DiffSelection) => void;
}

/** How long a new selection gets to be painted before the bar makes do with what it can read. */
const LOOK_FRAMES = 6;

/**
 * The small row a selection opens first when a host passes selection actions.
 * It takes the toolbar's ref, so a press outside it or Escape dismisses it
 * exactly as the comment box is dismissed (no new keys). It sits by the lines
 * it is about (`placeChooser`) and stays with them; while it is open the diff's
 * + mark steps aside (comments.css, usePierreTheme).
 */
export function SelectionChooser({
  toolbarRef,
  position,
  range,
  actions,
  onComment,
  onAsk,
  onShowMe,
}: {
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  position: { top: number; left: number };
  range: SelectionRange;
  actions: DiffSelectionActions;
  onComment: () => void;
  onAsk: () => void;
  onShowMe: () => void;
}) {
  const bounds = useVisibleViewportBounds(hasPrimaryCoarsePointer() ? 16 : 0);
  const [lines, setLines] = React.useState<SelectedLinesBox | null>(null);
  const [bar, setBar] = React.useState({ width: 0, height: 0 });
  const [looked, setLooked] = React.useState(false);
  const { start, end, side, endSide } = range;
  // Every frame while it is open, as nothing announces what moves the lines: the diff paints a new selection a
  // frame or two late and redraws its rows after a scroll has ended. A diff that dropped them leaves it where it was.
  React.useLayoutEffect(() => {
    const now = { start, end, side, endSide };
    let frames = 0;
    let id = 0;
    const look = () => {
      const waiting = frames < LOOK_FRAMES;
      const found = readSelectedLines(now, position, waiting);
      const el = toolbarRef.current;
      if (el) setBar((was) => (was.width === el.offsetWidth && was.height === el.offsetHeight ? was : { width: el.offsetWidth, height: el.offsetHeight }));
      if (found) setLines((was) => (was && was.top === found.top && was.bottom === found.bottom && was.left === found.left ? was : found));
      if (found || !waiting) setLooked(true);
      frames += 1;
      id = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(id);
  }, [start, end, side, endSide, position, toolbarRef]);
  // No lines to read: above the pointer where they were picked, never off the screen.
  const placed: React.CSSProperties = lines
    ? placeChooser(lines, bar, bounds)
    : {
        top: Math.max(bounds.top + 8, Math.min(position.top - 66, bounds.bottom - 52)),
        left: Math.max(bounds.left + 8, Math.min(position.left, bounds.right - 8)),
        transform: 'translateX(-50%)',
      };
  const content = (
    <div
      ref={toolbarRef}
      className="review-selpop"
      role="toolbar"
      aria-label="Selected lines"
      data-selection-chooser=""
      style={{ position: 'fixed', ...placed, zIndex: 1000, ...(looked ? {} : { visibility: 'hidden' as const }) }}
    >
      <button type="button" className="review-selpop-btn" onClick={onComment} data-selection-action="comment">
        Comment
      </button>
      {actions.onAsk && (
        <button type="button" className="review-selpop-btn" onClick={onAsk} data-selection-action="ask">
          Ask
        </button>
      )}
      {actions.onShowMe && (
        <button type="button" className="review-selpop-btn review-selpop-show" onClick={onShowMe} data-selection-action="show-me">
          Show me
        </button>
      )}
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
