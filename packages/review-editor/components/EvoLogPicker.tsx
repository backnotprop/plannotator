import React, { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { JjEvoLogEntry } from '@plannotator/shared/types';

interface EvoLogPickerProps {
  entries: JjEvoLogEntry[];
  /** Currently selected evolog commit ID. */
  selectedCommitId: string;
  /** The default commit ID (second evolog entry — previous state). */
  detectedCommitId: string;
  onSelect: (commitId: string) => void;
  disabled?: boolean;
}

/**
 * Picker for jj evolog entries.
 *
 * Shows the evolution history of the current change so the user can pick
 * which previous state to compare against. The newest entry (index 0) is
 * the current `@`; subsequent entries are older states in reverse order.
 */
export const EvoLogPicker: React.FC<EvoLogPickerProps> = ({
  entries,
  selectedCommitId,
  detectedCommitId,
  onSelect,
  disabled,
}) => {
  const [open, setOpen] = useState(false);

  const selected = entries.find((e) => e.commitId === selectedCommitId) ?? entries[1];
  const isCustom = selectedCommitId !== detectedCommitId;

  const handleSelect = (commitId: string) => {
    onSelect(commitId);
    setOpen(false);
  };

  const handleReset = () => {
    onSelect(detectedCommitId);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={`Compare against evolog entry: ${selectedCommitId}`}
          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium overflow-hidden transition-colors focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed ${
            isCustom
              ? 'bg-primary/10 border border-primary/30 text-foreground'
              : 'bg-muted border border-transparent text-foreground'
          }`}
        >
          <span className="text-[10px] uppercase tracking-wide opacity-60 flex-shrink-0">
            from
          </span>
          <span className="truncate flex-1 text-left font-mono">
            {(selected?.commitId ?? selectedCommitId).slice(0, 8)}
          </span>
          {selected?.age && (
            <span className="text-[10px] text-muted-foreground truncate">
              {selected.age}
            </span>
          )}
          <svg
            className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 w-80 bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <div className="px-3 py-2 border-b border-border/50">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Evolution history — pick a previous state to compare against
            </p>
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {entries.map((entry, idx) => {
              const isSelected = entry.commitId === selectedCommitId;
              const isDetected = entry.commitId === detectedCommitId;
              const isCurrent = idx === 0;

              return (
                <button
                  key={entry.commitId}
                  type="button"
                  disabled={isCurrent}
                  onClick={() => !isCurrent && handleSelect(entry.commitId)}
                  className={`w-full flex items-start gap-2 px-3 py-2 text-xs text-left transition-colors focus:outline-none focus:bg-muted ${
                    isCurrent
                      ? 'opacity-40 cursor-default'
                      : 'hover:bg-muted cursor-pointer'
                  } ${isSelected && !isCurrent ? 'text-foreground font-medium' : 'text-foreground/80'}`}
                >
                  <span className="w-3 flex-shrink-0 mt-0.5">
                    {isSelected && !isCurrent && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {entry.commitId.slice(0, 8)}
                    </span>
                    {entry.description && (
                      <span className="block truncate mt-0.5">{entry.description}</span>
                    )}
                  </span>
                  <span className="flex-shrink-0 flex flex-col items-end gap-1 max-w-[40%]">
                    {entry.age && (
                      <span className="text-[10px] text-muted-foreground truncate max-w-full">
                        {entry.age}
                      </span>
                    )}
                    <span className="flex gap-1">
                      {isCurrent && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 py-0.5 rounded bg-muted">
                          current
                        </span>
                      )}
                      {isDetected && !isCurrent && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 py-0.5 rounded bg-muted">
                          default
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {isCustom && (
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={handleReset}
                className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
              >
                Reset to default ({detectedCommitId.slice(0, 8)})
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
