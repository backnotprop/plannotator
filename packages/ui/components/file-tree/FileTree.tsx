/**
 * FileTree — a virtualized file tree for large path lists.
 *
 * Renders only the rows in view plus `overscan` above and below, at a fixed
 * row height, from a `FileTreeStore` (see store.ts and model.ts). Rows look
 * like the sidebar FileBrowser's (13 px muted file names, 11 px folder rows
 * with a chevron and folder icon, `+N -N`, status letters, comment counts),
 * with indent guides drawn the way VS Code's default does (`onHover`: only
 * while the pointer is over the tree), the open file's folder guide a little
 * stronger.
 *
 * One tab stop: the tree element holds focus and points at the focused row
 * with `aria-activedescendant`. Keys are VS Code's (a standard tree widget):
 * Up/Down, Right opens or goes to the first child, Left closes or goes to the
 * parent, Home/End, PageUp/PageDown, type-ahead, Enter and Space open a file
 * or toggle a folder. Nothing global is registered.
 *
 * Layout reads: `scrollTop` (scroll events) and the viewport height (one
 * `clientHeight` read at mount, then ResizeObserver). A cut-off name reads its
 * own width only when the pointer rests on it (HostTitle `cut`).
 */
import React, { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { HostTitle } from '../HostTitle';
import { CountBadge } from '../sidebar/CountBadge';
import { ROOT, type FileTreeModel, type FileTreeRow } from './model';
import type { FileTreeBadge, FileTreeMarkerTone, FileTreeStore, FileTreeTone } from './store';

export const FILE_TREE_ROW_HEIGHT = 22;
export const FILE_TREE_TOUCH_ROW_HEIGHT = 36;
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
   * in the tree.
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
  /** Fixed row height in px. Default 22, or 36 on a touch screen. */
  rowHeight?: number;
  /** Indent per level in px. Default 8 (FileBrowser uses 14). */
  indent?: number;
  /** Rows rendered above and below the viewport. Default 10. */
  overscan?: number;
  /** The tree's accessible name. */
  label?: string;
  /** Words for screen readers. */
  labels?: { markedBelow?: string };
  className?: string;
  style?: React.CSSProperties;
}

/** Left padding inside a row before level 0. */
const PAD = 8;
/** The chevron column (FileBrowser's w-3). */
const TWISTIE = 12;
/** A file row starts its icon here past the folder's chevron (FileBrowser's paddingLeft + 15). */
const FILE_SHIFT = 15;

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
    <svg className={`w-3 h-3 flex-shrink-0 ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
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
  const nameText = p.touch ? 'text-[15px]' : p.isDir ? 'text-[11px]' : 'text-[13px]';
  const base = p.isDir
    ? 'gap-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50'
    : `gap-2 text-muted-foreground ${disabled ? 'opacity-70 cursor-default' : 'hover:bg-muted hover:text-foreground'}`;
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
      className={`absolute inset-x-1 flex items-center pr-2 rounded-sm select-none whitespace-nowrap cursor-pointer data-[ring]:outline data-[ring]:outline-1 data-[ring]:-outline-offset-1 data-[ring]:outline-ring ${base} ${tint} ${nameText}`}
      style={{ top: p.index * p.height, height: p.height, paddingLeft: p.isDir ? left : left + FILE_SHIFT }}
    >
      {p.depth > 0 && (
        <span
          aria-hidden
          data-guides
          className="pointer-events-none absolute inset-y-0 opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/ft:opacity-100"
          style={{
            left: guideLeft,
            width: p.depth * p.indent,
            backgroundImage: `repeating-linear-gradient(to right, var(--ft-guide) 0 1px, transparent 1px ${p.indent}px)`,
          }}
        />
      )}
      {p.strongLevel >= 0 && (
        <span
          aria-hidden
          data-guide-strong
          className="pointer-events-none absolute inset-y-0 w-px opacity-0 transition-opacity duration-100 motion-reduce:transition-none group-hover/ft:opacity-100"
          style={{ left: guideLeft + p.strongLevel * p.indent, background: 'var(--ft-guide-strong)' }}
        />
      )}
      {p.isDir && <Chevron open={p.expanded} />}
      {icon != null && icon !== false && icon}
      <HostTitle title={p.displayName} cut>
        <span className={`truncate min-w-0 ${p.isDir ? '' : 'flex-1'} ${p.badge?.struck ? 'line-through' : ''}`}>{p.displayName}</span>
      </HostTitle>
      <span className="ml-auto flex flex-shrink-0 items-center gap-1.5 text-[10px]">
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

const TYPEAHEAD_MS = 700;

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(props, ref) {
  const { tree, selectedPath = null, onOpen, onToggle, renderIcon = defaultFileTreeIcon, indent = FILE_TREE_INDENT, overscan = 10, label = 'Files', labels, className, style } = props;
  useSyncExternalStore(tree.subscribe, tree.getVersion, tree.getVersion);
  const model = tree.model;
  const coarse = useCoarsePointer();
  const h = props.rowHeight ?? (coarse ? FILE_TREE_TOUCH_ROW_HEIGHT : FILE_TREE_ROW_HEIGHT);
  const domPrefix = `ft${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const [firstRow, setFirstRow] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [focusId, setFocusId] = useState(-1);
  const [hasFocus, setHasFocus] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [revealTick, setRevealTick] = useState(0);
  const lastFocusIndex = useRef(0);
  const pendingReveal = useRef<{ id: number } | null>(null);
  const typeahead = useRef({ text: '', at: 0 });

  // Viewport height: one read at mount, then ResizeObserver (no forced layout).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.height;
      if (typeof next === 'number') setViewH(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = model.rowCount;
  // A hidden or not-yet-measured tree draws 30 rows rather than none.
  const viewport = viewH > 0 ? viewH : 30 * h;
  const pageRows = Math.max(1, Math.floor(viewport / h));
  const top = clamp(firstRow, 0, Math.max(0, total - pageRows));
  const start = Math.max(0, top - overscan);
  const end = Math.min(total, top + pageRows + 1 + overscan);
  const rows: FileTreeRow[] = model.rows(start, end - start);

  // The focused row: gone → the row now in its place; hidden → its visible folder.
  let focus = focusId;
  if (focus > ROOT && !model.isAlive(focus)) focus = model.rowAt(clamp(lastFocusIndex.current, 0, total - 1));
  else if (focus > ROOT && !model.isVisible(focus)) focus = model.visibleAncestor(focus);
  const focusIndex = focus > ROOT ? model.indexOfId(focus) : -1;
  if (focusIndex >= 0) lastFocusIndex.current = focusIndex;

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

  // revealPath: scroll once the expanded rows are in the spacer.
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    if (!pending) return;
    pendingReveal.current = null;
    const at = model.indexOfId(pending.id);
    if (at >= 0) ensureVisible(at, true);
  }, [revealTick, model, ensureVisible]);

  useImperativeHandle(
    ref,
    () => ({
      revealPath(path, options) {
        const id = tree.model.find(path);
        if (id <= ROOT) return false;
        tree.batch((m) => m.expandAncestors(id));
        if (options?.focus !== false) setFocusId(id);
        pendingReveal.current = { id };
        setRevealTick((t) => t + 1);
        return true;
      },
      focus() {
        scrollRef.current?.focus();
      },
    }),
    [tree],
  );

  const moveTo = (index: number) => {
    if (total === 0) return;
    const i = clamp(index, 0, total - 1);
    setFocusId(model.rowAt(i));
    ensureVisible(i);
  };

  const toggle = (id: number) => {
    const open = !model.isExpanded(id);
    tree.batch((m) => (open ? m.expand(id) : m.collapse(id)));
    onToggle?.(model.pathOf(id), open);
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
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
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
          else if (model.childrenOf(id).length > 0) moveTo(cur + 1);
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
    const rowEl = (event.target as Element).closest?.('[data-node]');
    if (!rowEl) return;
    const id = Number(rowEl.getAttribute('data-node'));
    if (!model.isAlive(id)) return;
    setFocusId(id);
    activate(id);
  };

  const onFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setHasFocus(true);
    if (focusIndex < 0 && total > 0) {
      const sel = selectedId > ROOT ? model.indexOfId(selectedId) : -1;
      const at = sel >= 0 ? sel : clamp(Math.floor(scrollTopRef.current / h), 0, total - 1);
      setFocusId(model.rowAt(at));
    }
  };

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const y = event.currentTarget.scrollTop;
    scrollTopRef.current = y;
    const row = Math.floor(y / h);
    if (row !== firstRow) setFirstRow(row);
  };

  const ringId = hasFocus && keyboard ? focus : -1;
  const activeDescendant = hasFocus && focusIndex >= start && focusIndex < end ? `${domPrefix}-${focus}` : undefined;
  const dotLabel = labels?.markedBelow ?? 'Contains changes';

  const treeStyle = useMemo(
    () =>
      ({
        '--ft-guide': 'color-mix(in oklab, var(--muted-foreground) 28%, transparent)',
        '--ft-guide-strong': 'color-mix(in oklab, var(--muted-foreground) 70%, transparent)',
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
      <div role="presentation" style={{ position: 'relative', height: total * h, minHeight: '100%' }}>
        {rows.map((r) => {
          const path = model.pathOf(r.id);
          const badge = tree.badgeOf(path);
          const totals = r.isDir ? model.totals(r.id) : null;
          const additions = totals ? totals.additions : (badge?.additions ?? 0);
          const deletions = totals ? totals.deletions : (badge?.deletions ?? 0);
          return (
            <RowView
              key={r.id}
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
              count={totals ? totals.count : (badge?.count ?? 0)}
              dot={r.isDir && !r.expanded && r.markedBelow && additions === 0 && deletions === 0}
              dotLabel={dotLabel}
              touch={h >= FILE_TREE_TOUCH_ROW_HEIGHT}
              renderIcon={renderIcon}
            />
          );
        })}
      </div>
    </div>
  );
});
