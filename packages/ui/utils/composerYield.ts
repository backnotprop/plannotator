export type ComposerYieldState = 'none' | 'near' | 'over';

export const COMPOSER_YIELD_NEAR_ENTER_PX = 80;
export const COMPOSER_YIELD_NEAR_EXIT_PX = 96;
export const COMPOSER_YIELD_OVER_EXIT_PX = 48;

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
