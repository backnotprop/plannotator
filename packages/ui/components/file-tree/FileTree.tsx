/**
 * FileTree — a virtualized file tree for large path lists.
 *
 * Renders only the rows in view plus `overscan` above and below (and the
 * focused row wherever it is), all one height, from a `FileTreeStore` (see
 * store.ts and model.ts). The height is `rowHeight` or, when the text is
 * larger, the measured height of a line of row text plus padding, so
 * text-only zoom and a minimum font size never overlap rows. Rows look
 * like the sidebar FileBrowser's (muted names, a chevron and folder icon,
 * `+N -N`, status letters, comment counts) set the way VS Code's explorer
 * sets them: one 13 px size for files and folders, file icons in the folder
 * icons' column, indent and guides on the inline start side (right-to-left
 * pages mirror), indent guides drawn the way VS Code's default does (`onHover`: only
 * while the pointer is over the tree; also while the tree has keyboard focus,
 * and always on a screen without hover, #2062), the open file's folder guide a
 * little stronger.
 *
 * One tab stop: the tree element holds focus and points at the focused row
 * with `aria-activedescendant`. Keys are VS Code's (a standard tree widget):
 * Up/Down, Right opens or goes to the first child, Left closes or goes to the
 * parent, Home/End, PageUp/PageDown, type-ahead, Enter and Space open a file
 * or toggle a folder. Nothing global is registered.
 *
 * Everything kept across changes is kept by path, since node ids change when
 * a sliced build lands or a snapshot rebuilds: the focused row, a pending
 * reveal, and the row at the top of the view (a change above it moves
 * scrollTop by the change in its row, so what is on screen stays put; so does
 * a change of row height). A filter set while a sliced build runs shows a
 * quiet "Indexing…" line until the index lands (`aria-busy` meanwhile).
 *
 * Layout reads: `scrollTop` (scroll events), the viewport's `clientHeight` and
 * the text probe's `offsetHeight` (once at mount, then on ResizeObserver
 * callbacks). A cut-off name reads its own width only when the pointer rests
 * on it (HostTitle `cut`).
 */
import React, { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { HostTitle } from '../HostTitle';
import { CountBadge } from '../sidebar/CountBadge';
import { ROOT, type FileTreeModel, type FileTreeRow } from './model';
import type { FileTreeBadge, FileTreeMarkerTone, FileTreeStore, FileTreeTone } from './store';

export const FILE_TREE_ROW_HEIGHT = 22;
export const FILE_TREE_TOUCH_ROW_HEIGHT = 44;
export const FILE_TREE_INDENT = 8;

/** What an icon renderer is told about a row. */
export interface FileTreeIconInfo {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  depth: number;
}

export interface FileTreeHandle {
  /**
   * Expand the folders above `path`, scroll its row into view (centred when it
   * was out of view) and make it the focused row. False when the path is not
   * in the tree or the filter hides it. While a sliced build runs, a path not
   * there yet is revealed once the index lands (true).
   */
  revealPath(path: string, options?: { focus?: boolean }): boolean;
  /** Move keyboard focus into the tree. */
  focus(): void;
}

export interface FileTreeProps {
  tree: FileTreeStore;
  /** The open file: tinted, and marked `aria-selected`. */
  selectedPath?: string | null;
  /** A file was clicked, or Enter / Space pressed on it. */
  onOpen?: (path: string) => void;
  /** A folder was opened or closed by the user. */
  onToggle?: (path: string, expanded: boolean) => void;
  /** Icons. Default: FileBrowser's folder and file glyphs. Return null for none. Keep the function stable. */
  renderIcon?: (info: FileTreeIconInfo) => React.ReactNode;
  /**
   * Row height in px, a minimum: rows grow with the text when it is larger
   * (text-only zoom, a minimum font size). Default 22, or 44 on a touch screen.
   */
  rowHeight?: number;
  /** Indent per level in px. Default 8 (FileBrowser uses 14). */
  indent?: number;
  /** Rows rendered above and below the viewport. Default 10. */
  overscan?: number;
  /** The tree's accessible name. */
  label?: string;
  /** Words for screen readers. */
  labels?: { markedBelow?: string; indexing?: string };
  className?: string;
  style?: React.CSSProperties;
}

/** Padding inside a row, on the inline start side, before level 0. */
const PAD = 8;
/** The chevron column (FileBrowser's w-3). Files keep it empty, so file and folder icons line up. */
const TWISTIE = 12;

const LETTER_TONE: Record<FileTreeTone, string> = {
  added: 'text-success',
  untracked: 'text-primary',
  deleted: 'text-destructive',
  renamed: 'text-[#007aff]',
  conflict: 'text-destructive',
  modified: 'text-warning',
  ignored: 'text-muted-foreground',
};

const MARKER_TONE: Record<FileTreeMarkerTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning-foreground',
  destructive: 'bg-destructive/15 text-destructive',
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`w-3 h-3 flex-shrink-0 ${open ? 'rotate-90' : 'rtl:-scale-x-100'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

/** FileBrowser's glyphs: a folder outline for folders, a document for files. */
export function defaultFileTreeIcon(info: FileTreeIconInfo): React.ReactNode {
  if (info.isDir) {
    return (
      <svg className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(coarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(pointer: coarse)');
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return coarse;
}

interface RowViewProps {
  domId: string;
  id: number;
  index: number;
  height: number;
  indent: number;
  depth: number;
  name: string;
  displayName: string;
  path: string;
  isDir: boolean;
  expanded: boolean;
  setSize: number;
  posInSet: number;
  selected: boolean;
  ring: boolean;
  /** The guide level drawn stronger, or -1. */
  strongLevel: number;
  badge: FileTreeBadge | undefined;
  additions: number;
  deletions: number;
  count: number;
  dot: boolean;
  dotLabel: string;
  touch: boolean;
  renderIcon: (info: FileTreeIconInfo) => React.ReactNode;
}

const RowView = memo(function RowView(p: RowViewProps) {
  const left = PAD + p.depth * p.indent;
  const icon = p.renderIcon({ path: p.path, name: p.name, isDir: p.isDir, expanded: p.expanded, depth: p.depth });
  const guideLeft = PAD + TWISTIE / 2;
  const disabled = p.badge?.disabled === true;
  const marker = p.badge?.marker;
  const nameText = p.touch ? 'text-[15px]' : 'text-[13px]';
  const base = p.isDir
    ? 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
    : `text-muted-foreground ${disabled ? 'opacity-70 cursor-default' : 'hover:bg-muted hover:text-foreground'}`;
  const tint = p.selected ? 'bg-primary/30 text-primary hover:bg-primary/30 hover:text-primary' : !p.isDir && p.count > 0 ? 'bg-primary/[0.08]' : '';
  return (
    <div
      id={p.domId}
      role="treeitem"
      aria-level={p.depth + 1}
      aria-setsize={p.setSize}
      aria-posinset={p.posInSet}
      aria-expanded={p.isDir ? p.expanded : undefined}
      aria-selected={p.selected}
      aria-disabled={disabled || undefined}
      data-row={p.index}
      data-node={p.id}
      data-path={p.path}
      data-selected={p.selected || undefined}
      data-ring={p.ring || undefined}
      className={`absolute inset-x-1 flex items-center gap-1.5 pe-2 rounded-sm select-none whitespace-nowrap cursor-pointer data-[ring]:outline data-[ring]:outline-1 data-[ring]:-outline-offset-1 data-[ring]:outline-ring ${base} ${tint} ${nameText}`}
      style={{ top: p.index * p.height, height: p.height, paddingInlineStart: left }}
    >
      {p.depth > 0 && (
        <span
          aria-hidden
          data-guides
          className="pointer-events-none absolute inset-y-0 opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/ft:opacity-100 group-focus-visible/ft:opacity-100 [@media(hover:none)]:opacity-100 rtl:-scale-x-100"
          style={{
            insetInlineStart: guideLeft,
            width: p.depth * p.indent,
            backgroundImage: `repeating-linear-gradient(to right, var(--ft-guide) 0 1px, transparent 1px ${p.indent}px)`,
          }}
        />
      )}
      {p.strongLevel >= 0 && (
        <span
          aria-hidden
          data-guide-strong
          className="pointer-events-none absolute inset-y-0 w-px opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/ft:opacity-100 group-focus-visible/ft:opacity-100 [@media(hover:none)]:opacity-100"
          style={{ insetInlineStart: guideLeft + p.strongLevel * p.indent, background: 'var(--ft-guide-strong)' }}
        />
      )}
      {p.isDir ? <Chevron open={p.expanded} /> : <span aria-hidden className="w-3 flex-shrink-0" />}
      {icon != null && icon !== false && icon}
      <HostTitle title={p.displayName} cut>
        <span dir="auto" className={`truncate min-w-0 flex-1 ${p.badge?.struck ? 'line-through' : ''}`}>{p.displayName}</span>
      </HostTitle>
      <span className="ms-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
        {marker && (
          <span
            role={marker.label ? 'img' : undefined}
            aria-label={marker.label}
            className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none ${MARKER_TONE[marker.tone]}`}
          >
            {marker.glyph}
          </span>
        )}
        {p.count > 0 && <CountBadge count={p.count} active={p.selected} />}
        {p.additions > 0 && <span className="text-success">+{p.additions}</span>}
        {p.deletions > 0 && <span className="text-destructive">-{p.deletions}</span>}
        {!p.isDir && p.badge?.letter && (
          <span className={`font-semibold ${LETTER_TONE[p.badge.tone ?? 'modified']}`}>{p.badge.letter}</span>
        )}
        {p.dot && <span role="img" aria-label={p.dotLabel} className="size-1.5 rounded-full bg-warning" />}
        {!p.isDir && p.badge?.label && <span className="sr-only">{p.badge.label}</span>}
      </span>
    </div>
  );
});

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The guide drawn stronger for the open file: its folder's (VS Code: an open folder's own, else the parent's). */
function strongGuide(model: FileTreeModel, selected: number): { level: number; from: number; to: number } | null {
  if (selected <= ROOT || !model.isAlive(selected)) return null;
  const owner = model.isDir(selected) && model.isExpanded(selected) && model.childrenOf(selected).length > 0 ? selected : model.parentOf(selected);
  if (owner === ROOT || !model.isExpanded(owner)) return null;
  const at = model.indexOfId(owner);
  if (at < 0) return null;
  return { level: model.depthOf(owner), from: at + 1, to: at + model.rowsUnder(owner) };
}

/**
 * Where focus goes when its row is gone: the row now in its place while that
 * is inside the nearest folder above the gone path that is still in the tree
 * (a whole folder removed keeps focus near where it was), else that folder.
 */
function focusAfterRemoval(model: FileTreeModel, path: string, lastIndex: number): number {
  const total = model.rowCount;
  const inPlace = model.rowAt(clamp(lastIndex, 0, total - 1));
  let ancestor = -1;
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    ancestor = model.find(path.slice(0, cut));
    if (ancestor > ROOT) break;
  }
  if (ancestor <= ROOT) return inPlace;
  if (!model.isVisible(ancestor)) return model.visibleAncestor(ancestor);
  for (let n = inPlace; n > ROOT; n = model.parentOf(n)) if (n === ancestor) return inPlace;
  return ancestor;
}

const TYPEAHEAD_MS = 700;
/** Room left around a line of text when the text, not `rowHeight`, sets the row height. */
const ROW_TEXT_PADDING = 2;

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(props, ref) {
  const { tree, selectedPath = null, onOpen, onToggle, renderIcon = defaultFileTreeIcon, indent = FILE_TREE_INDENT, overscan = 10, label = 'Files', labels, className, style } = props;
  const version = useSyncExternalStore(tree.subscribe, tree.getVersion, tree.getVersion);
  const model = tree.model;
  const coarse = useCoarsePointer();
  const touch = (props.rowHeight ?? (coarse ? FILE_TREE_TOUCH_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT)) >= FILE_TREE_TOUCH_ROW_HEIGHT;
  const minRow = props.rowHeight ?? (coarse ? FILE_TREE_TOUCH_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT);
  const domPrefix = `ft${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const scrollTopRef = useRef(0);
  const [firstRow, setFirstRow] = useState(0);
  /** A render after scrollTop was set in code: the row number may be the same while the row height is not. */
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [viewH, setViewH] = useState(0);
  const [textH, setTextH] = useState(0);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [revealTick, setRevealTick] = useState(0);
  const lastFocusIndex = useRef(0);
  const pendingReveal = useRef<string | null>(null);
  const typeahead = useRef({ text: '', at: 0 });
  /** The row at the top of the view, by path, so a change above it does not move what is on screen. */
  const anchor = useRef<{ path: string; offset: number; version: number; h: number } | null>(null);

  // Row height follows the text: a hidden line of row text is measured once and
  // again whenever it changes size (text-only zoom, a minimum font size, a font
  // that loads late). Every row is the same height, so the window stays exact.
  const h = Math.max(minRow, textH > 0 ? Math.ceil(textH) + ROW_TEXT_PADDING : 0);

  // Viewport height and text height: one read each at mount, then ResizeObserver.
  // Both read clientHeight / offsetHeight, so padding never makes them disagree.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const probe = probeRef.current;
    if (!el || !probe) return;
    setViewH(el.clientHeight);
    setTextH(probe.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === el) setViewH(el.clientHeight);
        else setTextH((entry.target as HTMLElement).offsetHeight);
      }
    });
    ro.observe(el);
    ro.observe(probe);
    return () => ro.disconnect();
  }, []);

  // A filter waiting for a sliced build has no rows yet: the tree says "Indexing…".
  const pending = tree.filterPending;
  const total = pending ? 0 : model.rowCount;
  // A hidden or not-yet-measured tree draws 30 rows rather than none.
  const viewport = viewH > 0 ? viewH : 30 * h;
  const pageRows = Math.max(1, Math.floor(viewport / h));
  // The window comes from scrollTop and the row height in use, never a row
  // number worked out with an earlier height (a height change would blank it).
  // `firstRow` is what re-renders on scroll.
  void firstRow;
  const top = clamp(Math.floor(scrollTopRef.current / h), 0, Math.max(0, total - pageRows));
  const start = Math.max(0, top - overscan);
  const end = Math.min(total, top + pageRows + 1 + overscan);
  const rows: FileTreeRow[] = pending ? [] : model.rows(start, end - start);

  // The focused row, kept by path: hidden under a closed folder → that folder;
  // gone → the row now in its place while that is still inside the nearest
  // folder above it that is left, else that folder.
  let focus = focusPath === null || pending ? -1 : model.find(focusPath);
  if (focus > ROOT && !model.isVisible(focus)) focus = model.visibleAncestor(focus);
  if (focusPath !== null && !pending && focus <= ROOT && total > 0) focus = focusAfterRemoval(model, focusPath, lastFocusIndex.current);
  const focusIndex = focus > ROOT ? model.indexOfId(focus) : -1;
  if (focusIndex >= 0) lastFocusIndex.current = focusIndex;
  // The focused row is always in the DOM, so aria-activedescendant never points at nothing.
  if (focusIndex >= 0 && (focusIndex < start || focusIndex >= end)) {
    const row = model.rowFor(focus);
    if (row) rows.push(row);
  }

  const selectedId = selectedPath ? model.find(selectedPath) : -1;
  const strong = strongGuide(model, selectedId);

  const scrollTo = useCallback(
    (y: number) => {
      const el = scrollRef.current;
      const max = Math.max(0, total * h - viewport);
      const next = clamp(Math.round(y), 0, max);
      scrollTopRef.current = next;
      if (el) el.scrollTop = next;
      setFirstRow(Math.floor(next / h));
      redraw();
    },
    [total, h, viewport],
  );

  const ensureVisible = useCallback(
    (index: number, center = false) => {
      const y = index * h;
      const cur = scrollTopRef.current;
      if (y >= cur && y + h <= cur + viewport) return;
      if (center) scrollTo(y - (viewport - h) / 2);
      else if (y < cur) scrollTo(y);
      else scrollTo(y + h - viewport);
    },
    [h, viewport, scrollTo],
  );

  // After the tree changes, keep the top row where it was (rows are absolutely
  // placed, so the browser's own scroll anchoring cannot). Not at the very top:
  // a new row there should show, as with CSS scroll anchoring. Then note the
  // top row for next time.
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    let hostScrolled = false;
    if (a && a.version !== version && el) {
      // A host that set scrollTop in the same task as the change (its scroll
      // event has not come yet): its position wins. A scrollTop the browser
      // clamped because the tree got shorter is not the host's.
      const actual = el.scrollTop;
      const max = el.scrollHeight - el.clientHeight;
      const clamped = actual < scrollTopRef.current && actual >= max - 1;
      if (Math.abs(actual - scrollTopRef.current) > 1 && !clamped) {
        hostScrolled = true;
        scrollTopRef.current = actual;
        setFirstRow(Math.floor(actual / h));
        redraw();
      }
    }
    if (a && !hostScrolled && (a.version !== version || a.h !== h) && scrollTopRef.current > 0) {
      let id = model.find(a.path);
      if (id > ROOT && !model.isVisible(id)) id = model.visibleAncestor(id);
      const at = id > ROOT ? model.indexOfId(id) : -1;
      if (at >= 0) {
        const y = at * h + (a.h === h ? a.offset : Math.round((a.offset * h) / a.h));
        if (y !== scrollTopRef.current) scrollTo(y);
      }
    }
    const topIndex = Math.floor(scrollTopRef.current / h);
    const topId = total > 0 ? model.rowAt(clamp(topIndex, 0, total - 1)) : -1;
    anchor.current = topId > ROOT ? { path: model.pathOf(topId), offset: scrollTopRef.current - topIndex * h, version, h } : null;
  }, [version, model, h, total, scrollTo, firstRow]);

  // Focus held on a row that is gone or hidden moves for good to the row that shows it.
  useLayoutEffect(() => {
    if (focusPath === null || focus <= ROOT) return;
    const shown = model.pathOf(focus);
    if (shown !== focusPath) setFocusPath(shown);
  }, [version, focusPath, focus, model]);

  // revealPath: scroll once the expanded rows are in the spacer.
  useLayoutEffect(() => {
    const path = pendingReveal.current;
    if (path === null) return;
    pendingReveal.current = null;
    const at = model.indexOf(path);
    if (at >= 0) ensureVisible(at, true);
  }, [revealTick, model, ensureVisible]);

  useImperativeHandle(ref, () => {
    const revealPath = (path: string, options?: { focus?: boolean }): boolean => {
      if (tree.filterPending || tree.model.find(path) <= ROOT) {
        // While a sliced build runs the path may not be in the preview yet (or
        // a filter waits for the index): reveal it once the index lands.
        if (!tree.loading) return false;
        void tree.whenReady().then(() => {
          if (!tree.loading && tree.model.find(path) > ROOT) revealPath(path, options);
        });
        return true;
      }
      // A path the filter hides is not revealed, and opens nothing.
      if (tree.reveal(path) < 0) return false;
      if (options?.focus !== false) setFocusPath(tree.model.pathOf(tree.model.find(path)));
      pendingReveal.current = path;
      setRevealTick((t) => t + 1);
      return true;
    };
    return {
      revealPath,
      focus() {
        scrollRef.current?.focus();
      },
    };
  }, [tree]);

  const focusRow = (id: number) => setFocusPath(id > ROOT ? model.pathOf(id) : null);

  const moveTo = (index: number) => {
    if (total === 0) return;
    const i = clamp(index, 0, total - 1);
    focusRow(model.rowAt(i));
    ensureVisible(i);
  };

  const toggle = (id: number) => {
    const path = model.pathOf(id);
    const open = !model.isExpanded(id);
    if (open) tree.expand(path);
    else tree.collapse(path);
    onToggle?.(path, open);
  };

  const activate = (id: number) => {
    if (id <= ROOT) return;
    if (model.isDir(id)) {
      toggle(id);
      return;
    }
    const path = model.pathOf(id);
    if (tree.badgeOf(path)?.disabled) return;
    onOpen?.(path);
  };

  const findByPrefix = (needle: string, from: number): number => {
    let hit = -1;
    const test = (id: number, index: number) => {
      if (tree.displayName(model.nameOf(id)).toLocaleLowerCase().startsWith(needle)) {
        hit = index;
        return true;
      }
      return false;
    };
    model.scan(from, test);
    if (hit < 0 && from > 0) {
      model.scan(0, (id, index) => (index >= from ? true : test(id, index)));
    }
    return hit;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || pending) return;
    const cur = focusIndex;
    const id = focus;
    let handled = true;
    const key = event.key;
    const ta = typeahead.current;
    const typing = event.timeStamp - ta.at < TYPEAHEAD_MS && ta.text.length > 0;
    switch (key) {
      case 'ArrowDown': moveTo(cur < 0 ? 0 : cur + 1); break;
      case 'ArrowUp': moveTo(cur < 0 ? 0 : cur - 1); break;
      case 'Home': moveTo(0); break;
      case 'End': moveTo(total - 1); break;
      case 'PageDown': moveTo(cur < 0 ? 0 : cur + Math.max(1, pageRows - 1)); break;
      case 'PageUp': moveTo(cur < 0 ? 0 : cur - Math.max(1, pageRows - 1)); break;
      case 'ArrowRight':
        if (id > ROOT && model.isDir(id)) {
          if (!model.isExpanded(id)) toggle(id);
          else if (model.shownChildCount(id) > 0) moveTo(cur + 1);
        } else if (cur < 0) moveTo(0);
        break;
      case 'ArrowLeft':
        if (id > ROOT && model.isDir(id) && model.isExpanded(id)) toggle(id);
        else if (id > ROOT && model.parentOf(id) !== ROOT) moveTo(model.indexOfId(model.parentOf(id)));
        else if (cur < 0) moveTo(0);
        break;
      case 'Enter':
        if (cur < 0) moveTo(0);
        else activate(id);
        break;
      default:
        if (key.length === 1 && (key !== ' ' || typing)) {
          const text = (typing ? ta.text : '') + key.toLocaleLowerCase();
          ta.text = text;
          ta.at = event.timeStamp;
          // One letter pressed again and again cycles through the names starting with it.
          const repeated = text.length > 1 && [...text].every((c) => c === text[0]);
          const needle = repeated ? text[0] : text;
          const from = text.length === 1 || repeated ? cur + 1 : Math.max(cur, 0);
          const hit = total > 0 ? findByPrefix(needle, from % total) : -1;
          if (hit >= 0) moveTo(hit);
        } else if (key === ' ') {
          if (cur < 0) moveTo(0);
          else activate(id);
        } else handled = false;
    }
    if (handled) {
      event.preventDefault();
      if (!keyboard) setKeyboard(true);
    }
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rowEl = (event.target as Element).closest?.('[data-path]');
    if (!rowEl) return;
    const path = rowEl.getAttribute('data-path')!;
    const id = model.find(path);
    if (id <= ROOT) return;
    setFocusPath(path);
    activate(id);
  };

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setHasFocus(true);
    if (focusIndex < 0 && total > 0) {
      const sel = selectedId > ROOT ? model.indexOfId(selectedId) : -1;
      const at = sel >= 0 ? sel : clamp(Math.floor(scrollTopRef.current / h), 0, total - 1);
      focusRow(model.rowAt(at));
    }
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const y = event.currentTarget.scrollTop;
    scrollTopRef.current = y;
    const row = Math.floor(y / h);
    if (row !== firstRow) setFirstRow(row);
    else if (anchor.current) anchor.current.offset = y - row * h;
  };

  const ringId = hasFocus && keyboard ? focus : -1;
  const activeDescendant = hasFocus && focusIndex >= 0 ? `${domPrefix}-${focus}` : undefined;
  const dotLabel = labels?.markedBelow ?? 'Contains changes';
  const indexingId = `${domPrefix}-indexing`;

  const treeStyle = useMemo(
    () =>
      ({
        '--ft-guide': 'color-mix(in oklab, var(--muted-foreground) 28%, transparent)',
        '--ft-guide-strong': 'color-mix(in oklab, var(--muted-foreground) 70%, transparent)',
        overflowAnchor: 'none',
        ...style,
      }) as React.CSSProperties,
    [style],
  );

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      aria-activedescendant={activeDescendant}
      aria-busy={tree.loading || undefined}
      aria-describedby={pending ? indexingId : undefined}
      tabIndex={0}
      data-file-tree=""
      className={`group/ft relative h-full overflow-auto outline-none ${className ?? ''}`}
      style={treeStyle}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onPointerDown={() => keyboard && setKeyboard(false)}
      onFocus={onFocus}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setHasFocus(false);
      }}
    >
      {/* A line of row text (the rows' font and line height), measured for the row height. */}
      <span
        ref={probeRef}
        aria-hidden
        data-ft-probe=""
        className={`pointer-events-none invisible absolute start-0 top-0 whitespace-nowrap ${touch ? 'text-[15px]' : 'text-[13px]'}`}
      >
        Ag
      </span>
      {pending && (
        // Read through aria-describedby (a tree holds tree items only).
        <div id={indexingId} aria-hidden data-ft-indexing="" className={`px-3 text-muted-foreground/70 ${touch ? 'text-[15px]' : 'text-[13px]'}`} style={{ lineHeight: `${h}px` }}>
          {labels?.indexing ?? 'Indexing…'}
        </div>
      )}
      <div role="presentation" style={{ position: 'relative', height: total * h, minHeight: '100%' }}>
        {rows.map((r) => {
          const path = model.pathOf(r.id);
          const badge = tree.badgeOf(path);
          const totals = r.isDir ? model.totals(r.id) : null;
          const additions = totals ? totals.additions : (badge?.additions ?? 0);
          const deletions = totals ? totals.deletions : (badge?.deletions ?? 0);
          return (
            <RowView
              key={path}
              domId={`${domPrefix}-${r.id}`}
              id={r.id}
              index={r.index}
              height={h}
              indent={indent}
              depth={r.depth}
              name={r.name}
              displayName={r.isDir ? r.name : tree.displayName(r.name)}
              path={path}
              isDir={r.isDir}
              expanded={r.expanded}
              setSize={r.setSize}
              posInSet={r.posInSet}
              selected={r.id === selectedId}
              ring={r.id === ringId}
              strongLevel={strong && r.index >= strong.from && r.index <= strong.to ? strong.level : -1}
              badge={badge}
              additions={additions}
              deletions={deletions}
              count={r.isDir ? 0 : (badge?.count ?? 0)}
              dot={r.isDir && !r.expanded && r.markedBelow && additions === 0 && deletions === 0}
              dotLabel={dotLabel}
              touch={touch}
              renderIcon={renderIcon}
            />
          );
        })}
      </div>
    </div>
  );
});
