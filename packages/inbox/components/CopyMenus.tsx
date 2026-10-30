import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { copyAuthor, copyMarkdown, messageMarkdown, threadMarkdown } from '../copyMarkdown';
import { plural, whenTime } from '../format';
import { Icon } from '../icons';
import { Tip } from './Tip';
import type { InboxToastModel } from './Toast';

/**
 * Copy a message, copy a thread (design record "inbox-copy-message", option
 * B, approved 2026-10-28). Each open message has a quiet ⋯ after Reply in its
 * head line (shown on hover, keyboard focus or while its menu is open, the
 * sidebar ⋯'s rule; always on a phone): Copy message, Copy link to message,
 * then Copy thread. A right-click on the head line opens the same menu (not
 * on a phone). The thread header's ⋯ holds Pin thread, Copy thread, Copy link and Copy
 * thread ID. Base UI carries the keys (arrows, Home/End, type-ahead, Escape
 * and Tab close, focus back to ⋯); no new shortcut. The look is the project
 * menu's (`.ib-pm`); on a phone, its bottom sheet with a title.
 */

export interface CopyMenuHost {
  thread: InboxThread;
  /** The thread's address, or one message's (`&msg=`): rowMenu.ts `threadLink`. */
  linkOf: (messageId?: string) => string;
  onToast?: (toast: Omit<InboxToastModel, 'id'>) => void;
  /** A phone: ⋯ always shown, the menu a sheet from the bottom edge, no right-click. */
  phone: boolean;
}

/** The message as the toast and the sheet's title name it: "Claude Code, 7:34 PM". */
function who(message: InboxMessageWire): string {
  return `${copyAuthor(message)}, ${whenTime(message.created_at)}`;
}

function useCopies({ thread, linkOf, onToast }: CopyMenuHost) {
  const say = (ok: boolean, lead: string, detail: string) => onToast?.(ok ? { icon: 'check', lead, detail } : { icon: 'warn', lead: "Couldn't copy" });
  const subject = `“${thread.subject ?? '(no subject)'}”`;
  return {
    message: (message: InboxMessageWire) => void copyMarkdown(messageMarkdown(message)).then((ok) => say(ok, 'Message copied', who(message))),
    messageLink: (message: InboxMessageWire) => void copyTextToClipboard(linkOf(message.id)).then((ok) => say(ok, 'Link copied', who(message))),
    thread: () => void copyMarkdown(threadMarkdown(thread)).then((ok) => say(ok, 'Thread copied', plural(thread.messages.length, 'message'))),
    threadLink: () => void copyTextToClipboard(linkOf()).then((ok) => say(ok, 'Link copied', subject)),
    threadId: () => void copyTextToClipboard(thread.thread_id).then((ok) => say(ok, 'Thread ID copied', subject)),
  };
}

/** The menus are drawn inside the window's root, so its styles (and theme) reach them. */
function usePortal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(ref.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  return { ref, portal };
}

/**
 * One open message's menu: its ⋯ (handed to `head` to place after Reply) and,
 * off a phone, a right-click on the head line `head` draws.
 */
export function MessageMenu(props: CopyMenuHost & { message: InboxMessageWire; head: (more: ReactElement) => ReactElement }) {
  const { message, phone } = props;
  const copies = useCopies(props);
  const { ref: more, portal } = usePortal<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const named = who(message);
  const items = (
    <>
      {/* The popup is named already (aria-label): the title is for the eye only, on a phone's sheet. */}
      <div className="ib-pm-title" aria-hidden="true">
        {copyAuthor(message)} · {whenTime(message.created_at)}
      </div>
      <Menu.Item className="ib-pmi" label="Copy message" onClick={() => copies.message(message)} data-copy-item="message">
        <Icon name="copy" size={15} />
        Copy message
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Copy link to message" onClick={() => copies.messageLink(message)} data-copy-item="message-link">
        <Icon name="link" size={15} />
        Copy link to message
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      <Menu.Item className="ib-pmi" label="Copy thread" onClick={() => copies.thread()} data-copy-item="thread">
        <Icon name="stack" size={15} />
        Copy thread
      </Menu.Item>
    </>
  );
  const trigger = (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip content="More">
        <Menu.Trigger
          ref={more}
          className="ib-mut ib-mmore"
          aria-label={`More: ${named}`}
          data-open={open || contextOpen ? '' : undefined}
          data-phone={phone ? '' : undefined}
          data-message-more={message.id}
        >
          <Icon name="dots" size={16} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm" aria-label={`Message from ${named}`} data-message-menu={message.id}>
            {items}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
  const head = props.head(trigger);
  if (phone) return head;
  return (
    <ContextMenu.Root onOpenChange={setContextOpen}>
      <ContextMenu.Trigger render={head} />
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          {/* Focus goes back to the message's ⋯, never the page. */}
          <ContextMenu.Popup className="ib-pm" aria-label={`Message from ${named}`} data-message-menu={message.id} data-context="" finalFocus={more}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The thread header's ⋯ More: Pin thread (Unpin thread while pinned) first, in its own group, as the row menu
 * leads with it (only when the Inbox keeps pins: `pin` is absent on an older one, and a phone's way to pin
 * is here, it has no row menu); then Copy thread, Copy link and Copy thread ID (a phone's only way to them).
 */
export function ThreadMore(props: CopyMenuHost & { pin?: { pinned: boolean; onToggle: () => void } }) {
  const { thread, phone, pin } = props;
  const copies = useCopies(props);
  const { ref, portal } = usePortal<HTMLButtonElement>();
  return (
    <Menu.Root modal={false}>
      <Tip content="More">
        <Menu.Trigger ref={ref} className="ib-iconbtn ib-tmore" aria-label="More" data-thread-more="">
          <Icon name="dots" size={18} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm" aria-label={thread.subject ?? 'Thread'} data-thread-menu="">
            <div className="ib-pm-title" dir="auto" aria-hidden="true">
              {thread.subject ?? '(no subject)'}
            </div>
            {pin && (
              <>
                <Menu.Item className="ib-pmi" label={pin.pinned ? 'Unpin thread' : 'Pin thread'} onClick={pin.onToggle} data-thread-pin-item="">
                  <Icon name={pin.pinned ? 'pinOff' : 'pin'} size={15} />
                  {pin.pinned ? 'Unpin thread' : 'Pin thread'}
                </Menu.Item>
                <Menu.Separator className="ib-pm-sep" />
              </>
            )}
            <Menu.Item className="ib-pmi" label="Copy thread" onClick={() => copies.thread()} data-copy-item="thread">
              <Icon name="stack" size={15} />
              Copy thread
            </Menu.Item>
            <Menu.Separator className="ib-pm-sep" />
            <Menu.Item className="ib-pmi" label="Copy link" onClick={() => copies.threadLink()} data-copy-item="thread-link">
              <Icon name="link" size={15} />
              Copy link
            </Menu.Item>
            <Menu.Item className="ib-pmi" label="Copy thread ID" onClick={() => copies.threadId()} data-copy-item="thread-id">
              <Icon name="hash" size={15} />
              Copy thread ID
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
