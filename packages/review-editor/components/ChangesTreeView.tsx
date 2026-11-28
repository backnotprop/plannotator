import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { FileTreeRowDecorationContext, FileTreeRowParts, FileTreeSortEntry, GitStatusEntry } from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeNode } from '../utils/buildFileTree';
import type { DiffFile } from '../types';
import { GROUP_ICONS, TreeRowMenu, ancestorsOf, countParts, fileRowParts, gitStatusFor, leadAtRoot, type FileRowState } from './treeRows';
import { treeLook } from './treeLook';
import { useTreeSearchKeys } from './treeSearchKeys';

export interface ChangesTreeGroup {
  key: string;
  label: string;
  tooltip?: string;
  tree: FileTreeNode[];
  paths: readonly string[];
  additions: number;
  deletions: number;
}

export interface ChangesTreeHandle {
  setAllFoldersExpanded: (expanded: boolean) => void;
  focus: () => void;
}

export interface ChangesTreeExtraFile {
  file: DiffFile;
  index: number;
}

export type ChangesTreePick = { via: 'focus' };

interface ChangesTreeViewProps extends FileRowState {
  touch?: boolean;
  searchAccessory?: React.ReactNode;
  tree: FileTreeNode[];
  groups: ChangesTreeGroup[] | null;
  initiallyFoldedGroups?: ReadonlySet<string>;
  activePath: string | null;
  hiddenFiles: ReadonlySet<string>;
  hideViewedFiles: boolean;
  repoRoot?: string | null;
  onSelectFile: (index: number, how?: ChangesTreePick) => void;
  extraFiles?: readonly ChangesTreeExtraFile[];
  onDoubleClickFile?: (index: number) => void;
  handleRef?: React.Ref<ChangesTreeHandle>;
  grouping?: string;
}

const NO_PATHS: ReadonlySet<string> = new Set();
const NO_EXTRA: readonly ChangesTreeExtraFile[] = [];

function expandAll(model: { getItem: (path: string) => unknown }, dirs: readonly string[]) {
  for (const dir of dirs) {
    const item = model.getItem(dir) as { expand?: () => void; isExpanded?: () => boolean } | null;
    if (item?.expand && !item.isExpanded?.()) item.expand();
  }
}
const CHAIN_JOIN = '∕';

type Entry =
  | { kind: 'file'; file: DiffFile; index: number }
  | { kind: 'folder'; node: FileTreeNode }
  | { kind: 'group'; group: ChangesTreeGroup };

interface Layout {
  paths: string[];
  dirs: string[];
  entries: Map<string, Entry>;
  treePathOf: Map<string, string>;
  folderPathOf: Map<string, string>;
  groupDirs: Map<string, string>;
}

function layoutTree(tree: FileTreeNode[], groups: ChangesTreeGroup[] | null, hidden: ReadonlySet<string>, activePath: string | null, extra: readonly ChangesTreeExtraFile[]): Layout {
  const out: Layout = { paths: [], dirs: [], entries: new Map(), treePathOf: new Map(), folderPathOf: new Map(), groupDirs: new Map() };
  const visible = (node: FileTreeNode): boolean =>
    node.type === 'file' ? !hidden.has(node.path) || node.path === activePath : (node.children ?? []).some(visible);
  const walk = (nodes: FileTreeNode[], prefix: string) => {
    for (const node of nodes) {
      if (!visible(node)) continue;
      if (node.type === 'folder') {
        const dir = `${prefix}${node.name.split('/').join(CHAIN_JOIN)}/`;
        out.paths.push(dir);
        out.dirs.push(dir);
        out.entries.set(dir, { kind: 'folder', node });
        out.folderPathOf.set(node.path, dir);
        walk(node.children ?? [], dir);
      } else if (node.file && node.fileIndex != null) {
        const path = `${prefix}${node.name}`;
        out.paths.push(path);
        out.entries.set(path, { kind: 'file', file: node.file, index: node.fileIndex });
        out.treePathOf.set(node.path, path);
      }
    }
  };
  if (groups) {
    for (const group of groups) {
      if (!group.tree.some(visible)) continue;
      const dir = `${group.label}/`;
      out.paths.push(dir);
      out.dirs.push(dir);
      out.entries.set(dir, { kind: 'group', group });
      out.groupDirs.set(group.key, dir);
      walk(group.tree, dir);
    }
  } else {
    walk(tree, '');
  }
  const taken = new Set(out.paths.map((path) => path.replace(/\/$/, '')));
  for (const { file, index } of extra) {
    if (hidden.has(file.path) && file.path !== activePath) continue;
    let path = file.path.split('/').join(CHAIN_JOIN);
    while (taken.has(path)) path += '\u200b';
    taken.add(path);
    out.paths.push(path);
    out.entries.set(path, { kind: 'file', file, index });
    if (!out.treePathOf.has(file.path)) out.treePathOf.set(file.path, path);
  }
  return out;
}

export const ChangesTreeView: React.FC<ChangesTreeViewProps> = (props) => {
  const {
    tree,
    groups,
    initiallyFoldedGroups,
    activePath,
    viewedFiles,
    hiddenFiles,
    hideViewedFiles,
    annotationCounts,
    markdownPreviewedPaths,
    showViewedControls,
    handleRef,
    extraFiles = NO_EXTRA,
  } = props;

  const pinnedPath = hideViewedFiles && activePath && hiddenFiles.has(activePath) ? activePath : null;
  const layout = useMemo(
    () => layoutTree(tree, groups, hideViewedFiles ? hiddenFiles : NO_PATHS, pinnedPath, extraFiles),
    [tree, groups, hideViewedFiles, hiddenFiles, pinnedPath, extraFiles],
  );

  const orderRef = useRef(new Map<string, number>());
  orderRef.current = useMemo(() => new Map(layout.paths.map((path, index) => [path, index])), [layout]);
  const orderOf = (entry: FileTreeSortEntry) =>
    orderRef.current.get(entry.path) ?? orderRef.current.get(`${entry.path}/`) ?? Number.MAX_SAFE_INTEGER;

  const live = useRef({ props, layout });
  live.current = { props, layout };
  const justPicked = useRef<string | null>(null);
  const pick = (entry: { file: DiffFile; index: number }) => {
    justPicked.current = entry.file.path;
    setTimeout(() => {
      if (justPicked.current === entry.file.path) justPicked.current = null;
    }, 0);
    live.current.props.onSelectFile(entry.index);
  };

  const renderParts = useCallback((context: FileTreeRowDecorationContext): FileTreeRowParts | null => rowParts(context), []);

  const rowParts = ({ row }: FileTreeRowDecorationContext): FileTreeRowParts | null => {
    const { props: p, layout: l } = live.current;
    const entry = l.entries.get(row.path);
    if (!entry) return null;
    if (entry.kind === 'group') {
      const total = entry.group.paths.length;
      const viewed = entry.group.paths.filter((path) => p.viewedFiles.has(path)).length;
      return {
        tone: 'heading',
        title: entry.group.tooltip,
        lead: GROUP_ICONS[entry.group.key] ? [GROUP_ICONS[entry.group.key]] : undefined,
        trail: [{ text: `${viewed}/${total}`, title: `${viewed} of ${total} viewed` }, ...countParts(entry.group.additions, entry.group.deletions)],
      };
    }
    if (entry.kind === 'folder') {
      return { trail: countParts(entry.node.additions, entry.node.deletions) };
    }
    return fileRowParts(entry.file, p);
  };

  const gitStatus = useMemo(() => {
    const status: GitStatusEntry[] = [];
    for (const [path, entry] of layout.entries) {
      if (entry.kind !== 'file') continue;
      status.push({ path, status: gitStatusFor(entry.file, props.getSectionEntry) });
    }
    return status;
  }, [layout, props.getSectionEntry]);

  const initialExpanded = useMemo(() => {
    const folded = new Set([...(initiallyFoldedGroups ?? [])].map((key) => layout.groupDirs.get(key)).filter(Boolean));
    return layout.dirs.filter((dir) => !folded.has(dir) && !ancestorsOf(dir).some((a) => folded.has(a)));
  }, []);

  const { model } = useFileTree({
    paths: layout.paths,
    sort: (a: FileTreeSortEntry, b: FileTreeSortEntry) => orderOf(a) - orderOf(b),
    initialExpansion: 'closed',
    flattenEmptyDirectories: false,
    initialExpandedPaths: initialExpanded,
    searchText: (path: string) => {
      const entry = live.current.layout.entries.get(path);
      if (entry?.kind === 'file') return entry.file.path;
      return entry?.kind === 'folder' ? `${entry.node.path}/` : '';
    },
    ...treeLook(!!props.touch),
    gitStatus,
    onSelectionChange: (selected) => {
      const { props: p, layout: l } = live.current;
      const last = selected[selected.length - 1];
      const entry = last ? l.entries.get(last) : undefined;
      if (entry?.kind === 'file') {
        if (entry.file.path !== p.activePath) pick(entry);
        return;
      }
      queueMicrotask(() => syncSelection());
    },
    rows: {
      renderParts,
      onDoubleClick: ({ path }) => {
        const { props: p, layout: l } = live.current;
        const entry = l.entries.get(path);
        if (entry?.kind === 'file') p.onDoubleClickFile?.(entry.index);
      },
      onActivate: ({ path }) => {
        const { props: p, layout: l } = live.current;
        const entry = l.entries.get(path);
        if (entry?.kind === 'file' && entry.file.path === p.activePath) pick(entry);
      },
    },
  });

  const expandedOnce = useRef(false);
  if (!expandedOnce.current) {
    expandedOnce.current = true;
    expandAll(model, initialExpanded);
  }

  const lastActive = useRef<string | null | undefined>(undefined);
  const syncSelection = useCallback((reveal = false) => {
    const { props: p, layout: l } = live.current;
    const target = p.activePath ? l.treePathOf.get(p.activePath) ?? null : null;
    const selected = model.getSelectedPaths();
    if (target && selected.length === 1 && selected[0] === target) return;
    for (const path of selected) model.getItem(path)?.deselect();
    if (!target) return;
    const folded = ancestorsOf(target).filter((dir) => {
      const item = model.getItem(dir);
      return item != null && 'isExpanded' in item && !item.isExpanded();
    });
    if (folded.length > 0 && !reveal) return;
    for (const dir of folded) (model.getItem(dir) as { expand?: () => void } | null)?.expand?.();
    model.getItem(target)?.select();
    model.scrollToPath(target, { focus: false, offset: 'nearest' });
  }, [model]);

  const firstLayout = useRef(layout);
  useEffect(() => {
    if (firstLayout.current === layout) return;
    const before = firstLayout.current;
    firstLayout.current = layout;
    const collapsed = new Set(before.dirs.filter((dir) => {
      const item = model.getItem(dir);
      return item != null && 'isExpanded' in item && !item.isExpanded();
    }));
    const seen = new Set(before.dirs);
    for (const key of initiallyFoldedGroups ?? []) {
      const dir = layout.groupDirs.get(key);
      if (dir && !seen.has(dir)) collapsed.add(dir);
    }
    const open = layout.dirs.filter((dir) => !collapsed.has(dir) && !ancestorsOf(dir).some((a) => collapsed.has(a) && !seen.has(a)));
    model.resetPaths(layout.paths, { initialExpandedPaths: open });
    expandAll(model, open);
    model.setGitStatus(gitStatus);
    syncSelection();
  }, [layout, gitStatus, model, syncSelection, initiallyFoldedGroups]);

  const pendingSync = useRef<{ frame: number; reveal: boolean } | null>(null);
  useEffect(() => {
    const previous = lastActive.current;
    lastActive.current = activePath;
    const reveal = previous !== undefined && previous !== activePath;
    if (previous === undefined || typeof requestAnimationFrame === 'undefined') {
      syncSelection(reveal);
      return;
    }
    if (pendingSync.current) {
      pendingSync.current.reveal ||= reveal;
      return;
    }
    const pending = { frame: 0, reveal };
    pending.frame = requestAnimationFrame(() => {
      pendingSync.current = null;
      syncSelection(pending.reveal);
    });
    pendingSync.current = pending;
  }, [activePath, syncSelection]);
  useEffect(() => () => {
    if (pendingSync.current) cancelAnimationFrame(pendingSync.current.frame);
  }, []);

  useEffect(() => {
    model.refreshRows();
  }, [model, viewedFiles, props.stagedFiles, annotationCounts, markdownPreviewedPaths, showViewedControls, props.threadCount, props.fileLead]);

  const openFocused = useCallback(() => {
    const focused = model.getFocusedPath();
    const { props: p, layout: l } = live.current;
    const entry = focused ? l.entries.get(focused) : undefined;
    if (entry?.kind === 'file' && entry.file.path !== p.activePath && entry.file.path !== justPicked.current) p.onSelectFile(entry.index, { via: 'focus' });
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

  React.useImperativeHandle(handleRef, () => ({
    setAllFoldersExpanded: (expanded: boolean) => {
      const { layout: l } = live.current;
      const keep = expanded ? l.dirs : [...l.groupDirs.values()];
      model.resetPaths(l.paths, { initialExpandedPaths: keep });
      expandAll(model, keep);
      model.setGitStatus(gitStatus);
      syncSelection();
    },
    focus: () => {
      const { props: p, layout: l } = live.current;
      const target = (p.activePath ? l.treePathOf.get(p.activePath) : undefined) ?? l.paths[0];
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
  }), [model, gitStatus, syncSelection]);

  // A marked file at the root, outside any group: the tree makes room for its mark (treeLook).
  const leadRoom = useMemo(() => !groups && leadAtRoot(tree.flatMap((node) => (node.type === 'file' ? [node.path] : [])), props.fileLead), [groups, tree, props.fileLead]);

  return (
    <PierreFileTree
      model={model}
      header={props.searchAccessory}
      className="review-file-tree"
      data-changes-tree=""
      data-review-tree-filter={props.searchAccessory ? '' : undefined}
      data-tree-grouping={props.grouping ?? 'none'}
      data-lead-room={leadRoom ? '' : undefined}
      style={{ height: '100%' }}
      renderContextMenu={(item, context) => {
        const entry = live.current.layout.entries.get(item.path);
        return entry?.kind === 'file' ? <TreeRowMenu path={entry.file.path} repoRoot={live.current.props.repoRoot} close={context.close} anchor={context.anchorRect} /> : null;
      }}
    />
  );
};
