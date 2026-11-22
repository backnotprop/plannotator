import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileTreeRowDecorationContext, FileTreeRowParts, GitStatusEntry } from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import type { RepoOnDiskChange } from '@plannotator/shared/repo-files';
import type { DiffFile } from '../types';
import type { RepoFilesState } from '../hooks/useRepoFiles';
import { initialRepoExpansion } from '../utils/repoTree';
import { prefetchRepoFile } from '../hooks/useRepoFileText';
import { TreeRowMenu, ancestorsOf, countParts, fileRowParts, folderLineCounts, gitStatusFor, leadAtRoot, notePart, type FileRowState } from './treeRows';
import { treeLook } from './treeLook';
import { useTreeSearchKeys } from './treeSearchKeys';

type ReadyRepoFiles = Extract<RepoFilesState, { status: 'ready' }>;

export interface RepoTreeHandle {
  setAllFoldersExpanded: (expanded: boolean) => void;
  focus: () => void;
}

interface RepoTreeViewProps extends FileRowState {
  touch?: boolean;
  searchAccessory?: React.ReactNode;
  repo: ReadyRepoFiles;
  loadDir: (dir: string) => void;
  files: DiffFile[];
  visiblePaths?: ReadonlySet<string>;
  activePath: string | null;
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

function listPaths(paths: ReadyRepoFiles['paths'], dirs: ReadyRepoFiles['dirs'], changed: readonly string[], loading: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  if (paths) {
    for (const path of paths) out.add(path);
  } else {
    for (const entries of dirs.values()) {
      for (const entry of entries) out.add(entry.type === 'dir' ? dirPath(entry.path) : entry.path);
    }
  }
  for (const path of changed) out.add(path);
  for (const dir of loading) if (!dirs.has(dir)) out.add(`${dirPath(dir)}${LOADING}`);
  return [...out];
}

export const RepoTreeView: React.FC<RepoTreeViewProps> = (props) => {
  const { repo, files, visiblePaths, activePath, handleRef } = props;
  const changedIndex = useMemo(() => new Map(files.map((file, index) => [file.path, index])), [files]);
  const changedPaths = useMemo(
    () => visiblePaths ? [...visiblePaths] : files.map((file) => file.path),
    [files, visiblePaths],
  );
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const paths = useMemo(
    () => listPaths(repo.paths, repo.dirs, changedPaths, loading),
    [repo.paths, repo.dirs, changedPaths, loading],
  );

  const folderCounts = useRef(new Map<string, { additions: number; deletions: number }>());
  folderCounts.current = useMemo(() => folderLineCounts(files), [files]);
  const lastOpened = useRef<string | null>(null);
  const live = useRef({ props, changedIndex, changedPaths, paths });
  live.current = { props, changedIndex, changedPaths, paths };

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

  const renderParts = useCallback((context: FileTreeRowDecorationContext): FileTreeRowParts | null => rowParts(context), []);

  const rowParts = ({ row }: FileTreeRowDecorationContext): FileTreeRowParts | null => {
    const { props: p, changedIndex: index } = live.current;
    if (row.kind === 'directory') {
      const counts = folderCounts.current.get(dirPath(row.path));
      return counts ? { trail: countParts(counts.additions, counts.deletions) } : null;
    }
    if (row.name === LOADING) return { tone: 'loading' };
    const at = index.get(row.path);
    const onDisk = p.repo.onDisk[row.path];
    const mark = onDisk ? { text: '\u25cf', color: 'var(--warning)', title: ON_DISK_TITLES[onDisk] } : notePart(row.path, p);
    if (at !== undefined) return fileRowParts(p.files[at], p, mark);
    return { title: row.path, trail: mark ? [mark] : [] };
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
    ...treeLook(!!props.touch),
    gitStatus,
    onDirectoryExpand: ensureLoaded,
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
      renderParts,
      onDoubleClick: ({ path }) => {
        const { props: p, changedIndex: index } = live.current;
        const at = index.get(path);
        if (at !== undefined) p.onDoubleClickFile?.(at);
        else if (!path.endsWith(`/${LOADING}`)) p.onOpenRepoFile?.(path, { pin: true });
      },
      onActivate: ({ path }) => {
        const { props: p, changedIndex: index } = live.current;
        if (path !== p.activePath || path.endsWith('/')) return;
        const at = index.get(path);
        if (at !== undefined) p.onSelectFile(at);
        else p.onOpenRepoFile?.(path, { pin: false });
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
  }, [model, props.viewedFiles, props.stagedFiles, props.annotationCounts, props.markdownPreviewedPaths, props.showViewedControls, props.threadCount, props.fileLead, repo.onDisk, files]);

  const openFocused = useCallback(() => {
    const focused = model.getFocusedPath();
    if (!focused || focused.endsWith('/') || focused.endsWith(`/${LOADING}`)) return;
    const { props: p, changedIndex: index } = live.current;
    if (focused === p.activePath) return;
    const at = index.get(focused);
    if (at !== undefined) p.onSelectFile(at);
    else if (focused !== lastOpened.current) {
      lastOpened.current = focused;
      p.onOpenRepoFile?.(focused, { pin: false });
    }
  }, [model]);
  const searchKeys = useTreeSearchKeys(model);
  const focusing = useRef(false);

  useEffect(() => {
    let lastFocused = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused === lastFocused) return;
      lastFocused = focused;
      if (focusing.current || !model.getFileTreeContainer()?.shadowRoot?.activeElement || searchKeys.quiet()) return;
      openFocused();
    });
  }, [model, openFocused, searchKeys]);

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
      const { props: p, changedPaths, paths } = live.current;
      const dirs = expanded ? [...initialRepoExpansion(changedPaths, p.activePath)].map(dirPath) : [];
      model.resetPaths(paths, { initialExpandedPaths: dirs });
      model.setGitStatus(gitStatus);
      for (const dir of dirs) ensureLoaded(dir);
    },
    focus: () => {
      const { activePath: active } = live.current.props;
      const target = (active && known.current.has(active) ? active : undefined) ?? model.getVisibleRows(0, 0)[0]?.path;
      if (!target) return;
      focusing.current = true;
      for (const dir of ancestorsOf(target)) (model.getItem(dir) as { expand?: () => void } | null)?.expand?.();
      model.scrollToPath(target, { focus: true, offset: 'nearest' });
      const land = (tries: number) => {
        const rows = model.getFileTreeContainer()?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [];
        const row = [...rows].find((r) => r.dataset.itemPath === target);
        if (!row && tries > 0 && typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(() => land(tries - 1));
          return;
        }
        row?.focus({ preventScroll: true });
        setTimeout(() => { focusing.current = false; }, 0);
      };
      land(4);
    },
  }), [model, gitStatus, ensureLoaded]);

  // A marked changed file at the repository's root: the tree makes room for its mark (treeLook).
  const leadRoom = useMemo(() => leadAtRoot(files.flatMap((file) => (file.path.includes('/') ? [] : [file.path])), props.fileLead), [files, props.fileLead]);

  return (
    <PierreFileTree
      model={model}
      header={props.searchAccessory}
      className="review-file-tree"
      data-repo-file-tree=""
      data-review-tree-filter={props.searchAccessory ? '' : undefined}
      data-lead-room={leadRoom ? '' : undefined}
      aria-label="All files"
      style={{ height: '100%' }}
      renderContextMenu={(item, context) =>
        item.kind === 'file' ? <TreeRowMenu path={item.path} repoRoot={live.current.props.repoRoot} close={context.close} anchor={context.anchorRect} /> : null
      }
    />
  );
};
