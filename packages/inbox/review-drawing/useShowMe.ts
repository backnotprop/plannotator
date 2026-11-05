/**
 * Show me makes a Shape (approval "code-review-launch-build", item 1): the
 * person asks the agent that wrote a review for a Shape of some of its lines, or
 * of the whole review. It is an Inbox Ask turn with `kind: "show_me"` on the
 * existing `POST …/ask`, so it takes the same slot and the same pull bridge as
 * Ask; the window builds the request (core's `inboxShowMeRequest`). The agent
 * stores the board with `plannotator shape update --thread`, the way any board
 * is stored; the Inbox names it on the turn when the window reads the
 * conversation (`showMeShapes`), and the board opens over the review. Its short
 * answer streams here as an Ask answer does. No new keys.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxShowMeRequest, type InboxShowMeTarget } from '@plannotator/core/inbox-review';
import { useAIChat } from '@plannotator/ui/hooks/useAIChat';
import type { AIResponse } from '@plannotator/ui/types';
import { SESSION_ASK_ERROR_CODES } from '@plannotator/ui/utils/aiProvider';
import type { SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type InboxAskTurnWire, type InboxShowMeAsk } from '../api';
import { onAskChange } from '../ask/askEvents';
import { askTurnNote } from '../ask/askModel';
import { errorText } from '../toastError';
import { showMeEnded, showMeSamePlace, waitingShowMe } from './showMeModel';

/** The server writes the real context for each session (inbox-ask.ts): the hook only needs one to start. */
const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

/** What a Show me is about: lines of a file, or the whole review (`file` null). */
export interface ShowMePlace {
  file: string | null;
  lines: [number, number] | null;
}

export interface ShowMeState {
  /** Whether the agent can take a Show me now (a live owner); the buttons show only then. */
  canAsk: boolean;
  /** The box: composing (`turn` null) or the request it sent; `again`: Show me again, for this board. */
  box: { place: ShowMePlace; words: string; turn: string | null; again?: string } | null;
  /** The turn is running: the agent is drawing it (or, `waiting`, about to). */
  drawing: boolean;
  /** While it runs: the agent was busy and the Show me waits for it, or interrupts it (the Ask window's words). */
  waiting?: 'waiting' | 'interrupting' | null;
  /** The agent was busy when asked: the Ask window's choice (ask when it finishes, or interrupt). */
  busy?: AIResponse | null;
  /** The request's answer when it came with no board. */
  answerOnly: string | null;
  problem: string | null;
  posting: boolean;
}

export function useShowMe({
  threadId,
  reviewId,
  title,
  round,
  agent,
  enabled,
  subscribeBoards,
  onBoard,
}: {
  threadId: string;
  reviewId: string;
  title: string;
  round: number;
  /** The agent's name, for the Ask window's notes ("Claude Code went away before it finished."). */
  agent: string;
  enabled: boolean;
  /** Boards changed: the window's `event: shapes`. Returns the unsubscribe. */
  subscribeBoards: (listener: () => void) => () => void;
  /** Open this board over the review. */
  onBoard: (id: string) => void;
}) {
  const chat = useAIChat({ context: ASK_CONTEXT });
  const [turns, setTurns] = useState<InboxAskTurnWire[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [box, setBox] = useState<ShowMeState['box']>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const live = useRef<{ turn: string; index: number } | null>(null);
  /** What the box sent, to send again when the person picks a busy choice (the same turn, as Ask's retry). */
  const sent = useRef<{ turn: string; question: string; showMe: InboxShowMeAsk } | null>(null);

  const reload = useCallback(() => {
    if (!enabled) return;
    inboxApi.askRead(threadId).then(
      (model) => {
        setTurns(model.conversation?.turns ?? []);
        setRunning(model.running);
        setCanAsk(model.can_ask);
      },
      () => {},
    );
  }, [enabled, threadId]);

  useEffect(() => {
    reload();
    const stopAsk = onAskChange((changed) => {
      if (changed === null || changed === threadId) reload();
    });
    const stopBoards = subscribeBoards(reload);
    return () => {
      stopAsk();
      stopBoards();
    };
  }, [reload, threadId, subscribeBoards]);

  const turnOf = (id: string | null) => (id ? turns.find((turn) => turn.id === id) : undefined);

  // The board for the request in the box arrived: it opens over the review.
  const boxTurn = turnOf(box?.turn ?? null);
  useEffect(() => {
    if (!boxTurn?.shape) return;
    setBox(null);
    onBoard(boxTurn.shape);
  }, [boxTurn?.id, boxTurn?.shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // The stream's words for a turn, until the Inbox keeps the answer.
  const streamed = (turnId: string): string => {
    if (live.current?.turn !== turnId) return '';
    return chat.messages[live.current.index]?.response?.text ?? '';
  };
  const answerOf = (turn: InboxAskTurnWire | undefined) => (turn ? (turn.answer ?? streamed(turn.id)) : '');
  const liveResponse = live.current ? chat.messages[live.current.index]?.response : undefined;
  const streaming = liveResponse?.isStreaming === true;

  // The stream ended: read what the Inbox kept.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) reload();
    wasStreaming.current = streaming;
  }, [streaming, reload]);

  // Drawing only while the turn runs (the Inbox's slot holds it, or this page's answer streams), as waitingShowMe
  // reads it: a Show me the agent never took (busy, no connection) is not drawing.
  const boxRunning = !!box?.turn && (running === box.turn || (live.current?.turn === box.turn && streaming));
  const boxDone = !!boxTurn && (boxTurn.answer !== undefined || boxTurn.stopped === true || boxTurn.failure !== undefined);
  const boxResponse = box?.turn && live.current?.turn === box.turn && !streaming ? liveResponse : undefined;
  const boxBusy = !boxRunning && !boxDone && boxResponse?.errorCode === SESSION_ASK_ERROR_CODES.agentBusy ? boxResponse : null;
  // It ended with no board and no answer: the Ask window's note for the turn (the agent went…), else the chat's own
  // problem (the session is blocked…). A window that is not streaming it (a reload) has no chat: when the Inbox no
  // longer runs the turn and kept nothing, it is the Ask window's "No answer arrived."
  const boxEnded = !!box?.turn && showMeEnded(boxTurn, { running: boxRunning, busy: !!boxBusy });
  const boxFailed = boxEnded ? ((boxTurn && askTurnNote(boxTurn, agent)) ?? boxResponse?.error ?? (boxTurn && live.current?.turn !== box?.turn ? 'No answer arrived.' : null)) : null;
  // The box goes back to its words, with the note, ready to send again.
  useEffect(() => {
    if (!boxFailed) return;
    setBox((current) => (current?.turn ? { ...current, turn: null } : current));
    setProblem(boxFailed);
  }, [boxFailed]);

  /**
   * Show me on these lines (or the whole review). What was asked about the
   * same place opens again, never a second request: the board a Show me on it
   * made (in this round or an earlier one), else the Show me the agent is
   * drawing now (its box, waiting). Other lines open the box.
   */
  const open = (place: ShowMePlace) => {
    setProblem(null);
    const made = turns.filter((turn) => turn.shape && turn.show_me && showMeSamePlace(turn.show_me, place)).at(-1);
    if (made?.shape) {
      setBox(null);
      onBoard(made.shape);
      return;
    }
    const waiting = waitingShowMe(turns, reviewId, place, running, streaming ? (live.current?.turn ?? null) : null);
    if (waiting?.show_me) {
      setBox({
        place: { file: waiting.show_me.file, lines: waiting.show_me.lines },
        words: waiting.show_me.words ?? '',
        turn: waiting.id,
        ...(waiting.again_shape !== undefined ? { again: waiting.again_shape } : {}),
      });
      return;
    }
    setBox({ place, words: '', turn: null });
  };

  /** Show me again: the box for what this board was made of, asked anew as a new version (other words). */
  const again = (shape: string) => {
    setProblem(null);
    const made = turns.filter((turn) => turn.shape === shape && turn.show_me).at(-1)?.show_me;
    setBox({ place: made ? { file: made.file, lines: made.lines } : { file: null, lines: null }, words: made?.words ?? '', turn: null, again: shape });
  };

  /** POST the turn (again, for a busy choice: the same turn) and start its answer, as the Ask window does. */
  const post = async (turnId: string, question: string, showMe: InboxShowMeAsk, policy?: SessionAskAction) => {
    setPosting(true);
    setProblem(null);
    try {
      const posted = await inboxApi.askSend(threadId, turnId, question, showMe);
      setTurns(posted.conversation.turns);
      if (posted.provider_id) {
        setBox((current) => (current ? { ...current, turn: turnId } : current));
        live.current = { turn: turnId, index: chat.messages.length };
        void chat.ask({ prompt: question, ...(policy ? { busyPolicy: policy } : {}) }, { providerId: posted.provider_id });
      } else {
        // Nobody to ask: the box stays as it was written, to send when the agent is back.
        setBox((current) => (current ? { ...current, turn: null } : current));
        setProblem('No answer arrived.');
      }
      reload();
    } catch (cause) {
      setProblem(errorText(cause, 'That question did not go through. Try again.'));
    } finally {
      setPosting(false);
    }
  };

  const send = async () => {
    if (!box || box.turn || posting) return;
    const words = box.words.replace(/\s+/g, ' ').trim();
    const target: InboxShowMeTarget = { review: reviewId, file: box.place.file, lines: box.place.lines, round, ...(words ? { words } : {}) };
    const turnId = generateId('ask');
    const question = inboxShowMeRequest({ target, title, threadId, ...(box.again !== undefined ? { again: box.again } : {}) });
    const showMe: InboxShowMeAsk = { kind: 'show_me', show_me: target, ...(box.again !== undefined ? { again_shape: box.again } : {}) };
    sent.current = { turn: turnId, question, showMe };
    await post(turnId, question, showMe);
  };

  /** The agent was busy: the person's choice, ask when it finishes or interrupt it (the Ask window's busy choice). */
  const busyChoice = async (policy: SessionAskAction) => {
    const asked = sent.current;
    if (!asked || asked.turn !== box?.turn || posting) return;
    await post(asked.turn, asked.question, asked.showMe, policy);
  };

  /** Stop: the running turn stops; a Show me that is not running (busy, or never taken) just goes. */
  const stop = async () => {
    const turn = box?.turn;
    if (!turn) return;
    if (boxRunning) {
      try {
        await inboxApi.askStop(threadId, turn);
      } catch (cause) {
        setProblem(errorText(cause, 'That Stop did not go through. Try again.'));
        return;
      }
    }
    setBox(null);
    setProblem(null);
    reload();
  };

  const state: ShowMeState = {
    canAsk: enabled && canAsk,
    box,
    drawing: boxRunning,
    waiting: boxRunning && live.current?.turn === box?.turn ? (liveResponse?.status ?? null) : null,
    busy: boxBusy,
    answerOnly: box?.turn && boxDone && !boxTurn?.shape ? answerOf(boxTurn) || null : null,
    problem,
    posting,
  };

  return {
    state,
    open,
    again,
    setWords: (words: string) => setBox((current) => (current && !current.turn ? { ...current, words } : current)),
    send,
    busyChoice,
    stop,
    closeBox: () => setBox(null),
  };
}
