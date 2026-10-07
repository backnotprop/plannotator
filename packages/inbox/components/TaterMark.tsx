/**
 * The sidebar's brand mark: Workspaces' Tater sprite as Workspaces draws it
 * (apps/web/src/components/sprites/TaterSpriteSidebar.tsx and SpriteSheet.tsx
 * in the Workspaces repo): 24 frames of 77x88 at 2x, shown 44 px high,
 * mirrored, looping over 3.5 s. It pauses while offscreen, and under
 * prefers-reduced-motion it shows its first frame (inbox.css, `ib-tater`).
 */
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
    <span
      ref={ref}
      className="ib-tater"
      data-sprite="tater-sidebar"
      aria-hidden="true"
      style={{ backgroundImage: `url(${spriteSheet})`, animationPlayState: offscreen ? 'paused' : 'running' }}
    />
  );
}
