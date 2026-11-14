/**
 * A board over its thread or over the grid, with Show me from the board: the same request and the same box as a
 * review's board, with no review behind it. It needs a thread and a live owner, as Ask does (`can_ask`): with neither,
 * the box has Ask and Change it, which wait for the agent, and the board is as it always was.
 *
 * The Show me itself (`useThreadShowMe`) lives in the window, above the board: a board closed while one draws keeps
 * its wait and the presses behind it, and the new board opens when it lands, as over a review.
 */
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import { ShowMeBox } from '../review-drawing/ShowMeLayer';
import { showMeFromShape, useShowMe } from '../review-drawing/useShowMe';
import { ShapeLayer } from './ShapeParts';
import { useBoardsNav } from './ShapeBoardsNav';
import type { InboxShapes } from './useInboxShapes';

const NO_FILES: readonly { path: string; patch: string }[] = [];
const NO_OTHERS: readonly string[] = [];

export type ThreadShowMe = ReturnType<typeof useThreadShowMe>;

/**
 * Show me from the boards over a thread. It keeps to one thread while it has something going (a wait, or presses
 * behind it), so those go to the thread they were pressed in; it moves to the open board's thread when it has none.
 */
export function useThreadShowMe({ shapes, board, onBoard, say }: { shapes: InboxShapes; board: string | null; onBoard: (id: string) => void; say: (text: string) => void }) {
  const boardThread = board ? ((shapes.shapes ?? []).find((shape) => shape.id === board)?.thread ?? null) : null;
  const [threadId, setThreadId] = useState<string | null>(null);
  const showMe = useShowMe({ threadId: threadId ?? '', reviewId: null, title: '', round: 1, agent: null, others: NO_OTHERS, files: NO_FILES, boardOpen: true, enabled: !!threadId, subscribeBoards: shapes.subscribe, onBoard, say });
  useEffect(() => {
    if (!boardThread || boardThread === threadId || showMe.inUse) return;
    showMe.closeBox();
    setThreadId(boardThread);
  }, [boardThread, threadId, showMe.inUse]); // eslint-disable-line react-hooks/exhaustive-deps
  return { showMe, threadId };
}

export function ThreadShapeLayer({
  host,
  id,
  shapes,
  threadShowMe,
  onBoard,
  ...layer
}: Omit<ComponentProps<typeof ShapeLayer>, 'back' | 'headSide'> & { shapes: InboxShapes; threadShowMe: ThreadShowMe; onBoard: (id: string) => void }) {
  const boardThread = (shapes.shapes ?? []).find((shape) => shape.id === id)?.thread ?? null;
  const { showMe, threadId } = threadShowMe;
  const fromBoard = useRef(showMe.fromBoard);
  fromBoard.current = showMe.fromBoard;
  // Show me only on a board of the thread it keeps to: another thread's waits until that one has nothing going.
  const canShowMe = !!boardThread && boardThread === threadId && showMe.state.canAsk;
  const withShowMe = useMemo<ShapeHost>(
    () => (canShowMe ? { ...host, showMe: (board, part) => showMeFromShape(() => fromBoard.current, board, part) } : host),
    [host, canShowMe],
  );
  const nav = useBoardsNav({ shapes: shapes.shapes, threadId: boardThread, board: id, parents: showMe.parents, onBoard });
  return <ShapeLayer {...layer} host={withShowMe} id={id} back={nav.back} headSide={nav.list} />;
}

/** The wait for a Show me from a thread's board: it stays when the board closes, and goes when the new board opens. */
export function ThreadShowMeBox({ threadShowMe }: { threadShowMe: ThreadShowMe }) {
  const { showMe } = threadShowMe;
  return (
    <ShowMeBox
      state={showMe.state}
      agent={showMe.agent}
      onWords={showMe.setWords}
      onSend={() => void showMe.send()}
      onBusy={(policy) => void showMe.busyChoice(policy)}
      onStop={() => void showMe.stop()}
      onClose={showMe.closeBox}
    />
  );
}
