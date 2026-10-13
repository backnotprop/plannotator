import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDiffFileTree,
  type DiffFileTreeFile,
  type DiffFileTreeNode,
  type DiffFileTreeStatus,
} from '../utils/diffFileTree';
import { useDiffFileTreeExpansion, type DiffFileTreeDefaultExpanded } from '../hooks/useDiffFileTreeExpansion';

export type { DiffFileTreeFile, DiffFileTreeNode, DiffFileTreeStatus } from '../utils/diffFileTree';
export type { DiffFileTreeDefaultExpanded } from '../hooks/useDiffFileTreeExpansion';

/*
 * The diff file tree's presentational parts. Plannotator's code review renders
 * its tree rows from the atoms below (folder row, file-row content, change
 * letter, +/- counts, indentation), adding its review-only decorations
 * (viewed/stage controls, annotation badge, context menu) around them; the
 * `DiffFileTree` component at the bottom is the read-only, embeddable tree a
 * host drops beside its own diff list.
 */

/** Left padding of a row at `depth` (px). */
export function diffFileTreeIndent(depth: number): number {
  return 4 + depth * 8;
}

/** Leading change-type letter — A/D/R/U carry weight and color; modified gets
 * a whisper-quiet M so the column has no holes. Fixed slot keeps names aligned. */
export const ChangeTypeLetter: React.FC<{
  status: DiffFileTreeStatus;
  oldPath?: string;
  untracked?: boolean;
}> = ({ status, oldPath, untracked }) => (
  <span className="w-3 text-center text-[10px] flex-shrink-0">
    {untracked ? (
      <span className="font-semibold text-muted-foreground/70" title="Untracked file">U</span>
    ) : status === 'added' ? (
      <span className="font-semibold text-success" title="Added file">A</span>
    ) : status === 'deleted' ? (
      <span className="font-semibold text-destructive" title="Deleted file">D</span>
    ) : status === 'renamed' ? (
      <span className="font-semibold text-[#007aff]" title={oldPath ? `Renamed from ${oldPath}` : 'Renamed file'}>R</span>
    ) : status === 'binary' ? (
      <span className="font-semibold text-muted-foreground/70" title="Binary file">B</span>
    ) : (
      <span className="text-muted-foreground/40" title="Modified file">M</span>
    )}
  </span>
);

/** Right-anchored +/- pair — one fixed-width block so the numbers always end
 * flush at the row edge, stay tight together, and add-only rows leave no
 * phantom gap. */
export const DiffCounts: React.FC<{ additions: number; deletions: number }> = ({ additions, deletions }) => (
  <span className="min-w-[7ch] text-right whitespace-nowrap flex-shrink-0 text-[10px] tabular-nums">
    {additions > 0 && <span className="additions">+{additions}</span>}
    {additions > 0 && deletions > 0 && <span> </span>}
    {deletions > 0 && <span className="deletions">-{deletions}</span>}
  </span>
);

type FolderRowProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'className' | 'style' | 'children'> & {
  node: Pick<DiffFileTreeNode, 'name' | 'depth' | 'additions' | 'deletions'>;
  isExpanded: boolean;
  onToggle: () => void;
  ref?: React.Ref<HTMLButtonElement>;
};

/** A folder row: chevron, (possibly merged) folder name, summed +/- counts. */
export const DiffFileTreeFolderRow: React.FC<FolderRowProps> = ({ node, isExpanded, onToggle, ...buttonProps }) => (
  <button
    {...buttonProps}
    onClick={onToggle}
    className="w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
    style={{ paddingLeft: diffFileTreeIndent(node.depth) }}
  >
    <svg
      className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
    <span className="truncate">{node.name}</span>
    {(node.additions > 0 || node.deletions > 0) && (
      <div className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px]">
        {node.additions > 0 && (
          <span className="additions">+{node.additions}</span>
        )}
        {node.deletions > 0 && (
          <span className="deletions">-{node.deletions}</span>
        )}
      </div>
    )}
  </button>
);

/**
 * The inside of a file row (render it in a `file-tree-item` row element):
 * `[leading][letter][name][afterName]` then the right-anchored counts.
 * `leading` and `afterName` are where the review puts its viewed/stage
 * controls and annotation badge.
 */
export const DiffFileTreeFileRowContent: React.FC<{
  file: Pick<DiffFileTreeFile, 'status' | 'oldPath' | 'additions' | 'deletions'>;
  name: string;
  untracked?: boolean;
  leading?: React.ReactNode;
  afterName?: React.ReactNode;
}> = ({ file, name, untracked, leading, afterName }) => (
  <>
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      {leading}
      <ChangeTypeLetter status={file.status} oldPath={file.oldPath} untracked={untracked} />
      <span className="truncate">{name}</span>
      {afterName}
    </div>
    <DiffCounts additions={file.additions} deletions={file.deletions} />
  </>
);

// --- Embeddable read-only tree ---

export interface DiffFileTreeProps {
  /** The changed files. Order does not matter; the tree sorts. */
  files: readonly DiffFileTreeFile[];
  /** Path of the selected file (controlled), or null. */
  selectedPath: string | null;
  /** Called with a file's `path` on click, Enter/Space, or arrow/j/k/Home/End. */
  onSelect: (path: string) => void;
  /** Which folders start open; re-applied when the set of files changes. Default 'all'. */
  defaultExpanded?: DiffFileTreeDefaultExpanded;
  /** Accessible name of the tree. Default "Changed files". */
  label?: string;
  className?: string;
}

interface VisibleRow {
  key: string;
  node: DiffFileTreeNode;
  parentKey: string | null;
}

function rowKey(node: DiffFileTreeNode): string {
  return node.type === 'file' ? `file:${node.path}` : `folder:${node.path}`;
}

function collectVisibleRows(
  nodes: DiffFileTreeNode[],
  expanded: Set<string>,
  parentKey: string | null,
  out: VisibleRow[],
): VisibleRow[] {
  for (const node of nodes) {
    const key = rowKey(node);
    out.push({ key, node, parentKey });
    if (node.type === 'folder' && expanded.has(node.path) && node.children) {
      collectVisibleRows(node.children, expanded, key, out);
    }
  }
  return out;
}

/** File paths in the order the tree renders them (collapse state ignored). */
function visualFilePaths(nodes: DiffFileTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'file') out.push(node.path);
    else if (node.children) visualFilePaths(node.children, out);
  }
  return out;
}

/** Content signature, so a host that rebuilds an equal `files` array each
 * render does not reset the folders it opened or closed. */
function filesSignature(files: readonly DiffFileTreeFile[]): string {
  return files.map((f) => `${f.path}\u0000${f.oldPath ?? ''}\u0000${f.status}\u0000${f.additions}\u0000${f.deletions}`).join('\u0001');
}

/**
 * Read-only diff file tree: the same folder collapsing, change letters, +/-
 * counts, icons and indentation as Plannotator's code-review tree, with WAI-ARIA
 * tree semantics. Keyboard (while focus is in the tree, never window-wide):
 * ArrowDown/`j` and ArrowUp/`k` select the next/previous file in tree order,
 * Home/End the first/last (the review's keys); ArrowRight/ArrowLeft open/close
 * a focused folder, and ArrowLeft from a file moves focus to its folder.
 * Theme comes from the ThemeProvider tokens via `@plannotator/ui/styles.css`.
 */
export const DiffFileTree: React.FC<DiffFileTreeProps> = ({
  files,
  selectedPath,
  onSelect,
  defaultExpanded = 'all',
  label = 'Changed files',
  className,
}) => {
  const signature = filesSignature(files);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, not identity
  const tree = useMemo(() => buildDiffFileTree(files), [signature]);
  const filesInOrder = useMemo(() => visualFilePaths(tree), [tree]);

  const { expandedFolders, setFolderExpanded, toggleFolder } = useDiffFileTreeExpansion(tree, selectedPath, defaultExpanded);
  const rows = useMemo(() => collectVisibleRows(tree, expandedFolders, null, []), [tree, expandedFolders]);

  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const selectedKey = selectedPath ? `file:${selectedPath}` : null;
  const rowKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const tabStopKey =
    focusedKey && rowKeys.has(focusedKey)
      ? focusedKey
      : selectedKey && rowKeys.has(selectedKey)
        ? selectedKey
        : rows[0]?.key ?? null;

  // Move DOM focus once the target row exists (selecting a file inside a
  // collapsed folder opens the folder first, one render later).
  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const el = rowRefs.current.get(key);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const focusRow = useCallback((key: string) => {
    setFocusedKey(key);
    pendingFocus.current = key;
    const el = rowRefs.current.get(key);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  }, []);

  const selectFile = useCallback(
    (path: string) => {
      onSelect(path);
      focusRow(`file:${path}`);
    },
    [onSelect, focusRow],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (filesInOrder.length === 0) return;
      const pos = selectedPath ? filesInOrder.indexOf(selectedPath) : -1;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (pos < filesInOrder.length - 1) selectFile(filesInOrder[pos + 1]);
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (pos > 0) selectFile(filesInOrder[pos - 1]);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        selectFile(filesInOrder[0]);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        selectFile(filesInOrder[filesInOrder.length - 1]);
        return;
      }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;

      const current = rows.find((r) => r.key === tabStopKey);
      if (!current) return;
      e.preventDefault();
      const { node } = current;
      if (e.key === 'ArrowRight') {
        if (node.type !== 'folder') return;
        if (!expandedFolders.has(node.path)) {
          setFolderExpanded(node.path, true);
        } else {
          const index = rows.indexOf(current);
          const child = rows[index + 1];
          if (child && child.parentKey === current.key) focusRow(child.key);
        }
        return;
      }
      if (node.type === 'folder' && expandedFolders.has(node.path)) {
        setFolderExpanded(node.path, false);
      } else if (current.parentKey) {
        focusRow(current.parentKey);
      }
    },
    [filesInOrder, selectedPath, selectFile, rows, tabStopKey, expandedFolders, setFolderExpanded, focusRow],
  );

  const setRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  };

  return (
    <div
      role="tree"
      aria-label={label}
      className={className ? `px-1 py-1 ${className}` : 'px-1 py-1'}
      onKeyDown={handleKeyDown}
      data-diff-file-tree=""
    >
      {rows.map(({ key, node }) => {
        const level = node.depth + 1;
        const tabIndex = key === tabStopKey ? 0 : -1;
        if (node.type === 'folder') {
          const isExpanded = expandedFolders.has(node.path);
          return (
            <DiffFileTreeFolderRow
              key={key}
              ref={setRef(key)}
              type="button"
              role="treeitem"
              aria-level={level}
              aria-expanded={isExpanded}
              tabIndex={tabIndex}
              data-path={node.path}
              onFocus={() => setFocusedKey(key)}
              node={node}
              isExpanded={isExpanded}
              onToggle={() => {
                toggleFolder(node.path);
                setFocusedKey(key);
              }}
            />
          );
        }
        const file = node.file!;
        const isActive = node.path === selectedPath;
        return (
          <button
            key={key}
            ref={setRef(key)}
            type="button"
            role="treeitem"
            aria-level={level}
            aria-selected={isActive}
            tabIndex={tabIndex}
            data-path={node.path}
            title={node.path}
            onFocus={() => setFocusedKey(key)}
            onClick={() => selectFile(node.path)}
            className={`file-tree-item w-full text-left group${isActive ? ' active' : ''}`}
            style={{ paddingLeft: diffFileTreeIndent(node.depth) }}
          >
            <DiffFileTreeFileRowContent file={file} name={node.name} />
          </button>
        );
      })}
    </div>
  );
};
