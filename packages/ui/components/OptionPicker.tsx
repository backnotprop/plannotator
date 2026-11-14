import React, { useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../lib/utils';

export const SEARCHABLE_THRESHOLD = 12;

export interface SelectOptionGroup {
  label: string | null;
  options: Array<{ value: string; label: string; icon?: React.ReactNode }>;
}

export function groupModelOptions(options: Array<{ value: string; label: string; icon?: React.ReactNode }>): SelectOptionGroup[] {
  const slashed = options.filter((o) => o.value.includes('/')).length;
  if (options.length <= SEARCHABLE_THRESHOLD || slashed < options.length / 2) {
    return [{ label: null, options }];
  }
  const groups = new Map<string, Array<{ value: string; label: string; icon?: React.ReactNode }>>();
  for (const o of options) {
    const key = o.value.includes('/') ? o.value.slice(0, o.value.indexOf('/')) : 'other';
    const bucket = groups.get(key);
    if (bucket) bucket.push(o);
    else groups.set(key, [o]);
  }
  return [...groups.entries()].map(([label, opts]) => ({ label, options: opts }));
}

export function labelWithinGroup(label: string, group: string | null): string {
  if (group && label.startsWith(`${group}/`)) return label.slice(group.length + 1);
  return label;
}

export type OptionPickerOption = { value: string; label: string; icon?: React.ReactNode };

export type OptionPickerTrigger = 'pill' | 'field' | 'text';

export interface OptionPickerProps {
  value: string;
  options: OptionPickerOption[];
  onChange: (value: string) => void;
  trigger: OptionPickerTrigger;
  label?: string;
  icon?: React.ReactNode;
  placeholder?: string;
  title?: string;
  side?: 'top' | 'bottom';
  footerAction?: { label: string; onClick: () => void };
  keysStayInList?: boolean;
  plainGroupLabels?: boolean;
}

const TRIGGER: Record<OptionPickerTrigger, string> = {
  pill: 'flex items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-border',
  field: 'flex w-full items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:border-border',
  text: 'flex items-center gap-1 rounded px-1 py-0.5 -mx-1 transition-colors hover:bg-muted/50',
};

export function OptionPicker({
  value,
  options,
  onChange,
  trigger,
  label,
  icon,
  placeholder,
  title,
  side = 'bottom',
  footerAction,
  keysStayInList = false,
  plainGroupLabels = false,
}: OptionPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = options.find((o) => o.value === value);
  const searchable = options.length > SEARCHABLE_THRESHOLD;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
    : options;
  const grouped = groupModelOptions(filtered);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const select = (v: string) => {
    onChange(v);
    close();
  };
  const shown = current?.label ?? (value || placeholder || '');

  return (
    <div
      className={cn('relative', trigger === 'field' && 'w-full')}
      data-option-picker={trigger}
      onKeyDown={(e) => {
        if (!keysStayInList || e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={TRIGGER[trigger]}
      >
        {icon ?? current?.icon}
        {label && <span className="text-muted-foreground">{label}:</span>}
        <span className={cn('truncate', trigger === 'field' ? 'min-w-0 flex-1 text-foreground' : trigger === 'pill' ? 'max-w-[260px] text-foreground' : '')}>{shown}</span>
        <ChevronDown className={cn('shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-180')} size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            role="listbox"
            className={cn(
              'absolute z-20 rounded-lg border border-border bg-popover shadow-lg',
              side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
              trigger === 'field' ? 'left-0 right-0' : 'left-0',
              searchable ? 'min-w-[280px] w-max max-w-[340px]' : 'min-w-[160px]',
            )}
          >
            {searchable && (
              <div className="p-1 pb-0">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                      if (keysStayInList) e.preventDefault();
                      close();
                    }
                    if (e.key === 'Enter' && keysStayInList) e.preventDefault();
                    if (e.key === 'Enter' && filtered.length > 0) select(filtered[0].value);
                  }}
                  placeholder="Type to filter…"
                  className="w-full rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-border"
                />
              </div>
            )}
            <div className={cn('overflow-y-auto p-1', searchable ? 'max-h-80' : 'max-h-56')}>
              {filtered.length === 0 && <div className="px-2.5 py-2 text-xs text-muted-foreground">No matches</div>}
              {grouped.map((group) => (
                <React.Fragment key={group.label ?? '__flat'}>
                  {group.label && (
                    <div className={plainGroupLabels ? 'px-2.5 pb-0.5 pt-1.5 text-xs text-muted-foreground' : 'px-2.5 pb-0.5 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/40'}>
                      {group.label}
                    </div>
                  )}
                  {group.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      role="option"
                      aria-selected={value === o.value}
                      onClick={() => select(o.value)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                        value === o.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      {o.icon}
                      <span className="min-w-0 flex-1 truncate">{labelWithinGroup(o.label, group.label)}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
            {footerAction && (
              <div className="border-t border-border/60 p-1">
                <button
                  type="button"
                  onClick={() => {
                    close();
                    footerAction.onClick();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                >
                  <Plus className="shrink-0" size={11} />
                  {footerAction.label}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
