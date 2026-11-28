/**
 * The Swarm badge's motion, "Gather" (the owner's pick, the designer's round 2; round 3 adds the loose round icon and
 * the settle to off).
 * Only `transform` and `opacity` move, on the compositor (Web Animations); swarmBadge.css owns the loops (dot drift,
 * star drift and twinkle) and every rest state. This file and swarmBadge.css are the badge's whole motion: a later round
 * replaces them and SwarmBadge.tsx's markup constants, nothing else.
 *
 * Reduced motion: none of this runs; the badge is simply there, its stars drawn still.
 */

const E_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const E_DOTS = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

/** How long the Gather takes to the stars, and when, from its start, the badge settles off (round 3: 1,250 ms). */
export const SWARM_GATHER_MS = 960;
export const SWARM_SETTLE_AT_MS = 1_250;
/** The settle to off: the glow subsides more slowly than a click turns it off (swarmBadge.css `[data-settling]`). */
export const SWARM_SETTLE_MS = 480;
/** When the first-time card may come, from the badge's appearance: once it has settled (at once with reduced motion). */
export const swarmTipAfterMs = (): number => (swarmReducedMotion() ? 0 : SWARM_SETTLE_AT_MS + SWARM_SETTLE_MS);

/** Where the eight loose particles and the five stars start from (px from their resting spot). */
const PART = [[-42, -14], [-26, -30], [-8, 38], [-46, 12], [30, -32], [44, 6], [16, 34], [-18, -40]] as const;
const STAR = [[8, 6], [-8, 0], [-3, 8], [0, -8], [6, -4]] as const;

export function swarmReducedMotion(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type Frames = Keyframe[];
const play = (el: Element | null, frames: Frames, options: KeyframeAnimationOptions): Animation | null =>
  el && typeof (el as HTMLElement).animate === 'function' ? (el as HTMLElement).animate(frames, { fill: 'backwards', ...options }) : null;

/** A dot's start, from its `data-v` ("x,y": out along its own direction from the icon's centre). */
const scatterOf = (dot: Element): [number, number] => {
  const [x, y] = (dot.getAttribute('data-v') ?? '0,0').split(',').map(Number);
  return [x || 0, y || 0];
};

/** Cancels every running animation under `slot`. */
export function swarmMotionStop(slot: HTMLElement): void {
  if (typeof slot.getAnimations !== 'function') return;
  // The CSS loops (drift, twinkle) are the stylesheet's: only the script's own animations go.
  for (const animation of slot.getAnimations({ subtree: true })) if (!(typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation)) animation.cancel();
}

/** The unlock: the dots fly in and become the icon, the badge forms around them, then the stars spark out of it. */
export function swarmGather(slot: HTMLElement): void {
  if (swarmReducedMotion()) return;
  swarmMotionStop(slot);
  slot.querySelectorAll('.ib-sw-lab-on .ib-sw-g i').forEach((dot, i) => {
    const [x, y] = scatterOf(dot);
    play(dot, [{ opacity: 0, transform: `translate(${x}px, ${y}px) scale(0.5)` }, { opacity: 1, offset: 0.25 }, { opacity: 1, transform: 'none' }], { duration: 540, delay: i * 30, easing: E_DOTS });
  });
  slot.querySelectorAll('.ib-sw-p').forEach((p, i) => {
    const [x, y] = PART[i % PART.length]!;
    play(p, [{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 0.9, offset: 0.3 }, { opacity: 0, transform: 'translate(0, 0) scale(0.3)' }], { duration: 500, delay: 20 + i * 18, easing: 'cubic-bezier(0.55, 0, 0.65, 0.6)' });
  });
  const shell = [{ opacity: 0, transform: 'scale(0.9)' }, { opacity: 1, transform: 'none' }];
  play(slot.querySelector('.ib-sw-clip'), shell, { duration: 360, delay: 260, easing: E_OUT });
  play(slot.querySelector('.ib-sw-ring'), shell, { duration: 360, delay: 260, easing: E_OUT });
  play(slot.querySelector('.ib-sw-lab-on .ib-sw-word'), [{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 320, easing: E_OUT });
  play(slot.querySelector('.ib-sw-halo'), [{ opacity: 0, transform: 'scale(0.5)' }, { opacity: 1, transform: 'none' }], { duration: 520, delay: 300, easing: E_OUT });
  slot.querySelectorAll('.ib-sw-st').forEach((star, i) => {
    const [x, y] = STAR[i % STAR.length]!;
    play(star, [{ opacity: 0, transform: `translate(${x}px, ${y}px) scale(0.3)` }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 380 + i * 40, easing: E_OUT });
  });
}

/** Turned on: a short regather, and the stars come back. */
export function swarmRegather(slot: HTMLElement): void {
  if (swarmReducedMotion()) return;
  swarmMotionStop(slot);
  slot.querySelectorAll('.ib-sw-lab-on .ib-sw-g i').forEach((dot, i) => {
    const [x, y] = scatterOf(dot);
    play(dot, [{ transform: `translate(${x * 0.4}px, ${y * 0.4}px) scale(0.7)` }, { transform: 'none' }], { duration: 360, delay: i * 20, easing: E_DOTS });
  });
  play(slot.querySelector('.ib-sw-halo'), [{ transform: 'scale(0.85)' }, { transform: 'scale(1)' }], { duration: 400, delay: 80, easing: E_OUT });
  slot.querySelectorAll('.ib-sw-st').forEach((star, i) => {
    const [x, y] = STAR[i % STAR.length]!;
    play(star, [{ opacity: 0, transform: `translate(${x * 0.6}px, ${y * 0.6}px) scale(0.4)` }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 100 + i * 35, easing: E_OUT });
  });
}
