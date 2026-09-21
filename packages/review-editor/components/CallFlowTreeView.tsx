import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CallFlowNode, CallFlowTree } from '@plannotator/shared/call-flow-types';
import { Search } from 'lucide-react';
import { CommentPopover, type CommentTargetChip } from '@plannotator/ui/components/CommentPopover';
import type { CallFlowAnnotationTarget, SelectedLineRange } from '@plannotator/ui/types';
import {
  computeComposerYield,
  distanceToRect,
  type ComposerYieldState,
} from '@plannotator/ui/utils/composerYield';
import { splitCallFlowFilePath } from '../utils/callFlowPresentation';
import { CallFlowSearchControls } from './CallFlowSearchControls';
import {
  useCallFlowFindShortcut,
  type CallFlowFindShortcutSurface,
} from '../hooks/useCallFlowFindShortcut';

/** Map a located CallDiff node to the old/new source range used by code review. */
export function selectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  if (!node.line) return null;
  return {
    start: node.line,
    end: node.endLine && node.endLine >= node.line ? node.endLine : node.line,
    side: node.status === 'removed' ? 'deletions' : 'additions',
  };
}

/** Return the source range for any located Call Flow step. */
export function annotationSelectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  return selectionForCallFlowNode(node);
}

/** Build the durable source metadata carried by a Call Flow annotation. */
export function annotationTargetForCallFlowNode(
  node: CallFlowNode,
  entry: string,
  treePath: string,
): CallFlowAnnotationTarget | null {
  const range = annotationSelectionForCallFlowNode(node);
  const target = {
    treePath,
    entry,
    label: node.label,
    side: range?.side === 'deletions' || node.status === 'removed' ? 'old' as const : 'new' as const,
  };
  if (node.file && range) {
    return {
      ...target,
      filePath: node.file,
      lineStart: Math.min(range.start, range.end),
      lineEnd: Math.max(range.start, range.end),
    };
  }
  if (node.file) return { ...target, filePath: node.file };
  return target;
}

function statusGlyph(status: CallFlowNode['status']): string {
  if (status === 'added') return '+';
  if (status === 'removed') return '−';
  return '·';
}

function CallFlowSearchText({ text, query }: { readonly text: string; readonly query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return text;
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const content: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);
  while (matchIndex !== -1) {
    content.push(text.slice(cursor, matchIndex));
    content.push(
      <mark className="call-flow-tree-match" key={`${matchIndex}:${cursor}`}>
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>,
    );
    cursor = matchIndex + normalizedQuery.length;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }
  content.push(text.slice(cursor));
  return content;
}

interface CallFlowNodeRowProps {
  readonly node: CallFlowNode;
  readonly entry: string;
  readonly depth: number;
  readonly treePath: string;
  readonly onOpen: (node: CallFlowNode) => void;
  readonly onAnnotate?: (
    target: CallFlowAnnotationTarget,
    anchor: HTMLElement,
    extend: boolean,
  ) => void;
  readonly selectedTargetKeys: ReadonlySet<string>;
  readonly focusFiles?: ReadonlySet<string>;
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  /** Nodes visible in the current focused-context projection. */
  readonly changedSubtrees: ReadonlySet<CallFlowNode>;
  /** Nodes on a path to at least one structured-search result. */
  readonly searchSubtrees: ReadonlySet<CallFlowNode>;
  readonly searchQuery: string;
  readonly currentSearchPath?: string;
  readonly showAllContext: boolean;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly fileBoundaryPaths: ReadonlySet<string>;
  readonly onToggleNode: (treePath: string) => void;
}

function CallFlowNodeRow({
  node,
  entry,
  depth,
  treePath,
  onOpen,
  onAnnotate,
  selectedTargetKeys,
  focusFiles,
  canInteractWithNode,
  changedSubtrees,
  searchSubtrees,
  searchQuery,
  currentSearchPath,
  showAllContext,
  collapsedPaths,
  fileBoundaryPaths,
  onToggleNode,
}: CallFlowNodeRowProps) {
  // Complete CallDiff trees can contain thousands of unchanged context nodes.
  // Keep every subtree available, but only open paths that lead to an actual
  // change by default. This preserves the full result without mounting the
  // entire inferred graph into the DOM up front.
  const expanded = !collapsedPaths.has(treePath);
  const hasChildren = showAllContext
    ? node.children.length > 0
    : node.children.some((child) => changedSubtrees.has(child) || searchSubtrees.has(child));
  const inPatch = canInteractWithNode?.(node) ?? true;
  const navigable = Boolean(node.file && node.line && inPatch);
  const annotationTarget = annotationTargetForCallFlowNode(node, entry, treePath);
  const annotatable = Boolean(onAnnotate && annotationTarget);
  const selected = selectedTargetKeys.has(treePath);
  const focused = node.status !== 'same' && Boolean(node.file && focusFiles?.has(node.file));
  const path = node.file ? splitCallFlowFilePath(node.file) : null;
  const startsFileSection = Boolean(path && fileBoundaryPaths.has(treePath));
  const location = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '';
  const targetTitle = annotatable
    ? `${inPatch ? `Comment on ${node.label}.` : `Comment on ${node.label} as Call Flow feedback.`} Shift-click to add or remove this step from the open comment.`
    : navigable
      ? `Open ${location}`
      : node.file && node.line
        ? 'Outside the reviewed patch'
        : node.label;

  return (
    <li className="call-flow-node">
      {startsFileSection && path && node.file && (
        <div
          className="call-flow-file-boundary"
          style={{ '--call-flow-depth': depth } as React.CSSProperties}
          aria-label={`File boundary: ${node.file}`}
          title={node.file}
        >
          <span className="call-flow-file-boundary-label">File</span>
          <span className="call-flow-file-boundary-name">{path.name}</span>
          {path.directory && (
            <span className="call-flow-file-boundary-directory">{path.directory}</span>
          )}
        </div>
      )}
      <div
        className={`call-flow-row call-flow-row-${node.status}${focused ? ' call-flow-row-focused' : ''}${annotatable ? ' call-flow-row-selectable' : ''}${selected ? ' call-flow-row-selected' : ''}${currentSearchPath === treePath ? ' call-flow-row-search-current' : ''}`}
        style={{ '--call-flow-depth': depth } as React.CSSProperties}
        data-call-flow-target={treePath}
      >
        {hasChildren ? (
          <button
            type="button"
            className="call-flow-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.label}`}
            aria-expanded={expanded}
            onClick={() => onToggleNode(treePath)}
          >
            <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
          </button>
        ) : (
          <span className="call-flow-expand" aria-hidden="true" />
        )}
        <span className={`call-flow-status call-flow-status-${node.status}`} aria-label={node.status}>
          {statusGlyph(node.status)}
        </span>
        <button
          type="button"
          className="call-flow-node-target"
          disabled={!annotatable && !navigable}
          aria-pressed={annotatable ? selected : undefined}
          onClick={(event) => {
            if (annotatable && annotationTarget && onAnnotate) {
              const anchor = event.currentTarget.parentElement ?? event.currentTarget;
              onAnnotate(annotationTarget, anchor, event.shiftKey);
              return;
            }
            if (navigable) onOpen(node);
          }}
          title={targetTitle}
        >
          <span className="call-flow-node-label"><CallFlowSearchText text={node.label} query={searchQuery} /></span>
          {node.kind === 'branch' && <span className="call-flow-node-kind">branch</span>}
        </button>
        {path && node.line ? (
          <button
            type="button"
            className="call-flow-node-location"
            disabled={!navigable}
            onClick={() => onOpen(node)}
            title={navigable ? `Open ${location}` : 'Outside the reviewed patch'}
            aria-label={navigable ? `Open ${location}` : `Source ${location} is outside the reviewed patch`}
          >
            <span className="call-flow-node-location-main">
              <span className="call-flow-node-file"><CallFlowSearchText text={path.name} query={searchQuery} /></span>
              <span className="call-flow-node-line">:{node.line}</span>
            </span>
            {path.directory && (
              <span className="call-flow-node-directory"><CallFlowSearchText text={path.directory} query={searchQuery} /></span>
            )}
          </button>
        ) : (
          <span className="call-flow-node-location-placeholder" aria-hidden="true" />
        )}
      </div>
      {hasChildren && expanded && (
        <ol className="call-flow-children">
          {node.children.map((child, index) => (
            !showAllContext && !changedSubtrees.has(child) && !searchSubtrees.has(child) ? null : (
              <CallFlowNodeRow
                key={`${treePath}/${child.key}:${child.status}:${index}`}
                node={child}
                entry={entry}
                depth={depth + 1}
                treePath={`${treePath}/${child.key}:${index}`}
                onOpen={onOpen}
                onAnnotate={onAnnotate}
                selectedTargetKeys={selectedTargetKeys}
                focusFiles={focusFiles}
                canInteractWithNode={canInteractWithNode}
                changedSubtrees={changedSubtrees}
                searchSubtrees={searchSubtrees}
                searchQuery={searchQuery}
                currentSearchPath={currentSearchPath}
                showAllContext={showAllContext}
                collapsedPaths={collapsedPaths}
                fileBoundaryPaths={fileBoundaryPaths}
                onToggleNode={onToggleNode}
              />
            )
          ))}
        </ol>
      )}
    </li>
  );
}

interface CallFlowTreeViewProps {
  readonly trees: readonly CallFlowTree[];
  readonly onOpenNode: (node: CallFlowNode) => void;
  /** Commit one source-backed annotation through the native review model. */
  readonly onAnnotateTargets?: (
    targets: readonly CallFlowAnnotationTarget[],
    text: string,
  ) => boolean;
  /** Changed rows in these files receive the Lens focus treatment. */
  readonly focusFiles?: readonly string[];
  /** Gate navigation and comments to ranges represented by the active patch. */
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  /** Notify a containing popover while the multi-target composer is open. */
  readonly onAnnotationDraftChange?: (active: boolean) => void;
  readonly compact?: boolean;
  /** Entry disclosure used when a new tree result is mounted. */
  readonly defaultExpandedEntries?: 'first' | 'all';
  /** Amount of unchanged structural context shown before the user asks for all of it. */
  readonly initialContext?: 'changed' | 'nearby' | 'all';
  /** True only while this mounted renderer owns the foreground find shortcut. */
  readonly findShortcutActive?: boolean;
  /** Distinguishes a foreground Lens from a retained Dockview portal. */
  readonly findShortcutSurface?: CallFlowFindShortcutSurface;
}

interface CallFlowTreeSearchMatch {
  readonly treePath: string;
  readonly entryPath: string;
  readonly ancestorPaths: readonly string[];
}

function CallFlowEntrySection({
  entry,
  index,
  changedCount,
  changedSubtrees,
  searchSubtrees,
  searchQuery,
  currentSearchPath,
  showAllContext,
  onOpenNode,
  onAnnotate,
  selectedTargetKeys,
  focused,
  canInteractWithNode,
  collapsedPaths,
  fileBoundaryPaths,
  onToggleNode,
  expanded,
  onToggleEntry,
}: {
  readonly entry: CallFlowTree;
  readonly index: number;
  readonly changedCount: number;
  readonly changedSubtrees: ReadonlySet<CallFlowNode>;
  readonly searchSubtrees: ReadonlySet<CallFlowNode>;
  readonly searchQuery: string;
  readonly currentSearchPath?: string;
  readonly showAllContext: boolean;
  readonly onOpenNode: (node: CallFlowNode) => void;
  readonly onAnnotate?: CallFlowNodeRowProps['onAnnotate'];
  readonly selectedTargetKeys: ReadonlySet<string>;
  readonly focused?: ReadonlySet<string>;
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly fileBoundaryPaths: ReadonlySet<string>;
  readonly onToggleNode: (treePath: string) => void;
  readonly expanded: boolean;
  readonly onToggleEntry: (treePath: string) => void;
}) {
  const treePath = `${entry.entry}:${index}`;
  return (
    <section className="call-flow-entry">
      <button
        type="button"
        className="call-flow-entry-header"
        aria-expanded={expanded}
        onClick={() => onToggleEntry(treePath)}
      >
        <span className="call-flow-entry-mark" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
        <span className="call-flow-entry-label">{entry.entry}</span>
        <span className="call-flow-entry-meta">
          {changedCount.toLocaleString()} changed · entry path
        </span>
      </button>
      {expanded && (
        <ol className="call-flow-tree">
          <CallFlowNodeRow
            node={entry.tree}
            entry={entry.entry}
            depth={0}
            treePath={treePath}
            onOpen={onOpenNode}
            onAnnotate={onAnnotate}
            selectedTargetKeys={selectedTargetKeys}
            focusFiles={focused}
            canInteractWithNode={canInteractWithNode}
            changedSubtrees={changedSubtrees}
            searchSubtrees={searchSubtrees}
            searchQuery={searchQuery}
            currentSearchPath={currentSearchPath}
            showAllContext={showAllContext}
            collapsedPaths={collapsedPaths}
            fileBoundaryPaths={fileBoundaryPaths}
            onToggleNode={onToggleNode}
          />
        </ol>
      )}
    </section>
  );
}

/** Shared complete-tree renderer used by both the Dock and the per-file Lens. */
export function CallFlowTreeView({
  trees,
  onOpenNode,
  onAnnotateTargets,
  focusFiles,
  canInteractWithNode,
  onAnnotationDraftChange,
  compact = false,
  defaultExpandedEntries = 'first',
  initialContext = 'changed',
  findShortcutActive = false,
  findShortcutSurface = 'dock',
}: CallFlowTreeViewProps) {
  const focused = useMemo(() => focusFiles ? new Set(focusFiles) : undefined, [focusFiles]);
  const treeShape = useMemo(() => {
    const nodes = new Set<CallFlowNode>();
    const nearbyNodes = new Set<CallFlowNode>();
    const entryChangedCounts = new Map<CallFlowTree, number>();
    let totalNodes = 0;
    const visit = (node: CallFlowNode): { containsChange: boolean; changedCount: number } => {
      totalNodes += 1;
      let containsChange = node.status !== 'same';
      let changedCount = node.status === 'same' ? 0 : 1;
      const childResults = node.children.map(visit);
      for (const childResult of childResults) {
        if (childResult.containsChange) containsChange = true;
        changedCount += childResult.changedCount;
      }
      childResults.forEach((childResult, childIndex) => {
        if (!childResult.containsChange) return;
        const firstNearbyIndex = Math.max(0, childIndex - 1);
        const lastNearbyIndex = Math.min(node.children.length - 1, childIndex + 1);
        for (let nearbyIndex = firstNearbyIndex; nearbyIndex <= lastNearbyIndex; nearbyIndex += 1) {
          const nearbyNode = node.children[nearbyIndex];
          if (nearbyNode) nearbyNodes.add(nearbyNode);
        }
      });
      if (node.status !== 'same') {
        node.children.slice(0, 2).forEach((child) => nearbyNodes.add(child));
      }
      if (containsChange) nodes.add(node);
      return { containsChange, changedCount };
    };
    for (const tree of trees) {
      entryChangedCounts.set(tree, visit(tree.tree).changedCount);
    }
    nodes.forEach((node) => nearbyNodes.add(node));
    return {
      changedSubtrees: nodes as ReadonlySet<CallFlowNode>,
      nearbySubtrees: nearbyNodes as ReadonlySet<CallFlowNode>,
      entryChangedCounts: entryChangedCounts as ReadonlyMap<CallFlowTree, number>,
      totalNodes,
    };
  }, [trees]);
  const { changedSubtrees, nearbySubtrees, entryChangedCounts, totalNodes } = treeShape;
  const defaultSubtrees = initialContext === 'nearby' ? nearbySubtrees : changedSubtrees;
  const focusedContextLabel = initialContext === 'nearby' ? 'Show nearby context' : 'Show changed paths';
  const hiddenContextNodes = initialContext === 'all' ? 0 : totalNodes - defaultSubtrees.size;
  const [showAllContext, setShowAllContext] = useState(initialContext === 'all');
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const entryPaths = useMemo(() => trees.map((entry, index) => `${entry.entry}:${index}`), [trees]);
  const [expandedEntryPaths, setExpandedEntryPaths] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpandedEntries === 'all' ? entryPaths : entryPaths.slice(0, 1)),
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const selectSearchInputRef = useRef(false);
  const searchWasOpenRef = useRef(false);
  const treesRef = useRef<HTMLDivElement>(null);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const treeSearch = useMemo(() => {
    const matches: CallFlowTreeSearchMatch[] = [];
    const subtrees = new Set<CallFlowNode>();
    if (!normalizedSearchQuery) return { matches, subtrees };
    for (const [entryIndex, entry] of trees.entries()) {
      const entryPath = `${entry.entry}:${entryIndex}`;
      const visit = (
        node: CallFlowNode,
        treePath: string,
        ancestorPaths: readonly string[],
      ): boolean => {
        const matchesNode = `${node.label}\n${node.file ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedSearchQuery);
        if (matchesNode) {
          matches.push({ treePath, entryPath, ancestorPaths: [...ancestorPaths, treePath] });
        }
        let containsMatch = matchesNode;
        node.children.forEach((child, childIndex) => {
          if (visit(child, `${treePath}/${child.key}:${childIndex}`, [...ancestorPaths, treePath])) {
            containsMatch = true;
          }
        });
        if (containsMatch) subtrees.add(node);
        return containsMatch;
      };
      visit(entry.tree, entryPath, []);
    }
    return { matches, subtrees };
  }, [normalizedSearchQuery, trees]);
  const searchMatches = treeSearch.matches;
  const searchSubtrees = treeSearch.subtrees as ReadonlySet<CallFlowNode>;
  const currentSearchMatch = searchMatches[currentSearchIndex];
  const allEntriesExpanded = entryPaths.length > 0
    && entryPaths.every((entryPath) => expandedEntryPaths.has(entryPath));

  useEffect(() => {
    setCollapsedPaths(new Set());
    setExpandedEntryPaths(new Set(defaultExpandedEntries === 'all' ? entryPaths : entryPaths.slice(0, 1)));
    setShowAllContext(initialContext === 'all');
    setCurrentSearchIndex(0);
  }, [defaultExpandedEntries, entryPaths, initialContext, trees]);

  useEffect(() => {
    if (currentSearchIndex < searchMatches.length || searchMatches.length === 0) return;
    setCurrentSearchIndex(Math.max(0, searchMatches.length - 1));
  }, [currentSearchIndex, searchMatches.length]);

  const openSearchFromShortcut = useCallback(() => {
    selectSearchInputRef.current = true;
    setSearchOpen(true);
  }, []);
  useCallFlowFindShortcut({
    active: findShortcutActive,
    surface: findShortcutSurface,
    searchOpen,
    inputRef: searchInputRef,
    openSearch: openSearchFromShortcut,
  });

  useEffect(() => {
    if (!searchOpen) {
      if (searchWasOpenRef.current) {
        searchWasOpenRef.current = false;
        searchTriggerRef.current?.focus();
      }
      return;
    }
    searchWasOpenRef.current = true;
    if (selectSearchInputRef.current) {
      selectSearchInputRef.current = false;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!currentSearchMatch) return;
    setExpandedEntryPaths((current) => {
      if (current.has(currentSearchMatch.entryPath)) return current;
      const next = new Set(current);
      next.add(currentSearchMatch.entryPath);
      return next;
    });
    setCollapsedPaths((current) => {
      if (!currentSearchMatch.ancestorPaths.some((path) => current.has(path))) return current;
      const next = new Set(current);
      currentSearchMatch.ancestorPaths.forEach((path) => next.delete(path));
      return next;
    });
  }, [currentSearchMatch, normalizedSearchQuery]);

  useEffect(() => {
    if (!currentSearchMatch) return;
    const target = Array.from(
      treesRef.current?.querySelectorAll<HTMLElement>('[data-call-flow-target]') ?? [],
    ).find((element) => element.dataset.callFlowTarget === currentSearchMatch.treePath);
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [collapsedPaths, currentSearchMatch, expandedEntryPaths]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setCurrentSearchIndex(0);
  }, []);
  const updateSearchQuery = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentSearchIndex(0);
  }, []);
  const moveSearchMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    setCurrentSearchIndex((index) => (
      (index + direction + searchMatches.length) % searchMatches.length
    ));
  }, [searchMatches.length]);
  const toggleEntry = useCallback((entryPath: string) => {
    setExpandedEntryPaths((current) => {
      const next = new Set(current);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }, []);
  const toggleAllEntries = useCallback(() => {
    if (allEntriesExpanded) {
      setExpandedEntryPaths(new Set());
      return;
    }
    setExpandedEntryPaths(new Set(entryPaths));
    setCollapsedPaths(new Set());
  }, [allEntriesExpanded, entryPaths]);
  const toggleNode = useCallback((treePath: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(treePath)) next.delete(treePath);
      else next.add(treePath);
      return next;
    });
  }, []);
  const fileBoundaryPaths = useMemo<ReadonlySet<string>>(() => {
    const boundaries = new Set<string>();
    for (const [entryIndex, entry] of trees.entries()) {
      let previousFile: string | undefined;
      const visit = (node: CallFlowNode, treePath: string) => {
        if (node.file && node.file !== previousFile) boundaries.add(treePath);
        if (node.file) previousFile = node.file;
        if (collapsedPaths.has(treePath)) return;
        node.children.forEach((child, childIndex) => {
          if (!showAllContext && !defaultSubtrees.has(child) && !searchSubtrees.has(child)) return;
          visit(child, `${treePath}/${child.key}:${childIndex}`);
        });
      };
      visit(entry.tree, `${entry.entry}:${entryIndex}`);
    }
    return boundaries;
  }, [collapsedPaths, defaultSubtrees, searchSubtrees, showAllContext, trees]);
  const treeInstanceId = useId();
  const [draftTargets, setDraftTargets] = useState<CallFlowAnnotationTarget[]>([]);
  const [refocusToken, setRefocusToken] = useState(0);
  const [composerYield, setComposerYield] = useState<ComposerYieldState>('none');
  const composerYieldRef = useRef(composerYield);
  composerYieldRef.current = composerYield;
  const shiftHeldRef = useRef(false);
  const primaryTargetKeyRef = useRef<string | undefined>(undefined);
  primaryTargetKeyRef.current = draftTargets[0]
    ? `${treeInstanceId}:${draftTargets[0].treePath}`
    : undefined;
  const targetElements = useRef(new Map<string, HTMLElement>());
  const selectedTargetKeys = useMemo(
    () => new Set(draftTargets.map((target) => target.treePath)),
    [draftTargets],
  );
  const anchorEl = draftTargets[0]
    ? targetElements.current.get(draftTargets[0].treePath)
    : undefined;

  const handleYieldPointer = useCallback((clientX: number, clientY: number) => {
    if (!shiftHeldRef.current) return;
    const popover = Array.from(document.querySelectorAll('[data-comment-popover]')).find((candidate) => (
      candidate.querySelector('[data-target-chip-primary="true"]')?.getAttribute('data-target-chip')
        === primaryTargetKeyRef.current
    ));
    if (!popover) return;
    const next = computeComposerYield(
      composerYieldRef.current,
      distanceToRect(clientX, clientY, popover.getBoundingClientRect()),
    );
    if (next !== composerYieldRef.current) setComposerYield(next);
  }, []);

  useEffect(() => {
    if (draftTargets.length === 0) {
      shiftHeldRef.current = false;
      setComposerYield('none');
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftHeldRef.current = true;
    };
    const release = () => {
      shiftHeldRef.current = false;
      setComposerYield('none');
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') release();
    };
    const onMouseMove = (event: MouseEvent) => {
      if (event.shiftKey) shiftHeldRef.current = true;
      handleYieldPointer(event.clientX, event.clientY);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [draftTargets.length, handleYieldPointer]);

  const replaceDraft = (next: CallFlowAnnotationTarget[]) => {
    const wasActive = draftTargets.length > 0;
    const active = next.length > 0;
    setDraftTargets(next);
    if (wasActive !== active) onAnnotationDraftChange?.(active);
  };

  const selectTarget = (
    target: CallFlowAnnotationTarget,
    anchor: HTMLElement,
    extend: boolean,
  ) => {
    targetElements.current.set(target.treePath, anchor);
    if (!extend || draftTargets.length === 0) {
      replaceDraft([target]);
      return;
    }
    const existingIndex = draftTargets.findIndex((candidate) => candidate.treePath === target.treePath);
    const next = existingIndex === -1
      ? [...draftTargets, target]
      : draftTargets.filter((_, index) => index !== existingIndex);
    replaceDraft(next);
    setRefocusToken((token) => token + 1);
  };

  const removeTarget = (chipKey: string) => {
    replaceDraft(draftTargets.filter((target) => `${treeInstanceId}:${target.treePath}` !== chipKey));
    setRefocusToken((token) => token + 1);
  };

  const targetChips = useMemo<CommentTargetChip[]>(() => draftTargets.map((target) => {
    const sourceLabel = target.filePath
      ? `${splitCallFlowFilePath(target.filePath).name}${target.lineStart ? `:${target.lineStart}` : ''}`
      : 'inferred step';
    return {
      key: `${treeInstanceId}:${target.treePath}`,
      label: sourceLabel,
      excerpt: `${target.entry} → ${target.label}`,
    };
  }), [draftTargets, treeInstanceId]);

  return (
    <>
      <div ref={treesRef} className={`call-flow-trees${compact ? ' call-flow-trees-compact' : ''}`}>
        {trees.length > 0 && (
          <div className="call-flow-tree-toolbar">
            {hiddenContextNodes > 0 && <span className="call-flow-context-summary">
              {showAllContext
                ? `${totalNodes.toLocaleString()} inferred steps`
                : `${hiddenContextNodes.toLocaleString()} more context steps hidden`}
            </span>}
            <div className={`call-flow-tree-actions${searchOpen ? ' call-flow-tree-actions-searching' : ''}`}>
              {hiddenContextNodes > 0 && (
                <button
                  type="button"
                  aria-pressed={showAllContext}
                  onClick={() => setShowAllContext((visible) => !visible)}
                >
                  {showAllContext ? focusedContextLabel : 'Show all context'}
                </button>
              )}
              {searchOpen ? (
                <CallFlowSearchControls
                  inputRef={searchInputRef}
                  label="Search call paths"
                  placeholder="Find calls or files"
                  query={searchQuery}
                  currentMatchIndex={currentSearchIndex}
                  matchCount={searchMatches.length}
                  onQueryChange={updateSearchQuery}
                  onMoveMatch={moveSearchMatch}
                  onClose={closeSearch}
                />
              ) : (
                <button
                  ref={searchTriggerRef}
                  type="button"
                  className="call-flow-icon-button"
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search call paths"
                  title="Search call paths (Cmd/Ctrl+F)"
                >
                  <Search aria-hidden="true" size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={toggleAllEntries}
                aria-label={allEntriesExpanded ? 'Collapse all paths' : 'Expand all paths'}
              >
                {allEntriesExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            </div>
          </div>
        )}
        {trees.map((entry, index) => (
          <CallFlowEntrySection
            key={`${entry.entry}:${index}`}
            entry={entry}
            index={index}
            changedCount={entryChangedCounts.get(entry) ?? 0}
            changedSubtrees={defaultSubtrees}
            searchSubtrees={searchSubtrees}
            searchQuery={searchQuery}
            currentSearchPath={currentSearchMatch?.treePath}
            showAllContext={showAllContext}
            onOpenNode={onOpenNode}
            onAnnotate={onAnnotateTargets ? selectTarget : undefined}
            selectedTargetKeys={selectedTargetKeys}
            focused={focused}
            canInteractWithNode={canInteractWithNode}
            collapsedPaths={collapsedPaths}
            fileBoundaryPaths={fileBoundaryPaths}
            onToggleNode={toggleNode}
            expanded={expandedEntryPaths.has(`${entry.entry}:${index}`)}
            onToggleEntry={toggleEntry}
          />
        ))}
      </div>
      {onAnnotateTargets && anchorEl && draftTargets.length > 0 && (
        <CommentPopover
          anchorEl={anchorEl}
          contextText={`${draftTargets[0].entry} → ${draftTargets[0].label}`}
          isGlobal={false}
          allowImages={false}
          targetChips={targetChips}
          onRemoveTargetChip={removeTarget}
          refocusToken={refocusToken}
          captureStrayKeys
          yieldState={composerYield}
          onSubmit={(text) => {
            if (onAnnotateTargets(draftTargets, text)) replaceDraft([]);
          }}
          onClose={() => replaceDraft([])}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {draftTargets.length > 0
          ? `${draftTargets.length} call-flow ${draftTargets.length === 1 ? 'step' : 'steps'} selected.`
          : ''}
      </span>
    </>
  );
}
