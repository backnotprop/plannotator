import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChatWindowStore, useChatFrameFocusReturn } from '@plannotator/ui/components/chat';
import type { InboxAskChat, InboxAskConversationWire, InboxAskModel } from '../api';
import { useOpenInCodeRegion } from '../components/OpenIn';
import { AskChat } from './AskChat';
import { onAskChange } from './askEvents';
import { readAsk } from './askReads';
import { askUnseen } from './askModel';
import { sideQuote } from './askWords';
import { sideButtonFor, type SideButton } from './sideButton';

export interface InboxAskOptions {
  /** The settings are read, and not the tour: while false nothing is read and nothing shows. */
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
  /**
   * Side in a message's or a file's selection bar (approval "inbox-ask-ai-flow", 2026-11-08): the selected
   * words, quoted, open the thread's chat. Undefined while this thread cannot ask (`can_ask` false, Ask off),
   * and in the phone layout (`phone`, App's usePhone), where the owner keeps the selection bar without it.
   */
  side: ((selected: string, source?: string) => void) | undefined;
  /**
   * How the selection bar draws Side (approval "inbox-side-button", 2026-11-09): the mark of the agent that owns the
   * thread and "Side chat with <agent>", or the two bubbles and "Side chat" (sideButton.tsx). App provides it to the
   * thread's selection bars through `SideButtonContext`.
   */
  sideButton: SideButton;
  /**
   * The reply box's `/side` (the owner, 2026-11-09: "Similar to draw, I want a baked in command for side chat"): the
   * words typed in the reply go to the thread's chat, in its box after any words already there, unquoted, and the box
   * takes focus; `taken` is called once they are in the box, so the reply clears only then. No words: the chat just
   * opens. Undefined exactly where `side` is: the command is listed only where it works.
   */
  sideWords: ((words: string, taken?: () => void) => void) | undefined;
  /** The window. Outside the thread's section: see AskChat. */
  layer: ReactNode;
  /**
   * Open the open thread's chat with these words in its box, after any words
   * already there (code review's Ask on selected lines). Nothing while Ask is off. `source` (a Side's): where the
   * words came from, which the agent gets ahead of the question (AskChat, useAIChat's `contextPreamble`) and the box never shows.
   */
  askWith: (words: string, source?: string) => void;
  /** What the corner (floaters/useReplyFloaters.tsx) needs: this thread's chat as a row of its list, and the window. */
  corner: AskCorner;
}

/**
 * Ask's window as the corner sees it (approval "inbox-reply-floaters"): the corner's list holds this thread's chat
 * while its window is minimized, and a floating draft's window opens beside Ask's window.
 */
export interface AskCorner {
  on: boolean;
  /** The thread whose chat the window shows, or null. */
  threadId: string | null;
  /** The open thread has a chat (a first Ask AI happened): its row shows in the corner. */
  hasChat: boolean;
  /** An answer the person has not seen: a dot on its row. */
  unseen: boolean;
  host: string | null;
  subject: string | null;
  minimized: boolean;
  store: ChatWindowStore;
  open: () => void;
  minimize: () => void;
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
  const [seed, setSeed] = useState<{ threadId: string; words: string; token: number; source?: string; taken?: () => void } | null>(null);
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
    readAsk(reading).then(
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

  // One function for the window's life (a review's selection actions hold it): the thread on screen through its ref.
  const askWith = useCallback(
    (words: string, source?: string, taken?: () => void) => {
      const thread = onScreen.current;
      if (!thread) return;
      openChats.current.add(thread);
      store.setMinimized(false);
      // No words (a bare `/side`): the chat opens with its box as it was.
      if (words.trim()) {
        seedCount += 1;
        setSeed({ threadId: thread, words, token: seedCount, ...(source ? { source } : {}), ...(taken ? { taken } : {}) });
      }
      wantsFocus.current = thread;
      setFocusRequest((count) => count + 1);
    },
    [store],
  );

  const corner: AskCorner = {
    on,
    threadId: askFor,
    hasChat: (model?.conversation?.turns.length ?? 0) > 0,
    unseen: askUnseen(model?.conversation ?? null) !== null,
    host: model?.agent?.host ?? null,
    subject: model?.subject ?? null,
    minimized,
    store,
    open: () => {
      if (!askFor) return;
      openChats.current.add(askFor);
      store.setMinimized(false);
      askForFocus(askFor);
    },
    minimize: () => {
      if (askFor) openChats.current.delete(askFor);
      store.setMinimized(true);
    },
  };

  const canAsk = model?.can_ask === true;
  const side = useCallback((selected: string, source?: string) => askWith(sideQuote(selected), source), [askWith]);
  const sideWords = useCallback((words: string, taken?: () => void) => askWith(words, undefined, taken), [askWith]);

  const sideHost = model?.agent?.host ?? null;
  const sideButton = useMemo(() => sideButtonFor(sideHost), [sideHost]);

  const region = useOpenInCodeRegion({ thread: askFor ?? '' }, codeReview && !!askFor);

  return {
    askWith,
    corner,
    side: canAsk && !phone ? side : undefined,
    sideWords: canAsk && !phone ? sideWords : undefined,
    sideButton,
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
