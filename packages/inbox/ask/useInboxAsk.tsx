import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChatWindowStore, useChatFrameFocusReturn } from '@plannotator/ui/components/chat';
import { inboxApi, type InboxAskChat, type InboxAskConversationWire, type InboxAskModel } from '../api';
import { useOpenInCodeRegion } from '../components/OpenIn';
import { Tip } from '../components/Tip';
import { AskChat } from './AskChat';
import { onAskChange } from './askEvents';
import { sideQuote } from './askWords';

export interface InboxAskOptions {
  /** The settings are read, this is not a tailnet guest's page, and not the tour: while false nothing is read and nothing shows. */
  on: boolean;
  /** Settings → Capabilities → Code review: a code span in an answer shows its code, as in a message. */
  codeReview: boolean;
  /** The open thread, when this Inbox holds it. */
  threadId: string | null;
  phone: boolean;
  openThread: (threadId: string) => void;
  replyInThread: (threadId: string, words: string) => void;
}

export interface InboxAskParts {
  /** The Ask AI icon for the thread's top bar, or null. The only icon: a full-screen file's bar has none. */
  button: ReactNode;
  /**
   * Side in a message's or a file's selection bar (approval "inbox-ask-ai-flow", 2026-11-08): the selected
   * words, quoted, open the thread's chat. Undefined wherever the icon is null (this thread cannot ask, Ask off),
   * and in the phone layout (`phone`, App's usePhone), where the owner keeps the selection bar without it.
   */
  side: ((selected: string) => void) | undefined;
  /** The window. Outside the thread's section: see AskChat. */
  layer: ReactNode;
  /**
   * Open the open thread's chat with these words in its box, after any words
   * already there (code review's Ask on selected lines). Nothing while Ask is off.
   */
  askWith: (words: string) => void;
}

/**
 * Lucide's messages-square (ISC), the two bubbles Side wears in the selection bar: `packages/inbox` does not depend
 * on lucide. The owner dropped the sparkles for it (approval "inbox-ask-ai-flow", 2026-11-08).
 */
function MessagesSquareIcon() {
  return (
    <svg className="ib-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" data-ask-icon="messages-square">
      <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
    </svg>
  );
}

/**
 * Ask AI in the Inbox, for App.tsx: one window whose chat follows the open
 * thread. A thread comes back as it was left: open if it was open, minimized
 * otherwise. Picking a row only changes `#thread=`, so the window shows the
 * chat of whatever thread is on screen and the two can never disagree.
 */
/** Each seed's token, unique in this window. */
let seedCount = 0;

export function useInboxAsk({ on, codeReview, threadId, phone, openThread, replyInThread }: InboxAskOptions): InboxAskParts {
  const store = useMemo(() => new ChatWindowStore(), []);
  const minimized = useSyncExternalStore(store.subscribe, () => store.minimized);
  useChatFrameFocusReturn(store);
  const askFor = on ? threadId : null;
  const openChats = useRef(new Set<string>());

  const [read, setRead] = useState<{ threadId: string; model: InboxAskModel } | null>(null);
  const [picked, setPicked] = useState<InboxAskChat | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [seed, setSeed] = useState<{ threadId: string; words: string; token: number } | null>(null);
  /** The thread whose box takes focus once it can: only after a press here, never when the list moves to a thread. */
  const wantsFocus = useRef<string | null>(null);
  const askForFocus = (threadId: string) => {
    wantsFocus.current = threadId;
    setFocusRequest((count) => count + 1);
  };
  // Newest wins: a slow read must not paint over a later one, or over a send's own answer.
  const readSeq = useRef(0);
  // The thread on screen now: a send that lands after a switch still calls this, and must read this thread, not its own.
  const onScreen = useRef(askFor);
  useLayoutEffect(() => {
    onScreen.current = askFor;
  }, [askFor]);

  const reload = useCallback(() => {
    const reading = onScreen.current;
    if (!reading) return;
    const seq = ++readSeq.current;
    inboxApi.askRead(reading).then(
      (model) => {
        if (seq === readSeq.current) setRead({ threadId: reading, model });
      },
      () => {
        // Nothing to show for this thread; the next event reads again.
      },
    );
  }, []);

  useEffect(() => {
    reload();
    return onAskChange((changed) => {
      if (changed === null || changed === askFor) reload();
    });
  }, [askFor, reload]);

  const adopt = useCallback(
    (conversation: InboxAskConversationWire) => {
      setRead((last) => (last?.threadId === conversation.thread_id ? { ...last, model: { ...last.model, conversation } } : last));
      // POST /ask knows the conversation, not the running turn: the read after it does.
      reload();
    },
    [reload],
  );

  useLayoutEffect(() => {
    store.setMinimized(!askFor || !openChats.current.has(askFor));
  }, [askFor, store]);

  const model = read?.threadId === askFor ? read.model : null;
  const pressed = !minimized && askFor !== null;

  const press = () => {
    if (!askFor) return;
    if (pressed) {
      openChats.current.delete(askFor);
      store.setMinimized(true);
      return;
    }
    openChats.current.add(askFor);
    store.setMinimized(false);
    askForFocus(askFor);
  };

  const pick = (chat: InboxAskChat) => {
    if (chat.thread_id === askFor) return;
    openChats.current.add(chat.thread_id);
    setPicked(chat);
    askForFocus(chat.thread_id);
    openThread(chat.thread_id);
  };

  // A press on the window's plain surface lands focus on the page, where the Inbox's keys would take it for
  // the thread's (Mod+Enter would send the reply). Focus stays in the window.
  const keepFocusIn = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const frame = target.closest<HTMLElement>('[data-chat-window]');
    if (!frame || target.closest('button, textarea, a, [tabindex]')) return;
    requestAnimationFrame(() => {
      if (!frame.contains(document.activeElement)) frame.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    });
  };

  const button =
    model?.can_ask ? (
      <Tip content="Ask AI about this thread">
        <button type="button" className="ib-iconbtn ib-artbtn" aria-label="Ask AI about this thread" aria-pressed={pressed} data-chat-launcher="" data-ask-open="" onClick={press}>
          <MessagesSquareIcon />
        </button>
      </Tip>
    ) : null;

  // One function for the window's life (a review's selection actions hold it): the thread on screen through its ref.
  const askWith = useCallback(
    (words: string) => {
      const thread = onScreen.current;
      if (!thread) return;
      openChats.current.add(thread);
      store.setMinimized(false);
      seedCount += 1;
      setSeed({ threadId: thread, words, token: seedCount });
      wantsFocus.current = thread;
      setFocusRequest((count) => count + 1);
    },
    [store],
  );

  const canAsk = model?.can_ask === true;
  const side = useCallback((selected: string) => askWith(sideQuote(selected)), [askWith]);

  const region = useOpenInCodeRegion({ thread: askFor ?? '' }, codeReview && !!askFor);

  return {
    askWith,
    button,
    side: canAsk && !phone ? side : undefined,
    layer: askFor ? (
      // The code window's handlers sit on the layer itself: ChatFrame sizes itself from this element.
      <div className="ib-ask-layer" data-ask-layer="" onPointerDownCapture={keepFocusIn} {...region.handlers}>
        <AskChat
          key={askFor}
          threadId={askFor}
          store={store}
          model={model}
          picked={picked?.thread_id === askFor ? picked : null}
          phone={phone}
          focusRequest={focusRequest}
          seed={seed?.threadId === askFor ? seed : null}
          takeFocus={() => {
            if (wantsFocus.current !== askFor) return false;
            wantsFocus.current = null;
            return true;
          }}
          onPick={pick}
          onLeave={() => {
            openChats.current.delete(askFor);
          }}
          onConversation={adopt}
          onReload={reload}
          onReply={(words) => replyInThread(askFor, words)}
        />
        {region.window}
      </div>
    ) : null,
  };
}
