import React, { useEffect, useRef, useState } from 'react';
import { AnnotationToolstrip } from './AnnotationToolstrip';
import { DocBadges } from './DocBadges';
import {
  getScrollViewportIntersectionRoot,
  useScrollViewport,
} from '../hooks/useScrollViewport';
import type { EditorMode, InputMethod } from '../types';
import type { PlanDiffStats } from '../utils/planDiffEngine';
import {
  resolveCompactHeaderGeometry,
  snapCompactHeaderWidth,
} from './compactHeaderLayout';

const LEFT_OFFSET = 20;

export type StickyHeaderLaneVisibility = 'stuck' | 'always';

export interface StickyHeaderLaneProps {
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  taterMode?: boolean;
  hideQuickLabel?: boolean;

  visibility?: StickyHeaderLaneVisibility;
  sticky?: boolean;

  repoInfo?: { display: string; branch?: string } | null;
  planDiffStats?: PlanDiffStats | null;
  isPlanDiffActive?: boolean;
  hasPreviousVersion?: boolean;
  onPlanDiffToggle?: () => void;
  planDiffBaselineLabel?: string;
  planDiffBaselineTooltip?: string;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;

  maxWidth?: number | null;

  remountToken?: string;
}

export const StickyHeaderLane: React.FC<StickyHeaderLaneProps> = ({
  inputMethod,
  onInputMethodChange,
  mode,
  onModeChange,
  taterMode,
  hideQuickLabel,
  visibility = 'stuck',
  sticky = true,
  repoInfo,
  planDiffStats,
  isPlanDiffActive,
  hasPreviousVersion,
  onPlanDiffToggle,
  planDiffBaselineLabel,
  planDiffBaselineTooltip,
  archiveInfo,
  maxWidth,
  remountToken,
}) => {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = useState(false);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);
  const scrollViewport = useScrollViewport();
  const laneIsStuck = sticky && isStuck;
  const isVisible = visibility === 'always' || laneIsStuck;
  const showChrome = visibility === 'always' ? laneIsStuck : true;

  const headerGeometry = resolveCompactHeaderGeometry({
    containerWidth: wrapperWidth,
    trailingWidth: actionsWidth,
    leadingInset: LEFT_OFFSET,
  });
  const availableForBar = headerGeometry.availableForLeading;
  const isNarrow = headerGeometry.layout === 'narrow';
  const isToolstripIconOnly = headerGeometry.layout === 'tight';

  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = snapCompactHeaderWidth(entry.contentRect.width);
      setWrapperWidth((prev) => (prev === next ? prev : next));
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setActionsWidth(0);
    const el = document.querySelector<HTMLElement>('[data-sticky-actions]');
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = snapCompactHeaderWidth(entry.contentRect.width);
      setActionsWidth((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [remountToken]);

  useEffect(() => {
    if (!sticky) {
      setIsStuck(false);
      return;
    }
    if (!sentinelRef.current || !scrollViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      {
        root: getScrollViewportIntersectionRoot(scrollViewport),
        rootMargin: '80px 0px 0px 0px',
        threshold: 0,
      }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [scrollViewport, sticky]);

  return (
    <>
      {sticky && <div ref={sentinelRef} aria-hidden="true" className="h-0 w-0" />}

      <div
        ref={wrapperRef}
        data-sticky-header-lane="true"
        className={`${sticky ? 'sticky' : 'relative'} z-[60] w-full self-center pointer-events-none ${
          sticky ? (isNarrow ? 'top-[52px] md:top-[60px]' : 'top-3') : ''
        }`}
        style={maxWidth == null ? { height: 0 } : { maxWidth, height: 0 }}
      >
        <div
          inert={!isVisible || undefined}
          className={`absolute left-3 md:left-5 top-0 inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 overflow-hidden rounded-lg py-1 md:py-1.5 ${
            showChrome ? 'bg-card/95 backdrop-blur-sm shadow-sm border border-border/30' : ''
          } motion-reduce:transform-none ${
            isVisible
              ? 'opacity-100 translate-y-0 pointer-events-auto'
              : 'opacity-0 -translate-y-1 pointer-events-none'
          }`}
          style={{
            paddingLeft: 12,
            paddingRight: 12,
            maxWidth: isNarrow
              ? 'calc(100% - 24px)'
              : availableForBar > 0
                ? availableForBar
                : undefined,
            transition:
              'opacity 180ms cubic-bezier(0.2, 0, 0, 1), transform 180ms cubic-bezier(0.2, 0, 0, 1)',
            willChange: 'opacity, transform',
          }}
        >
          <div className="flex-shrink-0">
            <AnnotationToolstrip
              inputMethod={inputMethod}
              onInputMethodChange={onInputMethodChange}
              mode={mode}
              onModeChange={onModeChange}
              taterMode={taterMode}
              hideQuickLabel={hideQuickLabel}
              compact
              iconOnly={isNarrow || isToolstripIconOnly}
            />
          </div>
          <DocBadges
            layout="row"
            repoInfo={repoInfo}
            planDiffStats={planDiffStats}
            isPlanDiffActive={isPlanDiffActive}
            hasPreviousVersion={hasPreviousVersion}
            onPlanDiffToggle={onPlanDiffToggle}
            planDiffBaselineLabel={planDiffBaselineLabel}
            planDiffBaselineTooltip={planDiffBaselineTooltip}
            archiveInfo={archiveInfo}
          />
        </div>
      </div>
    </>
  );
};
