import React from 'react';

export type ChangedFileView = 'changes' | 'whole';

/**
 * Changes | Whole file, in a changed file's header (approved design record
 * "review-explorer", step 2). Changes is the diff; Whole file is the new side,
 * every line, with change bars in the gutter.
 */
export const FileViewSwitch: React.FC<{
  view: ChangedFileView;
  onSelect: (view: ChangedFileView) => void;
  /** Why Whole file cannot be shown (static patch, deleted file). */
  wholeUnavailableReason?: string | null;
}> = ({ view, onSelect, wholeUnavailableReason }) => {
  const segment = (key: ChangedFileView, label: string) => {
    const disabled = key === 'whole' && !!wholeUnavailableReason;
    return (
      <button
        type="button"
        data-file-view={key}
        aria-pressed={view === key}
        disabled={disabled}
        title={disabled ? wholeUnavailableReason ?? undefined : key === 'whole' ? 'The whole file at the diff\'s new side, with change bars' : 'The diff'}
        onClick={() => onSelect(key)}
        className={`px-2 py-0.5 rounded-sm text-xs whitespace-nowrap transition-colors ${
          view === key ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="flex-none flex items-center bg-muted/50 rounded p-0.5 mr-1" role="group" aria-label="File view" data-file-view-switch>
      {segment('changes', 'Changes')}
      {segment('whole', 'Whole file')}
    </div>
  );
};
