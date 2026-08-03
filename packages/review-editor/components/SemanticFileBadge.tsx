import React, { useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type {
  SemanticDiffBinaryChange,
  SemanticDiffChange,
} from '@plannotator/shared/semantic-diff-types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { useFileSemanticChanges } from '../hooks/useFileSemanticChanges';
import { SemanticDiffRows, lineSelectionForChange } from '../dock/panels/semanticDiffShared';

const CLOSE_DELAY_MS = 140;

/**
 * A compact "sem · N" pill shown in a file header. On hover it opens a popover
 * with that file's semantic changes — the same terminal rows as the semantic
 * panel. Renders nothing unless sem is available and the file has named changes.
 */
export const SemanticFileBadge: React.FC<{ filePath: string }> = ({ filePath }) => {
  const state = useReviewStateOptional();
  const available = state?.semanticDiffAvailable === true;
  const { loading, changes, binaryChanges } = useFileSemanticChanges(
    filePath,
    state?.rawPatch ?? '',
    available,
  );

  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const count = changes.length + binaryChanges.length;
  if (!state || !available) return null;
  // Sem is available but this file has no named changes (or is still
  // resolving): show a disabled "sem 0" so every header carries the badge in
  // the same spot — consistent look, aligned buttons, no popover.
  if (loading || count === 0) {
    return (
      <span
        className="semantic-file-badge semantic-file-badge-disabled"
        title="No semantic changes in this file"
        aria-disabled="true"
      >
        <span className="semantic-file-badge-label">sem</span>
        <span className="semantic-file-badge-count">0</span>
      </span>
    );
  }

  const openChange = (change: SemanticDiffChange) => {
    state.openDiffFile(change.filePath);
    state.onLineSelection(lineSelectionForChange(change));
    setOpen(false);
  };
  const openBinary = (change: SemanticDiffBinaryChange) => {
    state.openDiffFile(change.filePath);
    state.onLineSelection(null);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="semantic-file-badge"
            onMouseEnter={() => {
              cancelClose();
              setOpen(true);
            }}
            onMouseLeave={scheduleClose}
            title={`${count} semantic change${count === 1 ? '' : 's'} in this file`}
            aria-label={`Semantic changes for ${filePath}`}
          />
        }
      >
        <span className="semantic-file-badge-label">sem</span>
        <span className="semantic-file-badge-count">{count}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-[100]">
          <Popover.Popup
            className="semantic-diff-popover shadow-lg popover-enter"
            initialFocus={false}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="semantic-diff-popover-header">
              <span className="semantic-file-badge-label">sem</span>
              <span className="semantic-diff-popover-path" title={filePath}>{filePath}</span>
            </div>
            <div className="semantic-diff-popover-rows">
              <SemanticDiffRows
                changes={changes}
                binaryChanges={binaryChanges}
                onOpenChange={openChange}
                onOpenBinary={openBinary}
              />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
