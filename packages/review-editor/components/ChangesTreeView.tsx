import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { preparePresortedFileTreeInput, type FileTreeRowDecorationContext, type FileTreeRowParts, type GitStatusEntry } from '@pierre/trees';
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react';
import type { FileTreeNode } from '../utils/buildFileTree';
import type { DiffFile } from '../types';
import { GROUP_ICONS, ROW_ICONS, TreeRowMenu, ancestorsOf, countColumns, countParts, fileRowParts, gitStatusFor, hasBadge, withoutBadge, type SectionEntry } from './pierreRows';

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
}

interface ChangesTreeViewProps {
  tree: FileTreeNode[];
  groups: ChangesTreeGroup[] | null;
  initiallyFoldedGroups?: ReadonlySet<string>;
  activePath: string | null;
  viewedFiles: ReadonlySet<string>;
  hiddenFiles: ReadonlySet<string>;
  hideViewedFiles: boolean;
  showViewedControls: boolean;
  onToggleViewed?: (path: string) => void;
  stagedFiles: ReadonlySet<string>;
  stagingFile?: string | null;
  showStageControls: boolean;
  onStageFile?: (path: string) => void;
  getSectionEntry?: (path: string) => SectionEntry | undefined;
  annotationCounts: ReadonlyMap<string, number>;
  markdownPreviewedPaths?: ReadonlySet<string>;
  repoRoot?: string | null;
  onSelectFile: (index: number) => void;
  onDoubleClickFile?: (index: number) => void;
  handleRef?: React.Ref<ChangesTreeHandle>;
  grouping?: string;
  threadCount?: (path: string) => number;
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

function layoutTree(tree: FileTreeNode[], groups: ChangesTreeGroup[] | null, hidden: ReadonlySet<string>, activePath: string | null): Layout {
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
    stagedFiles,
    stagingFile,
    annotationCounts,
    markdownPreviewedPaths,
    showViewedControls,
    showStageControls,
    handleRef,
  } = props;

  const layout = useMemo(
    () => layoutTree(tree, groups, hideViewedFiles ? hiddenFiles : new Set<string>(), activePath),
    [tree, groups, hideViewedFiles, hiddenFiles, activePath],
  );

  const sinceBaseMode = props.getSectionEntry != null;
  const stageColumn = showStageControls && (sinceBaseMode ? true : stagedFiles.size > 0);

  const columns = useMemo(() => {
    let add = 0;
    let del = 0;
    let badge = groups != null;
    for (const entry of layout.entries.values()) {
      const counts = entry.kind === 'file' ? entry.file : entry.kind === 'folder' ? entry.node : entry.group;
      add = Math.max(add, counts.additions);
      del = Math.max(del, counts.deletions);
      if (!badge && entry.kind === 'file' && hasBadge(entry.file, props)) badge = true;
    }
    return { add, del, badge };
  }, [layout, groups, annotationCounts, markdownPreviewedPaths, props.threadCount]);

  const live = useRef({ props, layout, stageColumn, badge: columns.badge });
  live.current = { props, layout, stageColumn, badge: columns.badge };

  const renderParts = useCallback((context: FileTreeRowDecorationContext): FileTreeRowParts | null =>
    withoutBadge(rowParts(context), live.current.badge), []);

  const rowParts = ({ row }: FileTreeRowDecorationContext): FileTreeRowParts | null => {
    const { props: p, layout: l, stageColumn: withStage } = live.current;
    const entry = l.entries.get(row.path);
    if (!entry) return null;
    if (entry.kind === 'group') {
      const total = entry.group.paths.length;
      const viewed = entry.group.paths.filter((path) => p.viewedFiles.has(path)).length;
      return {
        tone: 'heading',
        title: entry.group.tooltip,
        lead: GROUP_ICONS[entry.group.key] ? [GROUP_ICONS[entry.group.key]] : undefined,
        trail: [{ text: `${viewed}/${total}`, title: `${viewed} of ${total} viewed` }, ...countParts(entry.group.additions, entry.group.deletions, true)],
      };
    }
    if (entry.kind === 'folder') {
      return { trail: [null, ...countParts(entry.node.additions, entry.node.deletions, true)] };
    }
    return fileRowParts(entry.file, p, withStage);
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
    preparedInput: preparePresortedFileTreeInput(layout.paths),
    initialExpansion: 'closed',
    flattenEmptyDirectories: false,
    initialExpandedPaths: initialExpanded,
    itemHeight: 24,
    icons: { set: 'minimal', colored: false, spriteSheet: ROW_ICONS },
    gitStatus,
    composition: { contextMenu: { triggerMode: 'right-click' } },
    onSelectionChange: (selected) => {
      const { props: p, layout: l } = live.current;
      const last = selected[selected.length - 1];
      const entry = last ? l.entries.get(last) : undefined;
      if (entry?.kind === 'file') {
        if (entry.file.path !== p.activePath) p.onSelectFile(entry.index);
        return;
      }
      queueMicrotask(syncSelection);
    },
    rows: {
      gitStatusPlacement: 'start',
      renderParts,
      onPartClick: ({ partId, path }) => {
        const { props: p, layout: l } = live.current;
        const entry = l.entries.get(path);
        if (entry?.kind !== 'file') return;
        if (partId === 'viewed') p.onToggleViewed?.(entry.file.path);
        if (partId === 'stage' || partId === 'unstage') p.onStageFile?.(entry.file.path);
      },
      onDoubleClick: ({ path }) => {
        const { props: p, layout: l } = live.current;
        const entry = l.entries.get(path);
        if (entry?.kind === 'file') p.onDoubleClickFile?.(entry.index);
      },
    },
  });

  const syncSelection = useCallback(() => {
    const { props: p, layout: l } = live.current;
    const target = p.activePath ? l.treePathOf.get(p.activePath) ?? null : null;
    const selected = model.getSelectedPaths();
    if (target && selected.length === 1 && selected[0] === target) return;
    for (const path of selected) model.getItem(path)?.deselect();
    if (!target) return;
    for (const dir of ancestorsOf(target)) {
      const item = model.getItem(dir);
      if (item && 'expand' in item && !item.isExpanded()) item.expand();
    }
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
    model.resetPaths({
      preparedInput: preparePresortedFileTreeInput(layout.paths),
      initialExpandedPaths: layout.dirs.filter((dir) => !collapsed.has(dir)),
    });
    model.setGitStatus(gitStatus);
    syncSelection();
  }, [layout, gitStatus, model, syncSelection]);

  useEffect(() => {
    syncSelection();
  }, [activePath, syncSelection]);

  useEffect(() => {
    model.refreshRows();
  }, [model, viewedFiles, stagedFiles, stagingFile, annotationCounts, markdownPreviewedPaths, showViewedControls, showStageControls, props.threadCount, columns]);

  useEffect(() => {
    let lastFocused = model.getFocusedPath();
    return model.subscribe(() => {
      const focused = model.getFocusedPath();
      if (focused === lastFocused) return;
      lastFocused = focused;
      const host = model.getFileTreeContainer();
      if (!host || document.activeElement !== host) return;
      const { props: p, layout: l } = live.current;
      const entry = focused ? l.entries.get(focused) : undefined;
      if (entry?.kind === 'file' && entry.file.path !== p.activePath) p.onSelectFile(entry.index);
    });
  }, [model]);

  React.useImperativeHandle(handleRef, () => ({
    setAllFoldersExpanded: (expanded: boolean) => {
      const { layout: l } = live.current;
      const keep = expanded ? l.dirs : [...l.groupDirs.values()];
      model.resetPaths({ preparedInput: preparePresortedFileTreeInput(l.paths), initialExpandedPaths: keep });
      model.setGitStatus(gitStatus);
      syncSelection();
    },
  }), [model, gitStatus, syncSelection]);

  const leadColumns = [showViewedControls ? '14px' : null, stageColumn ? '14px' : null].filter(Boolean).join(' ') || 'none';

  return (
    <PierreFileTree
      model={model}
      className="review-changes-tree"
      data-changes-tree=""
      data-tree-grouping={props.grouping ?? 'none'}
      style={{ '--trees-row-lead-columns': leadColumns, '--trees-row-trail-columns': countColumns(columns.add, columns.del, columns.badge), height: '100%' } as React.CSSProperties}
      renderContextMenu={(item, context) => {
        const entry = live.current.layout.entries.get(item.path);
        return entry?.kind === 'file' ? <TreeRowMenu path={entry.file.path} repoRoot={live.current.props.repoRoot} close={context.close} anchor={context.anchorRect} /> : null;
      }}
    />
  );
};
