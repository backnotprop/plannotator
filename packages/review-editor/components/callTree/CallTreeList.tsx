import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { CallTreeDoc } from '@plannotator/shared/call-tree';
import { CallFlowSearchControls } from '../CallFlowSearchControls';
import { useCallFlowFindShortcut } from '../../hooks/useCallFlowFindShortcut';
import { CallTree, type CallTreeProps } from './CallTree';

export interface CallTreeListItem {
  readonly key: string;
  readonly doc: CallTreeDoc;
  readonly onBack?: () => void;
  readonly autoFocus?: boolean;
  readonly headerAccessory?: React.ReactNode;
}

type SharedProps = Pick<CallTreeProps, 'onOpen' | 'canOpen' | 'loadNodeSource' | 'onAnnotateTargets'>;

export function CallTreeList({
  trees,
  findShortcutActive = false,
  ...shared
}: SharedProps & {
  readonly trees: readonly CallTreeListItem[];
  readonly findShortcutActive?: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The field answers each key at once; the trees follow as soon as they can,
  // so typing never waits for thousands of rows to be drawn.
  const treeQuery = useDeferredValue(query);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectOnOpen = useRef(false);
  const wasOpen = useRef(false);

  const countHandlers = useMemo(() => new Map(trees.map((tree) => [
    tree.key,
    (count: number) => setCounts((current) => (current.get(tree.key) === count ? current : new Map(current).set(tree.key, count))),
  ])), [trees]);

  const total = trees.reduce((sum, tree) => sum + (counts.get(tree.key) ?? 0), 0);
  const searching = treeQuery.trim().length > 0;
  useEffect(() => {
    if (total > 0 && currentIndex >= total) setCurrentIndex(total - 1);
  }, [currentIndex, total]);

  const active = useMemo(() => {
    if (!searching || total === 0) return null;
    let remaining = currentIndex;
    for (const tree of trees) {
      const count = counts.get(tree.key) ?? 0;
      if (remaining < count) return { key: tree.key, index: remaining };
      remaining -= count;
    }
    return null;
  }, [counts, currentIndex, searching, total, trees]);

  const openFromShortcut = useCallback(() => {
    selectOnOpen.current = true;
    setSearchOpen(true);
  }, []);
  useCallFlowFindShortcut({ active: findShortcutActive, surface: 'dock', searchOpen, inputRef, openSearch: openFromShortcut });

  useEffect(() => {
    if (!searchOpen) {
      if (wasOpen.current) {
        wasOpen.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    wasOpen.current = true;
    inputRef.current?.focus();
    if (selectOnOpen.current) {
      selectOnOpen.current = false;
      inputRef.current?.select();
    }
  }, [searchOpen]);

  const close = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setCurrentIndex(0);
  }, []);
  const move = useCallback((direction: 1 | -1) => {
    if (total === 0) return;
    setCurrentIndex((index) => (index + direction + total) % total);
  }, [total]);

  return (
    <div className="call-flow-call-trees">
      <div className="call-flow-tree-toolbar">
        <div className={`call-flow-tree-actions${searchOpen ? ' call-flow-tree-actions-searching' : ''}`}>
          {searchOpen ? (
            <CallFlowSearchControls
              inputRef={inputRef}
              label="Search call paths"
              placeholder="Find calls or files"
              query={query}
              currentMatchIndex={currentIndex}
              matchCount={total}
              onQueryChange={(next) => {
                setQuery(next);
                setCurrentIndex(0);
              }}
              onMoveMatch={move}
              onClose={close}
            />
          ) : (
            <button
              ref={triggerRef}
              type="button"
              className="call-flow-icon-button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search call paths"
              title="Search call paths (Cmd/Ctrl+F)"
            >
              <Search aria-hidden="true" size={14} />
            </button>
          )}
        </div>
      </div>
      {trees.map((tree) => (
        <CallTree
          key={tree.key}
          doc={tree.doc}
          {...shared}
          {...(tree.onBack ? { onBack: tree.onBack } : {})}
          autoFocus={tree.autoFocus}
          headerAccessory={tree.headerAccessory}
          searchQuery={treeQuery}
          activeMatch={active?.key === tree.key ? active.index : null}
          onMatchCountChange={countHandlers.get(tree.key)}
        />
      ))}
    </div>
  );
}
