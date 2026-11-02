import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChatWindowStore, useChatFrameFocusReturn } from '@plannotator/ui/components/chat';
import { inboxApi, type InboxAskChat, type InboxAskConversationWire, type InboxAskModel } from '../api';
import { Tip } from '../components/Tip';
import { AskChat } from './AskChat';
import { onAskChange } from './askEvents';

export interface InboxAskOptions {
  /** `ask_ai` in the settings, and not the tour: while false nothing is read and nothing shows. */
  on: boolean;
  /** The open thread, when this Inbox holds it. */
  threadId: string | null;
  phone: boolean;
  openThread: (threadId: string) => void;
  replyInThread: (threadId: string, words: string) => void;
}

export interface InboxAskParts {
  /** The Ask AI icon for the thread's top bar, or null. */
  button: ReactNode;
  /** The same icon for a full-screen file's bar. */
  fileButton: ReactNode;
  /** The window. Outside the thread's section: see AskChat. */
  layer: ReactNode;
}

/** Lucide's sparkles: the Inbox's own icons have no such mark, and `packages/inbox` does not depend on lucide. */
function SparklesIcon() {
  return (
    <svg className="ib-ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

/**
 * Ask AI in the Inbox, for App.tsx: one window whose chat follows the open
 * thread. A thread comes back as it was left: open if it was open, minimized
 * otherwise. Picking a row only changes `#thread=`, so the window shows the
 * chat of whatever thread is on screen and the two can never disagree.
 */
export function useInboxAsk({ on, threadId, phone, openThread, replyInThread }: InboxAskOptions): InboxAskParts {
  const store = useMemo(() => new ChatWindowStore(), []);
  const minimized = useSyncExternalStore(store.subscribe, () => store.minimized);
  useChatFrameFocusReturn(store);
  const askFor = on ? threadId : null;
  const openChats = useRef(new Set<string>());

  const [read, setRead] = useState<{ threadId: string; model: InboxAskModel } | null>(null);
  const [picked, setPicked] = useState<InboxAskChat | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  // Newest wins: a slow read must not paint over a later one, or over a send's own answer.
  const readSeq = useRef(0);

  const reload = useCallback(() => {
    if (!askFor) return;
    const seq = ++readSeq.current;
    inboxApi.askRead(askFor).then(
      (model) => {
        if (seq === readSeq.current) setRead({ threadId: askFor, model });
      },
      () => {
        // Nothing to show for this thread; the next event reads again.
      },
    );
  }, [askFor]);

  useEffect(() => {
    reload();
    return onAskChange((changed) => {
      if (changed === null || changed === askFor) reload();
    });
  }, [askFor, reload]);

  const adopt = useCallback(
    (conversation: InboxAskConversationWire) => {
      setRead((last) => (last?.threadId === askFor ? { ...last, model: { ...last.model, conversation } } : last));
      // POST /ask knows the conversation, not the running turn: the read after it does.
      reload();
    },
    [askFor, reload],
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
    setFocusRequest((count) => count + 1);
  };

  const pick = (chat: InboxAskChat) => {
    if (chat.thread_id === askFor) return;
    openChats.current.add(chat.thread_id);
    setPicked(chat);
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

  const icon = (className: string) =>
    model?.can_ask ? (
      <Tip content="Ask AI about this thread">
        <button type="button" className={className} aria-label="Ask AI about this thread" aria-pressed={pressed} data-chat-launcher="" data-ask-open="" onClick={press}>
          <SparklesIcon />
        </button>
      </Tip>
    ) : null;

  return {
    button: icon('ib-iconbtn ib-artbtn'),
    fileButton: icon(pressed ? 'ib-fvb ib-on' : 'ib-fvb'),
    layer: askFor ? (
      <div className="ib-ask-layer" data-ask-layer="" onPointerDownCapture={keepFocusIn}>
        <AskChat
          key={askFor}
          threadId={askFor}
          store={store}
          model={model}
          picked={picked?.thread_id === askFor ? picked : null}
          phone={phone}
          focusRequest={focusRequest}
          onPick={pick}
          onLeave={() => {
            openChats.current.delete(askFor);
          }}
          onConversation={adopt}
          onReload={reload}
          onReply={(words) => replyInThread(askFor, words)}
        />
      </div>
    ) : null,
  };
}
