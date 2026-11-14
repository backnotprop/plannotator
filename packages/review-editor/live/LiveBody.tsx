import { useLayoutEffect, useRef, useState } from 'react';
import { MarkdownBody } from '../components/MarkdownBody';

export const LIVE_BODY_LINES = 8;
const LINE_PX = 20;

export function LiveBody({ body, quiet }: { body: string; quiet: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > LIVE_BODY_LINES * LINE_PX + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body]);
  const clamped = long && !open;
  return (
    <>
      <div ref={ref} className="live-body min-w-0 break-words" data-live-body data-clamped={clamped ? '' : undefined} style={clamped ? { maxHeight: LIVE_BODY_LINES * LINE_PX, overflow: 'hidden' } : undefined}>
        <MarkdownBody markdown={body} textClassName="text-[13px]" />
      </div>
      {long ? (
        <button type="button" className={`${quiet} -ml-1`} data-live-more data-pn-touch-target aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}
