import type { ScreenRect } from '../../utils/diagram-projection';

type Point = { left: number; top: number };

/** Keep the note close to its bubble without covering another pin or a canvas control. */
export function placeNativeNote(pin: ScreenRect, width: number, height: number, roomWidth: number, roomHeight: number, obstacles: readonly ScreenRect[]): Point {
  const edge = 8, gap = 10;
  const alignedX = [pin.left, pin.left + (pin.width - width) / 2, pin.left + pin.width - width];
  const alignedY = [pin.top, pin.top + (pin.height - height) / 2, pin.top + pin.height - height];
  let best = { left: edge, top: edge };
  let bestScore = Infinity;
  let clusterLeft = Infinity, clusterRight = -Infinity, clusterTop = Infinity, clusterBottom = -Infinity;

  function consider(x: number, y: number, collect: boolean) {
    const left = Math.max(edge, Math.min(x, roomWidth - width - edge));
    const top = Math.max(edge, Math.min(y, roomHeight - height - edge));
    let covered = 0;
    for (const box of obstacles) {
      const overlapWidth = Math.min(left + width, box.left + box.width) - Math.max(left, box.left);
      const overlapHeight = Math.min(top + height, box.top + box.height) - Math.max(top, box.top);
      if (overlapWidth <= 0 || overlapHeight <= 0) continue;
      covered += overlapWidth * overlapHeight;
      if (collect) {
        clusterLeft = Math.min(clusterLeft, box.left);
        clusterRight = Math.max(clusterRight, box.left + box.width);
        clusterTop = Math.min(clusterTop, box.top);
        clusterBottom = Math.max(clusterBottom, box.top + box.height);
      }
    }
    const distance = Math.hypot(Math.max(0, left - pin.left - pin.width, pin.left - left - width), Math.max(0, top - pin.top - pin.height, pin.top - top - height));
    const score = covered * 1e6 + Math.abs(left - x) + Math.abs(top - y) + distance;
    if (score < bestScore) { bestScore = score; best = { left, top }; }
    return covered === 0;
  }

  function around(left: number, right: number, top: number, bottom: number, collect: boolean) {
    let clear = false;
    for (const y of alignedY) {
      if (consider(right + gap, y, collect)) clear = true;
      if (consider(left - width - gap, y, collect)) clear = true;
    }
    for (const x of alignedX) {
      if (consider(x, bottom + gap, collect)) clear = true;
      if (consider(x, top - height - gap, collect)) clear = true;
    }
    return clear;
  }

  if (!around(pin.left, pin.left + pin.width, pin.top, pin.top + pin.height, true)) {
    // If the pins occupy all four sides, place the note just outside that cluster.
    around(clusterLeft, clusterRight, clusterTop, clusterBottom, false);
  }
  return best;
}
