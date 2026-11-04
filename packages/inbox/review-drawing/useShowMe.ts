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
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type InboxAskTurnWire } from '../api';
import { onAskChange } from '../ask/askEvents';
import { errorText } from '../toastError';

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
   */
  shown: { drawing: InboxReviewDrawing; review: string; answer: string; as: 'sheet' | 'corner'; part: { name: string; mark: string | null; file: string; lines: [number, number] } | null } | null;
  /** The turn being drawn (between the request and the picture). */
  drawing: boolean;
  /** The request's answer when it came with no picture. */
  answerOnly: string | null;
  problem: string | null;
  posting: boolean;
}

const overlaps = (a: readonly [number, number], b: readonly [number, number]) => a[0] <= b[1] && b[0] <= a[1];

export function useShowMe({
  threadId,
  reviewId,
  earlier,
  title,
  round,
  enabled,
}: {
  threadId: string;
  reviewId: string;
  /** The thread's earlier reviews (earlier rounds), oldest first: their pictures stay as asked. */
  earlier: readonly string[];
  title: string;
  round: number;
  enabled: boolean;
}) {
  const chat = useAIChat({ context: ASK_CONTEXT });
  const [turns, setTurns] = useState<InboxAskTurnWire[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [drawings, setDrawings] = useState<InboxReviewDrawing[]>([]);
  const [before, setBefore] = useState<{ review: string; drawing: InboxReviewDrawing }[]>([]);
  const [box, setBox] = useState<ShowMeState['box']>(null);
  const [view, setView] = useState<{ drawing: string; as: 'sheet' | 'corner'; part: NonNullable<ShowMeState['shown']>['part'] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const live = useRef<{ turn: string; index: number } | null>(null);
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
    setView({ drawing: boxDrawing.id, as: 'sheet', part: null });
    setBox(null);
  }, [boxTurn?.id, boxDrawing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The stream's words for a turn, until the Inbox keeps the answer.
  const streamed = (turnId: string): string => {
    if (live.current?.turn !== turnId) return '';
    return chat.messages[live.current.index]?.response?.text ?? '';
  };
  const answerOf = (turn: InboxAskTurnWire | undefined) => (turn ? (turn.answer ?? streamed(turn.id)) : '');
  const streaming = live.current ? chat.messages[live.current.index]?.response?.isStreaming === true : false;

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
    view && viewed ? { drawing: viewed.drawing, review: viewed.review, answer: answerOf(turnOf(viewed.drawing.turn)), as: view.as, part: view.part } : null;
  const boxRunning = !!box?.turn && (running === box.turn || (live.current?.turn === box.turn && streaming));
  const boxDone = !!boxTurn && (boxTurn.answer !== undefined || boxTurn.stopped === true || boxTurn.failure !== undefined);

  /**
   * Show me on these lines (or the whole review). Lines an earlier round's
   * picture was asked on open that picture as asked (round 2: it stays, with
   * Show me again); other lines open the box.
   */
  const open = (place: ShowMePlace) => {
    setProblem(null);
    const asked = place.file && place.lines
      ? before.filter((at) => at.drawing.file === place.file && at.drawing.lines && overlaps(at.drawing.lines, place.lines!)).at(-1)
      : undefined;
    if (asked) {
      setBox(null);
      setView({ drawing: asked.drawing.id, as: 'sheet', part: null });
      return;
    }
    setBox({ place, words: '', turn: null });
  };

  /** Show me again: the box for an earlier round's picture, asking for the code as it is now. */
  const again = (drawing: InboxReviewDrawing) => {
    setProblem(null);
    setView(null);
    setBox({ place: { file: drawing.file, lines: drawing.lines }, words: drawing.words ?? '', turn: null, again: drawing.round });
  };

  const send = async () => {
    if (!box || box.turn || posting) return;
    const words = box.words.replace(/\s+/g, ' ').trim();
    const target: InboxShowMeTarget = { review: reviewId, file: box.place.file, lines: box.place.lines, round, ...(words ? { words } : {}) };
    const turnId = generateId('ask');
    const question = inboxShowMeRequest({ target, title, turnId, ...(box.again !== undefined ? { againOfRound: box.again } : {}) });
    setPosting(true);
    setProblem(null);
    try {
      const posted = await inboxApi.askSend(threadId, turnId, question, { kind: 'show_me', show_me: target, ...(box.again !== undefined ? { again_of_round: box.again } : {}) });
      setTurns(posted.conversation.turns);
      setBox((current) => (current ? { ...current, turn: turnId } : current));
      if (posted.provider_id) {
        live.current = { turn: turnId, index: chat.messages.length };
        void chat.ask({ prompt: question }, { providerId: posted.provider_id });
      } else {
        setProblem('The agent can’t take this right now. Try again in a moment.');
      }
      reload();
    } catch (cause) {
      setProblem(errorText(cause, 'That Show me did not go through. Try again.'));
    } finally {
      setPosting(false);
    }
  };

  const stop = async () => {
    const turn = box?.turn;
    if (!turn) return;
    try {
      await inboxApi.askStop(threadId, turn);
    } catch (cause) {
      setProblem(errorText(cause, 'That Stop did not go through. Try again.'));
    }
    reload();
  };

  const state: ShowMeState = {
    canAsk: enabled && canAsk,
    box,
    shown,
    drawing: boxRunning || (!!box?.turn && !boxDone && !boxDrawing),
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
    stop,
    closeBox: () => setBox(null),
    /** A part was clicked: the picture shrinks to the corner card. */
    toCorner: (part: NonNullable<ShowMeState['shown']>['part']) => setView((current) => (current ? { ...current, as: 'corner', part } : current)),
    grow: () => setView((current) => (current ? { ...current, as: 'sheet' } : current)),
    closePicture: () => setView(null),
  };
}
