/** The line under a 👍 Looks good (parts/AckPill.tsx), pure for the tests. */
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { INBOX_AUTO_SEND_ACK_NOTES, wholeMinutes } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import { autoAfterText, deliveryLine, TURN_ENDED_TEXT, waitInputs, type RecipientConnection } from '../deliveryLine';

/** Where a 👍 Looks good is on its way to the agent (amended 2026-10-16: it is sent through). */
export type AckPillState = 'pending' | 'queued' | 'sending' | 'saved' | 'delivered' | 'not-sent';

/**
 * The line under a 👍: the toast's Undo window still runs (`pending`), the
 * Inbox sent it and a connection wakes the agent with it (`queued`, or
 * `sending` while that session is idle: the same honest words as a reply's
 * line, from the session's connection now, `deliveryLine`), it waits for an
 * agent that only reads the thread (`saved`), or it reached the agent
 * (`delivered`: its turn was delivered, or the agent read it). No Send now: a
 * 👍 asks nothing of the agent, so it never goes into a running turn; it
 * waits for the turn to end. Pure, for the tests.
 */
export function ackPillLine(
  ack: NonNullable<InboxMessageWire['ack']>,
  agent: string,
  wakes: boolean,
  time: (iso: string) => string = whenTime,
  connection?: RecipientConnection | null,
  now: number = Date.now(),
): { state: AckPillState; text: string } {
  if (ack.delivered_at) {
    // Marked by the Inbox to go in by itself: say how it went in (into the running turn, or when it ended).
    const marked = ack.deliver_now_by === 'auto' && ack.deliver_now_at && ack.wait_started_at;
    const auto = !marked
      ? ''
      : ack.delivered_into_turn === false
        ? ` · ${TURN_ENDED_TEXT}`
        : ` · ${autoAfterText(wholeMinutes(ack.wait_started_at!, ack.deliver_now_at!))}`;
    return { state: 'delivered', text: `Delivered to ${agent}, ${time(ack.delivered_at)}${auto}` };
  }
  // The window ended after the person replied, or the agent wrote again: it was not sent.
  if (ack.not_sent === 'replied') return { state: 'not-sent', text: 'not sent: you replied' };
  if (ack.not_sent === 'wrote_again') return { state: 'not-sent', text: `not sent: ${agent} wrote again` };
  const you = `You, ${time(ack.at)} · `;
  if (ack.settled_seq == null) return { state: 'pending', text: `${you}goes to ${agent} in a few seconds` };
  // A 👍 settled before it was sent through (no note) never reaches a wake: it waits for a read.
  if (wakes && ack.note_id) {
    const line = deliveryLine({
      name: agent,
      deliveredAt: null,
      time,
      wakes: true,
      sendingNow: !!ack.deliver_now_at,
      connection,
      // It waits on a busy session: "Undelivered N min"; a 👍 waits for the turn to end (INBOX_AUTO_SEND_ACK_NOTES), no countdown.
      ...waitInputs(connection, ack.note_id, { wait_started_at: ack.wait_started_at, deliver_now_by: ack.deliver_now_by, deliver_now_at: ack.deliver_now_at }),
      ...(INBOX_AUTO_SEND_ACK_NOTES ? {} : { autoSendAfterMs: null }),
      now,
    });
    return { state: line.state === 'sending' ? 'sending' : 'queued', text: `${you}${line.text}` };
  }
  return { state: 'saved', text: `${you}Saved for ${agent}. It sees it when it next reads this thread.` };
}
