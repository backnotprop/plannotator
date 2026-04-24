import React, { useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { AvailableBranches } from '@plannotator/shared/types';

interface BaseBranchPickerProps {
  availableBranches: AvailableBranches;
  selectedBase: string;
  detectedBase: string;
  onSelectBase: (branch: string) => void;
  disabled?: boolean;
}

export const BaseBranchPicker: React.FC<BaseBranchPickerProps> = ({
  availableBranches,
  selectedBase,
  detectedBase,
  onSelectBase,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const { local, remote } = availableBranches;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { local, remote };
    return {
      local: local.filter((b) => b.toLowerCase().includes(q)),
      remote: remote.filter((b) => b.toLowerCase().includes(q)),
    };
  }, [local, remote, query]);

  const handleSelect = (branch: string) => {
    onSelectBase(branch);
    setOpen(false);
    setQuery('');
  };

  const handleReset = () => {
    onSelectBase(detectedBase);
    setOpen(false);
    setQuery('');
  };

  const isCustom = selectedBase !== detectedBase;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={`Review base: ${selectedBase}`}
          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed ${
            isCustom
              ? 'bg-primary/10 border border-primary/30 text-foreground'
              : 'bg-muted border border-transparent text-foreground'
          }`}
        >
          <span className="text-[10px] uppercase tracking-wide opacity-60 flex-shrink-0">
            base
          </span>
          <span className="truncate flex-1 text-left">{selectedBase}</span>
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
          className="z-50 w-72 bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <div className="p-2 border-b border-border/50">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search branches…"
              className="w-full px-2 py-1.5 bg-muted rounded text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {filtered.local.length === 0 && filtered.remote.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No branches match.
              </div>
            )}
            {filtered.local.length > 0 && (
              <BranchGroup
                title="Local"
                branches={filtered.local}
                selectedBase={selectedBase}
                detectedBase={detectedBase}
                onSelect={handleSelect}
              />
            )}
            {filtered.remote.length > 0 && (
              <BranchGroup
                title="Remote"
                branches={filtered.remote}
                selectedBase={selectedBase}
                detectedBase={detectedBase}
                onSelect={handleSelect}
              />
            )}
          </div>
          {isCustom && (
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={handleReset}
                className="w-full text-left px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded"
              >
                Reset to detected ({detectedBase})
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

interface BranchGroupProps {
  title: string;
  branches: string[];
  selectedBase: string;
  detectedBase: string;
  onSelect: (branch: string) => void;
}

const BranchGroup: React.FC<BranchGroupProps> = ({
  title,
  branches,
  selectedBase,
  detectedBase,
  onSelect,
}) => (
  <div className="py-1">
    <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {title}
    </div>
    {branches.map((branch) => {
      const isSelected = branch === selectedBase;
      const isDetected = branch === detectedBase;
      return (
        <button
          key={branch}
          type="button"
          onClick={() => onSelect(branch)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-muted focus:outline-none focus:bg-muted ${
            isSelected ? 'text-foreground font-medium' : 'text-foreground/80'
          }`}
        >
          <span className="w-3 flex-shrink-0">
            {isSelected && (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </span>
          <span className="truncate flex-1">{branch}</span>
          {isDetected && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-1 py-0.5 rounded bg-muted">
              detected
            </span>
          )}
        </button>
      );
    })}
  </div>
);
