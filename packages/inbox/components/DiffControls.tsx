/**
 * The diff controls in a review's top bar (approval "diff-controls-headers"):
 * one Split / Unified button, Collapse all (with more than one file), and the
 * "Diff display" popover behind a gear. The guided review draws them before
 * Close, the full-window review after its title. Every setting is code
 * review's own (diffOptions.ts), so a choice here holds there too; the popover
 * leaves out Whole file and Hide whitespace, which need the local repository.
 * Collapse all is this view's only: it folds or opens every file's diff and is
 * not remembered. A phone draws every diff Unified and has none of these.
 */

import { useConfigValue } from '@plannotator/ui/config';
import { DiffLayoutToggle, diffLayoutToggleTip } from '@plannotator/ui/components/DiffLayoutToggle';
import { DiffDisplayOptionsPopover } from '@plannotator/ui/components/DiffDisplayOptions';
import { chooseDiffOption } from '../diffOptions';
import { usePhone } from '../phone';
import { Tip } from './Tip';

/** Fold or open every file's diff: what GuideReader's `collapseAll` takes. */
export interface CollapseAllState {
  collapsed: boolean;
  token: number;
}

/** The next Collapse all: the other way from the last one (open, before any). */
export const nextCollapseAll = (was: CollapseAllState | null): CollapseAllState => ({ collapsed: !was?.collapsed, token: (was?.token ?? 0) + 1 });

const FOLD = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 4l5 5 5-5" />
    <path d="M7 20l5-5 5 5" />
  </svg>
);
const UNFOLD = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 9l5-5 5 5" />
    <path d="M7 15l5 5 5-5" />
  </svg>
);

export function DiffControls({
  files,
  collapseAll,
  onCollapseAll,
  layout = true,
}: {
  /** How many files the diff has: Collapse all shows with more than one. */
  files: number;
  collapseAll: CollapseAllState | null;
  onCollapseAll: () => void;
  /** False for a walkthrough: nothing is marked as changed, so Split would draw the same code twice. Default true. */
  layout?: boolean;
}) {
  const phone = usePhone();
  const style = useConfigValue('diffStyle');
  if (phone) return null;
  const folded = collapseAll?.collapsed === true;
  return (
    <span className="ib-dctl" role="group" aria-label="Diff display" data-diff-controls="">
      {layout && (
        <Tip content={diffLayoutToggleTip(style)} side="bottom">
          <DiffLayoutToggle className="ib-iconbtn ib-dctl-b ib-dctl-layout" value={style} onChange={(next) => chooseDiffOption('diffStyle', next)} nativeTitle={false} />
        </Tip>
      )}
      {files > 1 && (
        <Tip content={folded ? 'Expand all files' : 'Collapse all files'} side="bottom">
          <button type="button" className="ib-iconbtn ib-dctl-b" onClick={onCollapseAll} aria-label={folded ? 'Expand all files' : 'Collapse all files'} data-diff-collapse-all={folded ? 'collapsed' : 'open'}>
            {folded ? UNFOLD : FOLD}
          </button>
        </Tip>
      )}
      <DiffDisplayOptionsPopover repositoryOptions={false} onChange={(key, value) => chooseDiffOption(key as never, value as never)} triggerClassName="ib-iconbtn ib-dctl-b" triggerTitleSide="bottom" />
    </span>
  );
}
