/**
 * The motion of opening a snapshot into the canvas, and closing it again.
 *
 * One number, `p`, runs from 0 (the figure in the plan) to 1 (the open
 * canvas). Everything on screen is a function of `p` (`frameAt`): the
 * clipping rectangle grows from the figure's box to the whole window, the
 * camera goes from "the snapshot's part of the world drawn exactly where
 * the figure drew it" to the canvas's own view, and the corners square off.
 * The figure and the canvas are the same DOM renderer looking at the same
 * document, so there is no picture standing in for another: the thing the
 * person clicked is the thing that grows.
 *
 * `p` is moved by a critically damped spring, not a timed curve. A spring
 * keeps its velocity when its target changes, so the motion can be turned
 * round at any moment (close while still opening) without a jump or a
 * restart, and it never overshoots.
 */
import type { Rect } from '../model/geometry';
import { type Camera, type Size, lerpCamera } from '../view/camera';

export interface Spring {
  p: number;
  v: number;
}

/** Stiffness. With critical damping this settles in about 350 ms. */
export const SPRING_STIFFNESS = 260;
const DAMPING = 2 * Math.sqrt(SPRING_STIFFNESS);
/** Close enough to the target, and slow enough, to stop. */
const REST_DISTANCE = 0.0005;
const REST_SPEED = 0.005;

/**
 * Advance the spring by `dt` seconds towards `target`. Steps of at most
 * 4 ms inside, so a long frame cannot make it explode. Stays within 0 to 1.
 */
export function stepSpring(spring: Spring, target: number, dt: number): Spring {
  let { p, v } = spring;
  let left = Math.min(Math.max(dt, 0), 0.1);
  while (left > 0) {
    const h = Math.min(left, 0.004);
    const a = -SPRING_STIFFNESS * (p - target) - DAMPING * v;
    v += a * h;
    p += v * h;
    left -= h;
  }
  if (p <= 0) return { p: 0, v: Math.max(0, v) };
  if (p >= 1) return { p: 1, v: Math.min(0, v) };
  return { p, v };
}

export const springAtRest = (spring: Spring, target: number): boolean =>
  Math.abs(spring.p - target) < REST_DISTANCE && Math.abs(spring.v) < REST_SPEED;

export interface TransitionEnds {
  /** The figure's box in the window, in CSS pixels. */
  from: Rect;
  /** The window. */
  viewport: Size;
  /** The camera that draws the snapshot exactly over `from`. */
  startCamera: Camera;
  /** The camera of the open canvas. */
  endCamera: Camera;
  /** The figure's corner radius. */
  radius: number;
}

export interface TransitionFrame {
  /** `clip-path: inset(top right bottom left round radius)`, in pixels. */
  inset: { top: number; right: number; bottom: number; left: number; radius: number };
  camera: Camera;
  /** How visible the canvas's own bars are, 0 to 1. They arrive late and leave early. */
  chrome: number;
}

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export function frameAt(ends: TransitionEnds, p: number): TransitionFrame {
  const t = Math.max(0, Math.min(1, p));
  const { from, viewport } = ends;
  return {
    inset: {
      top: mix(from.y, 0, t),
      left: mix(from.x, 0, t),
      right: mix(viewport.w - (from.x + from.w), 0, t),
      bottom: mix(viewport.h - (from.y + from.h), 0, t),
      radius: mix(ends.radius, 0, t),
    },
    camera: lerpCamera(ends.startCamera, ends.endCamera, t, viewport),
    chrome: Math.max(0, Math.min(1, (t - 0.7) / 0.3)),
  };
}

export const insetToClipPath = (inset: TransitionFrame['inset']): string =>
  `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px round ${inset.radius}px)`;
