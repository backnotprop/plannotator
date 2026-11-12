import { debugLogOn, debugNote, whenDebugLogStops } from './debugLog';
import type { VoiceView } from './voiceSession';

export const VOICE_MISS_REACH_PX = 24;
export const VOICE_MISS_GAP_MS = 300;

export type VoiceMissEdge = 'above' | 'below' | 'left' | 'right';

export interface VoiceHitBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function voiceMiss(x: number, y: number, box: VoiceHitBox): { px: number; edge: VoiceMissEdge } | null {
  const outX = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
  const outY = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
  if (outX === 0 && outY === 0) return null;
  const px = Math.hypot(outX, outY);
  if (px > VOICE_MISS_REACH_PX) return null;
  const edge: VoiceMissEdge = outX > outY ? (x < box.left ? 'left' : 'right') : y < box.top ? 'above' : 'below';
  return { px: Math.round(px), edge };
}

const CONTROLS = 'button, a, input, textarea, [role="button"]';

const grows = (value: string): number => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n < 0 ? -n : 0;
};

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

export function watchVoiceMisses(button: Element, state: () => Pick<VoiceView, 'phase' | 'mode'>, now: () => number = () => performance.now()): () => void {
  if (!debugLogOn()) return () => {};
  let last = Number.NEGATIVE_INFINITY;
  const onDown = (event: PointerEvent) => {
    try {
      if (event.button !== 0) return;
      const { phase, mode } = state();
      if (phase !== 'opening' && phase !== 'listening') return;
      if (event.target instanceof Node && button.contains(event.target)) return;
      const t = now();
      if (t - last < VOICE_MISS_GAP_MS) return;
      const { box, w, h } = voiceHitBox(button);
      const miss = voiceMiss(event.clientX, event.clientY, box);
      if (!miss) return;
      last = t;
      const other = event.target instanceof Element && event.target.closest(CONTROLS) !== null;
      debugNote('voice_miss', { px: miss.px, edge: miss.edge, phase, mode: mode ?? undefined, w, h, other });
    } catch {
    }
  };
  document.addEventListener('pointerdown', onDown, true);
  let stopOff: () => void = () => {};
  const remove = () => {
    document.removeEventListener('pointerdown', onDown, true);
    stopOff();
  };
  stopOff = whenDebugLogStops(remove);
  return remove;
}
