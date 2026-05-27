import React, { useEffect, useMemo, useRef } from 'react';
import { CopyButton } from './CopyButton';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { useOverlayViewport } from '@plannotator/ui/hooks/useOverlayViewport';

interface LiveLogViewerProps {
  /** The full accumulated log text. */
  content: string;
  /** Whether the source is still producing output. */
  isLive?: boolean;
  /** Max bytes to render (trim from top). Default 50KB. */
  maxRenderSize?: number;
  /** Optional className for the outer container. */
  className?: string;
}

/**
 * Reusable streaming log viewer with auto-scroll, truncation, and copy.
 *
 * Auto-scrolls to bottom as new content arrives — unless the user has
 * scrolled up to read earlier output. Follows the AITab streaming pattern.
 */
export const LiveLogViewer: React.FC<LiveLogViewerProps> = ({
  content,
  isLive = false,
  maxRenderSize = 50_000,
  className,
}) => {
  const { ref: containerRef, viewport, onViewportReady } =
    useOverlayViewport<HTMLDivElement>();
  const isAtBottomRef = useRef(true);

  // Track whether the user is within 40px of the bottom. Attach directly
  // to the OverlayScrollbars viewport because React's onScroll doesn't
  // bubble across the library's wrapper layers.
  useEffect(() => {
    if (!viewport) return;
    const handleScroll = () => {
      isAtBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [viewport]);

  // Auto-scroll on new content if user is at bottom
  useEffect(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [content, viewport]);

  const displayText = useMemo(() => {
    if (content.length <= maxRenderSize) return content;
    const sliceFrom = content.indexOf('\n', content.length - maxRenderSize);
    return '[earlier output truncated]\n' + content.slice(sliceFrom === -1 ? content.length - maxRenderSize : sliceFrom + 1);
  }, [content, maxRenderSize]);

  if (!content && !isLive) {
    return (
      <div className={`flex items-center justify-center py-8 ${className ?? ''}`}>
        <p className="text-xs text-muted-foreground">No output captured.</p>
      </div>
    );
  }

  return (
    <div className={`group relative flex-1 min-h-0 ${className ?? ''}`}>
      <OverlayScrollArea
        className="h-full rounded bg-muted/30"
        onViewportReady={onViewportReady}
      >
        <div className="p-3">
        {!content && isLive ? (
          <span className="text-xs text-muted-foreground/50 animate-pulse">
            Waiting for output...
          </span>
        ) : (
          <pre className="text-xs leading-relaxed font-mono whitespace-pre-wrap break-words text-foreground/80">
            {displayText}
            {isLive && content && (
              <span className="inline-block w-1.5 h-3.5 bg-primary/60 ml-0.5 animate-pulse rounded-sm" />
            )}
          </pre>
        )}
        </div>
      </OverlayScrollArea>
      {content && (
        <div className="absolute top-2 right-2">
          <CopyButton text={content} variant="inline" />
        </div>
      )}
    </div>
  );
};
