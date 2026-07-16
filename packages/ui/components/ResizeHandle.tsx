import React from 'react';
import { createPortal } from 'react-dom';
import type { ResizeHandleProps as BaseProps } from '../hooks/useResizablePanel';

interface Props extends BaseProps {
  className?: string;
  /**
   * Extra classes for the inner visible track (the 4px bar that reveals on
   * hover). `className` only reaches the outer wrapper, so this is the seam for
   * restyling or suppressing the hover affordance. The track also carries a
   * `[data-resize-track]` attribute (same pattern as `[data-collapse]`) so a
   * host can target it from plain CSS — e.g. to kill the hover reveal:
   * `[data-resize-track] { background: none !important; }`.
   */
  trackClassName?: string;
  /** Suppress the hover color-change on the track entirely (no pop-in). */
  hideHoverTrack?: boolean;
  /** Cursor-following hint shown while hovering the handle (hidden mid-drag). */
  tooltip?: React.ReactNode;
  /** When provided, renders a hover-reveal collapse button centered on the
   *  handle (prototype's gutter affordance). Chevron direction follows `side`:
   *  a left sidebar collapses leftward, a right sidebar rightward. */
  onCollapse?: () => void;
  /**
   * Which panel this handle resizes, not which side of the boundary it's on.
   *
   * The touch-area is an absolutely-positioned child of a `w-0` parent, so
   * its actual width is `parent - left - right`. Because the parent is zero
   * wide, any combination where `left` and `right` cancel produces a 0-px
   * element and the handle becomes undraggable. See issue #354.
   *
   *   'left'  — resizes a left sidebar. Touch area extends slightly into the
   *             sidebar (leftward) and slightly past the boundary (rightward).
   *             12px total: `-left-1` (-4px) + `-right-2` (-8px) → width 12.
   *   'right' — resizes a right panel. Touch area must NOT extend leftward,
   *             because the adjacent content area's overlay scrollbar lives
   *             in that region (right edge of the content, just left of the
   *             boundary). `left-0 -right-3` → width 12, entirely to the
   *             right of the boundary. DO NOT push `left` positive —
   *             `left-3 -right-3` evaluates to width 0 and kills the drag.
   */
  side?: 'left' | 'right';
}

export const ResizeHandle: React.FC<Props> = ({
  isDragging,
  onPointerDown,
  onDoubleClick,
  style,
  className,
  trackClassName,
  hideHoverTrack,
  tooltip,
  side,
  onCollapse,
}) => {
  const [tip, setTip] = React.useState<{ x: number; y: number } | null>(null);
  const showTip = tooltip != null && tip != null && !isDragging;

  return (
    <div
      className={`relative w-0 cursor-col-resize flex-shrink-0 group${className ? ` ${className}` : ''}`}
    >
      {/* Visible track — 4px wide, centered on the zero-width layout box,
          invisible until hover/drag. `data-resize-track` + `trackClassName` are
          host seams for restyling/suppressing the hover reveal. */}
      <div
        data-resize-track={side ?? ''}
        className={`absolute inset-y-0 -left-0.5 -right-0.5 transition-colors ${
          isDragging || hideHoverTrack ? 'bg-transparent' : 'group-hover:bg-border'
        }${trackClassName ? ` ${trackClassName}` : ''}`}
      />
      {/* Wider grab/touch zone — must never have zero width (see `side` docs).
          Pointer events + setPointerCapture live here; touch-action:none (from
          style) stops touch drags from scroll-hijacking. */}
      <div
        className={`absolute inset-y-0 ${
          side === 'left' ? '-right-2 -left-1' :
          side === 'right' ? '-right-3 left-0' :
          '-inset-x-2'
        }`}
        style={style}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onPointerMove={tooltip != null && !isDragging ? (e) => setTip({ x: e.clientX, y: e.clientY }) : undefined}
        onPointerLeave={tooltip != null ? () => setTip(null) : undefined}
      />
      {/* Cursor-following hint. pointer-events-none so it never blocks the drag;
          portaled to body so the zero-width parent doesn't clip it. */}
      {showTip && typeof document !== 'undefined' && createPortal(
        <div
          data-print-hide
          style={{ position: 'fixed', left: tip.x + 14, top: tip.y + 16, zIndex: 100 }}
          className="pointer-events-none whitespace-nowrap rounded-md bg-surface-1 px-2 py-1 text-xs text-foreground shadow-md ring-1 ring-border/60"
        >
          {tooltip}
        </div>,
        document.body,
      )}
      {/* Hover-reveal collapse button, centered on the handle. stopPropagation on
          pointerdown so clicking it never starts a drag. Hidden mid-drag. */}
      {onCollapse && !isDragging && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCollapse();
          }}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          data-collapse={side}
          className="absolute top-1/2 left-1/2 z-20 flex h-6 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center before:absolute before:-inset-2 before:content-[''] rounded-sm bg-surface-1 text-muted-foreground/60 opacity-0 ring-1 ring-border/40 transition-opacity hover:text-foreground group-hover:opacity-100 group-hover/sidebar:opacity-100"
        >
          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={side === 'right' ? 'M9 5l7 7-7 7' : 'M15 19l-7-7 7-7'}
            />
          </svg>
        </button>
      )}
    </div>
  );
};
