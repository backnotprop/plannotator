import { useCallback, useState } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { initialLaunchChoice, launchChoiceSend } from './launchChoice';
import { LaunchChoiceButton, LaunchChoiceMenu } from './LaunchChoiceMenu';

/** `key` is the machine and agent: a pick holds only while that same one is in To. */
export function useLaunchChoice(key: string | null, choices: InboxLaunchChoices | undefined, phone: boolean) {
  const [picked, setPicked] = useState<{ key: string; choice: InboxLaunchChoice } | null>(null);
  const [open, setOpen] = useState(false);
  const offered = key !== null && !!choices && (choices.models.length > 0 || choices.efforts.length > 0);
  const choice = picked && picked.key === key ? picked.choice : initialLaunchChoice(choices);
  const close = useCallback(() => setOpen(false), []);
  return {
    open: offered && open,
    close,
    send: offered ? launchChoiceSend(choice) : {},
    button: (className: string) =>
      offered ? <LaunchChoiceButton choice={choice} choices={choices!} open={open} className={className} onToggle={() => setOpen((was) => !was)} /> : null,
    menu: () =>
      offered && open ? (
        <LaunchChoiceMenu choice={choice} choices={choices!} phone={phone} onClose={close} onChoice={(next) => setPicked({ key: key!, choice: next })} />
      ) : null,
  };
}
