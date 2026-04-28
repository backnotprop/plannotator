import React, { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import type { DiffOption } from '@plannotator/shared/types';

interface DiffTypePickerProps {
  options: DiffOption[];
  activeDiffType: string;
  onSelect: (diffType: string) => void;
  isLoading?: boolean;
  hasBasePicker: boolean;
}

/**
 * Plain-English explanations shown in a tooltip next to each option.
 * Keep these short — they're hover hints, not docs.
 */
const OPTION_HINTS: Record<string, string> = {
  uncommitted: "All your local changes — anything you haven't committed yet.",
  staged: "Only what you've run `git add` on.",
  unstaged: "What `git diff` shows with no arguments.",
  'last-commit': "Just your most recent commit.",
  branch: "Straight compare against the base branch (picked below). Can show commits that aren't yours if the base has new commits.",
  'merge-base': "Only what you've added on top of the base branch (picked below). Same as GitHub's PR view.",
};

export const DiffTypePicker: React.FC<DiffTypePickerProps> = ({
  options,
  activeDiffType,
  onSelect,
  isLoading,
  hasBasePicker,
}) => {
  const [open, setOpen] = useState(false);

  // When a base picker is wired up, strip branch names from the
  // base-dependent labels — the branch belongs in the picker.
  const displayLabel = (opt: DiffOption) => {
    if (!hasBasePicker) return opt.label;
    if (opt.id === 'merge-base') return 'Committed changes';
    return opt.label;
  };

  const active = options.find((o) => o.id === activeDiffType);
  const activeLabel = active ? displayLabel(active) : 'Select diff';

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={isLoading}
          className="w-full flex items-center gap-1.5 px-2.5 py-1.5 bg-muted rounded text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-wait"
        >
          <span className="truncate flex-1 text-left">{activeLabel}</span>
          {isLoading ? (
            <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-dropdown-menu-trigger-width)] bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden py-1 origin-[var(--radix-dropdown-menu-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          {options.map((opt) => {
            const hint = OPTION_HINTS[opt.id];
            const isActive = opt.id === activeDiffType;
            return (
              <DropdownMenu.Item
                key={opt.id}
                onSelect={() => onSelect(opt.id)}
                className={`flex items-center gap-2 mx-1 px-2 py-1.5 text-xs rounded cursor-pointer outline-none data-[highlighted]:bg-muted ${
                  isActive ? 'text-foreground font-medium' : 'text-foreground/80'
                }`}
              >
                <span className="w-3 flex-shrink-0">
                  {isActive && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span className="truncate flex-1">{displayLabel(opt)}</span>
                {hint && (
                  <Tooltip content={hint} side="right" delayDuration={200} wide>
                    <span
                      className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                      onPointerDown={(e) => e.stopPropagation()}
                      onPointerUp={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Heroicons information-circle (outline) */}
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                      </svg>
                    </span>
                  </Tooltip>
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
