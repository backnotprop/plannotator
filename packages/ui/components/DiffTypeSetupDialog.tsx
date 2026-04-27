import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { DefaultDiffType } from '@plannotator/shared/config';
import { markDiffTypeSetupDone } from '../utils/diffTypeSetup';
import { configStore } from '../config';

const OPTIONS: { value: DefaultDiffType; label: string; description: string }[] = [
  {
    value: 'unstaged',
    label: 'Unstaged',
    description: "Only changes you haven't staged yet",
  },
  {
    value: 'uncommitted',
    label: 'All Changes',
    description: "Everything you've changed since your last commit",
  },
  {
    value: 'staged',
    label: 'Staged',
    description: "Only changes you've staged for commit",
  },
  {
    value: 'merge-base',
    label: 'Committed',
    description: "Everything you've committed on this branch",
  },
];

interface DiffTypeSetupDialogProps {
  onComplete: (selected: DefaultDiffType) => void;
}

export const DiffTypeSetupDialog: React.FC<DiffTypeSetupDialogProps> = ({
  onComplete,
}) => {
  const [selected, setSelected] = useState<DefaultDiffType>(
    () => configStore.get('defaultDiffType')
  );

  const handleDone = () => {
    configStore.set('defaultDiffType', selected);
    markDiffTypeSetupDone();
    onComplete(selected);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold text-base mb-2">Default Diff View</h3>
          <p className="text-sm text-muted-foreground">
            Choose which changes to show when you open a code review.
            You can always switch between views during a session.
          </p>
        </div>

        {/* Options */}
        <div className="p-4 space-y-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSelected(opt.value)}
              className={`w-full flex items-start gap-3 p-3 rounded-lg border transition-colors text-left ${
                selected === opt.value
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${
                selected === opt.value ? 'border-primary' : 'border-muted-foreground/40'
              }`}>
                {selected === opt.value && (
                  <div className="w-2 h-2 rounded-full bg-primary" />
                )}
              </div>
              <div>
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-muted-foreground">{opt.description}</div>
              </div>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center gap-3">
          <p className="text-[10px] text-muted-foreground/70 flex-1">
            You can change this later in Settings &gt; Git.
          </p>
          <button
            onClick={handleDone}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity flex-shrink-0"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
