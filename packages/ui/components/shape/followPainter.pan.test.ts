/**
 * "Follow an example" on a drawing that pans (a wide canvas on a phone). DOM-gated (tests/dom-test-list.txt).
 * What regresses: a tag whose part is off screen is pulled into the slice that shows now, onto another
 * part, and stays there when the person pans to its part. Tags live in the scrolling drawing, so each
 * belongs beside its own part, anywhere inside the drawing's box.
 *
 * Layout is stood in for (happy-dom has none): the drawing is scaled by 0.5 to 700 × 300 px on screen,
 * and the frame shows its first 390 px.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ShapeExample, ShapeExampleStep } from '@plannotator/core/shape';

const hasDom = typeof document !== 'undefined';
const { FollowPainter } = (hasDom ? await import('./followPainter') : {}) as typeof import('./followPainter');

const K = 0.5;
const TAG = { w: 60, h: 16 };
type Rect = { left: number; top: number; width: number; height: number };
const rects = new Map<Element, Rect>();
const real = hasDom ? HTMLElement.prototype.getBoundingClientRect : null;

/** The drawing's parts in its own coordinates (1400 × 600), on screen at K. */
const PARTS = { near: [100, 100, 200, 60], far: [1100, 100, 200, 60] } as const;

function world(pans: boolean) {
  const view = document.createElement('div');
  view.className = 'shp-view';
  const frame = document.createElement('div');
  frame.className = `shp-drawn canvas${pans ? ' pan' : ''}`;
  const fit = document.createElement('div');
  fit.className = 'shp-drawn-fit';
  const host = document.createElement('div');
  view.append(frame);
  frame.append(fit);
  fit.append(host);
  document.body.append(view);
  const shadow = host.attachShadow({ mode: 'open' });
  const board = document.createElement('div');
  board.className = 'board';
  shadow.append(board);
  Object.defineProperty(board, 'offsetWidth', { configurable: true, get: () => 1400 });
  Object.defineProperty(view, 'clientWidth', { configurable: true, get: () => 390 });
  rects.set(board, { left: 0, top: 0, width: 700, height: 300 });
  rects.set(fit, { left: 0, top: 0, width: 700, height: 300 });
  rects.set(frame, { left: 0, top: 0, width: 390, height: 600 });
  rects.set(view, { left: 0, top: 0, width: 390, height: 800 });
  for (const [id, [x, y, w, h]] of Object.entries(PARTS)) {
    const part = document.createElement('div');
    part.setAttribute('data-mark', id);
    board.append(part);
    rects.set(part, { left: x * K, top: y * K, width: w * K, height: h * K });
  }
  return board;
}

/** A tag on screen: its anchor (style left/top, in the drawing's coordinates) and its class's offset. */
function tagRect(tag: HTMLElement): Rect {
  const ax = parseFloat(tag.style.left) * K;
  const ay = parseFloat(tag.style.top) * K;
  if (tag.classList.contains('top')) return { left: ax - TAG.w, top: ay - TAG.h - 4, width: TAG.w, height: TAG.h };
  if (tag.classList.contains('bottom')) return { left: ax - TAG.w, top: ay - TAG.h / 2, width: TAG.w, height: TAG.h };
  return { left: ax, top: ay, width: TAG.w, height: TAG.h };
}

function standInLayout() {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const r = this.classList.contains('shp-ex-tag') ? tagRect(this) : rects.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
    return new DOMRect(r.left, r.top, r.width, r.height);
  };
}

const step = (part: string): ShapeExampleStep => ({ part, tag: `at ${part}`, text: `It reaches ${part}` }) as ShapeExampleStep;
const EXAMPLE = { name: 'It ends', title: 'Through both', steps: [step('near'), step('far')] } as ShapeExample;
const tagOf = (board: HTMLElement, i: number) => board.querySelector<HTMLElement>(`.shp-ex-tag[data-ex-i="${i}"]`)!;

afterEach(() => {
  if (real) HTMLElement.prototype.getBoundingClientRect = real;
  rects.clear();
  document.body.innerHTML = '';
});

describe.skipIf(!hasDom)('Follow tags on a drawing that pans', () => {
  test('a tag whose part is off screen stays beside its part, not in the slice that shows', () => {
    standInLayout();
    const board = world(true);
    const painter = new FollowPainter(board, EXAMPLE);
    try {
      const far = tagOf(board, 1);
      // Right-aligned 12 px inside its part's right edge (1300), above it: where it would sit on a wide screen.
      expect(parseFloat(far.style.left)).toBe(1300 - 12);
      expect(far.classList.contains('top')).toBe(true);
      const near = tagOf(board, 0);
      expect(parseFloat(near.style.left)).toBe(300 - 12);
    } finally {
      painter.destroy();
    }
  });

  test('a tag still stays inside the drawing: one that would run past its edge comes back in', () => {
    standInLayout();
    const board = world(true);
    const edge = document.createElement('div');
    edge.setAttribute('data-mark', 'edge');
    board.append(edge);
    // A part flush with the drawing's right edge: its tag's right end would sit 6 px from it, inside the 8 px margin.
    rects.set(edge, { left: 700 - 30, top: 400 * K, width: 30, height: 30 });
    const painter = new FollowPainter(board, { ...EXAMPLE, steps: [step('edge')] });
    try {
      const r = tagOf(board, 0).getBoundingClientRect();
      expect(r.right).toBeLessThanOrEqual(700 - 8 + 0.5);
      expect(r.top).toBeGreaterThanOrEqual(0);
    } finally {
      painter.destroy();
    }
  });
});
