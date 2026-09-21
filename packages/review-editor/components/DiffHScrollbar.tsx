import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Per-file horizontal scrollbar for Pierre diffs (#1048).
 *
 * Pierre scrolls wide lines inside its own `[data-code]` element (in each
 * file's shadow root), whose native scrollbar sits at the bottom of that
 * file's content — off-screen on any diff taller than the panel, exactly
 * when a clipped long line needs it. Pierre's own bar is suppressed (see
 * `usePierreTheme`) and this one replaces it, rendered INSIDE the file's
 * header so it rides that header's sticky positioning: every file gets its
 * own bar, aligned to its own content, visible whenever the file is.
 *
 * The component locates its own target from its DOM position — either the
 * `diffs-container` it sits inside (the all-files header portal) or the one
 * alongside it (the single-file view) — so callers just place it near the
 * diff and pass positioning classes. It self-hides when the file's content
 * does not overflow horizontally, so wrapped and narrow diffs are
 * unaffected.
 *
 * `scrollWidth` is POLLED rather than observed: Pierre renders into shadow
 * roots, and shadow-content growth changes the scrollable overflow area
 * without ever resizing an observable border box.
 */

const POLL_MS = 200;

/**
 * Resolves the `diffs-container` this bar belongs to. Walks up from its own
 * position (crossing shadow boundaries, since Pierre portals the all-files
 * header into the item's shadow root) and, at each level, accepts either the
 * ancestor itself or a single `diffs-container` beneath it — which is how the
 * single-file view, where the bar is a sibling of the diff, resolves.
 */
function findDiffsHost(start: Node | null): HTMLElement | null {
  const isHost = (node: Node | null): node is HTMLElement =>
    node instanceof HTMLElement && node.tagName.toLowerCase() === 'diffs-container';

  let node: Node | null = start;
  while (node) {
    if (isHost(node)) return node;
    if (node instanceof Element || node instanceof ShadowRoot) {
      const nested = node.querySelectorAll('diffs-container');
      // Only unambiguous when this subtree renders exactly one file; the
      // all-files surface resolves earlier, by ancestry.
      if (nested.length === 1) return nested[0] as HTMLElement;
    }
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return null;
}

/**
 * The horizontal scroller for a Pierre file host: the first `[data-code]` in
 * its shadow root that actually overflows. In split + scroll mode there are
 * two (deletions / additions) and Pierre's own scrollSyncManager keeps them
 * in step, so driving the first is enough.
 */
function findOverflowingCodeEl(host: HTMLElement): HTMLElement | null {
  const candidates = host.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]');
  if (!candidates) return null;
  for (const el of Array.from(candidates)) {
    if (el.scrollWidth > el.clientWidth + 1) return el;
  }
  return null;
}

export const DiffHScrollbar: React.FC<{ className?: string }> = ({ className = '' }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [metrics, setMetrics] = useState<{ scrollWidth: number; clientWidth: number } | null>(null);
  const [thumbLeft, setThumbLeft] = useState(0);
  const dragStateRef = useRef<{ pointerId: number; grabOffset: number; maxLeft: number } | null>(null);

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const owner = findDiffsHost(trackRef.current);
        const scroller = owner ? findOverflowingCodeEl(owner) : null;
        scrollerRef.current = scroller;
        if (!scroller) {
          setMetrics((prev) => (prev === null ? prev : null));
          return;
        }
        const { scrollWidth, clientWidth } = scroller;
        setMetrics((prev) =>
          prev && prev.scrollWidth === scrollWidth && prev.clientWidth === clientWidth
            ? prev
            : { scrollWidth, clientWidth },
        );
      });
    };

    measure();
    const interval = setInterval(measure, POLL_MS);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Follow the scroller's own horizontal scroll (keyboard, trackpad gesture,
  // programmatic scrollTo).
  useEffect(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!metrics || !scroller || !track) return;

    const sync = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      const trackWidth = track.clientWidth;
      const thumbWidth = (scroller.clientWidth / scroller.scrollWidth) * trackWidth;
      const maxLeft = trackWidth - thumbWidth;
      const next = maxScroll > 0 ? (scroller.scrollLeft / maxScroll) * maxLeft : 0;
      // Skip no-op writes — thumbLeft drives scrollLeft in the drag path,
      // and echoing an unchanged value back would create a feedback cycle.
      setThumbLeft((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    };

    sync();
    scroller.addEventListener('scroll', sync, { passive: true });
    return () => scroller.removeEventListener('scroll', sync);
  }, [metrics]);

  const applyScroll = useCallback((nextThumbLeft: number, maxLeft: number) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const clamped = Math.max(0, Math.min(maxLeft, nextThumbLeft));
    setThumbLeft(clamped);
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    scroller.scrollLeft = maxLeft > 0 ? (clamped / maxLeft) * maxScroll : 0;
  }, []);

  const thumbWidthFor = (trackWidth: number) =>
    metrics ? (metrics.clientWidth / metrics.scrollWidth) * trackWidth : 0;

  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !metrics) return;
    e.preventDefault();
    e.stopPropagation();
    const trackWidth = track.clientWidth;
    dragStateRef.current = {
      pointerId: e.pointerId,
      grabOffset: e.clientX - track.getBoundingClientRect().left - thumbLeft,
      maxLeft: trackWidth - thumbWidthFor(trackWidth),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !track) return;
    applyScroll(e.clientX - track.getBoundingClientRect().left - drag.grabOffset, drag.maxLeft);
  };

  const onThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Page-jump on track click, like a native scrollbar.
    if (e.target !== e.currentTarget || !metrics) return;
    const trackWidth = e.currentTarget.clientWidth;
    const thumbWidth = thumbWidthFor(trackWidth);
    const clickX = e.clientX - e.currentTarget.getBoundingClientRect().left;
    applyScroll(clickX - thumbWidth / 2, trackWidth - thumbWidth);
  };

  // Always mounted (it has to be in the DOM to find its own target), but it
  // only paints once the file's content actually overflows.
  const thumbWidthPct = metrics ? (metrics.clientWidth / metrics.scrollWidth) * 100 : 0;

  return (
    <div
      ref={trackRef}
      data-diff-hscrollbar="true"
      aria-hidden="true"
      onPointerDown={onTrackPointerDown}
      className={`h-1.5 ${metrics ? 'cursor-default' : 'pointer-events-none'} ${className}`}
    >
      {metrics && (
        <div
          className="absolute top-0 h-full rounded-full bg-muted-foreground/40 transition-[background-color] hover:bg-muted-foreground/70"
          style={{ left: thumbLeft, width: `${thumbWidthPct}%` }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
        />
      )}
    </div>
  );
};
