import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatComposer, ChatFrame, ChatTranscript, type ChatMessage, type ChatStatus, type ChatTextPart, type ChatWindowStore } from '@plannotator/ui/components/chat';
import { SessionAskActions, type SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { useAIChat } from '@plannotator/ui/hooks/useAIChat';
import { SESSION_ASK_ERROR_CODES } from '@plannotator/ui/utils/aiProvider';
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type InboxAskChat, type InboxAskConversationWire, type InboxAskModel, type InboxAskTurnWire } from '../api';
import { isTouchPhone } from '../phone';
import { errorText } from '../toastError';
import { AskChatMenu } from './AskChatMenu';
import { askAnswerId, askChatName, askMessages, askStopped, askTurnNote, askUnanswered, askUnseen, askUserId } from './askModel';
import { readAskWords, saveAskWords } from './askWords';

/** The server writes the real context for each session (inbox-ask.ts): the hook only needs one to start. */
const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

export interface AskChatProps {
  threadId: string;
  store: ChatWindowStore;
  /** This thread's chat, or null while it is first read. */
  model: InboxAskModel | null;
  /** The row picked in the dropdown: its header until the read arrives. */
  picked: InboxAskChat | null;
  phone: boolean;
  /** Each press of the top bar icon: the box takes focus. */
  focusRequest: number;
  onPick: (chat: InboxAskChat) => void;
  onLeave: () => void;
  onConversation: (conversation: InboxAskConversationWire) => void;
  onReload: () => void;
  onReply: (words: string) => void;
}

/**
 * One thread's chat: its transcript, its box and its live answer. Keyed by
 * thread, and mounted while the window is minimized, so an answer keeps
 * arriving. The saved file is the truth and the stream only fills in the turn
 * running here; leaving the thread drops the stream, the server finishes the
 * answer, and coming back reads it.
 *
 * No Escape, no chord and no `useChatFrameKeys`: the Inbox gets no new
 * shortcuts. The window sits outside the thread's section and wears
 * `data-popover-layer`, so its keys reach neither the reply nor the ladder.
 */
export function AskChat({ threadId, store, model, picked, phone, focusRequest, onPick, onLeave, onConversation, onReload, onReply }: AskChatProps) {
  const chat = useAIChat({ context: ASK_CONTEXT });
  const [words, setWords] = useState(() => readAskWords(threadId));
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  /** The turn this window's stream belongs to, and its place in the hook's list (the list only grows). */
  const [live, setLive] = useState<{ turnId: string; index: number } | null>(null);
  const liveTurn = live?.turnId ?? null;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const conversation = model?.conversation ?? null;
  const agent = model?.agent ?? { host: picked?.host ?? null, name: '' };
  const response = live ? chat.messages[live.index]?.response : undefined;
  const streaming = response?.isStreaming === true;
  const saved = conversation?.turns.find((turn) => turn.id === liveTurn);
  const answerSaved = saved !== undefined && (saved.answer !== undefined || saved.failure !== undefined || saved.stopped === true);
  // The turn being answered: this window's stream, or the Inbox's word for one that started before a reload or elsewhere.
  const runningTurn = streaming && !answerSaved ? liveTurn : (model?.running ?? null);
  const busy = runningTurn !== null;
  const liveText = liveTurn && response && !answerSaved ? { turnId: liveTurn, text: response.text, streaming } : null;
  const messages = useMemo(() => askMessages(conversation, liveText), [conversation, liveText?.turnId, liveText?.text, liveText?.streaming]);
  const stopped = useMemo(() => askStopped(conversation), [conversation]);

  useEffect(() => {
    saveAskWords(threadId, words);
  }, [threadId, words]);

  // The stream ended here: read what the Inbox kept, whether or not its event came first.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) onReload();
    wasStreaming.current = streaming;
  }, [streaming, onReload]);
  useEffect(() => {
    if (runningTurn === null) setStopping(false);
  }, [runningTurn]);

  // Mark answers seen only while they are on screen.
  const unseen = askUnseen(conversation);
  const seenSent = useRef<string | null>(null);
  const windowOpen = !store.minimized;
  useEffect(() => {
    if (!windowOpen || !unseen || seenSent.current === unseen) return;
    seenSent.current = unseen;
    void inboxApi.askSeen(threadId, unseen).catch(() => {
      seenSent.current = null;
    });
  }, [threadId, unseen, windowOpen]);

  useLayoutEffect(() => {
    if (focusRequest > 0) composerRef.current?.focus();
  }, [focusRequest]);

  /** Start, or restart, the answer of a turn POST /ask accepted. */
  const answer = (turnId: string, question: string, providerId: string, policy?: SessionAskAction) => {
    setLive({ turnId, index: chat.messages.length });
    void chat.ask({ prompt: question, ...(policy ? { busyPolicy: policy } : {}) }, { providerId });
  };

  const post = async (turnId: string, question: string): Promise<string | null> => {
    const posted = await inboxApi.askSend(threadId, turnId, question);
    onConversation(posted.conversation);
    return posted.provider_id;
  };

  const send = async () => {
    const question = words.trim();
    if (!question || busy || postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    setProblem(null);
    const turnId = generateId('ask');
    try {
      const providerId = await post(turnId, question);
      // Only now: a refused question keeps its words, and words added meanwhile stay.
      setWords((box) => (box.trim() === question ? '' : box));
      if (providerId) answer(turnId, question, providerId);
    } catch (cause) {
      setProblem(errorText(cause, 'That question did not go through. Try again.'));
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };

  /** Ask a saved turn again: the same id, so it stays one question. */
  const askAgain = async (turn: InboxAskTurnWire, policy?: SessionAskAction) => {
    if (postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    setProblem(null);
    try {
      const providerId = await post(turn.id, turn.question);
      if (providerId) answer(turn.id, turn.question, providerId, policy);
    } catch (cause) {
      setProblem(errorText(cause, 'That question did not go through. Try again.'));
    } finally {
      postingRef.current = false;
      setPosting(false);
    }
  };

  // Stop goes by turn id, not by this page's AI session: it works after a reload and from another window.
  const stop = async () => {
    if (!runningTurn || stopping) return;
    setStopping(true);
    try {
      await inboxApi.askStop(threadId, runningTurn);
      onReload();
    } catch (cause) {
      setStopping(false);
      setProblem(errorText(cause, 'That Stop did not go through. Try again.'));
    }
  };

  const name = agent.name || 'The agent';
  const mark = <HostMark host={agent.host} />;

  const pendingLine = response?.status === 'waiting' ? `Waiting for ${name} to finish…` : response?.status === 'interrupting' ? `Interrupting ${name}…` : runningTurn && runningTurn !== liveTurn ? 'Answering…' : 'Connecting…';
  const hasWords = liveText ? liveText.text.length > 0 : false;
  const status: ChatStatus = !busy ? 'ready' : hasWords ? 'streaming' : 'submitted';

  const turnFooter = (turn: InboxAskTurnWire) => {
    const here = turn.id === liveTurn && !streaming ? response : undefined;
    if (here?.errorCode === SESSION_ASK_ERROR_CODES.agentBusy && turn.answer === undefined && !turn.stopped) {
      return (
        <div className="ib-ask-note" data-ask-note="busy">
          <p>{name} is working on something else.</p>
          <SessionAskActions response={here} onAction={(policy) => void askAgain(turn, policy)} />
        </div>
      );
    }
    if (turn.id === runningTurn) return null;
    const note = askTurnNote(turn, name) ?? (here?.error && turn.answer === undefined ? here.error : null);
    if (turn.stopped && turn.answer === undefined) {
      return (
        <p className="ib-ask-note" data-ask-note="stopped">
          Stopped.
        </p>
      );
    }
    if (!note && !askUnanswered(turn, runningTurn)) return null;
    return (
      <div className="ib-ask-note" data-ask-note="unanswered">
        <p>{note ?? 'No answer arrived.'}</p>
        <span className="ib-ask-noteacts">
          {turn.answer === undefined && (
            <button type="button" className="ib-ask-notebtn" disabled={busy || posting} onClick={() => void askAgain(turn)}>
              Ask again
            </button>
          )}
          <button
            type="button"
            className="ib-ask-notebtn"
            onClick={() => {
              onReply(turn.question);
              // A window that fills the screen would cover the reply it just opened.
              if (store.fullscreen || phone) onLeave();
            }}
          >
            Reply in the thread
          </button>
        </span>
      </div>
    );
  };

  const footer = (message: ChatMessage<ChatTextPart>) => {
    const turn = conversation?.turns.find((candidate) => askUserId(candidate.id) === message.id || askAnswerId(candidate.id) === message.id);
    if (!turn) return null;
    // Under the turn's last row.
    const hasAnswerRow = messages.some((row) => row.id === askAnswerId(turn.id));
    if (message.id !== (hasAnswerRow ? askAnswerId(turn.id) : askUserId(turn.id))) return null;
    return turnFooter(turn);
  };

  const last = conversation?.turns.at(-1);
  const current: InboxAskChat | null = model
    ? { thread_id: threadId, subject: model.subject, project: model.project, host: agent.host, at: last?.answered_at ?? last?.at ?? new Date().toISOString(), unread: false, answering: false }
    : picked;
  if (!current) return null;

  return (
    <ChatFrame
      store={store}
      label={`Ask AI: ${askChatName(current.subject)}`}
      className="isolate"
      rootProps={{ 'data-popover-layer': '', 'data-ask-window': threadId }}
      header={() => <AskChatMenu current={current} phone={phone} onPick={onPick} />}
      onMinimize={onLeave}
      onClose={() => {
        store.setMinimized(true);
        onLeave();
      }}
    >
      {() => (
        <>
          <ChatTranscript<ChatTextPart>
            messages={messages}
            status={status}
            agentName={name}
            agentMark={mark}
            label="Ask AI conversation"
            scrollRef={paneRef}
            stopped={stopped}
            pending={pendingLine}
            messageFooter={footer}
            empty={model ? <p className="ib-ask-empty">Ask {agent.name || 'the agent'} about this thread.</p> : null}
          />
          <ChatComposer
            value={words}
            onChange={setWords}
            onSend={() => void send()}
            onStop={() => void stop()}
            busy={busy}
            disabled={!model}
            sendOnEnter={!isTouchPhone()}
            label="Ask about this thread"
            placeholder="Ask about this thread"
            composerRef={composerRef}
            notices={
              problem ? (
                <p role="alert" className="ib-ask-problem">
                  {problem}
                </p>
              ) : undefined
            }
          />
        </>
      )}
    </ChatFrame>
  );
}
