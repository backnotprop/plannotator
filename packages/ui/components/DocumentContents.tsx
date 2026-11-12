import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Annotation, Block } from '../types';
import { CONTENTS_RAIL_MAX_LEVEL, tocHeadings } from '../utils/annotationHelpers';
import { useHeadingScrollSpy } from '../hooks/useHeadingScrollSpy';
import { TableOfContents } from './TableOfContents';

interface DocumentContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  scrollViewport: HTMLElement | null;
  onNavigate?: (blockId: string) => void;
  className?: string;
}

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
