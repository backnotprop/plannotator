import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { diffFileTreeIndent } from '@plannotator/ui/components/DiffFileTree';
import type { RepoOnDiskChange } from '@plannotator/shared/repo-files';
import type { DiffFile } from '../types';
import type { RepoFilesState } from '../hooks/useRepoFiles';
import { FileTreeNodeItem } from './FileTreeNode';
import type { FileTreeNode } from '../utils/buildFileTree';
import {
  addRepoDirEntries,
  baseName,
  buildRepoTreeIndex,
  emptyLazyRepoTreeIndex,
  flattenRepoTree,
  type RepoTreeIndex,
  type RepoTreeRow,
} from '../utils/repoTree';

/** Every row has one height, so the list renders only the window on screen. */
export const REPO_TREE_ROW_HEIGHT = 28;
const OVERSCAN_ROWS = 12;
/** Rows drawn before the scroll container has a size (first paint, tests). */
const UNMEASURED_ROWS = 80;

type ReadyRepoFiles = Extract<RepoFilesState, { status: 'ready' }>;

export interface RepoFileTreeProps {
  repo: ReadyRepoFiles;
  loadDir: (dir: string) => void;
  /** The review's changed files: they keep today's rows, badges and controls. */
  files: DiffFile[];
  activeFileIndex: number;
  /** A file of the listing open outside the diff (highlighted like the active row). */
  activeRepoPath?: string | null;
  expanded: ReadonlySet<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  /** Opens a file of the listing that is not in the review. Absent: such rows only show. */
  onOpenRepoFile?: (path: string, options: { pin: boolean }) => void;
  viewedFiles: Set<string>;
  onToggleViewed?: (filePath: string) => void;
  showViewedControls?: boolean;
  annotations: CodeAnnotation[];
  stagedFiles: Set<string>;
  repoRoot?: string | null;
  getSectionEntry?: (filePath: string) => { group: 'committed' | 'changes' | 'untracked'; staged: boolean } | undefined;
  onStageFile?: (filePath: string) => void;
  stagingFile?: string | null;
  showStageControls?: boolean;
  markdownPreviewedPaths?: ReadonlySet<string>;
  scrollHighlightIndex?: number;
  /** The scroll container the rows live in (the panel's scroll area). */
  getScrollElement: () => HTMLElement | null;
}

const ON_DISK_TITLES: Record<RepoOnDiskChange, string> = {
  A: 'Added on disk since this diff was taken. Refresh the diff to review it.',
  M: 'Changed on disk since this diff was taken. Refresh the diff to see it.',
  D: 'Deleted on disk since this diff was taken. Refresh the diff to see it.',
};

/** The amber dot on a file that changed on disk after the diff was taken. */
const OnDiskDot: React.FC<{ change: RepoOnDiskChange }> = ({ change }) => (
  <span
    data-repo-on-disk={change}
    className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0"
    title={ON_DISK_TITLES[change]}
    aria-label={ON_DISK_TITLES[change]}
  />
);

/**
 * The tree's All files: the whole repository at the diff's new side, changed
 * files with today's rows (viewed circle, status letter, +/-, comment badge,
 * staging), everything else muted.
 * Virtualized: only the rows in view are in the DOM.
 */
export const RepoFileTree: React.FC<RepoFileTreeProps> = ({
  repo,
  loadDir,
  files,
  activeFileIndex,
  activeRepoPath,
  expanded,
  onToggleFolder,
  onSelectFile,
  onDoubleClickFile,
  onOpenRepoFile,
  viewedFiles,
  onToggleViewed,
  showViewedControls = true,
  annotations,
  stagedFiles,
  repoRoot,
  getSectionEntry,
  onStageFile,
  stagingFile,
  showStageControls = true,
  markdownPreviewedPaths,
  scrollHighlightIndex,
  getScrollElement,
}) => {
  const changedIndex = useMemo(() => {
    const map = new Map<string, number>();
    files.forEach((file, index) => map.set(file.path, index));
    return map;
  }, [files]);
  const changedPaths = useMemo(() => files.map((file) => file.path), [files]);

  const index: RepoTreeIndex = useMemo(() => {
    if (repo.paths) return buildRepoTreeIndex(repo.paths, changedPaths);
    let built = emptyLazyRepoTreeIndex();
    // Parents first, so every folder lands under a loaded parent.
    const dirs = [...repo.dirs.keys()].sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
    for (const dir of dirs) built = addRepoDirEntries(built, dir, repo.dirs.get(dir) ?? [], changedPaths);
    return built;
  }, [repo.paths, repo.dirs, changedPaths]);

  const rows = useMemo(() => flattenRepoTree(index, expanded), [index, expanded]);

  // Lazy listings: an expanded folder the server has not sent yet is asked for.
  useEffect(() => {
    if (repo.paths) return;
    for (const row of rows) if (row.kind === 'loading') loadDir(row.path);
  }, [rows, repo.paths, loadDir]);

  const annotationCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const annotation of annotations) map.set(annotation.filePath, (map.get(annotation.filePath) ?? 0) + 1);
    return map;
  }, [annotations]);
  const getAnnotationCount = useCallback((path: string) => annotationCounts.get(path) ?? 0, [annotationCounts]);

  // --- Virtual window ---------------------------------------------------
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: UNMEASURED_ROWS });
  const measure = useCallback(() => {
    const scroller = getScrollElement();
    const list = listRef.current;
    if (!scroller || !list) return;
    const viewportHeight = scroller.clientHeight;
    if (viewportHeight <= 0) {
      setRange((current) => (current.start === 0 && current.end === UNMEASURED_ROWS ? current : { start: 0, end: UNMEASURED_ROWS }));
      return;
    }
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const offset = scroller.scrollTop - listTop;
    const start = Math.max(0, Math.floor(offset / REPO_TREE_ROW_HEIGHT) - OVERSCAN_ROWS);
    const end = Math.ceil((offset + viewportHeight) / REPO_TREE_ROW_HEIGHT) + OVERSCAN_ROWS;
    setRange((current) => (current.start === start && current.end === end ? current : { start, end }));
  }, [getScrollElement]);

  useLayoutEffect(() => {
    measure();
  }, [measure, rows.length]);

  useEffect(() => {
    const scroller = getScrollElement();
    if (!scroller) return;
    scroller.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [getScrollElement, measure]);

  // Bring the active file's row into view when it changes (j/k, a click in
  // the diff, a jump) and when the list first holds it (All files just
  // chosen), never again on an expand or a live refresh.
  const activePath = activeRepoPath ?? files[activeFileIndex]?.path ?? null;
  const revealedPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!activePath || revealedPath.current === activePath) return;
    const rowIndex = rows.findIndex((row) => row.kind === 'file' && row.path === activePath);
    const scroller = getScrollElement();
    const list = listRef.current;
    if (rowIndex === -1 || !scroller || !list) return;
    revealedPath.current = activePath;
    if (scroller.clientHeight <= 0) return;
    const listTop = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = listTop + rowIndex * REPO_TREE_ROW_HEIGHT;
    const bottom = top + REPO_TREE_ROW_HEIGHT;
    // Out of view: center it, so the files around it show too.
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, top - (scroller.clientHeight - REPO_TREE_ROW_HEIGHT) / 2);
    }
    measure();
  }, [activePath, rows, getScrollElement, measure]);

  const visible = rows.slice(range.start, Math.min(rows.length, range.end));

  const renderRow = (row: RepoTreeRow) => {
    const paddingLeft = diffFileTreeIndent(row.depth);
    if (row.kind === 'loading') {
      return (
        <div className="flex items-center h-full text-[11px] text-muted-foreground/60" style={{ paddingLeft: paddingLeft + 16 }}>
          Loading…
        </div>
      );
    }
    if (row.kind === 'folder') {
      return (
        <button
          type="button"
          data-repo-folder={row.path}
          aria-expanded={row.expanded}
          onClick={() => onToggleFolder(row.path)}
          className="w-full h-full flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
          style={{ paddingLeft }}
        >
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${row.expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate">{row.name}</span>
        </button>
      );
    }
    const fileIndex = changedIndex.get(row.path);
    const onDisk = repo.onDisk[row.path];
    if (fileIndex !== undefined) {
      const node: FileTreeNode = {
        type: 'file',
        name: row.name,
        path: row.path,
        depth: row.depth,
        fileIndex,
        file: files[fileIndex],
        additions: files[fileIndex].additions,
        deletions: files[fileIndex].deletions,
      };
      return (
        <div className="relative h-full" data-repo-file={row.path} data-repo-changed="">
          <FileTreeNodeItem
            node={node}
            expandedFolders={expanded as Set<string>}
            onToggleFolder={onToggleFolder}
            activeFileIndex={activeRepoPath ? -1 : activeFileIndex}
            scrollHighlightIndex={scrollHighlightIndex}
            onSelectFile={onSelectFile}
            onDoubleClickFile={onDoubleClickFile}
            viewedFiles={viewedFiles}
            onToggleViewed={onToggleViewed}
            showViewedControls={showViewedControls}
            hideViewedFiles={false}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            repoRoot={repoRoot}
            getSectionEntry={getSectionEntry}
            onStageFile={onStageFile}
            stagingFile={stagingFile}
            showStageControls={showStageControls}
            markdownPreviewedPaths={markdownPreviewedPaths}
          />
          {onDisk && (
            <span className="absolute right-[3.25rem] top-1/2 -translate-y-1/2 pointer-events-none">
              <OnDiskDot change={onDisk} />
            </span>
          )}
        </div>
      );
    }
    const isActive = activeRepoPath === row.path;
    const annotationCount = getAnnotationCount(row.path);
    return (
      <button
        type="button"
        data-repo-file={row.path}
        onClick={onOpenRepoFile ? () => onOpenRepoFile(row.path, { pin: false }) : undefined}
        onDoubleClick={onOpenRepoFile ? () => onOpenRepoFile(row.path, { pin: true }) : undefined}
        className={`file-tree-item w-full h-full text-left ${isActive ? 'active' : ''} ${onOpenRepoFile ? '' : 'cursor-default'}`}
        style={{ paddingLeft }}
        title={row.path}
      >
        {showViewedControls && <span className="w-4 h-4 flex-shrink-0" aria-hidden="true" />}
        {onDisk === 'A' || onDisk === 'M' ? (
          <span
            className={`w-3 text-center text-[10px] flex-shrink-0 font-semibold ${onDisk === 'A' ? 'text-success' : 'text-muted-foreground/60'}`}
            aria-hidden="true"
          >
            {onDisk}
          </span>
        ) : (
          <svg className="w-3 h-3 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        )}
        <span className={`truncate ${isActive ? '' : 'text-muted-foreground/80'}`}>{row.name}</span>
        {onDisk && <OnDiskDot change={onDisk} />}
        {annotationCount > 0 && (
          <span className="ml-auto text-[10px] text-primary tabular-nums flex-shrink-0" title={`${annotationCount} comment${annotationCount === 1 ? '' : 's'}`}>
            {annotationCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={listRef}
      role="tree"
      aria-label="All files"
      data-repo-file-tree=""
      className="relative"
      style={{ height: rows.length * REPO_TREE_ROW_HEIGHT }}
    >
      {visible.map((row, offset) => (
        <div
          key={`${row.kind}:${row.path}`}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={row.kind === 'folder' ? row.expanded : undefined}
          className="absolute left-0 right-0"
          style={{ top: (range.start + offset) * REPO_TREE_ROW_HEIGHT, height: REPO_TREE_ROW_HEIGHT }}
        >
          {renderRow(row)}
        </div>
      ))}
    </div>
  );
};

/** A path's name, for callers that need it outside the tree. */
export { baseName as repoBaseName };
