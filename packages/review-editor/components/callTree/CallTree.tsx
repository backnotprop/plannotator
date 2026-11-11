import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  buildCallTreeRows,
  callTreeRowFoldedByDefault,
  type CallTreeDoc,
  type CallTreeNode,
  type CallTreeRow,
} from '@plannotator/shared/call-tree';
import { CommentPopover, type CommentTargetChip } from '@plannotator/ui/components/CommentPopover';
import { CodeSnippetPreview } from '@plannotator/ui/components/CodeSnippetPreview';
import { useHoverPreview } from '@plannotator/ui/hooks/useHoverPreview';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import { splitCallFlowSignature } from '../../utils/callFlowPresentation';
import type { CallFlowNodeSource, CallFlowNodeSourceLoader } from '../../hooks/useCallFlowNodeSource';
import { annotationTargetForCallFlowNode, CALL_FLOW_PREVIEW_CONTEXT_LINES } from '../CallFlowTreeView';
import { useReviewCallTreeShortcuts } from './callTree.shortcuts';

/**
 * The Call tree: one function's calls, one per row, with tree lines and the
 * `file:line` on the right. Fed by one `CallTreeDoc` and callbacks only; it
 * reads no review state, so a Guided Review chapter or the Inbox review can
 * mount it as it is (phase 3).
 */
export interface CallTreeProps {
  readonly doc: CallTreeDoc;
  /** Open a row's line (click, Enter). */
  readonly onOpen: (node: CallTreeNode) => void;
  /** False: the row has nowhere to open (its location is not reachable here). */
  readonly canOpen?: (node: CallTreeNode) => boolean;
  /** Loads the source a location's hover preview shows (#2322); absent, no preview. */
  readonly loadNodeSource?: CallFlowNodeSourceLoader;
  /** Commit a comment on rows; absent, rows cannot be commented. */
  readonly onAnnotateTargets?: (targets: readonly CallFlowAnnotationTarget[], text: string) => boolean;
  /** Escape: back to where the tree was opened from. */
  readonly onBack?: () => void;
  /** Take keyboard focus on mount (a tree opened from a hunk). */
  readonly autoFocus?: boolean;
  /** Extra controls drawn at the end of the header line. */
  readonly headerAccessory?: React.ReactNode;
}

/** The last two path segments: `shapes/note/NoteShapeUtil.tsx` -> `note/NoteShapeUtil.tsx`. */
export function shortCallTreePath(file: string): string {
  return file.split('/').slice(-2).join('/');
}

/** `:line` when the call stays in its caller's file, `dir/file:line` when it moves. */
export function callTreeLocationText(row: Pick<CallTreeRow, 'node' | 'callerFile'>): string {
  const { node } = row;
  if (!node.file || !node.line) return '';
  return node.file === row.callerFile ? `:${node.line}` : `${shortCallTreePath(node.file)}:${node.line}`;
}

function RowLabel({ node }: { readonly node: CallTreeNode }) {
  if (node.kind === 'branch') return <span className="call-tree-branch-label">{node.label}</span>;
  const parts = splitCallFlowSignature(node.label);
  return (
    <span className="call-tree-signature">
      {parts.receiver && <span className="call-tree-receiver">{parts.receiver}</span>}
      <span className="call-tree-name">{parts.name}</span>
      {parts.rest && <span className="call-tree-args">{parts.rest}</span>}
    </span>
  );
}

interface RowProps {
  readonly row: CallTreeRow;
  readonly domId: string;
  readonly current: boolean;
  readonly openable: boolean;
  readonly commentable: boolean;
  readonly commenting: boolean;
  readonly loadNodeSource?: CallFlowNodeSourceLoader;
  readonly onSelect: (row: CallTreeRow, open: boolean) => void;
  readonly onToggle: (row: CallTreeRow) => void;
  readonly onComment: (row: CallTreeRow, anchor: HTMLElement) => void;
  readonly registerRow: (id: string, element: HTMLElement | null) => void;
}

const CallTreeRowView = memo(function CallTreeRowView({
  row,
  domId,
  current,
  openable,
  commentable,
  commenting,
  loadNodeSource,
  onSelect,
  onToggle,
  onComment,
  registerRow,
}: RowProps) {
  const { node } = row;
  const location = callTreeLocationText(row);
  const fullLocation = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '';
  // Dillon Mulroy's source preview (#2322): the same hook, window and loader as the Paths cards.
  const sourcePreview = useHoverPreview<CallFlowNodeSource>(
    () => loadNodeSource?.(node) ?? Promise.resolve(null),
    Boolean(loadNodeSource && node.file && node.line),
  );
  const expandable = row.childCount > 0 && !row.repeat;
  const className = [
    'call-tree-row',
    row.band ? `call-tree-band call-tree-band-${row.band}` : '',
    current ? 'call-tree-row-current' : '',
    commenting ? 'call-tree-row-commenting' : '',
    openable ? 'call-tree-row-openable' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      id={domId}
      ref={(element) => registerRow(row.id, element)}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={current}
      aria-expanded={expandable ? !row.folded : undefined}
      className={className}
      data-call-tree-row={row.id}
      onClick={() => onSelect(row, openable)}
    >
      <span className="call-tree-gutter" aria-hidden="true">
        {row.band === 'added' ? '+' : row.band === 'removed' ? '−' : ''}
      </span>
      {commentable && (
        <button
          type="button"
          tabIndex={-1}
          className="call-tree-comment"
          aria-label={`Comment on ${node.label}`}
          title={`Comment on ${node.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onComment(row, event.currentTarget.parentElement ?? event.currentTarget);
          }}
        >
          +
        </button>
      )}
      <span className="call-tree-body">
        {row.guides.map((guide, index) => (
          <span key={index} className="call-tree-guide" aria-hidden="true">{guide === 'pipe' ? '│' : ''}</span>
        ))}
        {row.branch && (
          <span className="call-tree-guide call-tree-connector" aria-hidden="true">
            {row.branch === 'tee' ? '├' : '└'}<span className="call-tree-dash">──</span>
          </span>
        )}
        {expandable ? (
          <span
            className="call-tree-twist"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(row);
            }}
          >
            {row.folded ? '▸' : '▾'}
          </span>
        ) : (
          <span className="call-tree-twist" aria-hidden="true" />
        )}
        {row.dot && <span className={`call-tree-dot call-tree-dot-${row.dot}`} aria-hidden="true" />}
        {node.status === 'added' && <span className="sr-only">New: </span>}
        {node.status === 'removed' && <span className="sr-only">Removed: </span>}
        <span className={`call-tree-label call-tree-label-${node.status}`}>
          {node.provenance === 'agent' && <span className="call-tree-pencil" aria-hidden="true">✎ </span>}
          <RowLabel node={node} />
        </span>
        {node.notes?.map((note, index) => (
          <span key={index} className="call-tree-note">
            {note.provenance === 'agent' && <span className="call-tree-pencil" aria-hidden="true">✎ </span>}
            {note.text}
          </span>
        ))}
        {row.folded && <span className="call-tree-count">{row.childCount} {row.childCount === 1 ? 'call' : 'calls'}</span>}
        {row.repeat && <span className="call-tree-repeat">↑ above</span>}
      </span>
      <span className="call-tree-ref">
        {openable && <span className="call-tree-open" aria-hidden="true">⏎ open</span>}
        {location && (
          <button
            type="button"
            className="call-tree-location"
            tabIndex={current ? 0 : -1}
            ref={(element) => { sourcePreview.anchorRef.current = element; }}
            disabled={!openable}
            onMouseEnter={sourcePreview.onEnter}
            onMouseLeave={sourcePreview.onLeave}
            onFocus={sourcePreview.onEnter}
            onBlur={sourcePreview.onLeave}
            onClick={(event) => {
              event.stopPropagation();
              sourcePreview.dismiss();
              onSelect(row, openable);
            }}
            title={openable ? `Open ${fullLocation}` : 'Outside the reviewed patch'}
            aria-label={openable ? `Open ${fullLocation}` : `Source ${fullLocation} is outside the reviewed patch`}
          >
            {location}
          </button>
        )}
      </span>
      {sourcePreview.preview && node.line && (
        <CodeSnippetPreview
          anchorEl={sourcePreview.anchorRef.current}
          contents={sourcePreview.preview.contents}
          filepath={sourcePreview.preview.filepath}
          title={sourcePreview.preview.filepath}
          line={node.line}
          lineEnd={node.endLine && node.endLine > node.line ? node.endLine : undefined}
          contextLines={CALL_FLOW_PREVIEW_CONTEXT_LINES}
          onDismiss={sourcePreview.dismiss}
          {...sourcePreview.previewHandlers}
        />
      )}
    </div>
  );
});

/** The nearest row still drawn for an id that may have been folded away. */
function nearestDrawn(id: string, drawn: ReadonlySet<string>, fallback: string): string {
  let candidate = id;
  while (candidate && !drawn.has(candidate)) {
    const slash = candidate.lastIndexOf('/');
    if (slash === -1) return fallback;
    candidate = candidate.slice(0, slash);
  }
  return candidate || fallback;
}

export function CallTree({
  doc,
  onOpen,
  canOpen,
  loadNodeSource,
  onAnnotateTargets,
  onBack,
  autoFocus = false,
  headerAccessory,
}: CallTreeProps) {
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [changesOnly, setChangesOnly] = useState(false);
  const rows = useMemo(() => buildCallTreeRows(doc, { folds, changesOnly }), [doc, folds, changesOnly]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
  const [currentId, setCurrentId] = useState(doc.rootPath);
  const resolvedCurrentId = rowIndex.has(currentId)
    ? currentId
    : nearestDrawn(currentId, new Set(rowIndex.keys()), doc.rootPath);
  const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
  const rowElements = useRef(new Map<string, HTMLElement>());
  const idPrefix = useId();
  const [draft, setDraft] = useState<{ row: CallTreeRow; anchor: HTMLElement } | null>(null);

  useEffect(() => {
    if (resolvedCurrentId !== currentId) setCurrentId(resolvedCurrentId);
  }, [currentId, resolvedCurrentId]);

  useEffect(() => {
    if (autoFocus) treeElement?.focus({ preventScroll: false });
  }, [autoFocus, treeElement]);

  const registerRow = useCallback((id: string, element: HTMLElement | null) => {
    if (element) rowElements.current.set(id, element);
    else rowElements.current.delete(id);
  }, []);

  const isOpenable = useCallback(
    (node: CallTreeNode) => Boolean(node.file && node.line) && (canOpen?.(node) ?? true),
    [canOpen],
  );

  const reveal = useCallback((id: string) => {
    setCurrentId(id);
    requestAnimationFrame(() => rowElements.current.get(id)?.scrollIntoView?.({ block: 'nearest' }));
  }, []);

  const toggle = useCallback((row: CallTreeRow) => {
    setFolds((current) => {
      const next = new Map(current);
      const folded = !row.folded;
      if (folded === callTreeRowFoldedByDefault(row)) next.delete(row.id);
      else next.set(row.id, folded);
      return next;
    });
  }, []);

  const select = useCallback((row: CallTreeRow, open: boolean) => {
    setCurrentId(row.id);
    if (open) onOpen(row.node);
  }, [onOpen]);

  const startComment = useCallback((row: CallTreeRow, anchor: HTMLElement) => {
    if (!onAnnotateTargets) return;
    setCurrentId(row.id);
    setDraft({ row, anchor });
  }, [onAnnotateTargets]);

  const current = rows[rowIndex.get(resolvedCurrentId) ?? 0];
  const handled = (event: KeyboardEvent) => event.stopPropagation();
  useReviewCallTreeShortcuts({
    target: treeElement,
    handlers: {
      moveDown: (event) => {
        handled(event);
        const index = rowIndex.get(resolvedCurrentId) ?? 0;
        const next = rows[Math.min(rows.length - 1, index + 1)];
        if (next) reveal(next.id);
      },
      moveUp: (event) => {
        handled(event);
        const index = rowIndex.get(resolvedCurrentId) ?? 0;
        const next = rows[Math.max(0, index - 1)];
        if (next) reveal(next.id);
      },
      fold: (event) => {
        handled(event);
        if (!current) return;
        if (current.childCount > 0 && !current.repeat && !current.folded) toggle(current);
        else if (current.parentId) reveal(current.parentId);
      },
      unfold: (event) => {
        handled(event);
        if (!current) return;
        if (current.childCount > 0 && !current.repeat && current.folded) toggle(current);
        else if (current.childCount > 0 && !current.repeat) {
          const first = rows[(rowIndex.get(current.id) ?? 0) + 1];
          if (first) reveal(first.id);
        }
      },
      open: (event) => {
        handled(event);
        if (current && isOpenable(current.node)) onOpen(current.node);
      },
      comment: {
        when: () => Boolean(onAnnotateTargets),
        handle: (event) => {
          handled(event);
          if (!current) return;
          const element = rowElements.current.get(current.id);
          if (element) startComment(current, element);
        },
      },
      back: {
        when: () => Boolean(onBack),
        handle: (event) => {
          handled(event);
          event.preventDefault();
          onBack?.();
        },
      },
    },
  });

  const draftTargets = useMemo<CallFlowAnnotationTarget[]>(() => {
    if (!draft) return [];
    const target = annotationTargetForCallFlowNode(draft.row.node, doc.entry, draft.row.id);
    return target ? [target] : [];
  }, [doc.entry, draft]);
  const targetChips = useMemo<CommentTargetChip[]>(() => draftTargets.map((target) => ({
    key: `${idPrefix}:${target.treePath}`,
    label: target.filePath
      ? `${target.filePath.split('/').pop()}${target.lineStart ? `:${target.lineStart}` : ''}`
      : 'inferred step',
    excerpt: `${target.entry} → ${target.label}`,
  })), [draftTargets, idPrefix]);

  const closeDraft = () => {
    setDraft(null);
    treeElement?.focus({ preventScroll: true });
  };

  const domIdOf = (index: number) => `${idPrefix}-row-${index}`;
  const currentIndex = rowIndex.get(resolvedCurrentId) ?? 0;

  return (
    <section className="call-tree" aria-label={`Call tree ${doc.title}`}>
      <header className="call-tree-head">
        <h3 className="call-tree-title">{doc.title}</h3>
        <span className="call-tree-provenance">
          <span className="call-tree-provenance-dot" aria-hidden="true" />
          calls from analysis of the diff
        </span>
        <span className="call-tree-head-actions">
          <button
            type="button"
            className="call-tree-filter"
            aria-pressed={changesOnly}
            onClick={() => setChangesOnly((value) => !value)}
          >
            Changes only
          </button>
          {headerAccessory}
        </span>
        {doc.trail.length > 0 && (
          <p className="call-tree-trail">from {doc.trail.join(' › ')}</p>
        )}
      </header>
      <div
        ref={setTreeElement}
        className="call-tree-rows"
        role="tree"
        tabIndex={0}
        aria-label={`Call tree ${doc.title}`}
        aria-activedescendant={rows.length > 0 ? domIdOf(currentIndex) : undefined}
      >
        {rows.map((row, index) => (
          <CallTreeRowView
            key={row.id}
            row={row}
            domId={domIdOf(index)}
            current={row.id === resolvedCurrentId}
            openable={isOpenable(row.node)}
            commentable={Boolean(onAnnotateTargets)}
            commenting={draft?.row.id === row.id}
            loadNodeSource={loadNodeSource}
            onSelect={select}
            onToggle={toggle}
            onComment={startComment}
            registerRow={registerRow}
          />
        ))}
      </div>
      {draft && onAnnotateTargets && draftTargets.length > 0 && (
        <CommentPopover
          anchorEl={draft.anchor}
          contextText={`${draftTargets[0]!.entry} → ${draftTargets[0]!.label}`}
          isGlobal={false}
          allowImages={false}
          targetChips={targetChips}
          captureStrayKeys
          onSubmit={(text) => {
            if (onAnnotateTargets(draftTargets, text)) closeDraft();
          }}
          onClose={closeDraft}
        />
      )}
    </section>
  );
}
