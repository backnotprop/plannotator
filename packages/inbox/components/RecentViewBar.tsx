/**
 * Recent activity's bar (listRecentView.ts; design A, approved for this view only: no bar for anything else): a slim
 * line directly above the list while the view is on, in the look of Filter by typing's field (TitleFilter.tsx). The
 * cursor mark, "Recent activity", then quieter "· threads you acted in, newest first" (left out where the list is
 * narrow: beside a thread, a phone), and Done at its end, which leaves the view (a 44 px target on a phone). Hidden
 * while picking rows, whose bar takes the header's place. A screen reader hears the bar's words as the view turns on.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../icons';
import { leaveRecentView, recentViewTurn, useRecentView } from '../listRecentView';

const TITLE = 'Recent activity';
const NOTE = '· threads you acted in, newest first';
/** The view's turn already said: the list drawn anew with the view still on (a full-screen file closed) says nothing. */
let saidTurn = 0;

/**
 * The bar's words for a screen reader: a live region always on the page, filled once the view is on (one filled as it
 * mounts may go unsaid). Drawn after Filter by typing's field, so nothing comes between the header and that field.
 */
export function RecentViewSaid({ place }: { place: string }) {
  const on = useRecentView(place);
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (!on) return setSaid('');
    if (recentViewTurn() === saidTurn) return;
    saidTurn = recentViewTurn();
    setSaid(`${TITLE} ${NOTE}`);
  }, [on]);
  return (
    <span className="ib-sr" role="status" aria-live="polite" data-recent-view-said="">
      {said}
    </span>
  );
}

export function RecentViewBar({ place, picking }: { place: string; picking: boolean }) {
  const on = useRecentView(place);
  return (
    <>
      {on && !picking && (
        <div className="ib-rview" data-recent-view="">
          <div className="ib-rview-in">
            <div className="ib-rview-row">
              <Icon name="clickHere" />
              <span className="ib-rview-t">{TITLE}</span>
              <span className="ib-rview-note">{NOTE}</span>
              <button
                type="button"
                className="ib-pick-btn ib-pick-end ib-rview-done"
                aria-label={`Done, leave ${TITLE}`}
                onClick={(event) => {
                  const column = event.currentTarget.closest('.ib-listcol');
                  leaveRecentView();
                  column?.querySelector<HTMLElement>('[data-list-filter]')?.focus();
                }}
                data-recent-view-done=""
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
