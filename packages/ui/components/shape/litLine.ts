// A lit part in the board's technical drawing language shows one line in the
// mark colour: its own border or stroke, recoloured. A second ring drawn
// around a part that already has a line reads as two borders, one inside the
// other. Only a part with no line of its own gets an outline drawn for it.

const SHAPES = 'rect, circle, ellipse, polygon, path';

/** The line an element draws round itself: an SVG shape's stroke, an HTML box's border, or null (none). */
export function ownLine(el: Element): 'stroke' | 'border' | null {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  if (el instanceof SVGElement) {
    const stroke = cs?.stroke || el.style.stroke || el.getAttribute('stroke') || '';
    if (!stroke || stroke === 'none' || stroke === 'transparent') return null;
    const width = parseFloat(cs?.strokeWidth || el.style.strokeWidth || el.getAttribute('stroke-width') || '1');
    return width > 0 ? 'stroke' : null;
  }
  if (!cs) return null;
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const width = parseFloat(cs.getPropertyValue(`border-${side}-width`) || '0');
    const style = cs.getPropertyValue(`border-${side}-style`) || 'none';
    if (width > 0 && style !== 'none' && style !== 'hidden') return 'border';
  }
  return null;
}

/**
 * The element that draws a part's outline: the part itself when it is a box with a border or a shape with a stroke,
 * else (an SVG group) the stroked shape that spans it, at least 80% of its area (the box a part is drawn as, not an icon
 * or a rule inside it). Null: the part has no outline of its own.
 */
export function outlineOf(part: Element): Element | null {
  // A group's stroke is only what its shapes inherit: the part's line is one of its shapes.
  if (!(part instanceof SVGElement) || part.matches(SHAPES)) return ownLine(part) ? part : null;
  const r = part.getBoundingClientRect();
  const area = r.width * r.height;
  if (!(area > 0)) return null;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of part.querySelectorAll(SHAPES)) {
    if (el.closest('text, defs, marker, symbol, clipPath, mask, pattern, [data-icon], [data-logo], [data-brand]') || !ownLine(el)) continue;
    const b = el.getBoundingClientRect();
    const a = b.width * b.height;
    if (a >= 0.8 * area && a > bestArea) {
      best = el;
      bestArea = a;
    }
  }
  return best;
}
