import React from 'react';
import { cn } from '../lib/utils';
import { OptionPicker } from './OptionPicker';

// --- Launch-control primitives (ported from the prototype's sidebar) ---

// A labelled config row. Inline (label left, control right) by default; pass
// `stacked` to put a full-width control under the label — used for the model
// dropdown and the effort/reasoning segmented pickers, which need the room.
export function ConfigRow({ label, stacked, children }: { label: string; stacked?: boolean; children: React.ReactNode }) {
  if (stacked) {
    return (
      <div className="space-y-1">
        <span className="block text-[10px] text-muted-foreground/50">{label}</span>
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-[10px] text-muted-foreground/50">{label}</span>
      {children}
    </div>
  );
}

// Pill selector for small option sets (effort, reasoning, thinking).
export function SegmentedPicker({ options, value, onChange }: { options: Array<{ value: string; label: string }>; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-px rounded-lg bg-surface-1/50 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex-1 rounded-md px-2 py-1 font-medium text-[9px] transition-colors',
            value === opt.value
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground/50 hover:text-muted-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// Animated on/off switch (fast mode).
export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-border/50')}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}

export { SEARCHABLE_THRESHOLD, groupModelOptions, labelWithinGroup, type SelectOptionGroup } from './OptionPicker';

export function SelectMenu({ value, options, onChange, icon, placeholder, footerAction }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; icon?: React.ReactNode; placeholder?: string; footerAction?: { label: string; onClick: () => void } }) {
  return <OptionPicker trigger="field" value={value} options={options} onChange={onChange} icon={icon} placeholder={placeholder} footerAction={footerAction} />;
}
