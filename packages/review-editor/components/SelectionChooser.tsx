import React from 'react';
import { createPortal } from 'react-dom';
import { useVisibleViewportBounds, hasPrimaryCoarsePointer } from '@plannotator/ui/hooks/useViewportEnvironment';
import { getPageMarks, holdPageMark } from '@plannotator/ui/utils/pageMarks';
import { linesOffScreen, placeChooser, readSelectedLines, type ReadLines, type SelectionRange } from './selectionChooserPlace';

export interface DiffSelection {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
}

export interface DiffSelectionActions {
  onAsk?: (selection: DiffSelection) => void;
  onShowMe?: (selection: DiffSelection) => void;
}

const sameLines = (a: ReadLines, b: ReadLines) =>
  a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.shownTop === b.shownTop && a.shownBottom === b.shownBottom && a.roof === b.roof;

const LOOK_FRAMES = 6;

export function SelectionChooser({
  toolbarRef,
  position,
  range,
  actions,
  onComment,
  onAsk,
  onShowMe,
}: {
  toolbarRef: React.RefObject<HTMLDivElement | null>;
  position: { top: number; left: number };
  range: SelectionRange;
  actions: DiffSelectionActions;
  onComment: () => void;
  onAsk: () => void;
  onShowMe: () => void;
}) {
  const bounds = useVisibleViewportBounds(hasPrimaryCoarsePointer() ? 16 : 0);
  const [lines, setLines] = React.useState<ReadLines | null>(null);
  const [dropped, setDropped] = React.useState(false);
  const [bar, setBar] = React.useState({ width: 0, height: 0 });
  const [looked, setLooked] = React.useState(false);
  const { start, end, side, endSide } = range;
  React.useLayoutEffect(() => {
    const now = { start, end, side, endSide };
    let frames = 0;
    let id = 0;
    let diff: Element | null = null;
    let seen = false;
    const look = () => {
      const waiting = frames < LOOK_FRAMES;
      const found = readSelectedLines(now, position, waiting, diff);
      if (found?.own) diff = found.host;
      if (found) seen = true;
      setDropped(seen && !found);
      const el = toolbarRef.current;
      if (el) setBar((was) => (was.width === el.offsetWidth && was.height === el.offsetHeight ? was : { width: el.offsetWidth, height: el.offsetHeight }));
      if (found) setLines((was) => (was && sameLines(was, found) ? was : found));
      if (found || !waiting) setLooked(true);
      frames += 1;
      id = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(id);
  }, [start, end, side, endSide, position, toolbarRef]);
  const gone = dropped || (!!lines && linesOffScreen(lines, bounds));
  React.useLayoutEffect(() => (gone || !getPageMarks() ? undefined : holdPageMark(document.documentElement, 'data-pn-selection-chooser')), [gone]);
  const placed: React.CSSProperties = lines
    ? placeChooser(lines, bar, { ...bounds, top: Math.max(bounds.top, lines.roof) })
    : {
        top: Math.max(bounds.top + 8, Math.min(position.top - 66, bounds.bottom - 52)),
        left: Math.max(bounds.left + 8, Math.min(position.left, bounds.right - 8)),
        transform: 'translateX(-50%)',
      };
  const content = (
    <div
      ref={toolbarRef}
      className="review-selpop"
      role="toolbar"
      aria-label="Selected lines"
      {...(gone ? {} : { 'data-selection-chooser': '' })}
      style={{ position: 'fixed', ...placed, zIndex: 1000, ...(looked && !gone ? {} : { visibility: 'hidden' as const }) }}
    >
      <button type="button" className="review-selpop-btn" onClick={onComment} data-selection-action="comment">
        Comment
      </button>
      {actions.onAsk && (
        <button type="button" className="review-selpop-btn" onClick={onAsk} data-selection-action="ask">
          Ask
        </button>
      )}
      {actions.onShowMe && (
        <button type="button" className="review-selpop-btn review-selpop-show" onClick={onShowMe} data-selection-action="show-me">
          Show me
        </button>
      )}
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
