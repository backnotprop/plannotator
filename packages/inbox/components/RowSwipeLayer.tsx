import { forwardRef, useEffect, useRef, type RefObject } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { SWIPE_ARCHIVE_LABEL, SWIPE_QUIET_LABEL, SWIPE_UNREAD_LABEL, attachRowSwipe, rowSwipeActions } from '../rowSwipe';
import type { InboxListProps } from './InboxList';

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

/**
 * Swipe a row on a touch screen (rowSwipe.ts): right is the row's hover action (Quiet, or Mark unread), left Archive,
 * both through the row menu's action. One set of listeners on the list's scroll box, for every row shape. `latest`: the
 * list's newest props; `on`: the list has a row menu. Returns the ref for the list's RowSwipeLayer.
 */
export function useRowSwipe(bodyRef: RefObject<HTMLElement | null>, latest: RefObject<InboxListProps>, on: boolean, titleOf: (row: InboxListRow) => string) {
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const layer = layerRef.current;
    if (!on || !body || !layer) return;
    const find = (threadId: string) => {
      for (const section of latest.current.sections) {
        const row = section.threads.find((r) => r.thread_id === threadId);
        if (row) return { row, drawn: section.id };
      }
      return null;
    };
    return attachRowSwipe(body, layer, {
      actionsOf: (threadId) => {
        const found = find(threadId);
        if (!found) return null;
        const can = { markRead: latest.current.onMarkRead !== undefined, markUnread: latest.current.onMarkUnread !== undefined };
        return { ...rowSwipeActions(found.row, found.drawn, can), title: titleOf(found.row) };
      },
      onAction: (threadId, action) => {
        const found = find(threadId);
        return found ? latest.current.onRowAction?.(found.row, action) : undefined;
      },
      reduced: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
  }, [bodyRef, latest, on, titleOf]);
  return layerRef;
}
