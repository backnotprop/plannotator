/**
 * Composer-yield state machine for shift-click multi-select.
 *
 * While Shift is held during an HTML pinpoint draft, the comment composer must
 * get out of the way of the pointer: fade to ~40% as the pointer approaches,
 * and to near-zero + click-through (pointer-events: none) when the pointer is
 * over it — the DOM equivalent of Codex's setIgnoreMouseEvents click-through
 * popup, so the shift-click lands on the iframe beneath.
 *
 * Restoration uses hysteresis so the composer doesn't flicker at the border:
 * once 'over', the pointer must clear the composer by OVER_EXIT px before the
 * state drops back, and 'near' persists until NEAR_EXIT px (> NEAR_ENTER).
 */

export type ComposerYieldState = "none" | "near" | "over";

/** Distance (px from the composer rect) at which the composer starts fading. */
export const COMPOSER_YIELD_NEAR_ENTER_PX = 80;
/** Distance the pointer must exceed before a faded composer fully restores. */
export const COMPOSER_YIELD_NEAR_EXIT_PX = 96;
/** Distance the pointer must clear a click-through composer by to restore. */
export const COMPOSER_YIELD_OVER_EXIT_PX = 48;

/** Shortest distance from a point to a rect's edge; <= 0 means inside. */
export function distanceToRect(
  x: number,
  y: number,
  rect: { left: number; top: number; right: number; bottom: number },
): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  if (dx === 0 && dy === 0) return 0;
  return Math.hypot(dx, dy);
}

/** Next yield state for a pointer at `distance` px from the composer rect. */
export function computeComposerYield(
  prev: ComposerYieldState,
  distance: number,
): ComposerYieldState {
  if (distance <= 0) return "over";
  if (prev === "over") {
    // Hysteresis: don't restore until the pointer has moved well away.
    if (distance <= COMPOSER_YIELD_OVER_EXIT_PX) return "over";
    return distance <= COMPOSER_YIELD_NEAR_EXIT_PX ? "near" : "none";
  }
  if (prev === "near") {
    return distance <= COMPOSER_YIELD_NEAR_EXIT_PX ? "near" : "none";
  }
  return distance <= COMPOSER_YIELD_NEAR_ENTER_PX ? "near" : "none";
}
