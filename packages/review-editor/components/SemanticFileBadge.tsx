import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown } from 'lucide-react';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';
import { PaneSlotContext } from '../workspace/paneContext';
import { SemanticDiffRows, lineSelectionForChange } from '../dock/panels/semanticDiffShared';
import { semanticNoteCount, semanticNoteParts, type SemanticFileState } from '../semDiff/semanticFileState';

const CLOSE_DELAY_MS = 140;
const BADGE = 'flex-none w-[4.25rem] h-6 inline-flex items-center justify-center gap-1 rounded font-mono text-[11px] leading-none text-muted-foreground';
const NARROW_HIDDEN = '@max-[479px]/file-header:hidden';
const REACH = 'relative before:absolute before:inset-x-0 before:-inset-y-2';
const REACH_COARSE = 'relative [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:inset-x-0 [@media(pointer:coarse)]:before:-inset-y-2';
const COUNT = 'w-[3ch] py-px rounded-sm tabular-nums text-center';
const TIGHT_CHIP = '@max-[339px]/file-header:w-auto @max-[339px]/file-header:px-1';
const TIGHT_WORD = '@max-[339px]/file-header:hidden';

export type SemanticFileSwitch = { state: SemanticFileState; onToggle: () => void };

export function fileSemanticChanges(all: readonly SemanticDiffChange[] | undefined, filePath: string): SemanticDiffChange[] {
  return all ? all.filter((change) => change.filePath === filePath) : [];
}

const ShowInDiff: React.FC<{ on: boolean; onToggle: () => void }> = ({ on, onToggle }) => (
  <button type="button" role="switch" aria-checked={on} data-semantic-switch="" onClick={onToggle} className="ml-auto flex flex-none items-center gap-2 font-sans text-xs text-muted-foreground hover:text-foreground">
    <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${on ? 'bg-primary' : 'bg-muted-foreground/25'}`}>
      <span className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </span>
    Show in the diff
  </button>
);

export const SemanticFileBadge: React.FC<{ filePath: string; semantic?: SemanticFileSwitch; touch?: boolean }> = ({ filePath, semantic, touch = false }) => {
  const state = useReviewStateOptional();
  const slot = useContext(PaneSlotContext);
  const changes = useMemo(() => fileSemanticChanges(state?.semanticChanges, filePath), [state?.semanticChanges, filePath]);
  const [open, setOpen] = useState(false);
  const found = semantic && semantic.state.status !== 'working' ? semantic.state : null;
  const shown = semantic != null || state?.semanticDiffAvailable === true;
  const interactive = shown && (found != null || (!touch && changes.length > 0));
  useEffect(() => {
    if (!interactive) setOpen(false);
  }, [interactive]);
  if (!shown) return null;
  if (!found && touch) return null;
  if (!found && changes.length === 0) {
    const pending = semantic?.state.status === 'working' || state?.semanticChanges === undefined;
    return (
      <span
        title={pending ? 'Semantic changes are still being worked out' : 'No semantic changes in this file'}
        data-semantic-file-badge={pending ? 'pending' : 0}
        data-semantic-note={semantic?.state.status}
        className={`${BADGE} ${NARROW_HIDDEN} opacity-50`}
      >
        <span className="font-semibold tracking-[0.02em]">sem</span>
        <span className={COUNT}>{pending ? '–' : 0}</span>
      </span>
    );
  }

  const inAllChanges = slot?.component === REVIEW_PANEL_TYPES.ALL_FILES;
  const openChange = (change: SemanticDiffChange) => {
    const range = lineSelectionForChange(change);
    setOpen(false);
    if (inAllChanges && state?.revealInAllChanges && range) {
      state.revealInAllChanges(change.filePath, range);
      return;
    }
    state?.openDiffFile(change.filePath);
    state?.onLineSelection(range);
  };
  const on = found?.status !== 'off';
  const noted = found ? semanticNoteCount(found.summary) : 0;
  const count = changes.length || noted;
  const changesText = `${count} semantic change${count === 1 ? '' : 's'}`;
  const kinds = found ? semanticNoteParts(found.summary).join(', ') : '';
  const both = kinds !== '' && changes.length > 0 && changes.length !== noted;
  const text = !kinds ? changesText : on ? (both ? `${changesText}; ${kinds}` : kinds) : both ? `${changesText}; ${kinds} not shown in the diff` : `${kinds}, not shown in the diff`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={0}
        closeDelay={CLOSE_DELAY_MS}
        render={
          <button
            type="button"
            onClick={(event) => event.stopPropagation()}
            title={on ? (kinds ? text : `${text} in this file`) : `${text}. Open to show ${noted === 1 ? 'it' : 'them'}.`}
            aria-label={`Semantic changes for ${filePath}: ${text}`}
            data-semantic-file-badge={count}
            data-semantic-note={found?.status}
            className={`${BADGE} ${found ? `${touch ? REACH : REACH_COARSE} ${TIGHT_CHIP}` : NARROW_HIDDEN} transition-colors hover:text-foreground hover:bg-muted data-[popup-open]:text-foreground data-[popup-open]:bg-muted`}
          />
        }
      >
        <span className={`font-semibold tracking-[0.02em] ${TIGHT_WORD}`}>sem</span>
        <span className={`${COUNT} ${on ? 'bg-primary/15 text-primary' : 'text-primary/80 ring-1 ring-inset ring-primary/40'}`}>{count}</span>
        <ChevronDown aria-hidden="true" className={`w-3 h-3 flex-none text-muted-foreground ${TIGHT_WORD}`} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-[100]">
          <Popover.Popup
            initialFocus={(type) => type === 'keyboard'}
            data-semantic-file-popover=""
            className="w-[min(30rem,90vw)] max-h-[min(24rem,70vh)] overflow-auto p-1.5 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg font-mono text-[13px] leading-[1.55] tabular-nums outline-none popover-enter"
          >
            <div className="flex items-center gap-2 px-2 pt-1 pb-1.5 mb-1 border-b border-border text-muted-foreground">
              <span className="font-semibold tracking-[0.02em]">sem</span>
              <span className="min-w-0 truncate text-foreground" title={filePath}>{filePath}</span>
              {found && semantic && <ShowInDiff on={on} onToggle={semantic.onToggle} />}
            </div>
            {changes.length > 0 ? (
              <div className="semantic-diff-rows">
                <SemanticDiffRows changes={changes} binaryChanges={[]} onOpenChange={openChange} onOpenBinary={() => {}} />
              </div>
            ) : (
              <div className="px-2 py-1 text-muted-foreground">{kinds || changesText}</div>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
