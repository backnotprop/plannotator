const SHAPES = 'rect, circle, ellipse, polygon, path';

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

export function outlineOf(part: Element): Element | null {
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
