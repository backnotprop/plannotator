import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { DefaultDiffType } from '@plannotator/shared/config';
import { markDiffTypeSetupDone } from '../utils/diffTypeSetup';
import { configStore } from '../config';
import diffOptionsImg from '../assets/diff-options.png';

const OPTIONS: { value: DefaultDiffType; label: string; description: string }[] = [
  {
    value: 'uncommitted',
    label: 'All Changes',
    description: "Everything you've changed since your last commit — staged and unstaged",
  },
  {
    value: 'unstaged',
    label: 'Unstaged',
    description: "Only changes you haven't staged yet (git diff)",
  },
  {
    value: 'staged',
    label: 'Staged',
    description: "Only changes you've staged for commit (git diff --staged)",
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
  const [imageHovered, setImageHovered] = useState(false);

  const handleDone = () => {
    configStore.set('defaultDiffType', selected);
    markDiffTypeSetupDone();
    onComplete(selected);
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold text-base mb-2">Set Your Default Diff View</h3>
          <p className="text-sm text-muted-foreground">
            Pick which changes you want to see when you open a code review.
          </p>
        </div>

        {/* Body: 60/40 split */}
        <div className="flex gap-5 p-5">
          {/* Left: options (60%) */}
          <div className="flex-[3] space-y-2 min-w-0">
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

          {/* Right: image preview + hint (40%) */}
          <div className="flex-[2] flex flex-col items-center justify-center min-w-0">
            <div
              className="relative cursor-zoom-in"
              onMouseEnter={() => setImageHovered(true)}
              onMouseLeave={() => setImageHovered(false)}
            >
              <img
                src={diffOptionsImg}
                alt="Diff type dropdown in the toolbar"
                className="w-full rounded-lg shadow-sm"
                style={{
                  border: `2px solid ${imageHovered ? 'var(--primary)' : 'color-mix(in srgb, var(--primary) 30%, transparent)'}`,
                  transform: imageHovered ? 'scale(1.65)' : 'scale(1)',
                  zIndex: imageHovered ? 50 : 0,
                  position: 'relative',
                  transition: 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.2s ease',
                }}
              />
              {!imageHovered && (
                <div className="absolute inset-0 flex items-end justify-center pb-1.5 pointer-events-none">
                  <span className="text-[9px] text-muted-foreground/60 bg-background/80 px-1.5 py-0.5 rounded">
                    hover to preview
                  </span>
                </div>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground text-center leading-relaxed mt-3">
              You can switch views anytime during a review using this dropdown in the toolbar.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 pb-4 flex justify-end">
          <button
            onClick={handleDone}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
