import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { parseGuideSnapshot } from '@plannotator/core/guide-format';
import { inboxShowMeRequest, type InboxShowMePart, type InboxShowMeTarget } from '@plannotator/core/inbox-review';
import type { ShapeShowMeInput } from '@plannotator/ui/components/shape';
import { useAIChat } from '@plannotator/ui/hooks/useAIChat';
import type { AIResponse } from '@plannotator/ui/types';
import { SESSION_ASK_ERROR_CODES } from '@plannotator/ui/utils/aiProvider';
import type { SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { generateId } from '@plannotator/ui/utils/generateId';
import { inboxApi, type InboxAskTurnWire, type InboxShowMeAsk } from '../api';
import { onAskChange } from '../ask/askEvents';
import { readAsk } from '../ask/askReads';
import { askTurnNote } from '../ask/askModel';
import { errorText } from '../toastError';
import { focusBoardTitle } from '../shape/boardFocus';
import { boardParents, boardPressWaits, earlierLinesNow, reviewLines, showMeEnded, showMeSamePlace, waitingShowMe, type ReviewLines } from './showMeModel';

const ASK_CONTEXT = { mode: 'annotate', annotate: { filePath: '', content: '' } } as const;

export interface ShowMePlace {
  file: string | null;
  lines: [number, number] | null;
  part?: InboxShowMePart;
}

export function showMeFromShape(fromBoard: () => (part: InboxShowMePart, words: string) => void, board: string, input: ShapeShowMeInput): void {
  const part: InboxShowMePart = { board, name: input.name, ...(input.code ? { code: input.code } : {}), ...(input.parts?.length ? { parts: input.parts } : {}) };
  if (!input.picture) return fromBoard()(part, input.words);
  void input.picture
    .catch(() => null)
    .then((picture) => fromBoard()(picture ? { ...part, picture } : part, input.words));
}

export interface ShowMeState {
  canAsk: boolean;
  box: { place: ShowMePlace; words: string; turn: string | null; again?: string } | null;
  drawing: boolean;
  waiting?: 'waiting' | 'interrupting' | null;
  busy?: AIResponse | null;
  answerOnly: string | null;
  problem: string | null;
  posting: boolean;
}

export function useShowMe({
  threadId,
  reviewId,
  title,
  round,
  agent: agentIn,
  others,
  files,
  boardOpen,
  enabled,
  subscribeBoards,
  onBoard,
  say,
}: {
  threadId: string;
  reviewId: string | null;
  title: string;
  round: number;
  agent: string | null;
  others: readonly string[];
  files: readonly { path: string; patch: string }[];
  boardOpen: boolean;
  enabled: boolean;
  subscribeBoards: (listener: () => void) => () => void;
  onBoard: (id: string) => void;
  say?: (text: string) => void;
}) {
  const chat = useAIChat({ context: ASK_CONTEXT });
  const [turns, setTurns] = useState<InboxAskTurnWire[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [canAsk, setCanAsk] = useState(false);
  const [box, setBox] = useState<ShowMeState['box']>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const live = useRef<{ turn: string; index: number } | null>(null);
  const sent = useRef<{ turn: string; question: string; showMe: InboxShowMeAsk } | null>(null);

  const [agentRead, setAgentRead] = useState<string | null>(null);
  const agent = agentIn ?? agentRead;
  const reload = useCallback(() => {
    if (!enabled) return;
    readAsk(threadId).then(
      (model) => {
        setTurns(model.conversation?.turns ?? []);
        setRunning(model.running);
        setCanAsk(model.can_ask);
        setAgentRead(model.agent?.name ?? null);
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

  const [otherLines, setOtherLines] = useState<Record<string, ReviewLines>>({});
  const nowLines = useMemo(() => reviewLines(files), [files]);
  const askedElsewhere = turns.filter((turn) => turn.shape && turn.show_me && !turn.show_me.part && turn.show_me.review !== reviewId);
  const toRead = boardOpen || askedElsewhere.length > 0 ? others.join(',') : '';
  useEffect(() => {
    if (!toRead) return;
    let live = true;
    for (const review of toRead.split(',')) {
      if (otherLines[review]) continue;
      const known = (lines: ReviewLines) => {
        if (live) setOtherLines((current) => ({ ...current, [review]: lines }));
      };
      inboxApi.guide(review).then(
        (answer) => {
          const parsed = parseGuideSnapshot(answer.snapshot);
          known(parsed.ok ? reviewLines(parseDiffToFiles(parsed.value.review.rawPatch)) : new Map());
        },
        () => known(new Map()),
      );
    }
    return () => {
      live = false;
    };
  }, [toRead]);
  const placeNow = (asked: InboxShowMeTarget): ShowMePlace | null => {
    if (!asked.file || !asked.lines) return null;
    const now = earlierLinesNow(asked.lines, otherLines[asked.review ?? '']?.get(asked.file), nowLines.get(asked.file));
    return now ? { file: asked.file, lines: now } : null;
  };

  const turnOf = (id: string | null) => (id ? turns.find((turn) => turn.id === id) : undefined);

  const boxTurn = turnOf(box?.turn ?? null);
  const [queue, setQueue] = useState<{ place: ShowMePlace; words: string }[]>([]);
  const [startingTurn, setStartingTurn] = useState<string | null>(null);
  useEffect(() => {
    if (!boxTurn?.shape) return;
    setBox(null);
    if (queue.length > 0) return;
    onBoard(boxTurn.shape);
    focusBoardTitle(boxTurn.shape, (title) => say?.(title));
  }, [boxTurn?.id, boxTurn?.shape]);

  const streamed = (turnId: string): string => {
    if (live.current?.turn !== turnId) return '';
    return chat.messages[live.current.index]?.response?.text ?? '';
  };
  const answerOf = (turn: InboxAskTurnWire | undefined) => (turn ? (turn.answer ?? streamed(turn.id)) : '');
  const liveResponse = live.current ? chat.messages[live.current.index]?.response : undefined;
  const streaming = liveResponse?.isStreaming === true;

  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) reload();
    wasStreaming.current = streaming;
  }, [streaming, reload]);

  const boxRunning = !!box?.turn && (startingTurn === box.turn || running === box.turn || (live.current?.turn === box.turn && streaming));
  const boxDone = !!boxTurn && (boxTurn.answer !== undefined || boxTurn.stopped === true || boxTurn.failure !== undefined);
  const boxResponse = box?.turn && live.current?.turn === box.turn && !streaming ? liveResponse : undefined;
  const boxBusy = !boxRunning && !boxDone && boxResponse?.errorCode === SESSION_ASK_ERROR_CODES.agentBusy ? boxResponse : null;
  const boxEnded = !!box?.turn && showMeEnded(boxTurn, { running: boxRunning, busy: !!boxBusy });
  const boxFailed = boxEnded ? ((boxTurn && agent && askTurnNote(boxTurn, agent)) ?? boxResponse?.error ?? (boxTurn && live.current?.turn !== box?.turn ? 'No answer arrived.' : null)) : null;
  useEffect(() => {
    if (!boxFailed) return;
    setBox((current) => (current?.turn ? { ...current, turn: null } : current));
    setProblem(boxFailed);
  }, [boxFailed]);

  const openWhenRead = useRef<ShowMePlace | null>(null);
  const stillReading = (place: ShowMePlace) => askedElsewhere.some((turn) => turn.show_me!.file === place.file && !otherLines[turn.show_me!.review ?? '']);

  const open = (place: ShowMePlace) => {
    setProblem(null);
    openWhenRead.current = null;
    const made = turns.filter((turn) => turn.shape && turn.show_me?.review === reviewId && showMeSamePlace(turn.show_me, place)).at(-1);
    if (made?.shape) {
      setBox(null);
      onBoard(made.shape);
      return;
    }
    const waiting = waitingShowMe(turns, reviewId ?? '', place, running, streaming ? (live.current?.turn ?? null) : null);
    if (waiting?.show_me) {
      setBox({
        place: { file: waiting.show_me.file, lines: waiting.show_me.lines },
        words: waiting.show_me.words ?? '',
        turn: waiting.id,
        ...(waiting.again_shape !== undefined ? { again: waiting.again_shape } : {}),
      });
      return;
    }
    if (place.file && place.lines) {
      if (stillReading(place)) {
        openWhenRead.current = place;
        return;
      }
      const elsewhere = askedElsewhere.filter((turn) => {
        const now = placeNow(turn.show_me!);
        return !!now && showMeSamePlace(now, place);
      }).at(-1);
      if (elsewhere?.shape) {
        setBox(null);
        onBoard(elsewhere.shape);
        return;
      }
    }
    setBox({ place, words: '', turn: null });
  };
  useEffect(() => {
    const place = openWhenRead.current;
    if (place && !stillReading(place)) open(place);
  }, [otherLines]);

  const again = (shape: string) => {
    setProblem(null);
    const made = turns.filter((turn) => turn.shape === shape && turn.show_me).at(-1)?.show_me;
    const madePart = made?.part ? (({ picture: _picture, ...part }) => part)(made.part) : undefined;
    const place = madePart ? { file: null, lines: null, part: madePart } : made?.review === reviewId ? { file: made.file, lines: made.lines } : made ? placeNow(made) : null;
    setBox({ place: place ?? { file: null, lines: null }, words: made?.words ?? '', turn: null, again: shape });
  };

  const post = async (turnId: string, question: string, showMe: InboxShowMeAsk, policy?: SessionAskAction) => {
    setPosting(true);
    setProblem(null);
    try {
      const posted = await inboxApi.askSend(threadId, turnId, question, showMe);
      setTurns(posted.conversation.turns);
      if (posted.provider_id) {
        setBox((current) => (current ? { ...current, turn: turnId } : current));
        live.current = { turn: turnId, index: chat.messages.length };
        void chat.ask({ prompt: posted.turn?.question ?? question, ...(policy ? { busyPolicy: policy } : {}) }, { providerId: posted.provider_id });
      } else {
        setBox((current) => (current ? { ...current, turn: null } : current));
        setProblem('No answer arrived.');
      }
      reload();
    } catch (cause) {
      setBox((current) => (current?.turn === turnId ? { ...current, turn: null } : current));
      setProblem(errorText(cause, 'That question did not go through. Try again.'));
    } finally {
      setPosting(false);
    }
  };

  const request = (place: ShowMePlace, rawWords: string, againShape?: string) => {
    const words = rawWords.replace(/\s+/g, ' ').trim();
    const target: InboxShowMeTarget = { review: reviewId, file: place.file, lines: place.lines, round, ...(words ? { words } : {}), ...(place.part ? { part: place.part } : {}) };
    const turnId = generateId('ask');
    const question = inboxShowMeRequest({ target, title, threadId, ...(againShape !== undefined ? { again: againShape } : {}) });
    const showMe: InboxShowMeAsk = { kind: 'show_me', show_me: target, ...(againShape !== undefined ? { again_shape: againShape } : {}) };
    sent.current = { turn: turnId, question, showMe };
    return { turnId, question, showMe };
  };

  const send = async () => {
    if (!box || box.turn || posting) return;
    const asked = request(box.place, box.words, box.again);
    await post(asked.turnId, asked.question, asked.showMe);
  };

  const start = async (place: ShowMePlace, words: string, policy?: SessionAskAction) => {
    const asked = request(place, words);
    setBox({ place, words, turn: asked.turnId });
    setStartingTurn(asked.turnId);
    await post(asked.turnId, asked.question, asked.showMe, policy);
    setStartingTurn(null);
  };

  const fromBoard = (part: InboxShowMePart, words: string) => {
    setProblem(null);
    const place: ShowMePlace = { file: null, lines: null, part };
    const waits = boardPressWaits(box, posting) === 'wait';
    const drawing = !box && running ? turnOf(running) : undefined;
    if (drawing?.show_me) setBox({ place: { file: drawing.show_me.file, lines: drawing.show_me.lines, ...(drawing.show_me.part ? { part: drawing.show_me.part } : {}) }, words: drawing.show_me.words ?? '', turn: drawing.id });
    if (waits || drawing?.show_me) setQueue((current) => [...current, { place, words }]);
    else void start(place, words);
    focusBoardTitle(part.board);
  };
  useEffect(() => {
    if (box || posting || running || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void start(next!.place, next!.words, 'wait');
  }, [box, posting, running, queue.length]);

  const busyChoice = async (policy: SessionAskAction) => {
    const asked = sent.current;
    if (!asked || asked.turn !== box?.turn || posting) return;
    await post(asked.turn, asked.question, asked.showMe, policy);
  };

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
    fromBoard,
    inUse: !!box?.turn || posting || queue.length > 0,
    agent,
    parents: useMemo(() => boardParents(turns), [turns]),
    nowLines,
    linesOf: (review: string): ReviewLines | undefined => otherLines[review],
    boards: [...new Set(turns.flatMap((turn) => (turn.show_me && turn.shape ? [turn.shape] : [])))],
    askedOn: (board: string): string | undefined => [...turns].reverse().find((turn) => turn.shape === board)?.show_me?.review ?? undefined,
  };
}
