/**
 * What a Combine left where it was (approval "inbox-combine-across-computers", the owner: "One quiet line on the
 * combined thread naming what stayed or was left out"): under the new thread's first message, in the thread's own
 * quiet note style (a Tidy note's), "Still open on Mini: Refund totals · Not copied: plan.pdf". The server writes it
 * (`InboxMessage.combine_left`, inbox-combine-across.ts) as it learns it; nothing to press. Its mark is the neutral
 * note mark: nothing on the line is archived.
 */
import { inboxCombineLeftLine, type InboxCombineLeft } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';

export function CombineLeftNote({ left }: { left: InboxCombineLeft | undefined }) {
  const line = left ? inboxCombineLeftLine(left) : '';
  if (!line) return null;
  return (
    <p className="ib-tidy-mark" data-combine-left="">
      <Icon name="info" size={14} />
      <span dir="auto">{line}</span>
    </p>
  );
}
