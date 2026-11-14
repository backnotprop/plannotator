import React, { useLayoutEffect, useRef, useState } from 'react';

export const CLAMP_LINES = 8;

export const ClampedCommentBody: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  return (
    <>
      <div
        ref={ref}
        className={`${className ?? ''}${expanded ? '' : ' overflow-hidden'}`}
        style={expanded ? undefined : { maxHeight: `${CLAMP_LINES}lh` }}
        data-comment-body-clamped={expanded ? undefined : ''}
      >
        {children}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-sm"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          data-comment-show-more=""
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
};
