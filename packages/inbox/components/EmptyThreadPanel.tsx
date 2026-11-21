import { useEffect, useRef, useState } from 'react';
import { registerThreadDropTarget, THREAD_DROP_LAYER, type DropAnswer } from '../threadDrag';

/**
 * What the thread panel shows with no thread open (threadPanel.ts): one quiet line, centered in the pane.
 *
 * While a list row is carried (threadDrag.ts, approval "inbox-drag-threads") the empty pane is a place for it: a tint
 * and "Open here", and a drop opens that thread as a click on its row does (`onOpen`), with the free layout's switch
 * on or off. Several picked rows open nothing: the label says to bring one. Under the pointer the carried thread's ghost
 * says "Open here" beside it, so the pane's own label steps out of sight (`data-ghost-says`): one label, never two on
 * top of each other. A refusal's reason stays, as the ghost says none.
 */
export function EmptyThreadPanel({ onOpen }: { onOpen?: (threadId: string) => void }) {
  const line = useRef<HTMLParagraphElement>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  const [drop, setDrop] = useState<{ answer: DropAnswer; over: boolean } | null>(null);
  const takes = onOpen !== undefined;
  useEffect(() => {
    if (!takes) return;
    return registerThreadDropTarget({
      element: () => line.current?.closest<HTMLElement>('.ib-pempty') ?? null,
      layer: THREAD_DROP_LAYER.pane,
      what: 'Open here',
      accepts: (ids) => (ids.length === 1 ? 'take' : 'refuse'),
      show: (answer) => setDrop(answer ? { answer, over: false } : null),
      over: (point) => setDrop((was) => (was && was.over !== !!point ? { ...was, over: !!point } : was)),
      drop: (ids) => open.current?.(ids[0]!),
    });
  }, [takes]);
  // The pane (App.tsx draws it around this line) shows the place: its tint, stronger under the pointer.
  useEffect(() => {
    const pane = line.current?.closest<HTMLElement>('.ib-pempty');
    if (!pane) return;
    if (drop) pane.setAttribute('data-thread-drop', drop.answer === 'refuse' ? 'refuse' : drop.over ? 'over' : 'target');
    else pane.removeAttribute('data-thread-drop');
  }, [drop]);
  return (
    <>
      <p ref={line} hidden={drop !== null}>No thread selected</p>
      {drop && (
        <span className="ib-topen" data-thread-drop-label={drop.answer === 'refuse' ? 'refuse' : undefined} data-ghost-says={drop.over && drop.answer === 'take' ? '' : undefined} aria-hidden="true">
          {drop.answer === 'refuse' ? 'Open one thread at a time' : 'Open here'}
        </span>
      )}
    </>
  );
}
