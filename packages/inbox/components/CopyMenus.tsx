import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxMessageWire, InboxThread } from '@plannotator/core/inbox-types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { focusAfterSwap, SnoozeTimes, type SnoozeView } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { matchesShortcutBinding } from '@plannotator/ui/shortcuts';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { isEditableTarget, keyTarget } from '../shortcuts/guards';
import { useShortcutAria, withShortcut } from '../shortcuts/hint';
import { copyAuthor, copyMarkdown, messageMarkdown, threadMarkdown } from '../copyMarkdown';
import { plural, shortAgentName, whenTime } from '../format';
import { Icon } from '../icons';
import { DECISIONS_POST_TO_WORDS, decisionExportUrl, threadHasQuestionCards } from '../decisionExport';
import { inboxApi, type DecisionsPostTo } from '../api';
import { RefMarkIcon } from '../board/RefMark';
import { canPostDecisionsOn, useThreadPulls } from '../threadPulls/ThreadPulls';
import { Tip } from './Tip';
import { useMessageArm } from '../messageArming';
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

/**
 * The menus are drawn inside the window's root, so its styles (and theme) reach them. Found again after each render:
 * the element `ref` names can come later than the first one (a far message draws its ⋯ plain until it is armed), and
 * a menu drawn outside the root loses the root's styles (its icons come out as filled black shapes).
 */
function usePortal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.pn-inbox');
    if (root) setPortal(root);
  });
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
  const arm = useMessageArm();
  const named = who(message);
  // Shift+F10 or the context-menu key on the message's head (approval "inbox-keyboard-keys-2026-11-07", item 6): its
  // ⋯ menu opens, focus on the first item, as a row's and a card's menus open by key.
  const menuPopup = useRef<HTMLDivElement>(null);
  const keyOpened = useRef(false);
  useEffect(() => {
    if (!open || !keyOpened.current) return;
    keyOpened.current = false;
    const frame = requestAnimationFrame(() => menuPopup.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const onHeadKey = (event: ReactKeyboardEvent) => {
    // A text field in the head keeps its keys (Shift+F10 there is the field's own menu).
    if (event.nativeEvent.isComposing || open || contextOpen || isEditableTarget(keyTarget(event.nativeEvent))) return;
    const menuKey = event.key === 'ContextMenu' || inboxThreadShortcuts.shortcuts.messageMenu.bindings.some((binding) => matchesShortcutBinding(event.nativeEvent, binding));
    if (!menuKey) return;
    event.preventDefault();
    event.stopPropagation();
    keyOpened.current = true;
    setOpen(true);
    // Windows sends the context-menu key's own `contextmenu` on keyup: that one event is not a second menu.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      done();
    };
    const timer = setTimeout(() => done(), 1000);
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('contextmenu', swallow, true);
      window.removeEventListener('pointerdown', done, true);
    };
    window.addEventListener('contextmenu', swallow, true);
    window.addEventListener('pointerdown', done, true);
  };
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
  if (!arm.armed) {
    // Far from the view (messageArming.tsx): the same ⋯ and head line, with no menus behind them yet. A press (or the
    // menu key on the head) arms the message and opens its menu.
    const plain = (
      <button
        ref={more}
        type="button"
        className="ib-mut ib-mmore"
        aria-haspopup="menu"
        aria-expanded={false}
        aria-label={`More: ${named}`}
        data-phone={phone ? '' : undefined}
        data-message-more={message.id}
        onClick={() => {
          setOpen(true);
          arm.arm();
        }}
      >
        <Icon name="dots" size={16} />
      </button>
    );
    const head = props.head(plain);
    if (phone) return head;
    return cloneElement(head as ReactElement<{ onKeyDown?: (event: ReactKeyboardEvent) => void }>, {
      onKeyDown: (event: ReactKeyboardEvent) => {
        onHeadKey(event);
        if (event.defaultPrevented) arm.arm();
      },
    });
  }
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
          <Menu.Popup ref={menuPopup} className="ib-pm" aria-label={`Message from ${named}`} data-message-menu={message.id}>
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
      <ContextMenu.Trigger render={head} onKeyDown={onHeadKey} />
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
 * A launched thread's items on top of ⋯ (UX screen 07): Copy attach command, Stop <agent>, and Delete session
 * (it asks first, in the thread). Each is absent where it cannot work. Open in Terminal is not here: it shows
 * on the run line, only when a session waits on Terminal or can't start.
 */
export interface ThreadMoreLaunch {
  name: string;
  copyAttach: (() => void) | null;
  stop: (() => void) | null;
  remove: (() => void) | null;
}

/**
 * The thread header's ⋯ More (approval "inbox-thread-header", 2026-11-02).
 *
 * A launched thread (`launch`) leads with its own group above all of these, on desktop and phone alike.
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
    /** Add a pull request to the thread (approval "inbox-pr-binding"): opens the PRs card on its Add field. */
    addPull?: () => void;
    /**
     * Post decisions (step 2): Export decisions' "Post on a pull request" group, one row per PR on the thread; with
     * none, its Add a pull request… opens the PRs card and posts on the PR once it is added (`addPullThenPost`).
     * Absent where the thread's PRs can't be changed (a guest, another machine's thread).
     */
    postDecisions?: { post: (ref: string) => void; addPullThenPost: () => void };
    launch?: ThreadMoreLaunch | null;
  },
) {
  const { thread, phone, pin, markRead, moveBack, markUnread, archive, snooze, requestGuide, addPull, postDecisions, launch } = props;
  const copies = useCopies(props);
  const { ref, portal } = usePortal<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SnoozeView | null>(null);
  // A phone's "‹ Export decisions" sub-view (the sheet swaps in place, as Snooze's times do).
  const [exportView, setExportView] = useState(false);
  const exportOffered = threadHasQuestionCards(thread);
  const exportBack = useRef(false);
  // The thread's PRs for the Post group: read while the menu is open (the PR button keeps them current otherwise).
  const { answer: pullsAnswer } = useThreadPulls(thread.thread_id, open && exportOffered && !!postDecisions);
  // Only the PRs decisions can post on (a Bitbucket PR is refused by the server, so it gets no row).
  const linked = (pullsAnswer?.pulls ?? []).filter(canPostDecisionsOn);
  // Where to post (config.json `inboxDecisionsPostTo`): read when the menu opens, saved on a pick.
  const [postTo, setPostTo] = useState<DecisionsPostTo | null>(null);
  const postOffered = open && exportOffered && !!postDecisions;
  useEffect(() => {
    if (!postOffered) return;
    let live = true;
    inboxApi
      .decisionsPostTo()
      .then((value) => live && setPostTo(value))
      .catch(() => {
        // An older Inbox (no setting): no "Where to post" group.
      });
    return () => {
      live = false;
    };
  }, [postOffered]);
  // Back from the times: focus goes to Snooze again, not to the item now at its old index.
  const backed = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (view !== null || exportView || !backed.current) return;
    backed.current = false;
    const item = exportBack.current ? '[data-thread-export-item]' : '[data-thread-snooze-item]';
    exportBack.current = false;
    return focusAfterSwap(() => popup.current?.querySelector<HTMLElement>(item));
  }, [view, exportView]);
  useLayoutEffect(() => {
    if (!exportView) return;
    return focusAfterSwap(() => popup.current?.querySelector<HTMLElement>('[data-decision-export]'));
  }, [exportView]);
  // Export decisions (the owner, 2026-11-10): beside Add a pull request…, on every thread with question cards, linked PR
  // or not. Its submenu (and the phone's sub-view) is `downloads`: plain links the server answers as attachments (no
  // dialog), named by the server; then "Post on a pull request", one row per PR on the thread (one click posts, or
  // updates the comment posted before; the toast says which), or with none Add a pull request…, which posts once added.
  const postGroup = postDecisions && (
    <>
      <Menu.Separator className="ib-pm-sep" />
      <Menu.Group>
        <Menu.GroupLabel className="ib-pm-glabel">Post on a pull request</Menu.GroupLabel>
        {linked.map((pull) => (
          <Menu.Item key={pull.pull} className="ib-pmi" label={pull.ref} onClick={() => postDecisions.post(pull.ref)} data-decision-post={pull.ref}>
            <RefMarkIcon kind="pr" state={pull.state} size={15} />
            {pull.ref}
          </Menu.Item>
        ))}
        {pullsAnswer && linked.length === 0 && (
          <Menu.Item className="ib-pmi" label="Add a pull request" onClick={postDecisions.addPullThenPost} data-decision-post-add="">
            <Icon name="link" size={15} />
            Add a pull request…
          </Menu.Item>
        )}
        {/* Where to post belongs to the PR rows (the owner, 2026-11-10: "should be a part of the PR section"): in the same
            group, no divider, a quiet indented sub-choice under them. */}
        {postTo && (
          <Menu.RadioGroup
            aria-label="Where to post"
            className="ib-pm-subchoice"
            data-decision-post-where=""
            value={postTo}
            onValueChange={(next: DecisionsPostTo) => {
              if (next === postTo) return;
              const was = postTo;
              setPostTo(next);
              inboxApi.saveDecisionsPostTo(next).catch(() => setPostTo(was));
            }}
          >
            <div className="ib-pm-sublabel" aria-hidden="true">
              Where to post
            </div>
            {DECISIONS_POST_TO_WORDS.map(({ value, label }) => (
              <Menu.RadioItem key={value} value={value} closeOnClick={false} className="ib-pmi ib-pmi-sub" label={label} data-decision-post-to={value}>
                {postTo === value ? <Icon name="check" size={13} /> : <span className="ib-pmi-slot" aria-hidden="true" />}
                {label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        )}
      </Menu.Group>
    </>
  );
  const downloads = (
    <>
      <Menu.Item className="ib-pmi" label="Download as Markdown" render={<a href={decisionExportUrl(thread.thread_id, 'md')} download="" />} data-decision-export="md">
        <Icon name="doc" size={15} />
        Download as Markdown
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Download as HTML" render={<a href={decisionExportUrl(thread.thread_id, 'html')} download="" />} data-decision-export="html">
        <Icon name="code" size={15} />
        Download as HTML
      </Menu.Item>
      {postGroup}
    </>
  );
  const exportItem = !exportOffered ? null : phone ? (
    <Menu.Item className="ib-pmi" label="Export decisions" closeOnClick={false} onClick={() => setExportView(true)} data-thread-export-item="">
      <Icon name="download" size={15} />
      Export decisions
      <span className="ib-zsub">
        <Icon name="chevR" size={13} />
      </span>
    </Menu.Item>
  ) : (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="ib-pmi" label="Export decisions" data-thread-export-item="">
        <Icon name="download" size={15} />
        Export decisions
        <span className="ib-zsub">
          <Icon name="chevR" size={13} />
        </span>
      </Menu.SubmenuTrigger>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="left" align="start" sideOffset={2}>
          <Menu.Popup className="ib-pm" aria-label="Export decisions" data-thread-export-menu="">
            {downloads}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
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
    <Menu.Item className="ib-pmi" label={pin.pinned ? 'Unstar thread' : 'Star thread'} onClick={pin.onToggle} data-thread-pin-item="">
      <Icon name="star" size={15} className={pin.pinned ? 'ib-star-on' : undefined} />
      {pin.pinned ? 'Unstar thread' : 'Star thread'}
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
        if (!next) {
          setView(null);
          setExportView(false);
        }
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
            ) : exportView && exportOffered ? (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {thread.subject ?? '(no subject)'}
                </div>
                <Menu.Item
                  className="ib-pmi ib-zb"
                  label="Export decisions"
                  closeOnClick={false}
                  onClick={() => {
                    backed.current = true;
                    exportBack.current = true;
                    setExportView(false);
                  }}
                  data-decision-export-back=""
                >
                  <Icon name="chevL" size={14} />
                  Export decisions
                </Menu.Item>
                {downloads}
              </>
            ) : (
              <>
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {thread.subject ?? '(no subject)'}
                </div>
                {launch && (launch.copyAttach || launch.stop || launch.remove) && (
                  <>
                    {launch.copyAttach && (
                      <Menu.Item className="ib-pmi" label="Copy attach command" onClick={launch.copyAttach} data-launch-item="attach">
                        <Icon name="copy" size={15} />
                        Copy attach command
                      </Menu.Item>
                    )}
                    {launch.stop && (
                      <Menu.Item className="ib-pmi" label={`Stop ${launch.name}`} onClick={launch.stop} data-launch-item="stop">
                        <Icon name="xCircle" size={15} />
                        Stop {launch.name}
                      </Menu.Item>
                    )}
                    {launch.remove && (
                      <Menu.Item className="ib-pmi" label={`Delete ${launch.name} session…`} onClick={launch.remove} data-launch-item="delete">
                        <Icon name="x" size={15} />
                        Delete {launch.name} session…
                      </Menu.Item>
                    )}
                    <Menu.Separator className="ib-pm-sep" />
                  </>
                )}
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
                {(addPull || exportItem) && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    {addPull && (
                      <Menu.Item className="ib-pmi" label="Add a pull request" onClick={addPull} data-thread-add-pull-item="">
                        <Icon name="link" size={15} />
                        Add a pull request…
                      </Menu.Item>
                    )}
                    {exportItem}
                  </>
                )}
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
export function ThreadSnooze({ snooze, openRequest = 0 }: { snooze: ThreadSnoozeProps; openRequest?: number }) {
  const { ref, portal } = usePortal<HTMLButtonElement>();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SnoozeView>('times');
  // H (Thread.tsx): each request opens the menu at its times, focus on the first; picking still snoozes.
  const popup = useRef<HTMLDivElement>(null);
  const keyOpened = useRef(false);
  const snoozeKeys = useShortcutAria({ scope: inboxThreadShortcuts, action: 'snooze' });
  // Only a new request opens it: the clock mounting again (Z after Shift+E, J/K into a thread) keeps it shut.
  const seenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenRequest.current) return;
    seenRequest.current = openRequest;
    keyOpened.current = true;
    setView('times');
    setOpen(true);
  }, [openRequest]);
  useEffect(() => {
    if (!open || !keyOpened.current) return;
    keyOpened.current = false;
    const frame = requestAnimationFrame(() => popup.current?.querySelector<HTMLElement>('[data-snooze-choice]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  // A machine that must update first (approval "inbox-machine-update"): Snooze stays, and says why. After the hooks.
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
      <Tip content={withShortcut('Snooze', { scope: inboxThreadShortcuts, action: 'snooze' })}>
        <Menu.Trigger ref={ref} className="ib-iconbtn" aria-label="Snooze" aria-keyshortcuts={snoozeKeys} data-thread-snooze="">
          <Icon name="clock" size={17} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4}>
          <Menu.Popup ref={popup} className="ib-pm" aria-label="Snooze until" data-thread-snooze-menu="" finalFocus={ref}>
            <SnoozeTimes view={view} onView={setView} onPick={snooze.onPick} onClose={() => setOpen(false)} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
