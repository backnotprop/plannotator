import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Annotation, Block } from '../types';
import { CONTENTS_RAIL_MAX_LEVEL, tocHeadings } from '../utils/annotationHelpers';
import { useHeadingScrollSpy } from '../hooks/useHeadingScrollSpy';
import { TableOfContents } from './TableOfContents';

interface DocumentContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  /**
   * The element the document scrolls in. The current heading is read from it
   * and a click scrolls it. `null` until it has mounted.
   */
  scrollViewport: HTMLElement | null;
  /** Called with the heading's block id after a click (a sheet closes itself here). */
  onNavigate?: (blockId: string) => void;
  className?: string;
}

/**
 * A document's Contents list for a host without plan review's sidebar, on the
 * contents rail's surface (the Inbox's sheet, where the rail yields): the same
 * `TableOfContents` (click to scroll, the current heading highlighted) with
 * the rail's headings (levels 1 to 4) and the rail's scroll math
 * (`useHeadingScrollSpy`), so the list and the rail never disagree. It draws
 * no chrome; the host places it and titles it.
 *
 * The host mounts it afresh (a sheet that opens), often mid-document: the
 * current heading is read at once. The marked entry is kept in view inside the
 * list's own scroll box (a sheet).
 */
export function DocumentContents({ blocks, annotations, scrollViewport, onNavigate, className = '' }: DocumentContentsProps) {
  const headingIds = useMemo(
    () => tocHeadings(blocks, CONTENTS_RAIL_MAX_LEVEL).map((heading) => heading.id),
    [blocks],
  );
  const activeId = useHeadingScrollSpy(scrollViewport, headingIds);

  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const item = wrapRef.current?.querySelector<HTMLElement>('[aria-current="location"]');
    if (item) revealInList(item);
  }, [activeId]);

  return (
    <div ref={wrapRef} style={{ display: 'contents' }}>
      <TableOfContents
        blocks={blocks}
        annotations={annotations}
        activeId={activeId}
        onNavigate={onNavigate ?? noop}
        scrollViewport={scrollViewport}
        maxLevel={CONTENTS_RAIL_MAX_LEVEL}
        className={className}
      />
    </div>
  );
}

/**
 * Scroll the list's own scroll box (the nearest ancestor that scrolls) just
 * enough to show `item`, at once. Never the page or the document behind it.
 */
function revealInList(item: HTMLElement) {
  let box = item.parentElement;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  if (!box || box.scrollHeight <= box.clientHeight) return;
  const area = box.getBoundingClientRect();
  const rect = item.getBoundingClientRect();
  if (rect.top < area.top) box.scrollTop -= area.top - rect.top;
  else if (rect.bottom > area.bottom) box.scrollTop += Math.min(rect.bottom - area.bottom, rect.top - area.top);
}

function noop() {}
