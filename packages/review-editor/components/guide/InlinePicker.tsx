import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { groupModelOptions, labelWithinGroup, SEARCHABLE_THRESHOLD } from '@plannotator/ui/components/AgentControls';

export type InlinePickerOption = { value: string; label: string };

/** Inline "Label: Value ▾" picker — the wireframe's compact select pill.
 *  Long catalogs (marker-engine model lists can run to hundreds) automatically
 *  gain a type-to-filter input, a wider popover, and provider group headers. */
export function InlinePicker({
  label,
  value,
  options,
  onChange,
  escapeClosesOnlyList = false,
  plainGroupLabels = false,
}: {
  label: string;
  value: string;
  options: InlinePickerOption[];
  onChange: (v: string) => void;
  /** For a picker inside a dialog: Escape on an open list closes the list and nothing behind it. */
  escapeClosesOnlyList?: boolean;
  /** Group headings as the ids write them, with no capitals or wide tracking. */
  plainGroupLabels?: boolean;
}) {
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

  return (
    <div
      className="relative"
      onKeyDown={(e) => {
        if (!escapeClosesOnlyList || e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex items-center gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-border"
      >
        <span className="text-muted-foreground">{label}:</span>
        <span className="max-w-[260px] truncate text-foreground">{current?.label ?? value}</span>
        <ChevronDown className={`text-muted-foreground/40 transition-transform ${open ? 'rotate-180' : ''}`} size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className={`absolute left-0 top-full z-20 mt-1 rounded-lg border border-border/50 bg-popover shadow-xl ${
              searchable ? 'w-[340px]' : 'min-w-[140px]'
            }`}
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
                      if (escapeClosesOnlyList) e.preventDefault();
                      close();
                    }
                    if (e.key === 'Enter' && filtered.length > 0) select(filtered[0].value);
                  }}
                  placeholder="Type to filter…"
                  className="w-full rounded-md border border-border/40 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-border"
                />
              </div>
            )}
            <div className={`overflow-y-auto p-1 ${searchable ? 'max-h-80' : 'max-h-56'}`}>
              {filtered.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/50">No matches</div>
              )}
              {grouped.map((group) => (
                <React.Fragment key={group.label ?? '__flat'}>
                  {group.label && (
                    <div className={plainGroupLabels ? 'px-2.5 pb-0.5 pt-1.5 text-[11px] text-muted-foreground' : 'px-2.5 pb-0.5 pt-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/40'}>
                      {group.label}
                    </div>
                  )}
                  {group.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => select(o.value)}
                      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        value === o.value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{labelWithinGroup(o.label, group.label)}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
