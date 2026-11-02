import { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { inboxApi, type InboxAskChat } from '../api';
import { Icon } from '../icons';
import { askChatGroups, askChatName, askChatTime } from './askModel';

/**
 * The window's header: the current chat (its agent's real icon, the thread's
 * name, a caret) and the dropdown of chats, on the Inbox's own menu (`.ib-pm`;
 * Base UI carries the keys: arrows, Home/End, type-ahead, Escape and Tab close,
 * focus back on the chip). The list is read when it opens, so an answer in
 * another chat shows there and nowhere before that (told to the owner).
 * Rows have no close X: End stays on the round button.
 */
export function AskChatMenu({ current, phone, onPick }: { current: InboxAskChat; phone: boolean; onPick: (threadId: string) => void }) {
  const [chats, setChats] = useState<readonly InboxAskChat[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const chip = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  // Drawn inside the window's root, so its styles and theme reach the menu.
  useLayoutEffect(() => setPortal(chip.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);

  const read = () => {
    setNow(Date.now());
    inboxApi.askChats().then(
      (answer) => setChats(answer.chats),
      () => {
        // The menu still shows the chat on screen and what it read last.
      },
    );
  };

  const { top, recent } = askChatGroups(chats, current, now);
  const row = (chat: InboxAskChat) => {
    const name = askChatName(chat.subject);
    const when = askChatTime(chat.at, now);
    const isCurrent = chat.thread_id === current.thread_id;
    const state = isCurrent ? 'current' : chat.answering ? 'answering' : chat.unread ? 'unread' : null;
    return (
      <Menu.Item
        key={chat.thread_id}
        className="ib-pmi ib-ask-row"
        label={name}
        onClick={() => onPick(chat.thread_id)}
        aria-label={[name, chat.project, when, state === 'current' ? 'current chat' : state === 'answering' ? 'answering' : state === 'unread' ? 'new answer' : null].filter(Boolean).join(', ')}
        data-ask-chat={chat.thread_id}
        data-state={state ?? undefined}
      >
        <HostMark host={chat.host} />
        <span className="ib-ask-rowtext">
          <span className="ib-ask-rowname" dir="auto">
            {name}
          </span>
          <span className="ib-ask-rowsub">
            <span dir="auto">{chat.project}</span> · {when}
          </span>
        </span>
        {state === 'current' && <Icon name="check" size={15} className="ib-ask-check" />}
        {state === 'answering' && <span className="ib-ask-spin" aria-hidden="true" />}
        {state === 'unread' && <span className="ib-ask-dot" aria-hidden="true" />}
      </Menu.Item>
    );
  };

  return (
    <Menu.Root modal={false} onOpenChange={(open) => open && read()}>
      <Menu.Trigger ref={chip} className="ib-ask-chip" aria-label={`${askChatName(current.subject)}, chats`} data-ask-chip="">
        <HostMark host={current.host} />
        <span className="ib-ask-chipname" dir="auto">
          {askChatName(current.subject)}
        </span>
        <Icon name="chevD" size={13} className="ib-ask-caret" />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm ib-ask-menu" aria-label="Chats" data-ask-menu="">
            <div className="ib-pm-title" aria-hidden="true">
              Chats
            </div>
            {top.map(row)}
            {recent.length > 0 && (
              <>
                <Menu.Separator className="ib-pm-sep" />
                <Menu.Group>
                  <Menu.GroupLabel className="ib-ask-grouplabel">Recent</Menu.GroupLabel>
                  {recent.map(row)}
                </Menu.Group>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
