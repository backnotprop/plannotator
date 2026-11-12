import { afterEach, describe, expect, test } from 'bun:test';
import type { ShapeExample, ShapeExampleStep } from '@plannotator/core/shape';
import type { ShapeScene } from '@plannotator/core/shape-scene';

const hasDom = typeof document !== 'undefined';
const { FollowPainter } = (hasDom ? await import('./followPainter') : {}) as typeof import('./followPainter');
const { SceneDom } = (hasDom ? await import('./scene/dom') : {}) as typeof import('./scene/dom');
const { outlineOf } = (hasDom ? await import('./litLine') : {}) as typeof import('./litLine');

const SVG = 'http://www.w3.org/2000/svg';
const real = hasDom ? Element.prototype.getBoundingClientRect : null;
const rects = new Map<Element, [number, number, number, number]>();

function standInLayout() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const [l, t, w, h] = rects.get(this) ?? [0, 0, 0, 0];
    return new DOMRect(l, t, w, h);
  };
}

function board() {
  const host = document.createElement('div');
  document.body.append(host);
  const b = document.createElement('div');
  b.className = 'board';
  host.attachShadow({ mode: 'open' }).append(b);
  Object.defineProperty(b, 'offsetWidth', { configurable: true, get: () => 800 });
  rects.set(b, [0, 0, 800, 400]);
  const svg = document.createElementNS(SVG, 'svg');
  const g = document.createElementNS(SVG, 'g');
  g.setAttribute('data-mark', 'drawn');
  const box = document.createElementNS(SVG, 'rect');
  box.setAttribute('style', 'fill:var(--paper);stroke:var(--ink2)');
  box.setAttribute('stroke-width', '1.5');
  const words = document.createElementNS(SVG, 'text');
  words.textContent = 'Is the text whole?';
  g.append(box, words);
  svg.append(g);
  rects.set(g, [10, 10, 200, 64]);
  rects.set(box, [10, 10, 200, 64]);
  rects.set(words, [24, 20, 120, 16]);
  const bordered = document.createElement('div');
  bordered.setAttribute('data-mark', 'bordered');
  bordered.style.border = '1px solid #333';
  rects.set(bordered, [300, 10, 200, 64]);
  const plain = document.createElement('div');
  plain.setAttribute('data-mark', 'plain');
  rects.set(plain, [300, 200, 200, 64]);
  b.append(svg, bordered, plain);
  return { b, g, box, bordered, plain };
}

const step = (part: string): ShapeExampleStep => ({ part, tag: part, text: `It reaches ${part}` }) as ShapeExampleStep;
const EXAMPLE = { name: 'All', title: 'Through all', steps: [step('drawn'), step('bordered'), step('plain')] } as ShapeExample;

afterEach(() => {
  if (real) Element.prototype.getBoundingClientRect = real;
  rects.clear();
  document.body.innerHTML = '';
});

describe.skipIf(!hasDom)('a lit part shows one border', () => {
  test("an SVG part's line is the stroked box that spans it, not an icon or rule inside it", () => {
    standInLayout();
    const { g, box } = board();
    const rule = document.createElementNS(SVG, 'rect');
    rule.setAttribute('stroke', '#999');
    g.append(rule);
    rects.set(rule, [20, 50, 100, 1]);
    expect(outlineOf(g)).toBe(box);
    box.setAttribute('style', 'fill:var(--paper);stroke:none');
    expect(outlineOf(g)).toBe(null);
  });

  test('Follow an example: a part with its own line has no ring line; that line is marked to take the mark colour', () => {
    standInLayout();
    const { b, box, bordered, plain } = board();
    const painter = new FollowPainter(b, EXAMPLE);
    try {
      painter.set(null, 'fwd', true);
      const ring = (i: number) => b.querySelectorAll<HTMLElement>('.shp-ex-ring')[i]!;
      expect(ring(0).classList.contains('own')).toBe(true);
      expect(box.hasAttribute('data-ex-own')).toBe(true);
      expect(box.getAttribute('data-ex-s')).toBe('on');
      expect(ring(1).classList.contains('own')).toBe(true);
      expect(bordered.getAttribute('data-ex-s')).toBe('on');
      expect(ring(2).classList.contains('own')).toBe(false);
      expect(plain.hasAttribute('data-ex-own')).toBe(false);
      painter.set(0, 'fwd', true);
      expect(box.getAttribute('data-ex-s')).toBe('now');
      expect(bordered.getAttribute('data-ex-s')).toBe('later');
    } finally {
      painter.destroy();
    }
    expect(box.hasAttribute('data-ex-own')).toBe(false);
    expect(box.hasAttribute('data-ex-s')).toBe(false);
  });

  test("a lit scene piece in the technical look recolours its own stroke and border, and puts them back", () => {
    standInLayout();
    const slot = document.createElement('div');
    document.body.append(slot);
    const svg = document.createElementNS(SVG, 'svg');
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('data-part', 'box');
    const shape = document.createElementNS(SVG, 'rect');
    shape.setAttribute('style', 'stroke:var(--ink2)');
    const blob = document.createElementNS(SVG, 'circle');
    blob.setAttribute('style', 'fill:var(--blue)');
    const words = document.createElementNS(SVG, 'text');
    words.textContent = 'words';
    g.append(shape, blob, words);
    const card = document.createElement('div');
    card.setAttribute('data-part', 'card');
    card.style.borderWidth = '1px';
    card.style.borderStyle = 'solid';
    svg.append(g);
    slot.append(svg, card);
    const scene = { end: 1, tracks: { box: [{ at: 0, lit: true }], card: [{ at: 0, lit: true }] } } as unknown as ShapeScene;
    const dom = new SceneDom(slot, scene, 'drop-shadow(0 0 .6px var(--mark))', true);
    dom.measure();
    dom.apply(0.5);
    expect(shape.style.stroke).toBe('var(--mark)');
    expect(shape.style.filter).toBe('');
    expect(blob.style.filter).toContain('drop-shadow');
    expect(card.style.borderColor).toBe('var(--mark)');
    expect(card.style.filter).toBe('');
    dom.restore();
    expect(shape.style.stroke).toBe('var(--ink2)');
    expect(blob.style.filter).toBe('');
    expect(card.style.borderColor).toBe('');
  });
});
