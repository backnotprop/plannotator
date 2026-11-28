/**
 * A ship this window drew going turns merged (its `ships` event, a ships read): Reviews is read once more at once, so the
 * merged PR's row (kept while "Merged" shows, inbox-ship.md, How a ship ends) comes in now, not at the next timed read.
 */
import type { InboxShipView } from '@plannotator/core/inbox-pull-handoff';

/** Whether a ship in `before` that was not merged is merged in `after` (the same pull request's ship). */
export function shipTurnedMerged(before: ReadonlyMap<string, InboxShipView>, after: ReadonlyMap<string, InboxShipView>): boolean {
  for (const [key, ship] of after) {
    const was = before.get(key);
    if (ship.state === 'merged' && was && was.state !== 'merged') return true;
  }
  return false;
}
