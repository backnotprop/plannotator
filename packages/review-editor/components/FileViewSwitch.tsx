import React from 'react';

export type ChangedFileView = 'changes' | 'whole' | 'original';

const LABELS: Record<ChangedFileView, { label: string; title: string }> = {
  changes: { label: 'Diff', title: 'The diff' },
  whole: { label: 'Current', title: "The whole file at the diff's new side, with change bars" },
  original: { label: 'Original', title: "The whole file at the diff's old side, with the removed lines marked" },
};

export const FileViewSwitch: React.FC<{
  view: ChangedFileView;
  onSelect: (view: ChangedFileView) => void;
  wholeUnavailableReason?: string | null;
  originalUnavailableReason?: string | null;
}> = ({ view, onSelect, wholeUnavailableReason, originalUnavailableReason }) => {
  const segment = (key: ChangedFileView) => {
    const reason = key === 'whole' ? wholeUnavailableReason : key === 'original' ? originalUnavailableReason : null;
    const disabled = !!reason;
    return (
      <button
        key={key}
        type="button"
        data-file-view={key}
        aria-pressed={view === key}
        disabled={disabled}
        title={disabled ? reason ?? undefined : LABELS[key].title}
        onClick={() => onSelect(key)}
        className={`px-2 py-0.5 rounded-sm text-xs whitespace-nowrap transition-colors ${
          view === key ? 'bg-background text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {LABELS[key].label}
      </button>
    );
  };
  return (
    <div className="flex-none flex items-center bg-muted/50 rounded p-0.5 mr-1" role="group" aria-label="File view" data-file-view-switch>
      {segment('changes')}
      {segment('whole')}
      {segment('original')}
    </div>
  );
};
