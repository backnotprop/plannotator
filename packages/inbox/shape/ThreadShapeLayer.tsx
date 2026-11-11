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
  const canShowMe = !!boardThread && boardThread === threadId && showMe.state.canAsk;
  const withShowMe = useMemo<ShapeHost>(
    () => (canShowMe ? { ...host, showMe: (board, part) => showMeFromShape(() => fromBoard.current, board, part) } : host),
    [host, canShowMe],
  );
  const nav = useBoardsNav({ shapes: shapes.shapes, threadId: boardThread, board: id, parents: showMe.parents, onBoard });
  return <ShapeLayer {...layer} host={withShowMe} id={id} back={nav.back} headSide={nav.list} />;
}

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
