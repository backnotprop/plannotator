/**
 * The mark at the right of a routine's Reply row: "Routine · next Mon 9:00 AM · Edit", which opens its
 * editor. A routine is managed on the computer that made it, so on a thread from another linked machine it
 * reads "Routine on <machine>. Manage it there." with no link (no way into a page that has nothing to show).
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

export function ScheduledFoot({ messages, machine }: { messages: readonly InboxMessageWire[]; machine: { name: string } | null }) {
  let latest: InboxMessageWire | undefined;
  for (let i = messages.length - 1; i >= 0 && !latest; i--) if (messages[i]!.scheduled_run) latest = messages[i];
  if (!latest) return null;
  if (machine)
    return (
      <span className="st-foot-mark st-far" data-scheduled-foot-far="">
        <Icon name="scheduled" size={14} />
        <span>Routine on {machine.name}. Manage it there.</span>
      </span>
    );
  return <LocalFoot id={latest.scheduled_run!.scheduled_id} />;
}
