import React from 'react';
import { createPortal } from 'react-dom';
import type { ResizeHandleProps as BaseProps } from '../hooks/useResizablePanel';

interface Props extends BaseProps {
  className?: string;
  /**
   * The track also carries a `[data-resize-track]` attribute (same pattern as `[data-collapse]`)
   * so a host can target it from plain CSS — e.g. to kill the hover reveal: `[data-resize-track]
   * { background: none !important; }`.
   */
  trackClassName?: string;
  hideHoverTrack?: boolean;
  tooltip?: React.ReactNode;
  onCollapse?: () => void;
  /**
   * The touch-area is an absolutely-positioned child of a `w-0` parent, so its actual width is
   * `parent - left - right`.
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
      <div
        data-resize-track={side ?? ''}
        className={`absolute inset-y-0 -left-0.5 -right-0.5 transition-colors ${
          isDragging || hideHoverTrack ? 'bg-transparent' : 'group-hover:bg-border'
        }${trackClassName ? ` ${trackClassName}` : ''}`}
      />
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
