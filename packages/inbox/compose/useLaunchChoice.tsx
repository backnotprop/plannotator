import { useCallback, useState } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { initialLaunchChoice, launchChoiceSend } from './launchChoice';
import { LaunchChoiceButton, LaunchChoiceMenu } from './LaunchChoiceMenu';

/**
 * Compose's Model and Effort for the new session it would start (`key`: that machine and agent; `choices`: its launch
 * block's). A pick holds while the same agent on the same machine is in To; another one starts on its own last choice.
 * No `choices` (an agent that offers none, an older Inbox): no button, and a Send carries nothing.
 */
export function useLaunchChoice(key: string | null, choices: InboxLaunchChoices | undefined, phone: boolean) {
  const [picked, setPicked] = useState<{ key: string; choice: InboxLaunchChoice } | null>(null);
  const [open, setOpen] = useState(false);
  const offered = key !== null && !!choices && (choices.models.length > 0 || choices.efforts.length > 0);
  const choice = picked && picked.key === key ? picked.choice : initialLaunchChoice(choices);
  const close = useCallback(() => setOpen(false), []);
  return {
    open: offered && open,
    close,
    /** What the Send adds to `to.launch`. */
    send: offered ? launchChoiceSend(choice) : {},
    button: (className: string) =>
      offered ? <LaunchChoiceButton choice={choice} choices={choices!} open={open} className={className} onToggle={() => setOpen((was) => !was)} /> : null,
    menu: () =>
      offered && open ? (
        <LaunchChoiceMenu choice={choice} choices={choices!} phone={phone} onClose={close} onChoice={(next) => setPicked({ key: key!, choice: next })} />
      ) : null,
  };
}
