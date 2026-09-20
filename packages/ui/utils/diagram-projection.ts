/**
 * The overlay projection: the canvas scales a wrapper around the rendered
 * svg with a CSS transform; the overlay is a sibling of that wrapper,
 * unscaled, so rings and badges keep constant pixel size at every zoom.
 * Each target's box is read in svg user units (`getBBox`) and pushed
 * through `getScreenCTM`, which carries the svg viewBox scaling and every
 * ancestor transform, the wrapper's CSS zoom included. Minus the canvas
 * host's own rect, that is the ring's rectangle in overlay pixels.
 *
 * Pure over two browser APIs; happy-dom has neither, so the tests install
 * both on the captured fixture's elements with the numbers a real Chromium
 * measured (test-setup/fixtures/diagrams/*.geometry.json).
 */

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface HostRect {
  readonly left: number;
  readonly top: number;
}

export function projectElement(el: Element, host: HostRect): ScreenRect | null {
  const graphic = el as SVGGraphicsElement;
  if (typeof graphic.getBBox !== 'function' || typeof graphic.getScreenCTM !== 'function') {
    return null;
  }
  let box: DOMRect;
  try {
    box = graphic.getBBox();
  } catch {
    // A detached or display:none element throws in some engines.
    return null;
  }
  const m = graphic.getScreenCTM();
  if (m === null) return null;
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of corners) {
    const sx = m.a * x + m.c * y + m.e;
    const sy = m.b * x + m.d * y + m.f;
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    left: minX - host.left,
    top: minY - host.top,
    width: maxX - minX,
    height: maxY - minY,
  };
}
