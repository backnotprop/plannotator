/**
 * An agent's change message ("Made the routine X…") links its name to the editor (`#routine=sch_…`). In a
 * thread from another linked machine that link would open this computer's page, which does not have it: the name
 * stays as plain words and one line says where to manage it.
 */
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

const kept = new WeakMap<InboxMessageWire, { machine: string; message: InboxMessageWire }>();

export function farChangeMessage(message: InboxMessageWire, machine: string | null | undefined): InboxMessageWire {
  if (!machine || !message.scheduled_change) return message;
  const had = kept.get(message);
  if (had?.machine === machine) return had.message;
  const body = message.body.replace(/\[([^\]]+)\]\(#routine(?:=[^)]*)?\)/g, '$1');
  const far = { ...message, body: `${body}\n\nRoutine on ${machine}. Manage it there.` };
  kept.set(message, { machine, message: far });
  return far;
}
