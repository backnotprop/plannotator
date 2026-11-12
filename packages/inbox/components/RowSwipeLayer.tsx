import { forwardRef } from 'react';
import { Icon } from '../icons';
import { SWIPE_ARCHIVE_LABEL, SWIPE_QUIET_LABEL, SWIPE_UNREAD_LABEL } from '../rowSwipe';

/**
 * What shows under a thread row a finger swipes (rowSwipe.ts): one layer for
 * the whole list, which the swipe puts under the row it moves. Quiet (Mark
 * read; Mark unread on a read row) on the left, uncovered by a swipe right;
 * Archive on the right. Hidden (and so out of reach and out of the
 * accessibility tree) until a swipe shows a side; open on a button, that side
 * is a real button, named with the thread's title by rowSwipe.ts.
 */
export const RowSwipeLayer = forwardRef<HTMLDivElement>(function RowSwipeLayer(_props, ref) {
  return (
    <div ref={ref} className="ib-swl" data-row-swipe-layer="">
      <button type="button" className="ib-swa ib-swa-lead" data-row-swipe="lead">
        <span className="ib-swa-in">
          <span className="ib-swa-v" data-v="read">
            <Icon name="checkCircle" size={20} />
            {SWIPE_QUIET_LABEL}
          </span>
          <span className="ib-swa-v" data-v="mark-unread">
            <Icon name="envelope" size={20} />
            {SWIPE_UNREAD_LABEL}
          </span>
        </span>
      </button>
      <button type="button" className="ib-swa ib-swa-trail" data-row-swipe="trail">
        <span className="ib-swa-in">
          <span className="ib-swa-v">
            <Icon name="archive" size={20} />
            {SWIPE_ARCHIVE_LABEL}
          </span>
        </span>
      </button>
    </div>
  );
});
