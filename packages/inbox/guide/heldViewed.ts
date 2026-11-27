/**
 * A review's Viewed ticks as the person made them: what its Inbox keeps (`guide_viewed`), with each tick still held
 * for that Inbox here (its machine away, the outbox's `viewed`) laid over it in the order it was made. Each tick goes
 * as one file's change, so one held for a while never undoes another made since, here or there. Pure.
 */
import type { OutboxView } from '@plannotator/core/inbox-wire-models';

/** A held tick still on its way: queued or being sent. */
const WAITING = new Set<OutboxView['state']>(['queued', 'sending']);

/** The review's Viewed ticks still held for its machine, oldest first. */
export function heldViewed(outbox: ReadonlyMap<string, OutboxView> | null | undefined, messageId: string): OutboxView[] {
  const route = `messages/${messageId}/guide/viewed`;
  return [...(outbox?.values() ?? [])].filter((entry) => entry.route === route && WAITING.has(entry.state) && entry.viewed).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

export function viewedWithHeld(kept: readonly string[], outbox: ReadonlyMap<string, OutboxView> | null | undefined, messageId: string): string[] {
  const held = heldViewed(outbox, messageId);
  let shown = [...kept];
  for (const { viewed } of held) {
    shown = shown.filter((path) => path !== viewed!.path);
    if (viewed!.viewed) shown.push(viewed!.path);
  }
  return shown;
}
