/**
 * Split | Unified in a guided review (approval "inbox-guide-diff-style",
 * #2107): the control the guide reader raises in a tab out of the first
 * section card (the guide chain's `renderSectionTab`). It writes code review's
 * own diff layout (diffStyle.ts), so the choice holds in both. Native radios
 * in a radiogroup: Tab reaches the one chosen, the arrows choose.
 *
 * `icons`: the full-window review (the owner's note on r7, "limit the amount of text so the user can focus on the
 * diff"): Pierre's own two marks, the tooltip and each radio's name saying which is which. `name`: a second switch on
 * the page (the one held under the top bar) keeps its own radio group.
 */

import type React from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { InboxDiffStyle } from '../api';
import { chooseDiffStyle } from '../diffStyle';
import { Tip } from './Tip';

const CHOICES: { id: InboxDiffStyle; label: string; tip: string }[] = [
  { id: 'split', label: 'Split', tip: 'Split: old and new side by side. Also code review.' },
  { id: 'unified', label: 'Unified', tip: 'Unified: old and new in one column. Also code review.' },
];

/** `diffs-icon-diff-split` and `diffs-icon-diff-unified` of @pierre/diffs' sprite (dist/sprite.js), which its page does not always load. */
const MARKS: Record<InboxDiffStyle, React.ReactElement> = {
  split: (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0" />
      <path d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1" opacity=".3" />
    </svg>
  ),
  unified: (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10" />
      <path fillRule="evenodd" clipRule="evenodd" opacity=".4" d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" />
    </svg>
  ),
};

export function DiffStyleSwitch({ icons = false, name = 'ib-diff-style' }: { icons?: boolean; name?: string }) {
  const style = useConfigValue('diffStyle');
  return (
    <span className={`ib-seg ib-gtab${icons ? ' ib-gtab-marks' : ''}`} role="radiogroup" aria-label="Diff layout" data-diff-style-switch={style}>
      {CHOICES.map((choice) => (
        <Tip key={choice.id} content={choice.tip}>
          <label className="ib-seg-o" data-on={style === choice.id ? '' : undefined} data-diff-style={choice.id}>
            <input
              type="radio"
              name={name}
              aria-label={icons ? choice.label : undefined}
              value={choice.id}
              checked={style === choice.id}
              onChange={() => chooseDiffStyle(choice.id)}
            />
            {icons ? MARKS[choice.id] : choice.label}
          </label>
        </Tip>
      ))}
    </span>
  );
}
