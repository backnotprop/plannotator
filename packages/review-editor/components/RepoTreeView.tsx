import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeRowDecorationContext, FileTreeRowParts, GitStatusEntry } from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import type { RepoOnDiskChange } from '@plannotator/shared/repo-files';
import type { DiffFile } from '../types';
import type { RepoFilesState } from '../hooks/useRepoFiles';
import { initialRepoExpansion } from '../utils/repoTree';
import { prefetchRepoFile } from '../hooks/useRepoFileText';
import { ROW_ICONS, TreeRowMenu, ancestorsOf, fileRowParts, gitStatusFor, hasBadge, stageColumnShown, tightRow, type FileRowState } from './pierreRows';

type ReadyRepoFiles = Extract<RepoFilesState, { status: 'ready' }>;

export interface RepoTreeHandle {
  setAllFoldersExpanded: (expanded: boolean) => void;
}

interface RepoTreeViewProps extends FileRowState {
  touch?: boolean;
  repo: ReadyRepoFiles;
  loadDir: (dir: string) => void;
  files: DiffFile[];
  activePath: string | null;
  showStageControls: boolean;
  onToggleViewed?: (path: string) => void;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  onOpenRepoFile?: (path: string, options: { pin: boolean }) => void;
  repoRoot?: string | null;
  handleRef?: React.Ref<RepoTreeHandle>;
  snapshotId?: string;
}

const ON_DISK_TITLES: Record<RepoOnDiskChange, string> = {
  A: 'Added on disk since this diff was taken. Refresh the diff to review it.',
  M: 'Changed on disk since this diff was taken. Refresh the diff to see it.',
  D: 'Deleted on disk since this diff was taken. Refresh the diff to see it.',
};

const dirPath = (dir: string) => `${dir.replace(/\/$/, '')}/`;
const LOADING = 'Loading\u2026';

function listPaths(repo: ReadyRepoFiles, changed: readonly string[], loading: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  if (repo.paths) {
    for (const path of repo.paths) out.add(path);
  } else {
    for (const entries of repo.dirs.values()) {
      for (const entry of entries) out.add(entry.type === 'dir' ? dirPath(entry.path) : entry.path);
    }
  }
  for (const path of changed) out.add(path);
  for (const dir of loading) if (!repo.dirs.has(dir)) out.add(`${dirPath(dir)}${LOADING}`);
  return [...out];
}

export const RepoTreeView: React.FC<RepoTreeViewProps> = (props) => {
  const { repo, files, activePath, handleRef } = props;
  const changedIndex = useMemo(() => new Map(files.map((file, index) => [file.path, index])), [files]);
  const changedPaths = useMemo(() => files.map((file) => file.path), [files]);
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const paths = useMemo(() => listPaths(repo, changedPaths, loading), [repo, changedPaths, loading]);
  const stageColumn = stageColumnShown(props, props.showStageControls);
  const columns = useMemo(() => {
    let add = 0;
    let del = 0;
    let badge = Object.keys(repo.onDisk).length > 0;
    for (const file of files) {
      add = Math.max(add, file.additions);
      del = Math.max(del, file.deletions);
      if (!badge && hasBadge(file, props)) badge = true;
    }
    if (!badge) for (const count of props.annotationCounts.values()) if (count > 0) badge = true;
    return { add, del, badge };
  }, [files, repo.onDisk, props.annotationCounts, props.markdownPreviewedPaths, props.threadCount]);

  const lastOpened = useRef<string | null>(null);
  const live = useRef({ props, changedIndex, stageColumn, badge: columns.badge });
  live.current = { props, changedIndex, stageColumn, badge: columns.badge };

  const ensureLoaded = useCallback((dir: string) => {
    const { props: p } = live.current;
    if (p.repo.paths) return;
    const key = dir.replace(/\/$/, '');
    if (p.repo.dirs.has(key)) return;
    p.loadDir(key);
    setLoading((was) => (was.has(key) ? was : new Set(was).add(key)));
  }, []);

  useEffect(() => {
    setLoading((was) => {
      const left = [...was].filter((dir) => !repo.dirs.has(dir));
      return left.length === was.size ? was : new Set(left);
    });
  }, [repo.dirs]);

  const renderParts = useCallback((context: FileTreeRowDecorationContext): FileTreeRowParts | null =>
    tightRow(rowParts(context)), []);

  const rowParts = ({ row }: FileTreeRowDecorationContext): FileTreeRowParts | null => {
    if (row.kind === 'directory') return null;
    const { props: p, changedIndex: index, stageColumn: withStage } = live.current;
    if (row.name === LOADING) return { tone: 'loading' };
    const at = index.get(row.path);
    const onDisk = p.repo.onDisk[row.path];
    if (at !== undefined) {
      const parts = fileRowParts(p.files[at], p, withStage);
      if (onDisk && parts.trail) parts.trail = [{ text: '\u25cf', color: 'var(--warning)', title: ON_DISK_TITLES[onDisk] }, ...parts.trail.slice(1)];
      return parts;
    }
    const notes = p.annotationCounts.get(row.path) ?? 0;
    const lead = [p.showViewedControls ? null : undefined, withStage ? null : undefined].filter((cell) => cell !== undefined) as null[];
    return {
      tone: 'repo',
      title: row.path,
      lead,
      trail: [
        onDisk
          ? { text: '●', color: 'var(--warning)', title: ON_DISK_TITLES[onDisk] }
          : notes > 0
            ? { text: String(notes), color: 'var(--primary)', title: `${notes} comment${notes === 1 ? '' : 's'}` }
            : null,
        null,
        null,
      ],
    };
  };

  const gitStatus = useMemo(() => {
    const status: GitStatusEntry[] = files.map((file) => ({ path: file.path, status: gitStatusFor(file, props.getSectionEntry) }));
    for (const [path, change] of Object.entries(repo.onDisk)) {
      if (!changedIndex.has(path) && change !== 'D') status.push({ path, status: change === 'A' ? 'untracked' : 'modified' });
    }
    return status;
  }, [files, repo.onDisk, changedIndex, props.getSectionEntry]);

  const initialExpanded = useMemo(
    () => [...initialRepoExpansion(changedPaths, activePath)].map(dirPath),
    [],
  );

  const { model } = useFileTree({
    paths,
    initialExpansion: 'closed',
    flattenEmptyDirectories: false,
    initialExpandedPaths: initialExpanded,
    itemHeight: props.touch ? 44 : 24,
    icons: { set: 'minimal', colored: false, spriteSheet: ROW_ICONS },
    gitStatus,
    composition: { contextMenu: { triggerMode: 'right-click' } },
    onDirectoryExpand: ensureLoaded,
    search: true,
    fileTreeSearchMode: 'expand-matches',
    onSelectionChange: (selected) => {
      const { props: p, changedIndex: index } = live.current;
      const last = selected[selected.length - 1];
      if (!last || last.endsWith('/') || last.endsWith(`/${LOADING}`)) return;
      const at = index.get(last);
      if (at !== undefined) {
        if (p.files[at].path !== p.activePath) p.onSelectFile(at);
      } else if (last !== p.activePath && last !== lastOpened.current) {
        lastOpened.current = last;
        p.onOpenRepoFile?.(last, { pin: false });
      }
    },
    rows: {
      gitStatusPlacement: 'start',
      nameTruncation: 'middle',
      renderParts,
      onPartClick: ({ partId, path }) => {
        const { props: p } = live.current;
        if (partId === 'viewed') p.onToggleViewed?.(path);
        if (partId === 'stage' || partId === 'unstage') p.onStageFile?.(path);
      },
      onDoubleClick: ({ path }) => {
        const { props: p, changedIndex: index } = live.current;
        const at = index.get(path);
        if (at !== undefined) p.onDoubleClickFile?.(at);
        else if (!path.endsWith(`/${LOADING}`)) p.onOpenRepoFile?.(path, { pin: true });
      },
    },
  });

  useEffect(() => {
    for (const dir of initialExpanded) ensureLoaded(dir);
  }, [initialExpanded, ensureLoaded]);

  const known = useRef(new Set(paths));
  useEffect(() => {
    const added = paths.filter((path) => !known.current.has(path));
    const next = new Set(paths);
    const removed = [...known.current].filter((path) => !next.has(path));
    known.current = next;
    if (added.length === 0 && removed.length === 0) return;
    model.batch([
      ...removed.map((path) => ({ type: 'remove' as const, path, recursive: true })),
      ...added.map((path) => ({ type: 'add' as const, path })),
    ]);
  }, [paths, model]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(() => {
    model.refreshRows();
  }, [model, props.viewedFiles, props.stagedFiles, props.stagingFile, props.annotationCounts, props.markdownPreviewedPaths, props.showViewedControls, props.showStageControls, repo.onDisk, columns]);

  useEffect(() => {
    let lastFocused = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused === lastFocused) return;
      lastFocused = focused;
      const host = model.getFileTreeContainer();
      if (!host?.shadowRoot?.activeElement || !focused) return;
      if (focused.endsWith('/') || focused.endsWith(`/${LOADING}`)) return;
      const { props: p, changedIndex: index } = live.current;
      if (focused === p.activePath) return;
      const at = index.get(focused);
      if (at !== undefined) p.onSelectFile(at);
      else if (focused !== lastOpened.current) {
        lastOpened.current = focused;
        p.onOpenRepoFile?.(focused, { pin: false });
      }
    });
  }, [model]);

  useEffect(() => {
    if (activePath !== lastOpened.current) lastOpened.current = null;
  }, [activePath]);

  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!activePath || !known.current.has(activePath) || revealed.current === activePath) return;
    revealed.current = activePath;
    const selected = model.getSelectedPaths();
    if (!(selected.length === 1 && selected[0] === activePath)) {
      for (const path of selected) model.getItem(path)?.deselect();
      for (const dir of ancestorsOf(activePath)) {
        const item = model.getItem(dir);
        if (item && 'expand' in item && !item.isExpanded()) item.expand();
      }
      model.getItem(activePath)?.select();
    }
    model.scrollToPath(activePath, { focus: false, offset: 'nearest' });
  }, [activePath, paths, model]);

  useEffect(() => {
    const snapshotId = props.snapshotId;
    if (!activePath || !snapshotId) return;
    const all = model.getVisibleRows(0, model.getVisibleCount() - 1);
    const at = all.findIndex((row) => row.path === activePath);
    if (at < 0) return;
    const readable = (row: (typeof all)[number] | undefined) =>
      row && row.kind === 'file' && row.name !== LOADING && !changedIndex.has(row.path);
    const next = all.slice(at + 1).find((row) => row.kind === 'file');
    const previous = all.slice(0, at).reverse().find((row) => row.kind === 'file');
    for (const row of [next, previous]) if (readable(row)) prefetchRepoFile(row!.path, snapshotId);
  }, [activePath, model, props.snapshotId, changedIndex]);

  React.useImperativeHandle(handleRef, () => ({
    setAllFoldersExpanded: (expanded: boolean) => {
      const dirs = expanded ? [...initialRepoExpansion(live.current.props.files.map((f) => f.path), live.current.props.activePath)].map(dirPath) : [];
      model.resetPaths(listPaths(live.current.props.repo, live.current.props.files.map((f) => f.path)), { initialExpandedPaths: dirs });
      model.setGitStatus(gitStatus);
      for (const dir of dirs) ensureLoaded(dir);
    },
  }), [model, gitStatus, ensureLoaded]);

  const leadColumns = [props.showViewedControls ? '14px' : null, stageColumn ? '14px' : null].filter(Boolean).join(' ') || 'none';

  return (
    <PierreFileTree
      model={model}
      className="review-changes-tree"
      data-repo-file-tree=""
      aria-label="All files"
      style={{ '--trees-row-lead-columns': leadColumns, height: '100%' } as React.CSSProperties}
      renderContextMenu={(item, context) =>
        item.kind === 'file' ? <TreeRowMenu path={item.path} repoRoot={live.current.props.repoRoot} close={context.close} anchor={context.anchorRect} /> : null
      }
    />
  );
};
