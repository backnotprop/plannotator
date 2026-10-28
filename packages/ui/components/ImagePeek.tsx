import React, { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * The picture list a stepper opens ("A · Peek", approval "inbox-image-viewer",
 * 2026-10-15): one row per group (a message, a section of a document) with
 * its label, each item a thumbnail with its name under it, the open one
 * ringed. It floats over what is open and moves nothing under it; on a phone
 * it is a bottom sheet, three across.
 *
 * Keys only while it is open: ← → along the items, ↑ ↓ between rows (the
 * nearest column), Home / End, Enter or Space opens the item (`onPick`), Esc or
 * Tab closes it (`onClose`). The host puts focus back on the control that
 * opened it. Focus starts on the open item.
 *
 * Images are only ever drawn through `<img src>`.
 */
export interface ImagePeekItem {
  /** Unique across the peek. */
  key: string;
  name: string;
  /** An image URL for the thumbnail; absent for a file drawn as a type tile. */
  thumb?: string | null;
  /** The type tile's short label ("MD", "PDF") when there is no thumbnail. */
  tile?: string;
  /** Comments on it, shown as a count badge when more than 0. */
  count?: number;
  /** A paperclip badge (an attached file, as opposed to an image in the text). */
  attached?: boolean;
  /** Extra words for a screen reader ("changed since it was sent"). */
  detail?: string;
}

export interface ImagePeekRow {
  key: string;
  /** "11:22 AM", or a section heading. */
  label: string;
  items: ImagePeekItem[];
}

export interface ImagePeekProps {
  rows: readonly ImagePeekRow[];
  /** The open item's key: ringed, and where focus starts. */
  current: string | null;
  onPick: (key: string) => void;
  /** Esc or Tab (`key`: the host puts focus back on its opener), or a press outside / the sheet's backdrop (`outside`). */
  onClose: (reason: 'key' | 'outside') => void;
  /** `popover`: a panel the host positions above its bar. `sheet`: a phone's bottom sheet, three across. */
  variant?: 'popover' | 'sheet';
  /** The grid's accessible name. */
  label: string;
  /** An id for the panel, for the opener's `aria-controls`. */
  id?: string;
  className?: string;
  /**
   * The sheet only: controls drawn above the grid, outside it (the Inbox's
   * Previous / Next). Shift+Tab from the grid moves into them; Escape in them,
   * or Shift+Tab out of the first, closes the sheet (`onClose('key')`), so
   * focus never leaves it for the page behind. Absent (the default): the
   * sheet is unchanged.
   */
  sheetHeader?: React.ReactNode;
}

const PaperclipIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/** Where focus may move from `at` (row, column) for a key, or null when the key is not the grid's. */
export function peekMove(rows: readonly { items: readonly unknown[] }[], at: { row: number; col: number }, key: string): { row: number; col: number } | null {
  const flat: { row: number; col: number }[] = [];
  rows.forEach((row, r) => row.items.forEach((_, c) => flat.push({ row: r, col: c })));
  if (flat.length === 0) return null;
  const index = flat.findIndex((p) => p.row === at.row && p.col === at.col);
  switch (key) {
    case 'ArrowRight':
      return flat[Math.min(flat.length - 1, index + 1)]!;
    case 'ArrowLeft':
      return flat[Math.max(0, index - 1)]!;
    case 'Home':
      return flat[0]!;
    case 'End':
      return flat[flat.length - 1]!;
    case 'ArrowDown':
    case 'ArrowUp': {
      const step = key === 'ArrowDown' ? 1 : -1;
      for (let r = at.row + step; r >= 0 && r < rows.length; r += step) {
        const count = rows[r]!.items.length;
        if (count > 0) return { row: r, col: Math.min(at.col, count - 1) };
      }
      return at;
    }
    default:
      return null;
  }
}

/** A host that intercepts keys before they reach the peek (a modal's capture listener) hands them over here. */
export interface ImagePeekHandle {
  /** Handle one key as the peek would; true when it was the peek's (the caller prevents its default). */
  handleKey: (event: { key: string; isComposing?: boolean }) => boolean;
}

export const ImagePeek = forwardRef<ImagePeekHandle, ImagePeekProps>(function ImagePeek({ rows, current, onPick, onClose, variant = 'popover', label, id, className = '', sheetHeader }, ref) {
  const sheet = variant === 'sheet';
  const header = sheet && sheetHeader ? sheetHeader : null;
  const gridRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const labelId = `${(id ?? `pn-peek-${autoId}`).replace(/:/g, '')}-label`;
  const start = useMemo(() => {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r]!.items.findIndex((item) => item.key === current);
      if (c >= 0) return { row: r, col: c };
    }
    const r = rows.findIndex((row) => row.items.length > 0);
    return { row: Math.max(0, r), col: 0 };
  }, [rows, current]);
  const [focus, setFocus] = useState(start);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const cellOf = (at: { row: number; col: number }) => gridRef.current?.querySelector<HTMLElement>(`[data-peek-cell="${at.row}:${at.col}"]`) ?? null;

  // Focus starts on the open item, and the open item is in view.
  useLayoutEffect(() => {
    const cell = cellOf(start);
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press outside closes it (the opener toggles it itself).
  useEffect(() => {
    if (sheet) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || gridRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-peek-opener]')) return;
      onCloseRef.current('outside');
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [sheet]);

  const focusRef = useRef(focus);
  focusRef.current = focus;
  const handleKey = (event: { key: string; isComposing?: boolean }): boolean => {
    if (event.isComposing) return false;
    if (event.key === 'Escape' || event.key === 'Tab') {
      onClose('key');
      return true;
    }
    const at = focusRef.current;
    if (event.key === 'Enter' || event.key === ' ') {
      const item = rows[at.row]?.items[at.col];
      if (item) onPick(item.key);
      return true;
    }
    const next = peekMove(rows, at, event.key);
    if (!next) return false;
    focusRef.current = next;
    setFocus(next);
    const cell = cellOf(next);
    cell?.focus({ preventScroll: true });
    cell?.scrollIntoView?.({ block: 'nearest' });
    return true;
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  useImperativeHandle(ref, () => ({ handleKey: (event) => handleKeyRef.current(event) }), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // With a header above the grid, Shift+Tab moves up into it instead of closing the sheet.
    if (header && event.key === 'Tab' && event.shiftKey) return;
    if (!handleKey({ key: event.key, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const panel = (
    <div
      ref={gridRef}
      id={id}
      role="grid"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      data-image-peek={variant}
      className={
        sheet
          ? header
            ? `pointer-events-auto max-h-[70vh] w-full overflow-y-auto bg-popover px-3 pb-[calc(16px+env(safe-area-inset-bottom))] text-popover-foreground ${className}`
            : `pointer-events-auto max-h-[78vh] w-full overflow-y-auto rounded-t-[12px] border-t border-border bg-popover px-3 pb-[calc(16px+env(safe-area-inset-bottom))] pt-2 text-popover-foreground shadow-2xl ${className}`
          : `max-h-[min(460px,62vh)] w-[min(600px,calc(100vw-24px))] overflow-y-auto rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-[0_14px_36px_rgba(0,0,0,0.28)] ${className}`
      }
    >
      <span id={labelId} className="sr-only">
        {label}
      </span>
      {sheet && !header && <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />}
      {rows.map((row, r) => (
        <div
          key={row.key}
          role="row"
          className={`${sheet ? 'flex flex-col gap-2 py-2' : 'grid grid-cols-[84px_1fr] gap-2 px-1 py-2'} ${r > 0 ? 'border-t border-border/60' : ''}`}
          data-peek-row={row.key}
        >
          <span role="rowheader" className={`text-[12.5px] text-muted-foreground ${sheet ? 'px-1 text-[14px]' : 'pt-1 tabular-nums'}`}>
            {row.label}
          </span>
          <div role="presentation" className={sheet ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2'}>
            {row.items.map((item, c) => {
              const open = item.key === current;
              const focused = focus.row === r && focus.col === c;
              const words = [item.name, item.attached ? 'attached' : null, item.count ? `${item.count} comment${item.count === 1 ? '' : 's'}` : null, item.detail ?? null, open ? 'open now' : null]
                .filter(Boolean)
                .join(', ');
              return (
                <div
                  key={item.key}
                  role="gridcell"
                  tabIndex={focused ? 0 : -1}
                  aria-selected={open}
                  aria-label={words}
                  data-peek-cell={`${r}:${c}`}
                  data-peek-item={item.key}
                  data-peek-open={open ? '' : undefined}
                  onClick={() => onPick(item.key)}
                  onFocus={() => setFocus({ row: r, col: c })}
                  className="group flex min-w-0 cursor-pointer flex-col gap-1 rounded-lg p-1 outline-none hover:bg-muted/70 focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashed focus-visible:outline-foreground/45"
                >
                  <span
                    className={`relative block w-full overflow-hidden rounded-md border bg-muted ${sheet ? 'h-[99px]' : 'aspect-[16/10]'} ${open ? 'border-primary ring-2 ring-primary' : 'border-border/70'}`}
                  >
                    {item.thumb ? (
                      <img src={item.thumb} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover object-top" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center font-mono text-[12px] font-semibold tracking-wide text-muted-foreground">{item.tile ?? 'FILE'}</span>
                    )}
                    {item.attached && (
                      <span className="absolute bottom-1 left-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-card text-foreground shadow-sm" aria-hidden="true" data-peek-attached="">
                        <PaperclipIcon />
                      </span>
                    )}
                    {item.count ? (
                      <span className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground" aria-hidden="true" data-peek-count="">
                        {item.count}
                      </span>
                    ) : null}
                  </span>
                  <span className={`line-clamp-2 [overflow-wrap:anywhere] text-[12.5px] leading-tight ${open ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>{item.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  if (!sheet) return panel;
  return (
    <div className="fixed inset-0 z-[220] flex flex-col justify-end" data-image-peek-sheet="">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={() => onClose('outside')} data-peek-backdrop="" />
      <div className={header ? 'relative overflow-hidden rounded-t-[12px] border-t border-border bg-popover shadow-2xl' : 'relative'}>
        {header && (
          <div
            className="px-3 pt-2 text-popover-foreground"
            onKeyDown={(event) => {
              // Escape closes the sheet; so does Shift+Tab out of its first control (focus leaving the sheet
              // closes it, as Tab out of the grid does: the host puts focus back on its opener).
              const first = event.currentTarget.querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
              const leaving = event.key === 'Tab' && event.shiftKey && event.target === first;
              if (event.key !== 'Escape' && !leaving) return;
              event.preventDefault();
              event.stopPropagation();
              onClose('key');
            }}
            data-peek-sheet-header=""
          >
            <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />
            {header}
          </div>
        )}
        {panel}
      </div>
    </div>
  );
});
