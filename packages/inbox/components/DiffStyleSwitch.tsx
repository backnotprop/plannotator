/**
 * Split | Unified in a guided review (approval "inbox-guide-diff-style",
 * #2107): the control the guide reader raises in a tab out of the first
 * section card (the guide chain's `renderSectionTab`) where the host's bar
 * does not draw the diff controls (the pull request page). It writes code
 * review's own diff layout (diffOptions.ts), so the choice holds in both.
 * Native radios in a radiogroup: Tab reaches the one chosen, the arrows
 * choose. The guided review and the full-window review draw one Split /
 * Unified button in their bars instead (DiffControls).
 *
 * `icons`: the pull request page's flat review (the owner's note on r7, "limit the amount of text so the user can focus
 * on the diff"): two marks, the tooltip and each radio's name saying which is which. `name`: another switch on the page
 * (the one docked in the top bar) keeps its own radio group.
 */

import type React from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { InboxDiffStyle } from '../api';
import { chooseDiffOption } from '../diffOptions';
import { Tip } from './Tip';

const CHOICES: { id: InboxDiffStyle; label: string; tip: string }[] = [
  { id: 'split', label: 'Split', tip: 'Split: old and new side by side. Also code review.' },
  { id: 'unified', label: 'Unified', tip: 'Unified: old and new in one column. Also code review.' },
];

/**
 * Pierre's `diffs-icon-diff-split` and `diffs-icon-diff-unified` (@pierre/diffs dist/sprite.js) in one line: its
 * square cut into two panes, its minus and plus. Every stroke lands on a pixel. Pierre's panes are two solid tones,
 * which read as a dark block at this size; here only the chosen mark's panes fill, faintly, in those same two tones
 * (`.ib-mark-old`, `.ib-mark-new`: inbox.css).
 */
const MARKS: Record<InboxDiffStyle, React.ReactElement> = {
  split: (
    <svg className="ib-mark" viewBox="0 0 15 15" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true">
      <path className="ib-mark-old" stroke="none" d="M2 .5h5.5v14H2A1.5 1.5 0 0 1 .5 13V2A1.5 1.5 0 0 1 2 .5" />
      <path className="ib-mark-new" stroke="none" d="M7.5 .5H13A1.5 1.5 0 0 1 14.5 2v11a1.5 1.5 0 0 1-1.5 1.5H7.5z" />
      <rect x=".5" y=".5" width="14" height="14" rx="1.5" />
      <path d="M7.5 .5v14M3 7.5h3M9 7.5h3M10.5 6v3" />
    </svg>
  ),
  unified: (
    <svg className="ib-mark" viewBox="0 0 15 15" width="15" height="15" fill="none" stroke="currentColor" aria-hidden="true">
      <path className="ib-mark-old" stroke="none" d="M2 .5h11A1.5 1.5 0 0 1 14.5 2v5.5H.5V2A1.5 1.5 0 0 1 2 .5" />
      <path className="ib-mark-new" stroke="none" d="M.5 7.5h14V13a1.5 1.5 0 0 1-1.5 1.5H2A1.5 1.5 0 0 1 .5 13z" />
      <rect x=".5" y=".5" width="14" height="14" rx="1.5" />
      <path d="M.5 7.5h14M6 3.5h3M6 11.5h3M7.5 10v3" />
    </svg>
  ),
};

export function DiffStyleSwitch({
  icons = false,
  name = 'ib-diff-style',
  label = 'Diff layout',
}: {
  icons?: boolean;
  name?: string;
  /** The group's name, told apart when the page has several. */
  label?: string;
} = {}) {
  const style = useConfigValue('diffStyle');
  return (
    <span className={`ib-seg ib-gtab${icons ? ' ib-gtab-marks' : ''}`} role="radiogroup" aria-label={label} data-diff-style-switch={style}>
      {CHOICES.map((choice) => (
        <Tip key={choice.id} content={choice.tip} side={icons ? 'bottom' : undefined}>
          <label className="ib-seg-o" data-on={style === choice.id ? '' : undefined} data-diff-style={choice.id}>
            <input
              type="radio"
              name={name}
              aria-label={icons ? choice.label : undefined}
              value={choice.id}
              checked={style === choice.id}
              onChange={() => chooseDiffOption('diffStyle', choice.id)}
            />
            {icons ? MARKS[choice.id] : choice.label}
          </label>
        </Tip>
      ))}
    </span>
  );
}
