import { useEffect, useRef, useState } from 'react';
import spriteSheet from '../assets/tater-sidebar.webp';

export function TaterMark() {
  const ref = useRef<HTMLSpanElement>(null);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setOffscreen(!(entry?.isIntersecting ?? true)));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <span ref={ref} className="ib-tater" aria-hidden="true">
      <span
        className="ib-tater-strip"
        data-sprite="tater-sidebar"
        style={{ backgroundImage: `url(${spriteSheet})`, animationPlayState: offscreen ? 'paused' : 'running' }}
      />
    </span>
  );
}
