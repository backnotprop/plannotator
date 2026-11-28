/**
 * An agent's change message ("Made the routine X…") links its name to the editor (`#routine=sch_…`). In a thread from
 * another linked computer the routine is that computer's: its id is remembered as that computer's (the one the message
 * came from), so the link opens its editor here and every change goes there (client.ts), as for this computer's.
 */
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { machineOf, rememberMachine } from '../inboxUrl';

/** `farName`: the thread's computer's name when it is not this one (the message's own id says which computer). */
export function farChangeMessage(message: InboxMessageWire, farName: string | null | undefined): InboxMessageWire {
  const machine = farName && message.scheduled_change ? (machineOf(message.id) ?? machineOf(message.thread_id)) : null;
  if (machine) rememberMachine([message.scheduled_change!.scheduled_id], machine);
  return message;
}
