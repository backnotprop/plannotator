import React, { useState, useMemo, useRef, useCallback, type ReactNode } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from './Popover';

interface SearchableSelectProps<T extends { id: string }> {
  items: T[];
  selectedId?: string;
  onSelect: (item: T) => void;
  filterFn: (item: T, query: string) => boolean;
  renderItem: (item: T, state: { isSelected: boolean; isFocused: boolean }) => ReactNode;
  renderTrigger: (state: { open: boolean }) => ReactNode;
  headerContent?: ReactNode;
  placeholder?: string;
  emptyMessage?: string;
  align?: 'start' | 'center' | 'end';
  width?: string;
  onOpenChange?: (open: boolean) => void;
}

export function SearchableSelect<T extends { id: string }>({
  items,
  selectedId,
  onSelect,
  filterFn,
  renderItem,
  renderTrigger,
  headerContent,
  placeholder = 'Search...',
  emptyMessage = 'No results',
  align = 'start',
  width = 'w-64',
  onOpenChange,
}: SearchableSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => (search ? items.filter((item) => filterFn(item, search)) : items),
    [items, search, filterFn],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setSearch('');
        setFocusedIndex(-1);
      }
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const scrollToIndex = useCallback((i: number) => {
    listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const len = filtered.length;
      if (len === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = focusedIndex < len - 1 ? focusedIndex + 1 : 0;
        setFocusedIndex(next);
        scrollToIndex(next);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const next = focusedIndex > 0 ? focusedIndex - 1 : len - 1;
        setFocusedIndex(next);
        scrollToIndex(next);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (focusedIndex >= 0 && filtered[focusedIndex]) {
          onSelect(filtered[focusedIndex]);
          handleOpenChange(false);
        }
      }
    },
    [filtered, focusedIndex, onSelect, handleOpenChange, scrollToIndex],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{renderTrigger({ open })}</PopoverTrigger>
      <PopoverContent
        align={align}
        className={`${width} p-0`}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {/* Search row */}
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <svg
            className="w-3 h-3 flex-shrink-0 text-muted-foreground/60"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
            />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setFocusedIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        </div>

        {headerContent}

        {/* Item list */}
        <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground/60">{emptyMessage}</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                type="button"
                data-index={i}
                onClick={() => {
                  onSelect(item);
                  handleOpenChange(false);
                }}
                onMouseEnter={() => setFocusedIndex(i)}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  focusedIndex === i ? 'bg-muted/50' : 'hover:bg-muted/40'
                }`}
              >
                {renderItem(item, {
                  isSelected: item.id === selectedId,
                  isFocused: focusedIndex === i,
                })}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
