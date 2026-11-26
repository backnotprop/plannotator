import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import './glowStars.css';

/**
 * The lit look: a glow around one control and a few small stars drifting behind it (glowStars.css), the Swarm badge's
 * "on" look as a shared piece. Wrap the control and give it the class `GLOW_FACE` for the badge's gradient face:
 *
 *   <GlowStars><a className={`${GLOW_FACE} …`}>See the launch</a></GlowStars>
 *
 * The glow and the stars are decoration: aria-hidden, no pointer events, behind the control's face (never over its
 * label), and never left of it, where a neighbouring button sits. Reduced motion: still. A hidden tab: paused.
 */

/** The control's class for the lit face (gradient, indigo label, ring, focus ring outside the glow). */
export const GLOW_FACE = 'pn-glow-face';

interface Star {
  /** In the stars' layer, which reaches 20 px past the control's top, right and bottom edges. */
  readonly at: CSSProperties;
  readonly size: number;
  readonly hue: 0 | 1 | 2 | 3;
  readonly path: 'pn-glow-a' | 'pn-glow-b' | 'pn-glow-c';
  /** Seconds: the drift's period, the twinkle's period, the twinkle's phase. */
  readonly drift: number;
  readonly twinkle: number;
  readonly phase: number;
}

/** Above, below and right of the control (the left edge stays clear). */
const STARS: readonly Star[] = [
  { at: { left: '9%', top: 2 }, size: 13, hue: 0, path: 'pn-glow-a', drift: 6.2, twinkle: 3.1, phase: -0.4 },
  { at: { left: '58%', top: 4 }, size: 9, hue: 3, path: 'pn-glow-c', drift: 7.1, twinkle: 3.7, phase: -2.2 },
  { at: { right: 2, top: 'calc(50% - 6px)' }, size: 12, hue: 2, path: 'pn-glow-b', drift: 5.4, twinkle: 2.6, phase: -1.3 },
  { at: { left: '36%', bottom: 3 }, size: 8, hue: 1, path: 'pn-glow-b', drift: 6.6, twinkle: 4.2, phase: -0.9 },
  { at: { right: 10, bottom: 4 }, size: 10, hue: 0, path: 'pn-glow-a', drift: 5.8, twinkle: 3.3, phase: -2.6 },
  { at: { right: 8, top: 3 }, size: 7, hue: 1, path: 'pn-glow-c', drift: 5.0, twinkle: 2.9, phase: -1.8 },
];

export interface GlowStarsProps {
  readonly children: ReactNode;
  /** The wrapper's classes (its place in a flex row). */
  readonly className?: string;
  /** The control's corner radius (default 10px; a pill: 999px). */
  readonly radius?: string;
}

export function GlowStars({ children, className, radius }: GlowStarsProps) {
  const root = useRef<HTMLSpanElement>(null);

  // A hidden tab runs no loop.
  useEffect(() => {
    const el = root.current;
    if (!el || typeof document === 'undefined') return;
    const sync = () => el.toggleAttribute('data-paused', document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  return (
    <span
      ref={root}
      className={className ? `pn-glow ${className}` : 'pn-glow'}
      style={radius ? ({ '--pn-glow-radius': radius } as CSSProperties) : undefined}
      data-glow-stars
    >
      <span className="pn-glow-halo" aria-hidden="true" />
      <span className="pn-glow-stars" aria-hidden="true">
        {STARS.map((star, i) => (
          <i
            key={i}
            className="pn-glow-star"
            data-hue={star.hue}
            style={{
              ...star.at,
              width: star.size,
              height: star.size,
              ['--pn-glow-path' as string]: star.path,
              ['--pn-glow-drift' as string]: `${star.drift}s`,
              ['--pn-glow-twinkle' as string]: `${star.twinkle}s`,
              ['--pn-glow-phase' as string]: `${star.phase}s`,
            }}
          >
            <i>
              <i />
            </i>
          </i>
        ))}
      </span>
      {children}
    </span>
  );
}
