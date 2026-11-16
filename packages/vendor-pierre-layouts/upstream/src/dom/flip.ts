import type { Rect } from '../types';

/**
 * FLIP animations of the layout's own elements. The view applies a change in
 * one step, then animates each element from its old box with a transform, so
 * that the compositor runs the animation and content lays out once. These
 * functions read and animate the DOM directly: the reads must happen before
 * the view applies the change, and the animations after it, in the same frame.
 */

// Elements that animate a layout change carry this attribute with a stable key.
export const FLIP_ATTRIBUTE = 'data-layout-flip';
/**
 * The elements that animate a layout change. They are children of the root,
 * so this does not walk the pane content, as a query of the subtree would,
 * and it does not find the elements of a layout inside a pane. A pane that
 * does not show (hidden, or a tab that is not active) does not render, so it
 * neither gives nor takes a FLIP box.
 */
function flipElements(root: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const { children } = root;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (
      child instanceof HTMLElement &&
      child.hasAttribute(FLIP_ATTRIBUTE) &&
      child.getAttribute('data-pane-hidden') !== 'true'
    )
      elements.push(child);
  }
  return elements;
}
const DEFAULT_DURATION_MS = 240;
// The ID of the layout's own animations, so that it never touches animations in pane content.
const FLIP_ANIMATION_ID = 'pierre-layout-flip';
// An ease-out curve, written as cubic-bezier: Safari runs `linear()` easing on the main thread.
const FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
// Keyframes of the inverse scale of a pane's content. The inverse of a linear
// scale is not linear, so it is sampled: 16 steps keep the content within a
// fraction of a pixel of its own size.
const COUNTER_SCALE_STEPS = 16;
// The inverse scale of the content of a pane that grows from a line has no
// useful bound near the start, and the compositor builds the content at that
// scale: a cap of 8 made the commit of each show wait about 10 ms with real
// content at 16 panes. The pane is narrow until it reaches half its size, in
// the first two frames, so its content is narrower than its own size then.
// Other animations keep the exact inverse, so that text keeps its shape.
const MAX_GROWTH_COUNTER_SCALE = 2;
// The width or height that a pane that shows again starts from. Not 0: a
// matrix with a scale of 0 cannot interpolate, so its animation would jump.
const GROWTH_START_PX = 1;

/** The layout's running FLIP animations; animations in pane content are not included. */
export function flipAnimations(root: HTMLElement): Animation[] {
  if (typeof root.getAnimations !== 'function') return [];
  return root
    .getAnimations({ subtree: true })
    .filter((animation) => animation.id === FLIP_ANIMATION_ID);
}

/** Stop the running animations, so that a new animation starts from the current boxes. */
export function cancelFlipAnimations(root: HTMLElement): void {
  for (const animation of flipAnimations(root)) animation.cancel();
}

/** Jump the running animations to their end, for example when the container resizes. */
export function finishFlipAnimations(root: HTMLElement): void {
  for (const animation of flipAnimations(root)) animation.finish();
}

/** Read the box of each animatable element, relative to the layout root, including running animations. */
export function readBoxes(root: HTMLElement): Map<string, Rect> {
  const bounds = root.getBoundingClientRect();
  const boxes = new Map<string, Rect>();
  for (const element of flipElements(root)) {
    const key = element.getAttribute(FLIP_ATTRIBUTE) ?? '';
    // The focus indicator shares the key of its pane and comes after it. Keep
    // the box of the pane, so that both elements animate from it.
    if (boxes.has(key)) continue;
    const box = element.getBoundingClientRect();
    boxes.set(key, {
      x: box.left - bounds.left,
      y: box.top - bounds.top,
      width: box.width,
      height: box.height,
    });
  }
  return boxes;
}

function durationOf(root: HTMLElement): number {
  const value = getComputedStyle(root).getPropertyValue('--layout-duration');
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return DEFAULT_DURATION_MS;
  return value.trim().endsWith('ms') ? parsed : parsed * 1000;
}

// The line between two edges that met, the one edge that exists, or a fallback.
function meet(low: number, high: number, fallback: number): number {
  if (low > -Infinity && high < Infinity) return (low + high) / 2;
  if (low > -Infinity) return low;
  if (high < Infinity) return high;
  return fallback;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

// True when two boxes share an area, not only an edge.
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

/**
 * The start box of a pane that shows again: one pixel wide or high, on the
 * line where the panes beside it met before it showed, so that it grows while
 * they move away, in reverse of a hide. The panes that give it their space
 * tell the axis: panes at its left or right after the change, or above or
 * below it.
 */
function growthStart(
  key: string,
  to: Rect,
  before: ReadonlyMap<string, Rect>,
  after: ReadonlyMap<string, Rect>
): Rect {
  let left = -Infinity;
  let right = Infinity;
  let top = -Infinity;
  let bottom = Infinity;
  for (const [other, from] of before) {
    const end = after.get(other);
    if (other === key || !other.startsWith('pane:') || end === undefined)
      continue;
    if (!overlap(from, to)) continue;
    if (end.x + end.width <= to.x + 0.5)
      left = Math.max(left, from.x + from.width);
    else if (end.x >= to.x + to.width - 0.5) right = Math.min(right, from.x);
    else if (end.y + end.height <= to.y + 0.5)
      top = Math.max(top, from.y + from.height);
    else if (end.y >= to.y + to.height - 0.5) bottom = Math.min(bottom, from.y);
  }
  if (left > -Infinity || right < Infinity) {
    const x = meet(left, right, to.x + to.width / 2);
    return {
      x: clamp(x, to.x, to.x + to.width - GROWTH_START_PX),
      y: to.y,
      width: GROWTH_START_PX,
      height: to.height,
    };
  }
  const y = meet(top, bottom, to.y + to.height / 2);
  return {
    x: to.x,
    y: clamp(y, to.y, to.y + to.height - GROWTH_START_PX),
    width: to.width,
    height: GROWTH_START_PX,
  };
}

/**
 * FLIP: each element already has its final geometry. Animate it from its old box
 * with a transform only. `transform-origin` is `0 0` on these elements. With
 * `counterScale`, the inner wrapper of a pane host gets the inverse of the
 * host's scale on each frame, so its header and content keep their shape and
 * the frame reveals or clips them, instead of stretching them. `growing` holds
 * the keys of panes that show again: they grow from a line (see `growthStart`).
 */
export function animateFromBoxes(
  root: HTMLElement,
  before: ReadonlyMap<string, Rect>,
  counterScale: boolean,
  growing: ReadonlySet<string> = new Set()
): void {
  const duration = durationOf(root);
  const bounds = root.getBoundingClientRect();
  // Read every box before the first animation starts: a new animation dirties
  // style, and a read after it would force another layout.
  const elements = flipElements(root).map((element) => {
    const box = element.getBoundingClientRect();
    return {
      element,
      key: element.getAttribute(FLIP_ATTRIBUTE) ?? '',
      to: {
        x: box.left - bounds.left,
        y: box.top - bounds.top,
        width: box.width,
        height: box.height,
      },
    };
  });
  // The box of each key after the change. The focus indicator comes after its
  // pane, so the pane's box is kept.
  const after = new Map<string, Rect>();
  for (const { key, to } of elements) if (!after.has(key)) after.set(key, to);
  const plans: {
    element: HTMLElement;
    start: DOMMatrix;
    end: DOMMatrix;
    grows: boolean;
  }[] = [];
  for (const { element, key, to } of elements) {
    // A new element has no old box, and appears in place. A pane that shows
    // again has none either, and grows into its place.
    const grows = !before.has(key) && growing.has(key);
    const from = grows ? growthStart(key, to, before, after) : before.get(key);
    if (from === undefined) continue;
    if (
      Math.abs(from.x - to.x) < 0.5 &&
      Math.abs(from.y - to.y) < 0.5 &&
      Math.abs(from.width - to.width) < 0.5 &&
      Math.abs(from.height - to.height) < 0.5
    )
      continue;
    if (to.width === 0 || to.height === 0) continue;
    // The element's own transform, for example the translate of a covered pane,
    // is the end of the animation. Its layout box is the box without it.
    const own = getComputedStyle(element).transform;
    const end = own === 'none' ? new DOMMatrix() : new DOMMatrix(own);
    const start = new DOMMatrix([
      from.width / to.width,
      0,
      0,
      from.height / to.height,
      from.x - (to.x - end.e),
      from.y - (to.y - end.f),
    ]);
    plans.push({ element, start, end, grows });
  }
  const timing: KeyframeAnimationOptions = {
    duration,
    easing: FLIP_EASING,
    id: FLIP_ANIMATION_ID,
  };
  for (const { element, start, end, grows } of plans) {
    element.animate(
      [{ transform: start.toString() }, { transform: end.toString() }],
      timing
    );
    const inner = counterScale
      ? element.querySelector<HTMLElement>(':scope > .pierre-layout-pane-inner')
      : null;
    if (inner === null || (start.a === end.a && start.d === end.d)) continue;
    // Both animations share the timing, so at each eased progress the host's
    // scale is the linear mix of its keyframes, and the inner scale undoes it.
    const cap = grows ? MAX_GROWTH_COUNTER_SCALE : Infinity;
    const frames: Keyframe[] = [];
    for (let step = 0; step <= COUNTER_SCALE_STEPS; step++) {
      const progress = step / COUNTER_SCALE_STEPS;
      const x = start.a + (end.a - start.a) * progress;
      const y = start.d + (end.d - start.d) * progress;
      frames.push({
        offset: progress,
        transform: `scale(${Math.min(end.a / x, cap)}, ${Math.min(end.d / y, cap)})`,
      });
    }
    inner.animate(frames, timing);
  }
}
