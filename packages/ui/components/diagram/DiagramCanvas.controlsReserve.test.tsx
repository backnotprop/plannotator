/**
 * The canvas measures its zoom strip and asks its host for room under the drawing, once, and the answer holds:
 * - a drawing that would reach the strip at rest asks for the strip's band (its height and margin), and stays at the
 *   scale Fit gives it;
 * - after the host grew the box by that much, the next fit (a resize, the Fit control) asks for nothing new, so the box
 *   does not grow and shrink in turn;
 * - a canvas whose host passes no reserve asks for nothing (the full-screen viewer, other hosts).
 *
 * happy-dom lays nothing out, so the browser's answer for the canvas and the strip is stood in: a 356 x 374 canvas
 * (the page's canvas for the 4-node flowchart on a 390 px phone) plus whatever the host added, and the strip 34 px
 * tall, 16 px in from its bottom left, as Chromium and WebKit draw it there. Nothing else is stood in.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { DiagramCanvas } = hasDom ? await import('./DiagramCanvas') : ({} as typeof import('./DiagramCanvas'));

let root: Root | null = null;
let mount: HTMLElement | null = null;
const ownRect = hasDom ? Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect') : undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  mount?.remove();
  mount = null;
  if (ownRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownRect);
});

/** The host's added room, as laid out: the canvas is 374 px plus this. */
let laidOut = 0;
function standInLayout(): void {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const height = 374 + laidOut;
      if (this.hasAttribute('data-diagram-canvas')) return new DOMRect(0, 0, 356, height);
      if (this.hasAttribute('data-diagram-zoom-strip')) return new DOMRect(16, height - 50, 94, 34);
      return new DOMRect(0, 0, 0, 0);
    },
  });
}

function drawing(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 267 328');
  return svg;
}

const asked: number[] = [];
function Host({ reserve, svg }: { reserve: boolean; svg: SVGSVGElement }) {
  const [px, setPx] = useState(0);
  laidOut = px;
  const props = {
    svgNode: svg,
    targetSelector: 'g',
    dimmed: false,
    onSvgRoot: () => {},
    onHoverElement: () => {},
    onClickElement: () => {},
    onEscape: () => 'pass' as const,
    overlay: () => null,
    fitMaxScale: 1,
  };
  return (
    <DiagramCanvas
      {...props}
      controlsReserve={reserve ? { px, onChange: (next: number) => { asked.push(next); setPx(next); } } : undefined}
    />
  );
}

async function show(reserve: boolean): Promise<void> {
  asked.length = 0;
  laidOut = 0;
  standInLayout();
  mount = document.createElement('div');
  document.body.appendChild(mount);
  root = createRoot(mount);
  await act(async () => root!.render(<Host reserve={reserve} svg={drawing()} />));
}

const transform = () => document.querySelector<HTMLElement>('[data-diagram-svg]')!.style.transform;
const fitButton = () => document.querySelector<HTMLButtonElement>('[data-diagram-zoom-strip] [aria-label="Fit diagram"]')!;

describe.if(hasDom)('DiagramCanvas keeps the drawing clear of its zoom strip', () => {
  test('asks once for the band under a drawing that reaches the strip, at the scale Fit gives, and the answer holds', async () => {
    await show(true);
    // The band: 34 px of strip and its 16 px margin.
    expect(asked).toEqual([50]);
    const scale = (374 - 48) / 328;
    // Centred in the 374 px above the strip, 24 px from its top, at the same scale.
    expect(transform()).toContain(`scale(${scale})`);
    expect(transform()).toContain('translate(');
    const y = Number(/translate\([^,]+,\s*([-\d.]+)px\)/u.exec(transform())![1]);
    expect(y + 328 * scale).toBeLessThanOrEqual(374 + 50 - 50);
    // The Fit control on the grown box: nothing new asked, the same place.
    const before = transform();
    await act(async () => fitButton().click());
    expect([asked, transform()]).toEqual([[50], before]);
  });

  test('a canvas whose host passes no reserve asks for nothing and fits as before', async () => {
    await show(false);
    expect(asked).toEqual([]);
    const scale = (374 - 48) / 328;
    expect(transform()).toContain(`scale(${scale})`);
  });
});
