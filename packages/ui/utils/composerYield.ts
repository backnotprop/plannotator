/**
 * Composer-yield state machine for shift-click multi-select.
 *
 * While Shift is held during a multi-target draft, the comment composer gets
 * out of the pointer's way: it fades as the pointer approaches and becomes
 * click-through when the pointer is over it. Restoration uses hysteresis so
 * the composer does not flicker at its boundary.
 */

export type ComposerYieldState = 'none' | 'near' | 'over';

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
  previous: ComposerYieldState,
  distance: number,
): ComposerYieldState {
  if (distance <= 0) return 'over';
  if (previous === 'over') {
    if (distance <= COMPOSER_YIELD_OVER_EXIT_PX) return 'over';
    return distance <= COMPOSER_YIELD_NEAR_EXIT_PX ? 'near' : 'none';
  }
  if (previous === 'near') {
    return distance <= COMPOSER_YIELD_NEAR_EXIT_PX ? 'near' : 'none';
  }
  return distance <= COMPOSER_YIELD_NEAR_ENTER_PX ? 'near' : 'none';
}
