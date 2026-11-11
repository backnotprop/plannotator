// Hairline strokes, small corners, one type system (a clean sans for names, a monospace for labels
// and numbers, a few fixed steps), quiet fills, no shadows. It never touches a board without
// scenes, and everything it sets is put back.

export const LOOK_CSS = `
[data-scene-look=technical] {
  --blue-soft: color-mix(in oklab, #2f6fb0 6%, var(--paper));
  --amber-soft: color-mix(in oklab, #d9971f 8%, var(--paper));
  --green-soft: color-mix(in oklab, #2b8a57 6%, var(--paper));
  --plum-soft: color-mix(in oklab, #9b3f78 6%, var(--paper));
  --alert-soft: color-mix(in oklab, var(--destructive) 7%, var(--paper));
  --mark-soft: color-mix(in oklab, var(--primary) 9%, transparent);
  --sunk: color-mix(in oklab, var(--ink) 4%, var(--paper));
  --surface: var(--paper);
  --blue: color-mix(in oklab, #2f6fb0 62%, var(--ink));
  --amber: color-mix(in oklab, #b87a12 70%, var(--ink));
  --green: color-mix(in oklab, #2b8a57 62%, var(--ink));
  --plum: color-mix(in oklab, #9b3f78 62%, var(--ink));
}
[data-scene-look=technical] svg .obj { filter: none; }
[data-scene-look=technical] svg text { font-variant-numeric: tabular-nums; }
[data-scene-look=technical] > svg:first-of-type {
  background-image: radial-gradient(circle, color-mix(in oklab, var(--ink) 9%, transparent) .6px, transparent .9px);
  background-size: 16px 16px;
}
`;

/** A lit piece in the technical look: a crisp thin outline in the accent, not a glow. */
export const LIT_TECHNICAL = 'drop-shadow(0 0 .6px var(--mark)) drop-shadow(0 0 .6px var(--mark)) drop-shadow(0 0 .6px var(--mark))';

type Saved = { el: SVGElement; props: [string, string][] };

function set(saved: Saved[], el: SVGElement, props: Record<string, string>) {
  saved.push({ el, props: Object.keys(props).map((p) => [p, el.style.getPropertyValue(p)]) });
  for (const [p, v] of Object.entries(props)) el.style.setProperty(p, v);
}

/** Apply the per-element half to the scene's SVG; returns a function that puts it all back. */
export function applyTechnicalLook(svg: SVGSVGElement): () => void {
  const saved: Saved[] = [];
  const m = svg.getScreenCTM();
  const s = m ? Math.hypot(m.a, m.b) : 1; // screen px per drawing unit
  if (!(s > 0.01)) return () => {};
  const px = (n: number) => `${(n / s).toFixed(3)}px`;

  for (const el of svg.querySelectorAll<SVGElement>('path, line, polyline, polygon, circle, ellipse, rect')) {
    if (el.closest('[data-icon], [data-logo]')) continue;
    const cs = getComputedStyle(el);
    if (!cs.stroke || cs.stroke === 'none') continue;
    const ws = (parseFloat(cs.strokeWidth) || 1) * s;
    if (ws > 6) continue;
    set(saved, el, { 'stroke-width': px(ws > 3.2 ? 1.5 : 1) });
  }

  for (const el of svg.querySelectorAll<SVGRectElement>('rect')) {
    if (el.closest('[data-icon], [data-logo]')) continue;
    const rx = parseFloat(getComputedStyle(el).rx as string) || parseFloat(el.getAttribute('rx') ?? '') || 0;
    if (!rx) continue;
    let w = 0, h = 0;
    try {
      const b = el.getBBox();
      w = b.width * s;
      h = b.height * s;
    } catch {}
    if (Math.max(w, h) < 14) continue;
    const cap = Math.min(rx * s, 3);
    set(saved, el, { rx: px(cap), ry: px(cap) });
  }

  const texts = [...svg.querySelectorAll<SVGTextElement>('text')].filter((t) => !t.closest('[data-icon], [data-logo]'));
  const widthOf = (t: SVGTextElement) => {
    try {
      return t.getComputedTextLength();
    } catch {
      return 0;
    }
  };
  const info = texts.map((t) => {
    const cs = getComputedStyle(t);
    return { t, size: parseFloat(cs.fontSize) || 15, bold: (parseInt(cs.fontWeight, 10) || 400) >= 600, width: widthOf(t) };
  });
  if (info.length) {
    const sizes = info.map((i) => i.size).sort((a, b) => a - b);
    const med = sizes[Math.floor(sizes.length / 2)]!;
    // The label step is the drawing's own median size, never shrunk; only a blown-up drawing (a
    // wide screen) is brought down, to 12.5 px.
    const L = Math.min(med, 12.5 / s);
    const mono = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';
    const sans = 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)';
    for (const { t, size, bold, width } of info) {
      let props: Record<string, string>;
      if (size >= med * 1.6) props = { 'font-family': sans, 'font-weight': '500', 'font-size': `${(L * 1.8).toFixed(3)}px`, 'letter-spacing': '-0.01em' };
      else if (bold || size >= med * 1.15) props = { 'font-family': sans, 'font-weight': '600', 'font-size': `${(L * 1.12).toFixed(3)}px`, 'letter-spacing': '0' };
      else if (size <= med * 0.85) props = { 'font-family': mono, 'font-weight': '400', 'font-size': `${(L * 0.88).toFixed(3)}px`, 'letter-spacing': '0' };
      else props = { 'font-family': mono, 'font-weight': '400', 'font-size': `${L.toFixed(3)}px`, 'letter-spacing': '0' };
      set(saved, t, props);
      for (const sp of t.querySelectorAll<SVGElement>('tspan')) set(saved, sp, { 'font-size': 'inherit', 'font-weight': 'inherit', 'font-family': 'inherit' });
      // Never wider than the drawer laid it out: a monospace or a larger step would run a label
      // into its neighbour or out of its box.
      const now = widthOf(t);
      if (width > 0 && now > width * 1.02) t.style.setProperty('font-size', `${(parseFloat(props['font-size']!) * Math.max(0.7, width / now)).toFixed(3)}px`);
    }
  }

  return () => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { el, props } = saved[i]!;
      for (const [p, v] of props) {
        if (v) el.style.setProperty(p, v);
        else el.style.removeProperty(p);
      }
    }
  };
}
