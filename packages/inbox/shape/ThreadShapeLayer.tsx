/**
 * A board over its thread or over the grid, with Show me from the board: the same request and the same box as a
 * review's board, with no review behind it. It needs a thread and a live owner, as Ask does (`can_ask`): with neither,
 * the box has Ask and Change it, which wait for the agent, and the board is as it always was.
 */
import { useMemo, useRef } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import { useSidebar, SidebarTrigger } from '../shell/sidebar';
import { ShowMeBox } from '../review-drawing/ShowMeLayer';
import { useShowMe } from '../review-drawing/useShowMe';
import { ShapeBoardLayer } from './ShapeParts';
import { useBoardsNav } from './ShapeBoardsNav';
import type { InboxShapes } from './useInboxShapes';

const NO_FILES: readonly { path: string; patch: string }[] = [];
const NO_OTHERS: readonly string[] = [];

export function ThreadShapeLayer({ host, id, thread, shapes, onClose, onBoard }: { host: ShapeHost; id: string; thread: InboxThread | null; shapes: InboxShapes; onClose: () => void; onBoard: (id: string) => void }) {
  const { isMobile } = useSidebar();
  const threadId = (shapes.shapes ?? []).find((shape) => shape.id === id)?.thread ?? null;
  const showMe = useShowMe({ threadId: threadId ?? '', reviewId: null, title: '', round: 1, agent: null, others: NO_OTHERS, files: NO_FILES, boardOpen: true, enabled: !!threadId, subscribeBoards: shapes.subscribe, onBoard });
  const fromBoard = useRef(showMe.fromBoard);
  fromBoard.current = showMe.fromBoard;
  const withShowMe = useMemo<ShapeHost>(
    () => (threadId && showMe.state.canAsk ? { ...host, showMe: (board, part) => fromBoard.current({ board, name: part.name, ...(part.code ? { code: part.code } : {}) }, part.words) } : host),
    [host, threadId, showMe.state.canAsk],
  );
  const nav = useBoardsNav({ shapes: shapes.shapes, threadId, board: id, parents: showMe.parents, onBoard });
  return (
    <>
      <ShapeBoardLayer
        host={withShowMe}
        id={id}
        thread={thread}
        onClose={onClose}
        headStart={isMobile && !nav.back ? undefined : (
          <>
            {!isMobile && <SidebarTrigger />}
            {nav.back}
          </>
        )}
        headSide={nav.list}
      />
      <ShowMeBox
        state={showMe.state}
        agent={showMe.agent}
        onWords={showMe.setWords}
        onSend={() => void showMe.send()}
        onBusy={(policy) => void showMe.busyChoice(policy)}
        onStop={() => void showMe.stop()}
        onClose={showMe.closeBox}
      />
    </>
  );
}
