import React from 'react';
import type { EditableDocumentSaveStatus } from '../editableDocuments';

interface CompactEditControlsProps {
  documentTitle: string;
  sourceBacked: boolean;
  saveStatus: EditableDocumentSaveStatus | undefined;
  cancelMode: boolean;
  confirmDiscard: boolean;
  onSave: () => void;
  onExit: () => void;
}

/** Normal-flow mobile editing chrome. It deliberately avoids sticky/fixed
 * placement so the Plan keeps the page-scrolling Safari behavior. */
export const CompactEditControls: React.FC<CompactEditControlsProps> = ({
  documentTitle,
  sourceBacked,
  saveStatus,
  cancelMode,
  confirmDiscard,
  onSave,
  onExit,
}) => {
  const saving = saveStatus === 'saving';
  const saveFailed = saveStatus === 'conflict' || saveStatus === 'error';
  const canSave = sourceBacked && saveStatus !== 'clean' && saveStatus !== 'saved';
  const saveLabel = saving
    ? 'Saving…'
    : saveFailed
      ? 'Retry save'
      : saveStatus === 'missing'
        ? 'Recreate file'
        : canSave
          ? 'Save'
          : 'Saved';
  const exitLabel = cancelMode
    ? (confirmDiscard ? 'Discard changes' : 'Cancel')
    : 'Done';

  return (
    <div
      data-pn-compact-edit-controls="true"
      className="mb-3 flex w-full items-center gap-2 rounded-xl border border-border/60 bg-card/95 p-1.5 shadow-sm"
    >
      <div className="min-w-0 flex-1 px-2">
        <span className="block truncate text-sm font-medium text-foreground">Editing {documentTitle}</span>
        <span className="block text-[11px] leading-4 text-muted-foreground">
          {sourceBacked ? 'Save writes to the source file' : 'Done adds this edit to your feedback'}
        </span>
      </div>
      {sourceBacked && (
        <button
          type="button"
          data-pn-touch-target
          onClick={onSave}
          disabled={saving || !canSave}
          className={`shrink-0 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 ${
            saveFailed
              ? 'bg-destructive/10 text-destructive'
              : canSave
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {saveLabel}
        </button>
      )}
      <button
        type="button"
        data-pn-touch-target
        onClick={onExit}
        className={`shrink-0 rounded-lg px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 ${
          confirmDiscard
            ? 'bg-destructive text-destructive-foreground'
            : cancelMode
              ? 'bg-muted text-foreground'
              : 'bg-success text-success-foreground'
        }`}
      >
        {exitLabel}
      </button>
    </div>
  );
};
