import React from 'react';
import type { TreeScope } from '../hooks/useTreeScope';

const formatCount = (count: number) => count.toLocaleString('en-US');

/**
 * Changes | All files, at the top of the Tree view (approved design record
 * "review-explorer"). Changes is today's tree; All files is the whole
 * repository at the diff's new side. The count of All files shows once the
 * repository has been listed (it is never listed for a review that stays on
 * Changes).
 */
export const TreeScopeSwitch: React.FC<{
  scope: TreeScope;
  onSelect: (scope: TreeScope) => void;
  changedCount: number;
  /** Files in the repository, once known. */
  allCount?: number;
}> = ({ scope, onSelect, changedCount, allCount }) => {
  const segment = (key: TreeScope, label: string, count: number | undefined, title: string) => (
    <button
      type="button"
      onClick={() => onSelect(key)}
      className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-1 py-1 rounded-sm text-xs leading-none whitespace-nowrap transition-colors ${
        scope === key ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
      }`}
      title={title}
      aria-pressed={scope === key}
      data-tree-scope={key}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className={`tabular-nums font-mono text-[11px] ${scope === key ? 'text-primary' : 'text-muted-foreground/70'}`}>
          {formatCount(count)}
        </span>
      )}
    </button>
  );
  return (
    <div className="flex w-full items-center bg-muted/50 rounded p-0.5" role="group" aria-label="Files shown in the tree">
      {segment('changes', 'Changes', changedCount, 'The files this review changes')}
      {segment('all', 'All files', allCount, 'Every file of the repository at the revision the diff reads')}
    </div>
  );
};
