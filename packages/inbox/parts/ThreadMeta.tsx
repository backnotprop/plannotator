import type { ReactNode } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import { awayLine } from '../machines';
import { OpenLiveReview } from '../components/ReviewAnchorLine';

export function ThreadMeta({ machine, cardChip, messages }: { machine: MachineView | null; cardChip: ReactNode; messages: readonly InboxMessageWire[] }) {
  const live = machine ? undefined : messages.find((m) => m.id === m.thread_id && m.review_live);
  return (
    <>
      {machine && (
        <div className="ib-tmeta" data-thread-machine={machine.id} data-away={awayLine(machine) ? '' : undefined}>
          <span>{awayLine(machine) ?? `On ${machine.name}`}</span>
        </div>
      )}
      {cardChip ? <div className="ib-tmeta" data-thread-card-row="">{cardChip}</div> : null}
      {live?.review_live ? <OpenLiveReview threadId={live.thread_id} title={live.review_live.title} /> : null}
    </>
  );
}
