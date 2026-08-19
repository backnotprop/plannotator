import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { CallFlowNode } from '@plannotator/shared/call-flow-types';
import { getCallFlowTreesForFiles } from '@plannotator/shared/call-flow-types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import {
  CallFlowTreeView,
  selectionForCallFlowNode,
} from './CallFlowTreeView';
import { CallFlowRawView } from './CallFlowRawView';
import { splitCallFlowFilePath } from '../utils/callFlowPresentation';

const CLOSE_DELAY_MS = 250;
// Hover intent: scrolling the diff drags file headers under a stationary
// pointer; without a delay every badge that passes under the cursor pops the
// Lens open.
const OPEN_DELAY_MS = 100;
// After the last scroll event, how long before a pointer that ended up outside
// the Lens is allowed to close it.
const SCROLL_SETTLE_MS = 160;

/** Per-file call-flow Lens. The same shared analysis powers this and the Dock. */
export const CallFlowFileBadge: React.FC<{ filePath: string; oldPath?: string }> = ({ filePath, oldPath }) => {
  const state = useReviewStateOptional();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'paths' | 'raw'>('paths');
  const annotationDraftActiveRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInsideRef = useRef(false);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
  }, []);
  const analysis = state?.callFlowAnalysis;
  const focusFiles = useMemo(
    () => oldPath && oldPath !== filePath ? [filePath, oldPath] : [filePath],
    [filePath, oldPath],
  );
  const impacts = useMemo(() => analysis?.status === 'ready'
    ? [
        ...(analysis.data.fileImpacts[filePath] ?? []),
        ...(oldPath && oldPath !== filePath ? analysis.data.fileImpacts[oldPath] ?? [] : []),
      ]
    : [], [analysis, filePath, oldPath]);
  const trees = useMemo(
    () => analysis?.status === 'ready' ? getCallFlowTreesForFiles(analysis.data.trees, focusFiles) : [],
    [analysis, focusFiles],
  );
  const rawSections = useMemo(() => trees.flatMap((tree, index) => (
    tree.raw === undefined
      ? []
      : [{
          key: `${tree.entry}:${index}`,
          label: tree.entry,
          raw: tree.raw,
          rawLineStart: tree.rawLineStart,
        }]
  )), [trees]);
  const displayPath = useMemo(() => splitCallFlowFilePath(filePath), [filePath]);
  const skippedLanguage = useMemo(() => analysis?.status === 'ready'
    ? analysis.data.skippedLanguages.find((language) => language.files.some((file) => focusFiles.includes(file)))
    : undefined, [analysis, focusFiles]);
  const cancelClose = () => {
    if (!closeTimer.current) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!annotationDraftActiveRef.current) setOpen(false);
    }, CLOSE_DELAY_MS);
  };
  const cancelScheduledOpen = () => {
    if (!openTimer.current) return;
    clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const scheduleOpen = () => {
    cancelClose();
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const closeLens = () => {
    annotationDraftActiveRef.current = false;
    cancelScheduledOpen();
    setOpen(false);
  };
  // Scroll-chaining guard (reported on X for Safari): when the page scrolls —
  // including momentum chained out of the Lens's own scroll container — the
  // popup tracks its moving anchor and can slide out from under a stationary
  // pointer, firing mouseleave and closing the Lens mid-scroll. While a scroll
  // is in flight, hold any pending close; once it settles, close only if the
  // pointer really ended up outside.
  useEffect(() => {
    if (!open) return;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!pointerInsideRef.current && !annotationDraftActiveRef.current) {
          closeTimer.current = setTimeout(() => {
            if (!annotationDraftActiveRef.current) setOpen(false);
          }, CLOSE_DELAY_MS);
        }
      }, SCROLL_SETTLE_MS);
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [open]);
  if (!state || !state.callFlowAvailable || !analysis) return null;
  const openNode = (node: CallFlowNode) => {
    if (!node.file) return;
    state.openDiffFile(node.file);
    state.onLineSelection(selectionForCallFlowNode(node));
    closeLens();
  };
  if (skippedLanguage) {
    return (
      <button
        type="button"
        className="call-flow-file-badge call-flow-file-badge-missing"
        onClick={state.openCallFlowPanel}
        title={`${skippedLanguage.label} support is not installed`}
      >
        <span className="call-flow-file-badge-label">flow</span>
        <span className="call-flow-file-badge-count">—</span>
      </button>
    );
  }

  if (analysis.status === 'idle' || analysis.status === 'loading' || impacts.length === 0) {
    const failed = analysis.status === 'error';
    return (
      <button
        type="button"
        className={`call-flow-file-badge ${failed ? 'call-flow-file-badge-error' : 'call-flow-file-badge-disabled'}`}
        onClick={failed ? state.openCallFlowPanel : undefined}
        disabled={!failed}
        title={failed ? 'Call-flow analysis needs attention' : analysis.status === 'loading' ? 'Tracing call flow…' : 'No changed call paths in this file'}
      >
        <span className="call-flow-file-badge-label">flow</span>
        <span className="call-flow-file-badge-count">{failed ? '!' : analysis.status === 'loading' ? '…' : '0'}</span>
      </button>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && annotationDraftActiveRef.current) return;
        cancelScheduledOpen();
        setOpen(nextOpen);
      }}
    >
      <Popover.Trigger render={
        <button
          type="button"
          className="call-flow-file-badge"
          onMouseEnter={() => { pointerInsideRef.current = true; scheduleOpen(); }}
          onMouseLeave={() => { pointerInsideRef.current = false; cancelScheduledOpen(); scheduleClose(); }}
          title={`${impacts.length} changed call-flow ${impacts.length === 1 ? 'step' : 'steps'} in this file`}
          aria-label={`Call-flow impact for ${filePath}`}
        />
      }>
        <span className="call-flow-file-badge-label">flow</span>
        <span className="call-flow-file-badge-count">{impacts.length}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-[100]">
          <Popover.Popup
            className="call-flow-popover shadow-lg popover-enter"
            data-call-flow-lens="true"
            initialFocus={false}
            onMouseEnter={() => { pointerInsideRef.current = true; cancelClose(); }}
            onMouseLeave={() => { pointerInsideRef.current = false; scheduleClose(); }}
          >
            <div className="call-flow-popover-header">
              <div className="call-flow-popover-title" title={filePath}>
                <span className="call-flow-popover-path">{displayPath.name}</span>
                <span className="call-flow-popover-meta">
                  {trees.length} {trees.length === 1 ? 'path' : 'paths'} · {impacts.length} changed
                </span>
              </div>
              <div className="call-flow-popover-view-switch" aria-label="Call flow Lens view">
                <button type="button" aria-pressed={view === 'paths'} onClick={() => setView('paths')}>Paths</button>
                <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>Raw</button>
              </div>
            </div>
            {view === 'paths' ? (
              <CallFlowTreeView
                trees={trees}
                onOpenNode={openNode}
                onAnnotateTargets={state.onAddCallFlowAnnotation}
                focusFiles={focusFiles}
                canInteractWithNode={state.isCallFlowNodeInPatch}
                onAnnotationDraftChange={(active) => {
                  annotationDraftActiveRef.current = active;
                  if (!active) setOpen(false);
                }}
                defaultExpandedEntries="all"
                initialContext="nearby"
                findShortcutActive={open}
                findShortcutSurface="lens"
                compact
              />
            ) : (
              <CallFlowRawView
                sections={rawSections}
                onAnnotateTargets={state.onAddCallFlowAnnotation}
                onAnnotationDraftChange={(active) => {
                  annotationDraftActiveRef.current = active;
                  if (!active) setOpen(false);
                }}
                findShortcutActive={open}
                findShortcutSurface="lens"
                compact
              />
            )}
            <button type="button" className="call-flow-open-dock" onClick={() => { closeLens(); state.openCallFlowPanel(); }}>
              Open full call flow
              <span aria-hidden="true">→</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
