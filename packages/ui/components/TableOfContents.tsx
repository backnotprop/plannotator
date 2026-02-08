import React, { useState, useMemo, useCallback } from 'react';
import type { Block, Annotation } from '../types';
import {
  buildTocHierarchy,
  getAnnotationCountBySection,
  type TocItem,
} from '../utils/annotationHelpers';

interface TableOfContentsProps {
  blocks: Block[];
  annotations: Annotation[];
  activeId: string | null;
  onNavigate: (blockId: string) => void;
  className?: string;
}

interface TocItemProps {
  item: TocItem;
  activeId: string | null;
  onNavigate: (blockId: string) => void;
  isExpanded: boolean;
  onToggle: () => void;
  hasChildren: boolean;
}

function TocItemComponent({
  item,
  activeId,
  onNavigate,
  isExpanded,
  onToggle,
  hasChildren,
}: TocItemProps) {
  const isActive = item.id === activeId;
  const indent = item.level === 1 ? 'pl-1.5' : item.level === 2 ? 'pl-4' : 'pl-6';

  return (
    <li className="list-none">
      <div className="flex items-start group">
        {hasChildren && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex-shrink-0 w-5 h-5 mr-1 mt-0.5 flex items-center justify-center hover:bg-muted rounded transition-colors"
            aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
          >
            <svg
              className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <title>{isExpanded ? 'Collapse' : 'Expand'}</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
        )}
        
        <button
          type="button"
          onClick={() => onNavigate(item.id)}
          className={`
            flex-1 text-left text-xs py-1 px-1.5 rounded transition-colors
            ${indent}
            ${hasChildren ? '' : 'ml-6'}
            ${
              isActive
                ? 'text-primary bg-primary/10'
                : 'text-foreground/80 hover:text-foreground hover:bg-muted/50'
            }
          `}
          aria-current={isActive ? 'location' : undefined}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="flex-1 line-clamp-2 leading-relaxed">
              {item.content}
            </span>
            {item.annotationCount > 0 && (
              <span
                className="flex-shrink-0 bg-accent text-accent-foreground rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-medium"
                title={`${item.annotationCount} annotation${item.annotationCount === 1 ? '' : 's'}`}
              >
                {item.annotationCount}
              </span>
            )}
          </span>
        </button>
      </div>

      {hasChildren && isExpanded && (
        <ul className="mt-1 space-y-1">
          {item.children.map((child) => (
            <TocItemWithState
              key={child.id}
              item={child}
              activeId={activeId}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TocItemWithState({
  item,
  activeId,
  onNavigate,
}: {
  item: TocItem;
  activeId: string | null;
  onNavigate: (blockId: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const hasChildren = item.children.length > 0;

  return (
    <TocItemComponent
      item={item}
      activeId={activeId}
      onNavigate={onNavigate}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded(!isExpanded)}
      hasChildren={hasChildren}
    />
  );
}

export function TableOfContents({
  blocks,
  annotations,
  activeId,
  onNavigate,
  className = '',
}: TableOfContentsProps) {
  // Calculate annotation counts per section
  const annotationCounts = useMemo(
    () => getAnnotationCountBySection(blocks, annotations),
    [blocks, annotations]
  );

  // Build hierarchical TOC structure
  const tocItems = useMemo(
    () => buildTocHierarchy(blocks, annotationCounts),
    [blocks, annotationCounts]
  );

  // Handle navigation with smooth scroll
  const handleNavigate = useCallback(
    (blockId: string) => {
      onNavigate(blockId);
      
      // Find target element and scroll to it
      const target = document.querySelector(`[data-block-id="${blockId}"]`);
      if (target) {
        // Find the scrollable main container
        const scrollContainer = document.querySelector('main');
        if (!scrollContainer) return;
        
        // Account for sticky header (48px = h-12)
        const headerOffset = 80;
        const containerRect = scrollContainer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const scrollTop = scrollContainer.scrollTop;
        const relativeTop = targetRect.top - containerRect.top;
        const offsetPosition = scrollTop + relativeTop - headerOffset;

        scrollContainer.scrollTo({
          top: offsetPosition,
          behavior: 'smooth',
        });
      }
    },
    [onNavigate]
  );

  if (tocItems.length === 0) {
    return null;
  }

  return (
    <nav
      className={`bg-card/50 backdrop-blur-sm border-r border-border overflow-y-auto ${className}`}
      aria-label="Table of contents"
    >
      <div className="p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Contents
        </h2>
        <ul className="space-y-1">
          {tocItems.map((item) => (
            <TocItemWithState
              key={item.id}
              item={item}
              activeId={activeId}
              onNavigate={handleNavigate}
            />
          ))}
        </ul>
      </div>
    </nav>
  );
}
