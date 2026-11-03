/**
 * The delivery glyph before a list row's time ("Ticks", approval
 * "inbox-row-delivery", 2026-10-20): a clock while queued, three dots while
 * sending (still under reduced motion), ✓ saved (an agent reads it later),
 * ✓✓ delivered, a warning triangle when it was not delivered. The shape
 * tells the state, never the colour alone; the state in words is in the
 * row's accessible name (the glyph's `aria-label`), and the thread's own
 * delivery line is the tooltip. Send now stays in the thread.
 */
import type { ReactNode } from 'react';
import type { InboxRowDelivery } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { rowDeliveryLine, rowDeliverySpoken } from '../rowDelivery';
import { RowTip } from './RowTip';

/** Two offset checks: delivered (messaging apps' double tick). */
function DoubleCheck() {
  return (
    <svg className="ib-ic ib-dcheck" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m1.5 12.75 5 5 8-12" />
      <path d="m9.25 16.5 1.25 1.25 8-12" />
    </svg>
  );
}

/** Three dots that brighten in turn: sending. */
function SendingDots() {
  return (
    <span className="ib-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function Glyph({ state }: { state: InboxRowDelivery['state'] }) {
  if (state === 'delivered') return <DoubleCheck />;
  if (state === 'sending') return <SendingDots />;
  if (state === 'saved') return <Icon name="check" />;
  if (state === 'undelivered') return <Icon name="warn" />;
  return <Icon name="clock" />;
}

export function DeliveryTick({ delivery }: { delivery: InboxRowDelivery }) {
  return (
    <RowTip content={rowDeliveryLine(delivery)}>
      <span className="ib-tick" data-tick={delivery.state} role="img" aria-label={`${rowDeliverySpoken(delivery)},`}>
        <Glyph state={delivery.state} />
      </span>
    </RowTip>
  );
}

/** The row's time cell: the glyph, then the time (the delivery time once delivered). */
export function TimeWithTick({ delivery, time }: { delivery: InboxRowDelivery | null | undefined; time: ReactNode }) {
  if (!delivery) return <>{time}</>;
  return (
    <span className="ib-tickt">
      <DeliveryTick delivery={delivery} />
      <span>{time}</span>
    </span>
  );
}
