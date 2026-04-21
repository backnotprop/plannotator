/**
 * StickyHeaderLane — compact "ghost" header that pins as the user scrolls
 * past the AnnotationToolstrip.
 *
 * At rest (top of doc): invisible, non-interactive. The original toolstrip
 * and badge cluster on the card remain the visible source of truth.
 *
 * Layout is driven by two ResizeObserver measurements — the sticky
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
import { useScrollViewport } from '../hooks/useScrollViewport';
import type { EditorMode, InputMethod } from '../types';
import type { PlanDiffStats } from '../utils/planDiffEngine';

// Snap a measured pixel width to a 16px grid. ResizeObserver fires every
// frame during a drag; without quantization the sticky bar would
// re-render on every pixel. Hoisted to module scope so the effects
// (which use [] deps) can't accidentally close over a stale instance.
// Floor (not round) so wrapper undershoots and actions overshoots — both
// errors push toward a more cautious layout, avoiding a one-bucket overlap
// flash right at the 300/460 thresholds during a slow drag.
const snap = (n: number) => Math.floor(n / 16) * 16;

// Layout geometry — static tuning constants, hoisted alongside `snap`.
// LEFT_OFFSET: matches the bar's `md:left-5` (20px).
// GAP: minimum breathing room between the bar's right edge and the
//      action button cluster's left edge when they share a lane.
// Two-stage shared-lane shrinkage, mirroring the right side:
//   WIDE_BAR_WIDTH: full toolstrip (active labels Pinpoint/Markup ~300px)
//                   + badges (~140px) on a single line.
//   MIN_BAR_WIDTH:  icon-only toolstrip (~140px) + badges (~140px).
// Below MIN, even the icon-only bar can't fit beside the (likely also
// icon-only) action cluster — stack as the final fallback.
const LEFT_OFFSET = 20;
const GAP = 16;
const WIDE_BAR_WIDTH = 460;
const MIN_BAR_WIDTH = 300;

interface StickyHeaderLaneProps {
  // Toolstrip state
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  taterMode?: boolean;

  // Badge state
  repoInfo?: { display: string; branch?: string } | null;
  planDiffStats?: PlanDiffStats | null;
  isPlanDiffActive?: boolean;
  hasPreviousVersion?: boolean;
  onPlanDiffToggle?: () => void;
  archiveInfo?: { status: 'approved' | 'denied' | 'unknown'; timestamp: string; title: string } | null;

  // Layout
  maxWidth?: number | null;

  // Re-query token for the [data-sticky-actions] ResizeObserver. When the
  // Viewer remounts (e.g., toggling a linked doc), its `data-sticky-actions`
  // node is replaced — but StickyHeaderLane itself does NOT remount, so
  // its observer would otherwise stay attached to the now-detached old
  // node and freeze `actionsWidth`. Pass a string that changes whenever
  // Viewer remounts and the effect re-runs against the fresh DOM.
  remountToken?: string;
}

export const StickyHeaderLane: React.FC<StickyHeaderLaneProps> = ({
  inputMethod,
  onInputMethodChange,
  mode,
  onModeChange,
  taterMode,
  repoInfo,
  planDiffStats,
  isPlanDiffActive,
  hasPreviousVersion,
  onPlanDiffToggle,
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

  // Space available for the bar in the shared lane = wrapper width, minus
  // the bar's left offset, minus the action buttons' measured width, minus
  // the breathing gap.
  const availableForBar = wrapperWidth - LEFT_OFFSET - actionsWidth - GAP;

  // Narrow = not enough room in the shared lane for even the icon-only
  // bar. Falls back to a stacked row below the action buttons.
  // actionsWidth=0 before measurement is treated as "don't know yet"
  // (not narrow), so we don't flash the wrong layout on first paint.
  const measured = wrapperWidth > 0 && actionsWidth > 0;
  const isNarrow = measured && availableForBar < MIN_BAR_WIDTH;
  // Tight = shared lane still fits, but only if the toolstrip drops its
  // active labels and goes icon-only. Lets us stay horizontally aligned
  // for an extra ~160px of width before stacking.
  const isToolstripIconOnly =
    measured && !isNarrow && availableForBar < WIDE_BAR_WIDTH;

  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const next = snap(entry.contentRect.width);
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
      const next = snap(entry.contentRect.width);
      setActionsWidth((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [remountToken]);

  // IntersectionObserver-on-sentinel pattern (mirrors Viewer.tsx:257-267).
  // Sentinel sits inline at the top of the column. The 80px positive top
  // rootMargin grows the effective viewport upward so the sentinel is
  // considered "visible" for an extra ~80px of scroll — delaying the bar's
  // appearance until the real toolstrip has actually scrolled past. Without
  // this, the sentinel fires the moment scrolling begins and the ghost bar
  // doubles up with the still-visible toolstrip. Root is the OverlayScrollArea
  // viewport from context, NOT <main> (which doesn't actually scroll).
  useEffect(() => {
    if (!sentinelRef.current || !scrollViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry.isIntersecting),
      { root: scrollViewport, rootMargin: '80px 0px 0px 0px', threshold: 0 }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [scrollViewport]);

  return (
    <>
      {/* Sentinel — zero-size, rendered in normal flow at the top of the
          column. When it scrolls out of the OverlayScrollArea viewport,
          the sticky bar fades in. */}
      <div ref={sentinelRef} aria-hidden="true" className="h-0 w-0" />

      {/* Sticky wrapper — zero-height so it never pushes content down. The
          visible bar is positioned absolutely relative to this wrapper.
          The Viewer's outer wrapper uses z-50, so the sticky lane must
          sit above that to paint over the card.

          Narrow: the bar pins at top-[52px] / md:top-[60px] on its OWN
          full-width row BELOW the card's sticky action buttons. Stacked
          horizontal lanes, no horizontal collision possible.

          Wide / tight: the bar shares the top-3 lane with the action
          buttons (single horizontal header). */}
      <div
        ref={wrapperRef}
        className={`sticky z-[60] w-full self-center pointer-events-none ${
          isNarrow ? 'top-[52px] md:top-[60px]' : 'top-3'
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

            `inert` removes the bar from the tab order when not stuck. */}
        <div
          inert={!isStuck || undefined}
          className={`absolute left-3 md:left-5 top-0 inline-flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 overflow-hidden rounded-lg py-1 md:py-1.5 bg-card/95 backdrop-blur-sm shadow-sm border border-border/30 motion-reduce:transform-none ${
            isStuck
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
            archiveInfo={archiveInfo}
          />
        </div>
      </div>
    </>
  );
};
