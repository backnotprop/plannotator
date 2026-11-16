import React, { useContext, useMemo, useRef, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';
import { PaneSlotContext } from '../workspace/paneContext';
import { SemanticDiffRows, lineSelectionForChange } from '../dock/panels/semanticDiffShared';

const CLOSE_DELAY_MS = 140;
const BADGE = '@max-[479px]/file-header:hidden flex-none w-16 h-6 inline-flex items-center justify-center gap-1 rounded font-mono text-[11px] leading-none text-muted-foreground';
const COUNT = 'w-[3ch] py-px rounded-sm tabular-nums text-center';

export function fileSemanticChanges(all: readonly SemanticDiffChange[] | undefined, filePath: string): SemanticDiffChange[] {
  return all ? all.filter((change) => change.filePath === filePath) : [];
}

export const SemanticFileBadge: React.FC<{ filePath: string }> = ({ filePath }) => {
  const state = useReviewStateOptional();
  const slot = useContext(PaneSlotContext);
  const changes = useMemo(() => fileSemanticChanges(state?.semanticChanges, filePath), [state?.semanticChanges, filePath]);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!state?.semanticDiffAvailable) return null;
  if (changes.length === 0) {
    const pending = state.semanticChanges === undefined;
    return (
      <span
        title={pending ? 'Semantic changes are still being worked out' : 'No semantic changes in this file'}
        data-semantic-file-badge={pending ? 'pending' : 0}
        className={`${BADGE} opacity-50`}
      >
        <span className="font-semibold tracking-[0.02em]">sem</span>
        <span className={COUNT}>{pending ? '–' : 0}</span>
      </span>
    );
  }

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const inAllChanges = slot?.component === REVIEW_PANEL_TYPES.ALL_FILES;
  const openChange = (change: SemanticDiffChange) => {
    const range = lineSelectionForChange(change);
    setOpen(false);
    if (inAllChanges && state.revealInAllChanges && range) {
      state.revealInAllChanges(change.filePath, range);
      return;
    }
    state.openDiffFile(change.filePath);
    state.onLineSelection(range);
  };
  const count = changes.length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            onMouseEnter={() => {
              cancelClose();
              setOpen(true);
            }}
            onMouseLeave={scheduleClose}
            onClick={(event) => event.stopPropagation()}
            title={`${count} semantic change${count === 1 ? '' : 's'} in this file`}
            aria-label={`Semantic changes for ${filePath}: ${count}`}
            data-semantic-file-badge={count}
            className={`${BADGE} transition-colors hover:text-foreground hover:bg-muted data-[popup-open]:text-foreground data-[popup-open]:bg-muted`}
          />
        }
      >
        <span className="font-semibold tracking-[0.02em]">sem</span>
        <span className={`${COUNT} bg-primary/15 text-primary`}>{count}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-[100]">
          <Popover.Popup
            initialFocus={false}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            data-semantic-file-popover=""
            className="w-[min(30rem,90vw)] max-h-[min(24rem,70vh)] overflow-auto p-1.5 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg font-mono text-[13px] leading-[1.55] tabular-nums outline-none popover-enter"
          >
            <div className="flex items-center gap-2 px-2 pt-1 pb-1.5 mb-1 border-b border-border text-muted-foreground">
              <span className="font-semibold tracking-[0.02em]">sem</span>
              <span className="min-w-0 truncate text-foreground" title={filePath}>{filePath}</span>
            </div>
            <div className="semantic-diff-rows">
              <SemanticDiffRows changes={changes} binaryChanges={[]} onOpenChange={openChange} onOpenBinary={() => {}} />
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
