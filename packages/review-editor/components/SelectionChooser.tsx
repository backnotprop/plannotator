import React from 'react';
import { createPortal } from 'react-dom';
import { useVisibleViewportBounds, hasPrimaryCoarsePointer } from '@plannotator/ui/hooks/useViewportEnvironment';

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
  /** Ask for a picture of the lines. Absent: no Show me. */
  onShowMe?: (selection: DiffSelection) => void;
  /** The Show me button's mark (the host's own icon). */
  showMeIcon?: React.ReactNode;
}

const CommentIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const AskIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <path d="M12 17h.01" />
  </svg>
);

/**
 * The small row a selection opens first when a host passes selection actions.
 * It takes the toolbar's ref, so a press outside it or Escape dismisses it
 * exactly as the comment box is dismissed (no new keys).
 */
export function SelectionChooser({
  toolbarRef,
  position,
  actions,
  onComment,
  onAsk,
  onShowMe,
}: {
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  position: { top: number; left: number };
  actions: DiffSelectionActions;
  onComment: () => void;
  onAsk: () => void;
  onShowMe: () => void;
}) {
  const bounds = useVisibleViewportBounds(hasPrimaryCoarsePointer() ? 16 : 0);
  // Above the pointer where the lines were picked, so the lines stay in sight; never off the screen.
  const top = Math.max(bounds.top + 8, Math.min(position.top - 66, bounds.bottom - 52));
  const content = (
    <div
      ref={toolbarRef}
      className="review-selpop"
      role="toolbar"
      aria-label="Selected lines"
      data-selection-chooser=""
      style={{ position: 'fixed', top, left: Math.max(bounds.left + 8, Math.min(position.left, bounds.right - 8)), transform: 'translateX(-50%)', zIndex: 1000 }}
    >
      <button type="button" className="review-selpop-btn" onClick={onComment} data-selection-action="comment">
        <CommentIcon />
        Comment
      </button>
      {actions.onAsk && (
        <button type="button" className="review-selpop-btn" onClick={onAsk} data-selection-action="ask">
          <AskIcon />
          Ask
        </button>
      )}
      {actions.onShowMe && (
        <button type="button" className="review-selpop-btn review-selpop-show" onClick={onShowMe} data-selection-action="show-me">
          {actions.showMeIcon}
          Show me
        </button>
      )}
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
