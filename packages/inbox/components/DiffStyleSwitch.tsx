/**
 * Split | Unified in a guided review (approval "inbox-guide-diff-style",
 * #2107): the control the guide reader raises in a tab out of the first
 * section card (the guide chain's `renderSectionTab`). It writes code review's
 * own diff layout (diffStyle.ts), so the choice holds in both. Native radios
 * in a radiogroup: Tab reaches the one chosen, the arrows choose.
 */

import { useConfigValue } from '@plannotator/ui/config';
import type { InboxDiffStyle } from '../api';
import { chooseDiffStyle } from '../diffStyle';
import { Tip } from './Tip';

const CHOICES: { id: InboxDiffStyle; label: string; tip: string }[] = [
  { id: 'split', label: 'Split', tip: 'Split: old and new side by side. Also code review.' },
  { id: 'unified', label: 'Unified', tip: 'Unified: old and new in one column. Also code review.' },
];

export function DiffStyleSwitch() {
  const style = useConfigValue('diffStyle');
  return (
    <span className="ib-seg ib-gtab" role="radiogroup" aria-label="Diff layout" data-diff-style-switch={style}>
      {CHOICES.map((choice) => (
        <Tip key={choice.id} content={choice.tip}>
          <label className="ib-seg-o" data-on={style === choice.id ? '' : undefined} data-diff-style={choice.id}>
            <input
              type="radio"
              name="ib-diff-style"
              value={choice.id}
              checked={style === choice.id}
              onChange={() => chooseDiffStyle(choice.id)}
            />
            {choice.label}
          </label>
        </Tip>
      ))}
    </span>
  );
}
