/**
 * The debug log's `voice_miss`: a tap that lands just outside the mic's hit box while the mic is opening or listening.
 * A miss never reaches the button, so `voice_press` cannot show it; this measures how often stopping misses, and by
 * how much. Measurement only: it changes nothing the mic does, and the press itself is never touched.
 *
 * Off (the debug log is off), nothing is listened to. A line holds the distance, the side, the phase and the button's
 * size: never a word, a target or anything on the page.
 */
import { debugLogOn, debugNote, whenDebugLogStops } from './debugLog';
import type { VoicePhase } from './voiceSession';

/** A tap farther than this from the hit box was meant for something else. */
export const VOICE_MISS_REACH_PX = 24;
/** At most one line per this: a finger that taps three times in a row is one miss, not three. */
export const VOICE_MISS_GAP_MS = 300;

export type VoiceMissEdge = 'above' | 'below' | 'left' | 'right';

export interface VoiceHitBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far `(x, y)` is outside `box`, and on which side; null inside it or past the reach. */
export function voiceMiss(x: number, y: number, box: VoiceHitBox): { px: number; edge: VoiceMissEdge } | null {
  const outX = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
  const outY = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
  if (outX === 0 && outY === 0) return null;
  const px = Math.hypot(outX, outY);
  if (px > VOICE_MISS_REACH_PX) return null;
  const edge: VoiceMissEdge = outX > outY ? (x < box.left ? 'left' : 'right') : y < box.top ? 'above' : 'below';
  return { px: Math.round(px), edge };
}

/** What a pseudo-element's negative offset adds to the box (the phone's `::after`, inset -4px). */
const grows = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n < 0 ? -n : 0;
};

/** The button's hit box as the page lays it out now: its rect, grown by its `::after` when that reaches past it. */
export function voiceHitBox(button: Element): { box: VoiceHitBox; w: number; h: number } {
  const rect = button.getBoundingClientRect();
  const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  const after = getComputedStyle(button, '::after');
  if (after.content && after.content !== 'none' && after.position === 'absolute') {
    box.left -= grows(after.left);
    box.top -= grows(after.top);
    box.right += grows(after.right);
    box.bottom += grows(after.bottom);
  }
  return { box, w: Math.round(rect.width), h: Math.round(rect.height) };
}

/**
 * While the debug log is on, notes each near miss of `button` as `voice_miss`. The phase is read at the tap, and a
 * tap outside opening or listening is not one. Returns the removal; with the debug log off it listens to nothing.
 */
export function watchVoiceMisses(button: Element, phase: () => VoicePhase, now: () => number = () => performance.now()): () => void {
  if (!debugLogOn()) return () => {};
  let last = Number.NEGATIVE_INFINITY;
  const onDown = (event: PointerEvent) => {
    try {
      if (event.button !== 0) return;
      const at = phase();
      if (at !== 'opening' && at !== 'listening') return;
      if (event.target instanceof Node && button.contains(event.target)) return;
      const t = now();
      if (t - last < VOICE_MISS_GAP_MS) return;
      const { box, w, h } = voiceHitBox(button);
      const miss = voiceMiss(event.clientX, event.clientY, box);
      if (!miss) return;
      last = t;
      debugNote('voice_miss', { px: miss.px, edge: miss.edge, phase: at, w, h });
    } catch {
      // The log never changes a tap.
    }
  };
  // Capture: a tap that something else stops still counts.
  document.addEventListener('pointerdown', onDown, true);
  let stopOff: () => void = () => {};
  const remove = () => {
    document.removeEventListener('pointerdown', onDown, true);
    stopOff();
  };
  stopOff = whenDebugLogStops(remove);
  return remove;
}
