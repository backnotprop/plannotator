import React, { useRef, useState, useCallback, useEffect } from 'react';

interface ScrollFadeProps {
  children: React.ReactNode;
  className?: string;
  /** Height of the gradient fade in pixels. Default 20. */
  fadeHeight?: number;
}

/**
 * Wraps a scrollable container with gradient fade indicators at top/bottom.
 * Fades appear only when content overflows in that direction.
 */
export const ScrollFade: React.FC<ScrollFadeProps> = ({ children, className, fadeHeight = 20 }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);
  const [showBottom, setShowBottom] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowTop(el.scrollTop > 2);
    setShowBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }, []);

  useEffect(() => {
    update();
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [update]);

  return (
    <div className={`relative flex-1 min-h-0 ${className ?? ''}`}>
      <div
        className="absolute top-0 left-0 right-0 z-10 pointer-events-none bg-gradient-to-b from-background to-transparent transition-opacity duration-150"
        style={{ height: fadeHeight, opacity: showTop ? 1 : 0 }}
      />
      <div
        ref={scrollRef}
        onScroll={update}
        className="h-full overflow-y-auto"
      >
        {children}
      </div>
      <div
        className="absolute bottom-0 left-0 right-0 z-10 pointer-events-none bg-gradient-to-t from-background to-transparent transition-opacity duration-150"
        style={{ height: fadeHeight, opacity: showBottom ? 1 : 0 }}
      />
    </div>
  );
};
