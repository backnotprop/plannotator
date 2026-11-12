import React from 'react';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import { CopyButton } from './CopyButton';

interface CommentActionsProps {
  onEdit?: () => void;
  onExplain?: () => void;
  explainDisabled?: boolean;
  copyText?: string;
  onDelete?: () => void;
  selected?: boolean;
}

const ACTION_BTN = 'p-1 rounded text-muted-foreground transition-colors';

export const CommentActions: React.FC<CommentActionsProps> = ({ onEdit, onExplain, explainDisabled = false, copyText, onDelete, selected = false }) => {
  if (!onEdit && !onExplain && !copyText && !onDelete) return null;
  return (
  <div
    className={`flex items-center justify-end gap-1 mt-1.5 transition-opacity ${
      selected
        ? 'opacity-100'
        : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
    }`}
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
    {onExplain && <ExplainButton onExplain={onExplain} disabled={explainDisabled} />}
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

export const ExplainButton: React.FC<{ onExplain: () => void; disabled?: boolean }> = ({ onExplain, disabled = false }) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onExplain(); }}
    disabled={disabled}
    className={`${ACTION_BTN} hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40`}
    title="Explain finding"
    aria-label="Explain finding"
  >
    <SparklesIcon className="w-3 h-3" />
  </button>
);
