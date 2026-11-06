import { inboxApi } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { errorToast } from '../toastError';
import type { ComposeHeld } from './ComposeDialog';

type Toast = Omit<InboxToastModel, 'id'>;

/**
 * Remote launch: the toast for a new session held for a linked machine (`ComposeHeld`). Asleep, it says the agent
 * starts there when that machine is back; otherwise it is on its way ("Sending to Mac mini…"). While the write has not
 * left, Cancel takes it back (`POST /api/inbox/outbox/:key/cancel`) and the next toast says nothing was sent, or why
 * not (it already went). `show` replaces the window's one toast; `dismiss` closes it.
 */
export function heldLaunchToast(held: ComposeHeld, show: (toast: Toast, ms: number) => void, dismiss: () => void): { toast: Toast; ms: number } {
  const lead = held.asleep ? `${held.agentName} starts on ${held.machineName} when it's back` : `Sending to ${held.machineName}…`;
  if (!held.queued) return { toast: { icon: 'clock', lead }, ms: 7000 };
  return {
    toast: {
      icon: 'clock',
      lead,
      action: {
        label: 'Cancel',
        onPress: () => {
          dismiss();
          void inboxApi
            .cancelOutbox(held.key)
            .then(() => show({ icon: 'check', lead: 'Cancelled. Nothing was sent.' }, 7000))
            .catch((cause) => show(errorToast(cause, 'It was not cancelled.'), 7000));
        },
      },
    },
    // Long enough to read and change one's mind.
    ms: 12_000,
  };
}
