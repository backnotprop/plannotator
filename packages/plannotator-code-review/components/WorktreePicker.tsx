import React, { useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { WorktreeInfo } from '@plannotator/shared/types';

interface WorktreePickerProps {
  worktrees: WorktreeInfo[];
  activeWorktreePath: string | null;
  currentBranch?: string;
  onSelect: (path: string | null) => void;
  disabled?: boolean;
}

const MAIN_REPO = null;

export const WorktreePicker: React.FC<WorktreePickerProps> = ({
  worktrees,
  activeWorktreePath,
  currentBranch,
  onSelect,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const mainLabel = currentBranch || 'Main repo';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return worktrees;
    return worktrees.filter((wt) => {
      const branch = (wt.branch || '').toLowerCase();
      const path = wt.path.toLowerCase();
      return branch.includes(q) || path.includes(q);
    });
  }, [worktrees, query]);

  const mainMatchesQuery = !query.trim() || mainLabel.toLowerCase().includes(query.trim().toLowerCase());

  const handleSelect = (path: string | null) => {
    onSelect(path);
    setOpen(false);
    setQuery('');
  };

  const active = activeWorktreePath
    ? worktrees.find((wt) => wt.path === activeWorktreePath)
    : null;
  const activeLabel = active
    ? (active.branch || active.path.split('/').pop() || 'worktree')
    : mainLabel;
  const isCustom = activeWorktreePath !== null;

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
          title={active ? `Worktree: ${active.path}` : 'Main repository'}
          className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed ${
            isCustom
              ? 'bg-primary/10 border border-primary/30 text-foreground'
              : 'bg-muted border border-transparent text-foreground'
          }`}
        >
          <span className="truncate flex-1 text-left">{activeLabel}</span>
          {isCustom && (
            <span className="text-[10px] uppercase tracking-wide opacity-60 flex-shrink-0">
              worktree
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
          className="z-50 w-72 bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          onOpenAutoFocus={(e) => {
            // Only override Radix's default focus when the search input is
            // actually rendered — otherwise the preventDefault() would leave
            // focus on the trigger, and arrow keys would bubble out to the
            // file-tree nav. For short worktree lists we let Radix focus the
            // first picker button itself.
            if (searchRef.current) {
              e.preventDefault();
              searchRef.current.focus();
            }
          }}
        >
          {worktrees.length > 3 && (
            <div className="p-2 border-b border-border/50">
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search worktrees…"
                className="w-full px-2 py-1.5 bg-muted rounded text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          )}
          <div className="max-h-72 overflow-y-auto py-1">
            {mainMatchesQuery && (
              <WorktreeRow
                label={mainLabel}
                sublabel={null}
                isSelected={activeWorktreePath === MAIN_REPO}
                onClick={() => handleSelect(MAIN_REPO)}
              />
            )}

            {filtered.length > 0 && (
              <>
                {mainMatchesQuery && (
                  <div className="h-px bg-border/50 mx-2 my-1" />
                )}
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  Worktrees
                </div>
                {filtered.map((wt) => (
                  <WorktreeRow
                    key={wt.path}
                    label={wt.branch || wt.path.split('/').pop() || 'worktree'}
                    sublabel={wt.path}
                    isSelected={wt.path === activeWorktreePath}
                    onClick={() => handleSelect(wt.path)}
                  />
                ))}
              </>
            )}

            {!mainMatchesQuery && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No worktrees match.
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

interface WorktreeRowProps {
  label: string;
  sublabel: string | null;
  isSelected: boolean;
  onClick: () => void;
}

const WorktreeRow: React.FC<WorktreeRowProps> = ({ label, sublabel, isSelected, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full flex items-center gap-2 mx-1 px-2 py-1.5 text-xs text-left rounded hover:bg-muted focus:outline-none focus:bg-muted ${
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
    <div className="min-w-0 flex-1">
      <div className="truncate">{label}</div>
      {sublabel && (
        <div className="truncate text-[10px] text-muted-foreground">{sublabel}</div>
      )}
    </div>
  </button>
);
