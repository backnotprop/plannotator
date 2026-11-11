import React, { useMemo, useCallback } from 'react';
import { basenameFromPath } from '@plannotator/core/source-save';
import type { Block, Annotation } from '../types';
import {
  buildTocHierarchy,
  getAnnotationCountBySection,
  type TocItem,
} from '../utils/annotationHelpers';
import {
  getScrollViewportRect,
  getScrollViewportTop,
  scrollViewportTo,
  useScrollViewport,
} from '../hooks/useScrollViewport';

interface TableOfContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  activeId: string | null;
  onNavigate: (blockId: string) => void;
  className?: string;
  style?: React.CSSProperties;
  linkedDocFilepath?: string | null;
  onLinkedDocBack?: () => void;
  backLabel?: string;
  scrollViewport?: HTMLElement | null;
  maxLevel?: number;
}

function flattenToc(items: TocItem[]): TocItem[] {
  const out: TocItem[] = [];
  const walk = (list: TocItem[]) => {
    for (const it of list) {
      out.push(it);
      if (it.children.length) walk(it.children);
    }
  };
  walk(items);
  return out;
}

function itemClasses(level: number, isActive: boolean): string {
  const indent = level <= 1 ? '' : level === 2 ? 'ml-3' : level === 3 ? 'ml-6' : 'ml-9';
  const tone = isActive
    ? 'bg-surface-1 text-foreground'
    : level <= 1
      ? 'text-foreground/80 hover:bg-surface-1/70'
      : 'text-muted-foreground hover:bg-surface-1/70';
  return `${indent} ${tone}`;
}

export function TableOfContents({
  blocks,
  annotations,
  activeId,
  onNavigate,
  className = '',
  style,
  linkedDocFilepath,
  onLinkedDocBack,
  backLabel,
  scrollViewport: scrollViewportProp,
  maxLevel = 3,
}: TableOfContentsProps) {
  const annotationCounts = useMemo(
    () => getAnnotationCountBySection(blocks, annotations),
    [blocks, annotations]
  );

  const tocItems = useMemo(
    () => flattenToc(buildTocHierarchy(blocks, annotationCounts, maxLevel)),
    [blocks, annotationCounts, maxLevel]
  );

  const contextViewport = useScrollViewport();
  const scrollViewport = scrollViewportProp === undefined ? contextViewport : scrollViewportProp;

  const handleNavigate = useCallback(
    (blockId: string) => {
      onNavigate(blockId);
      const target = (scrollViewport ?? document).querySelector(`[data-block-id="${blockId}"]`);
      if (target && scrollViewport) {
        const scrollContainer = scrollViewport;
        const headerOffset = 80; // sticky header (h-12) + breathing room
        const containerRect = getScrollViewportRect(scrollContainer);
        const targetRect = target.getBoundingClientRect();
        const offsetPosition =
          getScrollViewportTop(scrollContainer) + (targetRect.top - containerRect.top) - headerOffset;
        scrollViewportTo(scrollContainer, { top: offsetPosition, behavior: 'smooth' });
      }
    },
    [onNavigate, scrollViewport]
  );

  // A linked document with no headings of its own — most obviously a raw-HTML one, which is never
  // parsed into blocks — still needs the "Viewing / Back to …" header, which lives here.
  if (tocItems.length === 0 && !linkedDocFilepath) {
    return null;
  }

  return (
    <nav
      className={className ?? 'bg-card/50 backdrop-blur-sm border-r border-border overflow-y-auto'}
      aria-label="Table of contents"
      style={style}
    >
      <div className="p-1.5">
        {linkedDocFilepath && (
          <div className="mb-2 px-0.5 pb-1.5 border-b border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-primary/80">Viewing</span>
              {onLinkedDocBack && (
                <button
                  onClick={onLinkedDocBack}
                  className="flex items-center gap-0.5 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                  </svg>
                  Back to {backLabel || 'plan'}
                </button>
              )}
            </div>
            <p className="text-[11px] text-foreground/70 truncate mt-0.5" title={linkedDocFilepath}>
              {basenameFromPath(linkedDocFilepath)}
            </p>
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {tocItems.map((item) => {
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                aria-current={isActive ? 'location' : undefined}
                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-medium leading-snug transition-colors ${itemClasses(
                  item.level,
                  isActive
                )}`}
              >
                <span className="line-clamp-2">{item.content}</span>
                {item.annotationCount > 0 && (
                  <span className="ml-1 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[9px] text-primary">
                    {item.annotationCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
