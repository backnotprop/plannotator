/**
 * The mark at the right of a routine's Reply row: "Routine · next Mon 9:00 AM · Edit", which opens its
 * editor. A linked computer's routine reads and opens the same: the routines' list holds it (the merged read), and its
 * editor here changes it there.
 */
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { writeRoute } from '../app/writeRoute';
import { Icon } from '../icons';
import { useScheduled } from './store';
import { nextWhenWords } from './words';

function LocalFoot({ id }: { id: string }) {
  const { rows } = useScheduled();
  const row = rows?.find((r) => r.id === id);
  // Not in this computer's list (deleted, or the switch is off): nothing to edit, no mark.
  if (!row) return null;
  const next = row.next_run ? nextWhenWords(row.next_run) : null;
  const words = next ? `Routine · next ${next}` : 'Routine';
  return (
    <button
      type="button"
      className="st-foot-mark"
      aria-label={`${next ? `Routine, next run ${next}` : 'Routine'}. Edit the routine`}
      onClick={() => writeRoute({ page: 'scheduled', project: null, thread: null, scheduled: id })}
      data-scheduled-foot={id}
    >
      <Icon name="scheduled" size={14} />
      <span>{words}</span>
      <span aria-hidden="true">·</span>
      <span className="st-edit">Edit</span>
    </button>
  );
}

/** `machine`: the thread's computer when it is a linked one; its routine is in the list by its id, as this one's are. */
export function ScheduledFoot({ messages }: { messages: readonly InboxMessageWire[]; machine?: { name: string } | null }) {
  let latest: InboxMessageWire | undefined;
  for (let i = messages.length - 1; i >= 0 && !latest; i--) if (messages[i]!.scheduled_run) latest = messages[i];
  if (!latest) return null;
  return <LocalFoot id={latest.scheduled_run!.scheduled_id} />;
}
