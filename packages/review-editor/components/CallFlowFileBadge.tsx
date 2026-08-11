import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { CallFlowNode } from '@plannotator/shared/call-flow-types';
import { getCallFlowTreesForFiles } from '@plannotator/shared/call-flow-types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import {
  annotationSelectionForCallFlowNode,
  CallFlowTreeView,
  selectionForCallFlowNode,
} from './CallFlowTreeView';

const CLOSE_DELAY_MS = 140;

/** Per-file call-flow Lens. The same shared analysis powers this and the Dock. */
export const CallFlowFileBadge: React.FC<{ filePath: string; oldPath?: string }> = ({ filePath, oldPath }) => {
  const state = useReviewStateOptional();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
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
  const skippedLanguage = useMemo(() => analysis?.status === 'ready'
    ? analysis.data.skippedLanguages.find((language) => language.files.some((file) => focusFiles.includes(file)))
    : undefined, [analysis, focusFiles]);
  if (!state || !state.callFlowAvailable || !analysis) return null;
  const cancelClose = () => {
    if (!closeTimer.current) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const openNode = (node: CallFlowNode) => {
    if (!node.file) return;
    state.openDiffFile(node.file);
    state.onLineSelection(selectionForCallFlowNode(node));
    setOpen(false);
  };
  const commentOnNode = (node: CallFlowNode) => {
    if (!node.file) return;
    const range = annotationSelectionForCallFlowNode(node);
    if (!range) return;
    setOpen(false);
    state.onRequestLineAnnotation(node.file, range);
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
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={
        <button
          type="button"
          className="call-flow-file-badge"
          onMouseEnter={() => { cancelClose(); setOpen(true); }}
          onMouseLeave={scheduleClose}
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
            initialFocus={false}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="call-flow-popover-header">
              <span className="call-flow-file-badge-label">flow</span>
              <span className="call-flow-popover-path" title={filePath}>{filePath}</span>
              <span className="call-flow-file-badge-count">{impacts.length}</span>
            </div>
            <div className="call-flow-popover-summary">
              {trees.length} complete entry {trees.length === 1 ? 'path' : 'paths'} containing {impacts.length} changed {impacts.length === 1 ? 'step' : 'steps'} in this file
            </div>
            <CallFlowTreeView
              trees={trees}
              onOpenNode={openNode}
              onCommentNode={commentOnNode}
              focusFiles={focusFiles}
              canInteractWithNode={state.isCallFlowNodeInPatch}
              compact
            />
            <button type="button" className="call-flow-open-dock" onClick={() => { setOpen(false); state.openCallFlowPanel(); }}>
              Open full call flow
              <span aria-hidden="true">→</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
