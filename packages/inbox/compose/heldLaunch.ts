import { inboxId } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { errorToast } from '../toastError';
import type { ComposeHeld } from './ComposeDialog';

type Toast = Omit<InboxToastModel, 'id'>;

export function heldLaunchToast(held: ComposeHeld, show: (toast: Toast, ms: number) => void, dismiss: () => void, kept?: () => void): { toast: Toast; ms: number } {
  const lead = !held.asleep
    ? `Sending to ${held.machineName}…`
    : held.first
      ? `Waiting for ${held.machineName}. It ${held.first} and starts ${held.agentName} when it's back.`
      : `${held.agentName} starts on ${held.machineName} when it's back`;
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
            .then(async () => {
              const saved = await inboxApi
                .saveDraft(inboxId('drf'), { ...held.words, to: null, project: null, files: [], base: null })
                .then(() => true, () => false);
              if (saved) kept?.();
              show({ icon: 'check', lead: saved ? 'Cancelled. Nothing was sent; your words are in Drafts.' : 'Cancelled. Nothing was sent.' }, 7000);
            })
            .catch((cause) => show(errorToast(cause, 'It was not cancelled.'), 7000));
        },
      },
    },
    ms: 12_000,
  };
}
