/** A 👍 Looks good's line under its message. */
import { useState } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { fullTime, whenTime } from '../format';
import type { RecipientConnection } from '../deliveryLine';
import { useMinuteClock } from '../components/Undelivered';
import { Tip } from '../components/Tip';
import { justReacted, reactionSpeech } from '../components/ReactionTray';
import { ackPillLine } from '../thread/ackLine';

/** Under a message the person marked 👍 Looks good: when, and where it is on its way to the agent. */
export function AckPill({
  ack,
  agent,
  wakes = false,
  connection,
  messageId,
}: {
  ack: NonNullable<InboxMessageWire['ack']>;
  /** The message it marks: where a reaction's emoji lands (ReactionTray.tsx `flyReaction`). */
  messageId?: string;
  agent: string;
  wakes?: boolean;
  /** How the agent's session is connected now (the sessions route's `asker.connection`); undefined while unknown. */
  connection?: RecipientConnection | null;
}) {
  // The wait on a busy session is written in whole minutes: its own clock, while the 👍 waits.
  const now = useMinuteClock(!ack.delivered_at && !!ack.note_id);
  const line = ackPillLine(ack, agent, wakes, whenTime, connection, now);
  // The emoji picked in the 👍's tray (approval "inbox-reaction-tray"): its name, or the emoji alone.
  const reaction = ack.reaction ?? null;
  // Only the line a reaction was just sent to fades in; an old one is simply there when the thread opens.
  const [fresh] = useState(() => !!messageId && justReacted(messageId));
  return (
    <p className="ib-ackpill" data-ack-pill={line.state} data-ack-for={messageId} data-ack-fresh={fresh ? '' : undefined}>
      <span className="ib-ackchip" data-bare={reaction && !reaction.label ? '' : undefined}>
        <span className="ib-ackemoji" aria-hidden="true">
          {reaction?.emoji ?? '👍'}
        </span>
        {reaction ? reaction.label ? ` ${reaction.label}` : <span className="ib-sr">{reactionSpeech(reaction)}</span> : ` ${ack.label}`}
      </span>
      <Tip content={line.state === 'delivered' && ack.delivered_at ? `You marked it ${fullTime(ack.at)}; delivered ${fullTime(ack.delivered_at)}` : fullTime(ack.at)}>
        <span className="ib-ackwhen">{line.text}</span>
      </Tip>
    </p>
  );
}
