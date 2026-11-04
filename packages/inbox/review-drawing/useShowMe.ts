/**
 * Show me (approval "shape-in-code-review", mock ac2): the person asks the
 * agent that wrote a review for a picture of some of its lines, or of the
 * whole review. It is an Inbox Ask turn with `kind: "show_me"` on the
 * existing `POST …/ask`, so it takes the same slot and the same pull bridge
 * as Ask; the window builds the request (core's `inboxShowMeRequest`). The
 * agent sends the picture with `plannotator review draw`, which marks the
 * turn and tells the window (`event: ask`); its short answer streams here as
 * an Ask answer does. No new keys.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxShowMeRequest, type InboxReviewDrawing, type InboxShowMeTarget } from '@plannotator/core/inbox-review';
import { useAIChat } from '@plannotator/ui/hooks/useAIChat';
import type { AIResponse } from '@plannotator/ui/types';
import { SESSION_ASK_ERROR_CODES } from '@plannotator/ui/utils/aiProvider';
import type { SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type InboxAskTurnWire } from '../api';
import { onAskChange } from '../ask/askEvents';
import { askTurnNote } from '../ask/askModel';
import { errorText } from '../toastError';
import { showMeSamePlace, waitingShowMe } from './showMeModel';

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
  /** The box: composing (`turn` null) or the request it sent; `again`: Show me again for a picture of that round. */
  box: { place: ShowMePlace; words: string; turn: string | null; again?: number } | null;
  /**
   * The picture on screen: the sheet over the review, or the corner card.
   * `review`: the review it was asked on (an earlier round's, when it stays as asked).
   * `from`: the place the person pressed Show me on that opened it (this round's lines), if any.
   */
  shown: {
    drawing: InboxReviewDrawing;
    review: string;
    answer: string;
    as: 'sheet' | 'corner';
    part: { name: string; mark: string | null; file: string; lines: [number, number] } | null;
    from: ShowMePlace | null;
  } | null;
  /** The turn is running: the agent is drawing it (or, `waiting`, about to). */
  drawing: boolean;
  /** While it runs: the agent was busy and the Show me waits for it, or interrupts it (the Ask window's words). */
  waiting?: 'waiting' | 'interrupting' | null;
  /** The agent was busy when asked: the Ask window's choice (ask when it finishes, or interrupt). */
  busy?: AIResponse | null;
  /** The request's answer when it came with no picture. */
  answerOnly: string | null;
  problem: string | null;
  posting: boolean;
}


export function useShowMe({
  threadId,
  reviewId,
  earlier,
  title,
  round,
  agent,
  enabled,
}: {
  threadId: string;
  reviewId: string;
  /** The thread's earlier reviews (earlier rounds), oldest first: their pictures stay as asked. */
  earlier: readonly string[];
  title: string;
  round: number;
  /** The agent's name, for the Ask window's notes ("Claude Code went away before it finished."). */
  agent: string;
  enabled: boolean;
}) {
  const chat = useAIChat({ context: ASK_CONTEXT });
  const [turns, setTurns] = useState<InboxAskTurnWire[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [drawings, setDrawings] = useState<InboxReviewDrawing[]>([]);
  const [before, setBefore] = useState<{ review: string; drawing: InboxReviewDrawing }[]>([]);
  const [box, setBox] = useState<ShowMeState['box']>(null);
  const [view, setView] = useState<{ drawing: string; as: 'sheet' | 'corner'; part: NonNullable<ShowMeState['shown']>['part']; from: ShowMePlace | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const live = useRef<{ turn: string; index: number } | null>(null);
  /** What the box sent, to send again when the person picks a busy choice (the same turn, as Ask's retry). */
  const sent = useRef<{ turn: string; question: string; showMe: Parameters<typeof inboxApi.askSend>[3] } | null>(null);
  const opened = useRef(new Set<string>());

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
    inboxApi.reviewDrawings(reviewId).then(
      (read) => setDrawings(read.drawings),
      () => {},
    );
  }, [enabled, threadId, reviewId]);

  const earlierKey = earlier.join(',');
  useEffect(() => {
    setBefore([]);
    if (!enabled || earlier.length === 0) return;
    let live = true;
    Promise.all(
      earlier.map((review) =>
        inboxApi.reviewDrawings(review).then(
          (read) => read.drawings.map((drawing) => ({ review, drawing })),
          () => [],
        ),
      ),
    ).then((all) => {
      if (live) setBefore(all.flat());
    });
    return () => {
      live = false;
    };
  }, [enabled, earlierKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    reload();
    return onAskChange((changed) => {
      if (changed === null || changed === threadId) reload();
    });
  }, [reload, threadId]);

  const turnOf = (id: string | null) => (id ? turns.find((turn) => turn.id === id) : undefined);
  const drawingOf = (turn: InboxAskTurnWire | undefined) => (turn?.drawing ? drawings.find((drawing) => drawing.id === turn.drawing) : undefined);

  // The picture for the request in the box arrived: it opens over the review, once.
  const boxTurn = turnOf(box?.turn ?? null);
  const boxDrawing = drawingOf(boxTurn);
  useEffect(() => {
    if (!boxTurn || !boxDrawing || opened.current.has(boxDrawing.id)) return;
    opened.current.add(boxDrawing.id);
    setView({ drawing: boxDrawing.id, as: 'sheet', part: null, from: box?.place ?? null });
    setBox(null);
  }, [boxTurn?.id, boxDrawing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const viewed = view
    ? (drawings.map((drawing) => ({ review: reviewId, drawing })).find((at) => at.drawing.id === view.drawing) ?? before.find((at) => at.drawing.id === view.drawing))
    : undefined;
  const shown: ShowMeState['shown'] =
    view && viewed ? { drawing: viewed.drawing, review: viewed.review, answer: answerOf(turnOf(viewed.drawing.turn)), as: view.as, part: view.part, from: view.from } : null;
  // Drawing only while the turn runs (the Inbox's slot holds it, or this page's answer streams), as waitingShowMe
  // reads it: a Show me the agent never took (busy, no connection) is not drawing.
  const boxRunning = !!box?.turn && (running === box.turn || (live.current?.turn === box.turn && streaming));
  const boxDone = !!boxTurn && (boxTurn.answer !== undefined || boxTurn.stopped === true || boxTurn.failure !== undefined);
  const boxResponse = box?.turn && live.current?.turn === box.turn && !streaming ? liveResponse : undefined;
  const boxBusy = !boxRunning && !boxDone && boxResponse?.errorCode === SESSION_ASK_ERROR_CODES.agentBusy ? boxResponse : null;
  // It ended with no picture and no answer: the Ask window's note for the turn (the agent went…), else the chat's
  // own problem (the session is blocked…).
  const boxFailed =
    box?.turn && !boxRunning && !boxBusy && !boxDrawing && !boxTurn?.stopped && boxTurn?.answer === undefined
      ? ((boxTurn && askTurnNote(boxTurn, agent)) ?? boxResponse?.error ?? null)
      : null;
  // The box goes back to its words, with the note, ready to send again.
  useEffect(() => {
    if (!boxFailed) return;
    setBox((current) => (current?.turn ? { ...current, turn: null } : current));
    setProblem(boxFailed);
  }, [boxFailed]);

  /**
   * Show me on these lines (or the whole review). What was asked about the
   * same place opens again, never a second request: this review's picture
   * (from this window or another one; the same place by `showMeSamePlace`),
   * else the Show me the agent is drawing now (its box, waiting), else an
   * earlier round's picture of the same place by the same rule, as asked
   * (round 2: it stays, with Show me again). Other lines open the box.
   */
  const open = (place: ShowMePlace) => {
    setProblem(null);
    const drawn = drawings.filter((drawing) => showMeSamePlace(drawing, place)).at(-1);
    if (drawn) {
      opened.current.add(drawn.id);
      setBox(null);
      setView({ drawing: drawn.id, as: 'sheet', part: null, from: place });
      return;
    }
    const waiting = waitingShowMe(turns, reviewId, place, running, streaming ? (live.current?.turn ?? null) : null);
    if (waiting?.show_me) {
      setView(null);
      setBox({
        place: { file: waiting.show_me.file, lines: waiting.show_me.lines },
        words: waiting.show_me.words ?? '',
        turn: waiting.id,
        ...(waiting.again_of_round !== undefined ? { again: waiting.again_of_round } : {}),
      });
      return;
    }
    const asked = place.file && place.lines ? before.filter((at) => showMeSamePlace(at.drawing, place)).at(-1) : undefined;
    if (asked) {
      setBox(null);
      setView({ drawing: asked.drawing.id, as: 'sheet', part: null, from: place });
      return;
    }
    setBox({ place, words: '', turn: null });
  };

  /**
   * Show me again: the box for a picture's lines, asked anew (other words).
   * An earlier round's asks for the code as it is now; `place`: where those
   * lines are in this round (the host anchors them, or takes the lines the
   * person pressed Show me on); absent, the lines the picture was asked on.
   */
  const again = (drawing: InboxReviewDrawing, place?: ShowMePlace) => {
    setProblem(null);
    setView(null);
    setBox({ place: place ?? { file: drawing.file, lines: drawing.lines }, words: drawing.words ?? '', turn: null, ...(drawing.round < round ? { again: drawing.round } : {}) });
  };

  /** POST the turn (again, for a busy choice: the same turn) and start its answer, as the Ask window does. */
  const post = async (turnId: string, question: string, showMe: Parameters<typeof inboxApi.askSend>[3], policy?: SessionAskAction) => {
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
        setProblem('The agent can’t take this right now. Try again in a moment.');
      }
      reload();
    } catch (cause) {
      setProblem(errorText(cause, 'That Show me did not go through. Try again.'));
    } finally {
      setPosting(false);
    }
  };

  const send = async () => {
    if (!box || box.turn || posting) return;
    const words = box.words.replace(/\s+/g, ' ').trim();
    const target: InboxShowMeTarget = { review: reviewId, file: box.place.file, lines: box.place.lines, round, ...(words ? { words } : {}) };
    const turnId = generateId('ask');
    const question = inboxShowMeRequest({ target, title, turnId, ...(box.again !== undefined ? { againOfRound: box.again } : {}) });
    const showMe = { kind: 'show_me' as const, show_me: target, ...(box.again !== undefined ? { again_of_round: box.again } : {}) };
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
    shown,
    drawing: boxRunning,
    waiting: boxRunning && live.current?.turn === box?.turn ? (liveResponse?.status ?? null) : null,
    busy: boxBusy,
    answerOnly: box?.turn && boxDone && !boxDrawing ? answerOf(boxTurn) || null : null,
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
    /** A part was clicked: the picture shrinks to the corner card. */
    toCorner: (part: NonNullable<ShowMeState['shown']>['part']) => setView((current) => (current ? { ...current, as: 'corner', part } : current)),
    grow: () => setView((current) => (current ? { ...current, as: 'sheet' } : current)),
    closePicture: () => setView(null),
  };
}
