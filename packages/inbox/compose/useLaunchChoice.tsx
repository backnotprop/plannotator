import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxLaunchChoice, InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';
import { initialLaunchChoice, launchChoiceHasModels, launchChoiceMenuName, launchChoiceNotice, launchChoiceSend } from './launchChoice';
import { LaunchChoiceButton, LaunchChoiceMenu } from './LaunchChoiceMenu';

/**
 * `key` is the machine and agent: a pick holds only while that same one is in To. `defaultFor`: the folder To names
 * (its project id, or the scratch pick; null for a typed folder): OpenCode's default is named only when it was read
 * for that folder, so a folder switch shows "Default model" until the new folder's is read. `say`: the window's live
 * region, for what changes in the open menu (the list read, or why it could not be).
 */
export function useLaunchChoice(
  key: string | null,
  given: InboxLaunchChoices | undefined,
  phone: boolean,
  options: { defaultFor?: string | null; say?: (words: string) => void } = {},
) {
  const { defaultFor = null, say } = options;
  const choices = useMemo(() => {
    if (!given?.default_model || (given.default_for !== undefined && given.default_for === defaultFor)) return given;
    const { default_model: _named, default_for: _for, ...rest } = given;
    return rest;
  }, [given, defaultFor]);
  const [picked, setPicked] = useState<{ key: string; choice: InboxLaunchChoice } | null>(null);
  const [open, setOpen] = useState(false);
  // OpenCode's list being read or not readable still offers the menu: Default, and why there is nothing else.
  const offered = key !== null && !!choices && (launchChoiceHasModels(choices) || choices.efforts.length > 0);
  const choice = picked && picked.key === key ? picked.choice : initialLaunchChoice(choices);
  const close = useCallback(() => setOpen(false), []);
  // While the menu is open, its change of kind is said: being read, then the list or why it could not be read.
  const notice = choices ? launchChoiceNotice(choices) : null;
  const kind = !choices ? null : choices.reading ? 'reading' : choices.unread ? `unread:${choices.unread}` : 'list';
  const said = useRef<string | null>(null);
  useEffect(() => {
    const before = said.current;
    said.current = offered && open ? kind : null;
    if (!say || !offered || !open || before === null || before === kind || !choices) return;
    say(notice ?? launchChoiceMenuName(choices));
  }, [kind, open, offered]); // eslint-disable-line react-hooks/exhaustive-deps
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
