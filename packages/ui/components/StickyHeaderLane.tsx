/**
 * StickyHeaderLane — compact "ghost" header that can pin as the user scrolls
 * past the AnnotationToolstrip.
 *
 * By default, the lane is invisible and non-interactive at rest, leaving the
 * original toolstrip and badge cluster as the visible source of truth. Hosts
 * can keep this measured lane visible at rest or let it scroll normally.
 *
 * Layout is driven by two ResizeObserver measurements — the lane
 * wrapper's actual width AND the Viewer action button cluster's actual
 * width — so the bar fits exactly into the space between its left edge
 * and the buttons, with no fixed pixel reserves.
 *
 *   availableForBar = wrapperWidth - LEFT_OFFSET - actionsWidth - GAP
 *
 * Three states based on availableForBar:
 *   wide  (>= WIDE_BAR_WIDTH): shared lane, toolstrip with active labels.
 *   tight (>= MIN_BAR_WIDTH):  shared lane, toolstrip icon-only — gives
 *                              the bar another ~160px of room before
 *                              forcing a layout change.
 *   narrow (< MIN_BAR_WIDTH):  stacked below the action buttons on its
 *                              own full-width row, icon-only toolstrip.
 *
 * Composes <AnnotationToolstrip compact /> + <DocBadges layout="row" />.
 * No state is duplicated — all props are passed through from App.tsx.
 */

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

// Matches the bar's `md:left-5` inset. The remaining shared geometry lives
// in compactHeaderLayout so Viewer-owned and standalone lanes cannot drift.
const LEFT_OFFSET = 20;

/** Controls when the compact header lane is visible and interactive. */
export type StickyHeaderLaneVisibility = 'stuck' | 'always';

/** Props for the measured compact annotation and document header lane. */
export interface StickyHeaderLaneProps {
  // Toolstrip state
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  taterMode?: boolean;
  /** Omit the Quick Label tool in the compact toolstrip (mirrors AnnotationToolstripProps.hideQuickLabel). */
  hideQuickLabel?: boolean;

  /**
   * Show the lane only after it sticks, or keep it visible at rest too.
   * Defaults to `'stuck'`, preserving the incumbent ghost-header behavior.
   * Hosts using `'always'` must reserve a clear header-height region because
   * the lane remains zero-height and absolutely positioned over its sibling.
   */
  visibility?: StickyHeaderLaneVisibility;
  /**
   * Keep the lane pinned while its scroll viewport moves. Pass the same value
   * to `Viewer.stickyActions` so both measured header lanes share one policy.
   * Defaults to true. Pair false with `visibility="always"`; the default
   * stuck-only visibility cannot become visible when stickiness is disabled.
   */
  sticky?: boolean;

  // Badge state
  repoInfo?: { display: string; branch?: string } | null;
  planDiffStats?: PlanDiffStats | null;
  isPlanDiffActive?: boolean;
  hasPreviousVersion?: boolean;
  onPlanDiffToggle?: () => void;
  /** Baseline suffix + tooltip for the plan-diff badge (see DocBadges). */
  planDiffBaselineLabel?: string;
  planDiffBaselineTooltip?: string;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;

  // Layout
  maxWidth?: number | null;
  /** Whether the document is rendered on the classic card grid look (defaults to true). When false (clean mode), drops the card inset. */
  gridEnabled?: boolean;

  /**
   * Optional custom sentinel element to observe for the stuck state.
   * When omitted, an internal zero-size sentinel is rendered at the top of the lane.
   */
  sentinelRef?: React.RefObject<HTMLDivElement | null>;

  // Re-query token for the [data-sticky-actions] ResizeObserver. When the
  // Viewer remounts (e.g., toggling a linked doc), its `data-sticky-actions`
  // node is replaced — but StickyHeaderLane itself does NOT remount, so
  // its observer would otherwise stay attached to the now-detached old
  // node and freeze `actionsWidth`. Pass a string that changes whenever
  // Viewer remounts and the effect re-runs against the fresh DOM.
  remountToken?: string;
}

/** Render the shared, measured header lane beside the Viewer's action cluster. */
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
  gridEnabled = true,
  sentinelRef: externalSentinelRef,
  remountToken,
}) => {
  const internalSentinelRef = useRef<HTMLDivElement>(null);
  const targetSentinelRef = externalSentinelRef ?? internalSentinelRef;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = useState(false);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);
  const scrollViewport = useScrollViewport();
  const laneIsStuck = sticky && isStuck;
  const isVisible = visibility === 'always' || laneIsStuck;
  const hasBadges = Boolean((hasPreviousVersion && planDiffStats) || archiveInfo);
  const isBadgesExpanded = laneIsStuck && hasBadges;
  // Preserve the incumbent ghost lane exactly: its chrome remains mounted
  // while the whole hidden bar fades out. Only the new always-visible mode
  // removes chrome at rest for the supported chrome-free presentation.
  const showChrome = visibility === 'always' ? laneIsStuck : true;

  const leftOffset = gridEnabled ? LEFT_OFFSET : 0;
  const headerGeometry = resolveCompactHeaderGeometry({
    containerWidth: wrapperWidth,
    trailingWidth: actionsWidth,
    leadingInset: leftOffset,
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

  // Measure the Viewer's action button cluster so the right reserve
  // reflects its REAL width (which varies with viewport — short vs full
  // labels — and with button count). No more guessing at ~310/360/400px.
  // The action button div is tagged with `data-sticky-actions` in
  // Viewer.tsx. It's a sibling in the DOM by the time effects fire.
  // Re-runs when `remountToken` changes so we re-query after Viewer
  // unmounts/remounts (e.g., linked-doc toggle) instead of leaving the
  // observer attached to a detached node.
  useEffect(() => {
    // Reset to the unmeasured state so the bar falls back to the safe
    // "no maxWidth cap" path for the one frame between Viewer remounting
    // and the new observer firing its first callback.
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

  // IntersectionObserver-on-sentinel pattern (mirrors Viewer.tsx:257-267).
  // Sentinel sits inline at the top of the column. The 80px positive top
  // rootMargin grows the effective viewport upward so the internal sentinel is
  // considered "visible" for an extra ~80px of scroll — delaying the bar's
  // appearance until the real toolstrip has actually scrolled past. When an
  // external sentinel is provided (anchored right below the resting toolstrip),
  // -12px rootMargin matches the top-3 sticky pin position exactly. Root is the
  // OverlayScrollArea viewport from context, NOT <main> (which doesn't actually scroll).
  useEffect(() => {
    if (!sticky) {
      setIsStuck(false);
      return;
    }
    const target = targetSentinelRef.current;
    if (!target || !scrollViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      {
        root: getScrollViewportIntersectionRoot(scrollViewport),
        rootMargin: externalSentinelRef ? '-12px 0px 0px 0px' : '80px 0px 0px 0px',
      }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scrollViewport, sticky, externalSentinelRef]);

  return (
    <>
      {/* Sentinel — rendered internally only when an external sentinel is not provided. */}
      {sticky && !externalSentinelRef && <div ref={internalSentinelRef} aria-hidden="true" className="h-0 w-0" />}

      {/* Zero-height wrapper — sticky by default, relative when sticky is
          disabled so the absolutely positioned lane scrolls in normal flow.
          It never pushes document content down.
          The Viewer's outer wrapper uses z-50, so the sticky lane must
          sit above that to paint over the card.

          Narrow: the bar pins at top-[52px] / md:top-[60px] on its OWN
          full-width row BELOW the card's sticky action buttons. Stacked
          horizontal lanes, no horizontal collision possible.

          Wide / tight: the bar shares the top-3 lane with the action
          buttons (single horizontal header). */}
      <div
        ref={wrapperRef}
        data-sticky-header-lane="true"
        data-print-hide
        className={`${sticky ? 'sticky' : 'relative'} z-[60] w-full self-center pointer-events-none ${
          sticky ? (isNarrow ? 'top-[52px] md:top-[60px]' : 'top-3') : ''
        }`}
        style={maxWidth == null ? { height: 0 } : { maxWidth, height: 0 }}
      >
        {/* Responsive bar.

            `inline-flex flex-wrap` + a measured `max-width` cap (set inline
            below) lets the bar wrap badges to a second row if the toolstrip
            + badges can't fit on one line. The max-width is computed from
            the real measured action button width — no fixed reserves.

            `flex-shrink-0` on the toolstrip wrapper is a defensive measure:
            if a long branch name pushes the badges, this stops the toolstrip
            from being squeezed below its natural width. `overflow-hidden`
            is the final safety net so any overflow clips inside the chrome
            rather than leaking out.

            `inert` removes the bar from the tab order whenever it is hidden. */}
        <div
          inert={!isVisible || undefined}
          className={`absolute ${gridEnabled ? 'left-3 md:left-5' : 'left-0'} top-0 inline-flex flex-wrap items-center gap-y-1 min-w-0 overflow-hidden rounded-lg py-1 md:py-1.5 ${
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
              'opacity 180ms cubic-bezier(0.2, 0, 0, 1), transform 180ms cubic-bezier(0.2, 0, 0, 1), background-color 150ms ease, box-shadow 150ms ease',
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
              showHelpLink={false}
              iconOnly={isNarrow || isToolstripIconOnly}
            />
          </div>
          <div
            data-sticky-badges-compartment
            className={`grid shrink-0 motion-reduce:transition-none ${
              isBadgesExpanded
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
            style={{
              gridTemplateColumns: isBadgesExpanded ? '1fr' : '0fr',
              transition:
                'grid-template-columns 280ms cubic-bezier(0.2, 0, 0, 1), opacity 240ms cubic-bezier(0.2, 0, 0, 1)',
              willChange: 'grid-template-columns, opacity',
            }}
          >
            <div className="min-w-0 overflow-clip" style={{ overflow: 'clip' }}>
              <div className="pl-3 w-max shrink-0 flex items-center whitespace-nowrap">
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
          </div>
        </div>
      </div>
    </>
  );
};
