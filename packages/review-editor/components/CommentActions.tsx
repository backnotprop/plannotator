import React from 'react';
import { CopyButton } from './CopyButton';

interface CommentActionsProps {
  /** When provided, shows the edit button (left-most). */
  onEdit?: () => void;
  /** When provided, shows the copy button (middle). */
  copyText?: string;
  /** When provided, shows the delete/close button (right-most). Omitted for
   *  read-only (e.g. externally-sourced) comments. */
  onDelete?: () => void;
}

const ACTION_BTN = 'p-1 rounded text-muted-foreground transition-colors';

/**
 * The single hover-revealed action row shared by every comment card (inline
 * diff, sidebar, file banner). Bottom-aligned, right-justified, order
 * left→right: edit · copy · delete (so the close/delete sits furthest right).
 * The parent card must carry the Tailwind `group` class for the hover reveal.
 */
export const CommentActions: React.FC<CommentActionsProps> = ({ onEdit, copyText, onDelete }) => {
  if (!onEdit && !copyText && !onDelete) return null;
  return (
  <div
    className="flex items-center justify-end gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
    onClick={(e) => e.stopPropagation()}
  >
    {onEdit && (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className={`${ACTION_BTN} hover:bg-muted hover:text-foreground`}
        title="Edit"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
    )}
    {copyText && <CopyButton text={copyText} variant="inline" />}
    {onDelete && (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className={`${ACTION_BTN} hover:bg-destructive/10 hover:text-destructive`}
        title="Delete"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    )}
  </div>
  );
};
