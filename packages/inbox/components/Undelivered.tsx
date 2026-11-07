/**
 * A reply that waits on a busy agent (owner approval "inbox-busy-agent-reply",
 * 2026-10-21): "Undelivered N min" on the list row and in the band under the
 * reply, with the promise "goes in by itself in M min" where the session's
 * connection can take it mid-turn (the server puts it in after
 * `INBOX_AUTO_SEND_AFTER_MS`), and Send now. Where it cannot go in sooner, the
 * band is grey, has no countdown, and says why and the fix. Whole minutes
 * only: each piece keeps its own clock, so a memoized row or the thread does
 * not render again for it. No toast, no shortcut.
 */
import { useEffect, useState } from 'react';
import type { DeliveryLine, RestartNote } from '../deliveryLine';
import { undeliveredLabel, undeliveredShort, undeliveredWords } from '../deliveryLine';
import { Icon } from '../icons';
import { StuckReason } from './RestartNote';
import { Tip } from './Tip';

/** How often the minute words are written again: often enough that a minute turns over within a few seconds. */
export const UNDELIVERED_TICK_MS = 5_000;

/** The wall clock, written again every `UNDELIVERED_TICK_MS` while `active`. */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), UNDELIVERED_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

type Wait = NonNullable<DeliveryLine['wait']>;

/**
 * The row's badge, in place of the count: blue while it can go in now, grey when it cannot. On a three-line or phone
 * row it says the short form, "Undelivered 3m", "2h", "1d" (approval "inbox-row-byline", option A), and the row
 * (InboxList's `CountWords`, which keeps the clock) puts "Undelivered 3 min" in the tooltip and its name; on a wide
 * row (`full`) the full words.
 */
export function UndeliveredBadge({ wait, now, full = false }: { wait: Wait; now: number; full?: boolean }) {
  return (
    <span className="ib-badge ib-b-wait" data-undelivered="" data-stuck={wait.steerable ? undefined : ''}>
      <span className="ib-bwt">{full ? undeliveredLabel(wait.since, now) : undeliveredShort(wait.since, now)}</span>
    </span>
  );
}

/** "Undelivered 3 min · Claude Code is working · goes in by itself in 2 min", with its own clock. */
export function UndeliveredText({ wait, name }: { wait: Wait; name: string }) {
  const now = useMinuteClock(true);
  const words = undeliveredWords(wait, now);
  return (
    <span className="ib-dl-text">
      <strong>{words.label}</strong> · {name} is working · <span className="ib-m-mute">{words.next}</span>
    </span>
  );
}

/**
 * The band under the reply while it waits on a busy session. Blue (`steerable`):
 * Send now, filled, and the countdown when it goes in by itself. Grey: no
 * button, no countdown, and why it cannot go in sooner, with the fix.
 */
export function UndeliveredBand({
  wait,
  name,
  onSendNow,
  sending,
  restart,
  restartName,
}: {
  wait: Wait;
  name: string;
  /** Present while Send now is offered. */
  onSendNow?: (() => void) | null;
  sending?: boolean;
  /** Why it cannot go in sooner, when the fix is a plugin reload (restartNote). */
  restart: RestartNote | null;
  restartName: string;
}) {
  const stuck = !wait.steerable;
  return (
    <div className="ib-delivered ib-undl" data-delivery="queued" data-undelivered="" data-stuck={stuck ? '' : undefined} tabIndex={-1}>
      <span className="ib-dl-main">
        <Icon name="clock" size={14} />
        <UndeliveredText wait={wait} name={name} />
      </span>
      {onSendNow && (
        <Tip content="Put it into the running turn now: the agent reads it at its next step, without waiting for the turn to end.">
          <button type="button" className="ib-sendnow ib-sendnow-go" data-send-now="" disabled={sending} onClick={onSendNow}>
            <Icon name="send" size={14} />
            Send now
          </button>
        </Tip>
      )}
      {stuck && <StuckReason note={restart} name={restartName} />}
    </div>
  );
}
