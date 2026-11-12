import { useEffect, useState } from 'react';
import type { DeliveryLine, RestartNote } from '../deliveryLine';
import { undeliveredLabel, undeliveredShort, undeliveredWords } from '../deliveryLine';
import { Icon } from '../icons';
import { StuckReason } from './RestartNote';
import { Tip } from './Tip';

export const UNDELIVERED_TICK_MS = 5_000;

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

export function UndeliveredBadge({ wait, now, full = false }: { wait: Wait; now: number; full?: boolean }) {
  return (
    <span className="ib-badge ib-b-wait" data-undelivered="" data-stuck={wait.steerable ? undefined : ''}>
      <span className="ib-bwt">{full ? undeliveredLabel(wait.since, now) : undeliveredShort(wait.since, now)}</span>
    </span>
  );
}

export function UndeliveredText({ wait, name }: { wait: Wait; name: string }) {
  const now = useMinuteClock(true);
  const words = undeliveredWords(wait, now);
  return (
    <span className="ib-dl-text">
      <strong>{words.label}</strong> · {name} is working · <span className="ib-m-mute">{words.next}</span>
    </span>
  );
}

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
  onSendNow?: (() => void) | null;
  sending?: boolean;
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
