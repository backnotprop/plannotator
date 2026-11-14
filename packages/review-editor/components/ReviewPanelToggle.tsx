import React from 'react';
import { formatShortcutBindingText, getShortcutPlatform, resolveShortcutBindings } from '@plannotator/ui/shortcuts';
import { reviewEditorShortcuts } from '../shortcuts';

export const ReviewPanelToggle: React.FC<{
  isOpen: boolean;
  commentCount: number;
  attention: boolean;
  onToggle: () => void;
}> = ({ isOpen, commentCount, attention, onToggle }) => {
  const binding = resolveShortcutBindings(reviewEditorShortcuts.shortcuts.toggleSidebar)[0];
  const hint = binding ? ` (${formatShortcutBindingText(binding, getShortcutPlatform())})` : '';
  const label = isOpen ? 'Close comments, AI and agents' : 'Open comments, AI and agents';
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      aria-label={label}
      title={`${label}${hint}`}
      data-review-panel-toggle=""
      className={`relative h-7 w-7 flex items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
        isOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      }`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      </svg>
      {commentCount > 0 ? (
        <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground px-0.5 tabular-nums">
          {commentCount > 99 ? '99+' : commentCount}
        </span>
      ) : attention && !isOpen ? (
        <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-primary" aria-hidden="true" />
      ) : null}
    </button>
  );
};
