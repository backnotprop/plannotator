/**
 * A phone's archived row: a swipe to the left unarchives it (approval "inbox-archived-group"), with "Unarchive" under
 * the row as it slides. Only a leftward swipe is taken: a rightward one (the system's Back from the screen's edge) and
 * an up or down one (the list's scroll, pull to refresh) are left alone, and a finger held still opens the row's menu
 * as on every row. Past a third of the row (at least 88 px) it unarchives on release; short of that it goes back.
 * Under reduced motion nothing slides back or away: the row returns or goes at once. The gesture is useLeftSwipe.ts.
 */
import type { ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { useLeftSwipe } from './useLeftSwipe';

export function SwipeToUnarchive({ row, onUnarchive, children }: { row: InboxListRow; onUnarchive: (row: InboxListRow) => void; children: ReactNode }) {
  const { wrap, face, handlers } = useLeftSwipe(() => onUnarchive(row));
  return (
    <div ref={wrap} className="ib-arcswipe" data-swipe-row={row.thread_id} {...handlers}>
      <div className="ib-arcswipe-under" aria-hidden="true">
        <Icon name="archive" size={16} />
        Unarchive
      </div>
      <div ref={face} className="ib-arcswipe-face">
        {children}
      </div>
    </div>
  );
}
