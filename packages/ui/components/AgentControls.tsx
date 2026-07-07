import React, { useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '../lib/utils';

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

// Pill selector for small option sets (effort, reasoning, tour engine).
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

// Lists longer than this get a type-to-filter input and provider grouping —
// marker-engine catalogs (Cursor ~150, Pi ~59, OpenCode ~25) are unusable as a
// flat list; the classic Claude/Codex catalogs (7–11) stay a plain menu.
// Exported so other pickers over the same catalogs (e.g. GuideEmptyState's
// InlinePicker in review-editor) share this one threshold instead of hardcoding it.
export const SEARCHABLE_THRESHOLD = 12;

export interface SelectOptionGroup {
  /** null = ungrouped (single flat list). */
  label: string | null;
  options: Array<{ value: string; label: string }>;
}

/** Group `provider/model`-shaped option lists by their provider prefix.
 *  Returns one ungrouped bucket when the list is small or ids aren't
 *  provider-prefixed (Claude aliases, Codex models, Cursor ids). */
export function groupModelOptions(options: Array<{ value: string; label: string }>): SelectOptionGroup[] {
  const slashed = options.filter((o) => o.value.includes('/')).length;
  if (options.length <= SEARCHABLE_THRESHOLD || slashed < options.length / 2) {
    return [{ label: null, options }];
  }
  const groups = new Map<string, Array<{ value: string; label: string }>>();
  for (const o of options) {
    const key = o.value.includes('/') ? o.value.slice(0, o.value.indexOf('/')) : 'other';
    const bucket = groups.get(key);
    if (bucket) bucket.push(o);
    else groups.set(key, [o]);
  }
  return [...groups.entries()].map(([label, opts]) => ({ label, options: opts }));
}

/** Strip a redundant `group/` prefix from an option label rendered under its
 *  group header (e.g. "anthropic/claude-sonnet-4-6" under "anthropic"). */
export function labelWithinGroup(label: string, group: string | null): string {
  if (group && label.startsWith(`${group}/`)) return label.slice(group.length + 1);
  return label;
}

// Dropdown button + downward popover. Reused for the provider selector and the
// model picker (whose 7–9 options rule out a segmented control). The popover
// opens downward (`top-full`) because the launch panel is pinned to the top of
// the tab. Long catalogs automatically gain a filter input + provider grouping.
export function SelectMenu({ value, options, onChange, icon, placeholder, footerAction }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; icon?: React.ReactNode; placeholder?: string; footerAction?: { label: string; onClick: () => void } }) {
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
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-1/50"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/80">{current?.label ?? placeholder}</span>
        <ChevronDown className={cn('shrink-0 text-muted-foreground/30 transition-transform', open && 'rotate-180')} size={10} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className={cn(
              'absolute right-0 top-full left-0 z-20 mt-1 rounded-xl bg-card shadow-[var(--card-shadow)] ring-1 ring-border/20',
              searchable && 'min-w-[240px]',
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
                    if (e.key === 'Escape') close();
                    if (e.key === 'Enter' && filtered.length > 0) select(filtered[0].value);
                  }}
                  placeholder="Type to filter…"
                  className="w-full rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-border/60"
                />
              </div>
            )}
            <div className={cn('overflow-y-auto p-1', searchable ? 'max-h-72' : 'max-h-56')}>
              {filtered.length === 0 && (
                <div className="px-2.5 py-2 text-[11px] text-muted-foreground/50">No matches</div>
              )}
              {grouped.map((group) => (
                <React.Fragment key={group.label ?? '__flat'}>
                  {group.label && (
                    <div className="px-2.5 pb-0.5 pt-1.5 font-medium text-[9px] uppercase tracking-wider text-muted-foreground/40">
                      {group.label}
                    </div>
                  )}
                  {group.options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => select(o.value)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-colors',
                        value === o.value
                          ? 'bg-surface-1 text-foreground'
                          : 'text-muted-foreground hover:bg-surface-1/50 hover:text-foreground',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{labelWithinGroup(o.label, group.label)}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
            {footerAction && (
              <div className="border-t border-border/20 p-1">
                <button
                  type="button"
                  onClick={() => {
                    close();
                    footerAction.onClick();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-surface-1/50 hover:text-foreground"
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
