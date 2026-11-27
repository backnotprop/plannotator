/**
 * A phone's reply sheet row for one of the thread's agents (PhoneReplyRecipient.tsx): a swipe to the left removes the
 * agent from the thread (approval "inbox-remove-agent-from-thread", proposal B's phone), with "Remove" under the row as
 * it slides, as an archived row slides over "Unarchive" (the same gesture, useLeftSwipe.ts). Past a third of the row
 * it removes on release; short of that it goes back.
 */
import type { ReactNode } from 'react';
import { Icon } from '../icons';
import { useLeftSwipe } from './useLeftSwipe';

export function SwipeToRemove({ session, onRemove, children }: { session: string; onRemove: () => void; children: ReactNode }) {
  const { wrap, face, handlers } = useLeftSwipe(onRemove);
  return (
    <div ref={wrap} className="ib-arcswipe ib-rmswipe" data-swipe-remove={session} {...handlers}>
      <div className="ib-arcswipe-under" aria-hidden="true">
        <Icon name="minus" size={16} />
        Remove
      </div>
      <div ref={face} className="ib-arcswipe-face">
        {children}
      </div>
    </div>
  );
}
