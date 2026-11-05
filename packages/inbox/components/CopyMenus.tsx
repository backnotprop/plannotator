import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { focusAfterSwap, SnoozeTimes, type SnoozeView } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { copyAuthor, copyMarkdown, messageMarkdown, threadMarkdown } from '../copyMarkdown';
import { plural, shortAgentName, whenTime } from '../format';
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

/** The message as the toast and the menu's name say it: "Claude Code, 7:34 PM" (`short`: a long agent name cut, for the toast). */
function who(message: InboxMessageWire, short = false): string {
  const name = copyAuthor(message);
  return `${short ? shortAgentName(name) : name}, ${whenTime(message.created_at)}`;
}

function useCopies({ thread, linkOf, onToast }: CopyMenuHost) {
  const say = (ok: boolean, lead: string, detail: string, speech?: string) =>
    onToast?.(ok ? { icon: 'check', lead, detail, ...(speech && speech !== `${lead}. ${detail}` ? { speech } : {}) } : { icon: 'warn', lead: "Couldn't copy" });
  const named = (lead: string, message: InboxMessageWire) => say(true, lead, who(message, true), `${lead}. ${who(message)}`);
  const subject = `“${thread.subject ?? '(no subject)'}”`;
  return {
    message: (message: InboxMessageWire) => void copyMarkdown(messageMarkdown(message)).then((ok) => (ok ? named('Message copied', message) : say(false, '', ''))),
    messageLink: (message: InboxMessageWire) => void copyTextToClipboard(linkOf(message.id)).then((ok) => (ok ? named('Link copied', message) : say(false, '', ''))),
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


/** Snooze for a thread: its times (Later today … Pick a time) and, on a snoozed thread, Unsnooze. */
export interface ThreadSnoozeProps {
  snoozed: boolean;
  onPick: (until: string) => void;
  onUnsnooze: () => void;
  /** This thread's machine must update first: Snooze stays, says why and opens the update dialog. */
  blocked?: { name: string; onPress: () => void };
}

/**
 * The thread header's ⋯ More (approval "inbox-thread-header", 2026-11-02).
 *
 * Off a phone the read button and Snooze are icons in the bar (`ThreadSnooze`), so the menu leads with Unsnooze (a
 * snoozed thread), Pin thread (Unpin thread while pinned; only when the Inbox keeps pins: `pin` is absent on an older
 * one) and Mark unread where the bar's read button does not offer it (`markUnread`; markRead.ts `canMarkUnread`).
 * Then Copy thread, then Copy link and Copy thread ID, then, in its own group, Archive thread (Unarchive thread on an
 * archived one; the owner, 2026-11-01: move it into the ⋯). None has a key. Request guided review (`requestGuide`)
 * has its own group above Archive, on desktop and in the phone sheet alike, only where the thread offers it.
 *
 * On a phone the bar has neither, and the sheet leads with them: every read action a desktop has (`markRead`,
 * `moveBack` on a thread marked read, `markUnread`), then
 * Snooze, which swaps the sheet in place for "‹ Snooze until" and its times, and Unsnooze; then a divider, Pin thread
 * in its own group, and the rest as above.
 */
export function ThreadMore(
  props: CopyMenuHost & {
    pin?: { pinned: boolean; onToggle: () => void };
    /** A phone's Mark read: the header's read button, moved into the sheet. */
    markRead?: () => void;
    /** A phone's Move back to the top on a thread marked read: the pressed Read button's click, moved into the sheet. */
    moveBack?: () => void;
    markUnread?: () => void;
    archive?: { archived: boolean; onToggle: () => void };
    snooze?: ThreadSnoozeProps;
    /** Request guided review (guideRequest.ts): its own group above Archive, only where the thread offers it. */
    requestGuide?: () => void;
  },
) {
  const { thread, phone, pin, markRead, moveBack, markUnread, archive, snooze, requestGuide } = props;
  const copies = useCopies(props);
  const { ref, portal } = usePortal<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SnoozeView | null>(null);
  // Back from the times: focus goes to Snooze again, not to the item now at its old index.
  const backed = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (view !== null || !backed.current) return;
    backed.current = false;
    return focusAfterSwap(() => popup.current?.querySelector<HTMLElement>('[data-thread-snooze-item]'));
  }, [view]);
  const readItems = (
    <>
      {markRead && (
        <Menu.Item className="ib-pmi" label="Mark read" onClick={markRead} data-thread-read-item="">
          <Icon name="mailOpen" size={15} />
          Mark read
        </Menu.Item>
      )}
      {moveBack && (
        <Menu.Item className="ib-pmi" label="Move back to the top" onClick={moveBack} data-thread-move-back-item="">
          <Icon name="inbox" size={15} />
          Move back to the top
        </Menu.Item>
      )}
      {markUnread && (
        <Menu.Item className="ib-pmi" label="Mark unread" onClick={markUnread} data-thread-unread-item="">
          <Icon name="mail" size={15} />
          Mark unread
        </Menu.Item>
      )}
    </>
  );
  const unsnoozeItem = snooze?.snoozed && (
    <Menu.Item className="ib-pmi" label="Unsnooze" onClick={snooze.onUnsnooze} data-thread-unsnooze-item="">
      <Icon name="inbox" size={15} />
      Unsnooze
    </Menu.Item>
  );
  const pinItem = pin && (
    <Menu.Item className="ib-pmi" label={pin.pinned ? 'Unpin thread' : 'Pin thread'} onClick={pin.onToggle} data-thread-pin-item="">
      <Icon name={pin.pinned ? 'pinOff' : 'pin'} size={15} />
      {pin.pinned ? 'Unpin thread' : 'Pin thread'}
    </Menu.Item>
  );
  const phoneLeads = !!(markRead || moveBack || markUnread || snooze);
  const lead = phone ? (
    <>
      {readItems}
      {snooze?.blocked && (
        <Menu.Item className="ib-pmi" label={`Snooze: update ${snooze.blocked.name} first`} onClick={snooze.blocked.onPress} data-thread-snooze-item="" data-snooze-blocked="">
          <Icon name="clock" size={15} />
          Snooze
          <span className="ib-zsub ib-zneeds">Update {snooze.blocked.name}</span>
        </Menu.Item>
      )}
      {snooze && !snooze.blocked && (
        <Menu.Item className="ib-pmi" label="Snooze" closeOnClick={false} onClick={() => setView('times')} data-thread-snooze-item="">
          <Icon name="clock" size={15} />
          Snooze
          <span className="ib-zsub">
            <Icon name="chevR" size={13} />
          </span>
        </Menu.Item>
      )}
      {unsnoozeItem}
      {phoneLeads && pin && <Menu.Separator className="ib-pm-sep" />}
      {pinItem}
    </>
  ) : (
    <>
      {unsnoozeItem}
      {pinItem}
      {readItems}
    </>
  );
  // Whether anything leads the menu (the divider before Copy thread): off a phone, Snooze itself is in the bar.
  const leads = phone ? phoneLeads || !!pin : !!(snooze?.snoozed || pin || markRead || moveBack || markUnread);
  return (
    <Menu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView(null);
      }}
    >
      <Tip content="More">
        <Menu.Trigger ref={ref} className="ib-iconbtn ib-tmore" aria-label="More" data-thread-more="">
          <Icon name="dots" size={18} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup ref={popup} className="ib-pm" aria-label={thread.subject ?? 'Thread'} data-thread-menu="">
            {view && snooze ? (
              <>
                {/* A phone's sheet keeps its title over the times (the approved phone sheet). */}
                {phone && (
                  <div className="ib-pm-title" dir="auto" aria-hidden="true">
                    {thread.subject ?? '(no subject)'}
                  </div>
                )}
                <SnoozeTimes
                  view={view}
                  onView={setView}
                  onBack={() => {
                    backed.current = true;
                    setView(null);
                  }}
                  onPick={snooze.onPick}
                  onClose={() => setOpen(false)}
                />
              </>
            ) : (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {thread.subject ?? '(no subject)'}
                </div>
                {lead}
                {leads && <Menu.Separator className="ib-pm-sep" />}
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
                {requestGuide && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.Item className="ib-pmi" label="Request guided review" onClick={requestGuide} data-thread-guide-request-item="">
                      <Icon name="book" size={15} />
                      Request guided review
                    </Menu.Item>
                  </>
                )}
                {archive && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.Item
                      className="ib-pmi"
                      label={archive.archived ? 'Unarchive thread' : 'Archive thread'}
                      onClick={archive.onToggle}
                      data-thread-archive-item=""
                    >
                      <Icon name="archive" size={15} />
                      {archive.archived ? 'Unarchive thread' : 'Archive thread'}
                    </Menu.Item>
                  </>
                )}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The thread header's Snooze clock, off a phone (approval "inbox-thread-header", 2026-11-02): an icon after the read
 * button, before the subject. It opens the times as a menu of their own, titled "Snooze until" (Later today,
 * Tomorrow, In 3 days, Next week, then Pick a time, which swaps in its two lists, "‹ Pick a time" going back), as
 * inbox-snooze defines them. Base UI carries the keys (arrows, type-ahead, Escape, focus back to the clock); no new
 * shortcut. Unsnooze stays in ⋯ More.
 */
export function ThreadSnooze({ snooze }: { snooze: ThreadSnoozeProps }) {
  const { ref, portal } = usePortal<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SnoozeView>('times');
  if (snooze.blocked) {
    return (
      <Tip content={`Update ${snooze.blocked.name} to snooze here`}>
        <button type="button" className="ib-iconbtn ib-snooze-blocked" aria-label={`Snooze: update ${snooze.blocked.name} first`} onClick={snooze.blocked.onPress} data-thread-snooze="" data-snooze-blocked="">
          <Icon name="clock" size={17} />
        </button>
      </Tip>
    );
  }
  return (
    <Menu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView('times');
      }}
    >
      <Tip content="Snooze">
        <Menu.Trigger ref={ref} className="ib-iconbtn" aria-label="Snooze" data-thread-snooze="">
          <Icon name="clock" size={17} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="ib-pm" aria-label="Snooze until" data-thread-snooze-menu="">
            <SnoozeTimes view={view} onView={setView} onPick={snooze.onPick} onClose={() => setOpen(false)} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
