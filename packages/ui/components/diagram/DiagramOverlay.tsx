import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { diagramTargetName } from '@plannotator/core/diagram-anchor';
import { cn } from '../../lib/utils';
import { projectElement, type ScreenRect } from '../../utils/diagram-projection';
import type { DiagramCanvasHandle } from './DiagramCanvas';
import type { DiagramComposerDraft, DiagramHover, ResolvedDiagramComment } from './useDiagramComments';

/**
 * Rings, numbered badges, the hover chip and the composer's anchor point,
 * projected from each part's `getBBox()` through `getScreenCTM()`. The
 * layer is a sibling of the transformed wrapper, so a ring is the same 2px
 * at every zoom. Reprojection is one requestAnimationFrame pass per change
 * (viewport, host resize, a new render, a new comment list): a design
 * constant, not a limit.
 */

/** Ring inset from the part's box, in overlay pixels. */
const RING_PAD_PX = 3;

interface Projected {
  readonly id: string;
  readonly number: number;
  readonly label: string;
  readonly resolved: boolean;
  readonly whole: boolean;
  readonly rect: ScreenRect;
  readonly additional: readonly ScreenRect[];
}

function pad(rect: ScreenRect): ScreenRect {
  return {
    left: rect.left - RING_PAD_PX,
    top: rect.top - RING_PAD_PX,
    width: rect.width + RING_PAD_PX * 2,
    height: rect.height + RING_PAD_PX * 2,
  };
}

function ringStyle(rect: ScreenRect): React.CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function DiagramOverlay({
  handle,
  resolved,
  hover,
  composer,
  selectedCommentId,
  onSelectComment,
  renderComposer,
}: {
  handle: DiagramCanvasHandle;
  resolved: readonly ResolvedDiagramComment[];
  hover: DiagramHover | null;
  composer: DiagramComposerDraft | null;
  selectedCommentId: string | null;
  onSelectComment: ((id: string | null) => void) | undefined;
  /** The composer, given the primary ring's rectangle to sit beside. */
  renderComposer: (anchorRect: ScreenRect) => React.ReactNode;
}) {
  const [projected, setProjected] = useState<readonly Projected[]>([]);
  const [hoverRect, setHoverRect] = useState<ScreenRect | null>(null);
  const [draftRects, setDraftRects] = useState<{
    primary: ScreenRect;
    additional: readonly ScreenRect[];
  } | null>(null);
  const frameRef = useRef<number | null>(null);
  const { viewport, hostRef, panIntoView } = handle;

  // One projection pass per change, after the wrapper's transform has
  // been written to the DOM (layout effect), on the next frame.
  useLayoutEffect(() => {
    const run = () => {
      frameRef.current = null;
      const host = hostRef.current;
      if (host === null) return;
      const hostRect = host.getBoundingClientRect();
      const next: Projected[] = [];
      for (const entry of resolved) {
        if (entry.element === null) continue;
        const rect = projectElement(entry.element, hostRect);
        if (rect === null) continue;
        next.push({
          id: entry.id,
          number: entry.number,
          label: entry.label,
          resolved: entry.resolved,
          whole: entry.whole,
          rect: pad(rect),
          additional: entry.additional
            .map((el) => projectElement(el, hostRect))
            .filter((r): r is ScreenRect => r !== null)
            .map(pad),
        });
      }
      setProjected(next);
      const hovered = hover === null ? null : projectElement(hover.element, hostRect);
      setHoverRect(hovered === null ? null : pad(hovered));
      if (composer === null) {
        setDraftRects(null);
      } else {
        const primary = projectElement(composer.primary.element, hostRect);
        setDraftRects(
          primary === null
            ? null
            : {
                primary: pad(primary),
                additional: composer.additional
                  .map((extra) => projectElement(extra.element, hostRect))
                  .filter((r): r is ScreenRect => r !== null)
                  .map(pad),
              },
        );
      }
    };
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    if (typeof requestAnimationFrame === 'function') {
      frameRef.current = requestAnimationFrame(run);
    } else {
      run();
    }
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [composer, hostRef, hover, resolved, viewport]);

  // Selecting a comment in the panel pans its part into view; the ring
  // pulses through the selected class below.
  const selectedRect = projected.find((entry) => entry.id === selectedCommentId)?.rect;
  const pannedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedRect === undefined || selectedCommentId === null) return;
    if (pannedForRef.current === selectedCommentId) return;
    pannedForRef.current = selectedCommentId;
    panIntoView(selectedRect);
  }, [panIntoView, selectedCommentId, selectedRect]);
  useEffect(() => {
    if (selectedCommentId === null) pannedForRef.current = null;
  }, [selectedCommentId]);

  return (
    <div data-diagram-overlay="" className="pointer-events-none absolute inset-0 z-[1]">
      {projected.map((entry) => (
        <div key={entry.id} data-diagram-mark={entry.id} data-number={entry.number}>
          <div
            className={cn(
              'absolute rounded-sm border-2',
              entry.resolved ? 'border-muted-foreground/50' : 'border-primary/70',
              entry.id === selectedCommentId && 'animate-pulse border-primary',
            )}
            style={ringStyle(entry.rect)}
            aria-hidden="true"
          />
          {entry.additional.map((rect, index) => (
            <div
              key={index}
              className="absolute rounded-sm border-2 border-dashed border-primary/60"
              style={ringStyle(rect)}
              aria-hidden="true"
            />
          ))}
          <button
            type="button"
            data-diagram-badge={entry.id}
            className={cn(
              'pointer-events-auto absolute flex size-5 -translate-y-1/2 items-center justify-center rounded-full border font-mono text-[10px] font-medium tabular-nums',
              // A part's badge rides its top-right corner; the whole
              // diagram's sits top-left, clear of the parts' badges.
              entry.whole ? '-translate-x-1/2' : 'translate-x-1/2',
              entry.resolved
                ? 'border-border bg-muted text-muted-foreground'
                : 'border-primary-foreground/40 bg-primary text-primary-foreground',
              entry.id === selectedCommentId && 'ring-2 ring-primary/40',
            )}
            style={{ left: entry.whole ? entry.rect.left : entry.rect.left + entry.rect.width, top: entry.rect.top }}
            aria-label={`Comment ${entry.number}: ${entry.label}`}
            title={entry.label}
            onClick={(event) => {
              event.stopPropagation();
              onSelectComment?.(entry.id);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
          >
            {entry.number}
          </button>
        </div>
      ))}
      {hoverRect !== null && hover !== null && composer === null && (
        <div data-diagram-hover="">
          <div className="absolute rounded-sm border-2 border-primary/50" style={ringStyle(hoverRect)} aria-hidden="true" />
          <span
            className="absolute -translate-y-full whitespace-nowrap rounded-sm border border-border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground"
            style={{ left: hoverRect.left, top: hoverRect.top - 4 }}
          >
            {hover.target.label !== '' ? hover.target.label : diagramTargetName(hover.target)}
            {hover.target.label !== '' && (
              <span className="text-muted-foreground/70"> · {diagramTargetName(hover.target)}</span>
            )}
          </span>
        </div>
      )}
      {draftRects !== null && composer !== null && (
        <div data-diagram-draft="">
          <div className="absolute rounded-sm border-2 border-primary" style={ringStyle(draftRects.primary)} aria-hidden="true" />
          {draftRects.additional.map((rect, index) => (
            <div key={index} className="absolute rounded-sm border-2 border-dashed border-primary" style={ringStyle(rect)} aria-hidden="true" />
          ))}
          {renderComposer(draftRects.primary)}
        </div>
      )}
    </div>
  );
}
