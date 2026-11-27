/** A list row's guided review mark (moved out of InboxList.tsx unchanged). */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { RowTip } from './RowTip';

export const guideWord = (row: InboxListRow) => (row.guide_walkthrough ? 'Walkthrough' : 'Guided review');

/** The record's 1.1: a thread that carries a guided review says so after its subject. */
export function GuideMark({ row }: { row: InboxListRow }) {
  if (!row.guide || row.section === 'sent') return null;
  const word = guideWord(row);
  return (
    <RowTip content={word} when={guideLabelHidden}>
      <span className="ib-att" data-guide-mark="" role="img" aria-label={word}>
        <Icon name="book" size={13} />
        <span className="ib-att-l">{word}</span>
      </span>
    </RowTip>
  );
}

/** The guided review mark drops its label to its icon when the row is short of room: only then does it need a tooltip. */
function guideLabelHidden(trigger: Element): boolean {
  const label = trigger.querySelector<HTMLElement>('.ib-att-l');
  return !label || label.offsetWidth === 0 || getComputedStyle(label).display === 'none';
}
