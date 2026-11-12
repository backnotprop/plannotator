import React from 'react';
import { Tooltip } from './Tooltip';

export const ViewedControl: React.FC<{
  isViewed: boolean;
  onToggle?: () => void;
  name?: string;
  forceVisible?: boolean;
}> = ({ isViewed, onToggle, name }) => (
  <Tooltip content={isViewed ? 'Viewed — click to unmark' : 'Mark as viewed'} side="bottom">
    <span
      role="checkbox"
      aria-checked={isViewed}
      aria-label={name ? (isViewed ? `${name}: viewed, unmark` : `Mark ${name} as viewed`) : isViewed ? 'Viewed — unmark' : 'Mark as viewed'}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onToggle?.();
        }
      }}
      className="w-4 h-4 flex items-center justify-center flex-shrink-0 rounded hover:bg-muted/50 cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
    >
      {isViewed ? (
        <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5 text-muted-foreground opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
    </span>
  </Tooltip>
);

export const CountColumns: React.FC<{
  additions: number;
  deletions: number;
  tone?: 'color' | 'quiet';
  addStyle?: React.CSSProperties;
  delStyle?: React.CSSProperties;
}> = ({ additions, deletions, tone = 'color', addStyle, delStyle }) => (
  <span data-count-columns={tone} className="review-count-columns">
    <span className={additions > 0 ? 'additions' : undefined} style={addStyle}>
      {additions > 0 ? `+${additions}` : ''}
    </span>
    <span className={deletions > 0 ? 'deletions' : undefined} style={delStyle}>
      {deletions > 0 ? `-${deletions}` : ''}
    </span>
  </span>
);

export function countColumnVars(additions: number, deletions: number): React.CSSProperties {
  const width = (n: number) => `calc(${Math.max(3, String(n).length + 1)}ch + 2px)`;
  return { '--count-add-w': width(additions), '--count-del-w': width(deletions) } as React.CSSProperties;
}
