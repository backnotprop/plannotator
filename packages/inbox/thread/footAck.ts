/**
 * When 👍 Looks good is offered (design record "inbox-acknowledge"), and the rule every message's reactions keep
 * (approval "inbox-reactions-every-message"): no plain emoji while a question waits. Moved out of Thread.tsx unchanged.
 */
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { lastNonNote } from '../folding';

/**
 * A question or action item of an agent's in the thread is open or picked: it waits on the person. An action item
 * counts like a question here (approval "inbox-next-actions"): the store refuses a 👍 while one waits.
 */
export function questionWaits(messages: readonly InboxMessageWire[]): boolean {
  return messages.some((m) => m.author.kind === 'agent' && [...(m.questions ?? []), ...(m.actions ?? [])].some((q) => q.state === 'open' || q.state === 'picked'));
}

/**
 * The foot's 👍 Looks good: on the agent's latest message (`ackTarget`), offered (`ackOffered`) while no question
 * waits on the person and the thread is not archived. Any agent message also reacts from its face and menu
 * (thread/MessageReactHost.tsx).
 */
export function footAck(messages: readonly InboxMessageWire[], canAck: boolean, archived: boolean): { ackTarget: InboxMessageWire | null; ackOffered: boolean } {
  const ackTarget = messages.filter((m) => m.author.kind === 'agent').at(-1) ?? null;
  // Nor once the person wrote back after it (their reply is the answer; its Sent / Delivered line stays).
  const personWroteLast = lastNonNote(messages)?.author.kind === 'person';
  // Nor once it was sent (its Undo window closed): the reaction stays shown under the message with no button, and the
  // agent's next message takes a new one (owner, 2026-11-07, approval "inbox-reaction-tray"; the store refuses a change).
  const ackSent = ackTarget?.ack?.settled_seq != null;
  return { ackTarget, ackOffered: canAck && ackTarget !== null && !archived && !questionWaits(messages) && !personWroteLast && !ackSent };
}
