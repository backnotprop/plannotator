/**
 * The Inbox's image viewer zooms and pans like the lightbox (ui's
 * ImageZoomStage): Ctrl/⌘ + wheel and a pinch about the pointer, a plain
 * wheel, drag, double click, Fit / Actual size with the scale beside them, a
 * comment's drawing kept in the image's transform, Fit for tall and wide
 * images, the swipe that steps only at Fit, and what a phone's follow swipe
 * asks the image (pan to the edge first, a drag down only at Fit). The keys (← → always step)
 * are in attachmentStepping.test.tsx; the real browser proof is
 * tests/e2e/inbox-image-zoom.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * happy-dom has no layout, so the stage's box and the image's own size are
 * given here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
const { ImageAttachmentView } = (hasDom ? await import('./components/ImageAttachmentView') : {}) as typeof import('./components/ImageAttachmentView');
type ImageSwipeEdges = import('./components/ImageAttachmentView').ImageSwipeEdges;

let root: Root | null = null;
let host: HTMLElement | null = null;
let was = '';
const happy = () => (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;

beforeEach(() => {
  if (!hasDom) return;
  // happy-dom answers a relative src with an error on about:blank: give the page an address.
  was = location.href;
  happy().setURL('http://localhost:4000/');
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.replaceChildren();
  happy().setURL(was);
});

const shot: InboxAttachmentState = {
  id: 'att_01K7ZOOMZOOMZOOMZOOMZOOMZO',
  name: 'checkout.png',
  path: '/work/shop/checkout.png',
  kind: 'image',
  named_path: null,
  sent_sha256: 'a'.repeat(64),
  size: 1000,
  sent_at: '2026-10-10T10:42:00.000Z',
  sent_mtime: '2026-10-10T10:42:00.000Z',
  message_id: 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM',
  changed_since_sent: false,
  unavailable: null,
  current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
  media_type: 'image/png',
};

const marked: Annotation = {
  id: 'ann-img-1',
  blockId: 'image',
  startOffset: 0,
  endOffset: 0,
  type: 'COMMENT' as Annotation['type'],
  text: 'Move this button',
  originalText: 'checkout.png',
  createdA: 0,
  images: [{ path: '/tmp/inbox/markups/abc.png', name: 'checkout, marked up' }],
};

type Props = Partial<React.ComponentProps<typeof ImageAttachmentView>>;

async function mount(props: Props = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<ImageAttachmentView attachment={shot} version="current" annotations={[]} selectedId={null} readOnly={false} onSave={async () => true} onError={() => {}} {...props} />);
  });
}

async function rerender(props: Props) {
  await act(async () => {
    root!.render(<ImageAttachmentView attachment={shot} version="current" annotations={[]} selectedId={null} readOnly={false} onSave={async () => true} onError={() => {}} {...props} />);
  });
}

/** Give the zoom stage a 1000 × 600 box and the image its own size (2000 × 1000 by default: Fit is 50%), then load it. */
async function load(width = 2000, height = 1000) {
  const stage = host!.querySelector<HTMLElement>('[data-image-zoom-stage]')!;
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: height });
  await act(async () => {
    img.dispatchEvent(new Event('load'));
  });
  return { stage, img };
}

function view(el: HTMLElement) {
  const m = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`no transform: ${el.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

async function wheel(stage: HTMLElement, deltaY: number, init: { ctrlKey?: boolean; metaKey?: boolean; x?: number; y?: number } = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clientX', { value: init.x ?? 500 });
  Object.defineProperty(event, 'clientY', { value: init.y ?? 300 });
  Object.defineProperty(event, 'ctrlKey', { value: !!init.ctrlKey });
  Object.defineProperty(event, 'metaKey', { value: !!init.metaKey });
  Object.defineProperty(event, 'shiftKey', { value: false });
  await act(async () => {
    stage.dispatchEvent(event);
  });
  return event;
}

async function pointer(stage: HTMLElement, type: string, id: number, x: number, y: number, pointerType = 'mouse') {
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true }));
  });
}

const zoomText = () => host!.querySelector('[data-image-zoom]')?.textContent?.replace(/^Zoom /, '') ?? null;
const fitButton = () => host!.querySelector<HTMLButtonElement>('[data-image-fit]')!;
const outer = () => host!.querySelector<HTMLElement>('.ib-imgstage')!;

describe.if(hasDom)('the Inbox image viewer zooms', () => {
  test('opens at Fit with the scale beside Actual size; Ctrl/⌘ + wheel zooms about the pointer', async () => {
    await mount();
    const { stage, img } = await load();
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
    expect(zoomText()).toBe('50%');
    expect(fitButton().textContent).toBe('Actual size');
    const before = view(img);
    const imageX = (700 - before.x) / before.scale;
    const event = await wheel(stage, -100, { ctrlKey: true, x: 700, y: 200 });
    expect(event.defaultPrevented).toBe(true);
    const after = view(img);
    expect(after.scale).toBeGreaterThan(0.6);
    // The pixel under the pointer stays under it (across; down, the taller image now covers the stage).
    expect(after.x + imageX * after.scale).toBeCloseTo(700, 5);
    expect(outer().getAttribute('data-fit')).toBe('zoom');
    expect(zoomText()).toBe(`${Math.round(after.scale * 100)}%`);
    expect(fitButton().textContent).toBe('Fit');
    await wheel(stage, -100, { metaKey: true });
    expect(view(img).scale).toBeGreaterThan(after.scale);
  });

  test('stops at Fit and at 800%; a plain wheel zooms an image that fits and scrolls one that does not', async () => {
    await mount();
    const { stage, img } = await load();
    for (let i = 0; i < 10; i += 1) await wheel(stage, 100, { ctrlKey: true });
    expect(view(img).scale).toBe(0.5);
    expect(outer().getAttribute('data-fit')).toBe('fit');
    for (let i = 0; i < 40; i += 1) await wheel(stage, -100, { ctrlKey: true });
    expect(view(img).scale).toBe(8);
    expect(zoomText()).toBe('800%');
    await act(async () => fitButton().click());
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
    await wheel(stage, -100);
    expect(view(img).scale).toBeGreaterThan(0.5);
  });

  test('Actual size and Fit reset it; the pane is told only Fit or Actual size; drag pans', async () => {
    const told: string[] = [];
    await mount({ onFitChange: (fit) => told.push(fit) });
    const { stage, img } = await load();
    await act(async () => fitButton().click());
    expect(view(img)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(outer().getAttribute('data-fit')).toBe('actual');
    expect(zoomText()).toBe('100%');
    await pointer(stage, 'pointerdown', 1, 500, 300);
    await pointer(stage, 'pointermove', 1, 400, 250);
    await pointer(stage, 'pointerup', 1, 400, 250);
    expect(view(img)).toEqual({ x: -100, y: -50, scale: 1 });
    // A gesture's zoom is remembered as Fit (the next visit opens at Fit).
    await wheel(stage, -50, { ctrlKey: true });
    expect(outer().getAttribute('data-fit')).toBe('zoom');
    await act(async () => fitButton().click());
    expect(view(img)).toEqual({ x: 0, y: 50, scale: 0.5 });
    expect(told).toEqual(['actual', 'fit']);
  });

  test('opens at Actual size when the pane remembered it', async () => {
    await mount({ initialFit: 'actual' });
    const { img } = await load();
    expect(view(img)).toEqual({ x: 0, y: 0, scale: 1 });
    expect(fitButton().textContent).toBe('Fit');
  });

  test('a double click toggles Fit and twice Fit; two fingers pinch; one finger pans a zoomed image', async () => {
    await mount();
    const { stage, img } = await load();
    for (let i = 0; i < 2; i += 1) {
      await pointer(stage, 'pointerdown', 1, 500, 300);
      await pointer(stage, 'pointerup', 1, 500, 300);
    }
    expect(view(img).scale).toBe(1);
    for (let i = 0; i < 2; i += 1) {
      await pointer(stage, 'pointerdown', 1, 500, 300);
      await pointer(stage, 'pointerup', 1, 500, 300);
    }
    expect(view(img).scale).toBe(0.5);
    // Two fingers 200 px apart spread to 400 px: twice the scale.
    await pointer(stage, 'pointerdown', 1, 400, 300, 'touch');
    await pointer(stage, 'pointerdown', 2, 600, 300, 'touch');
    await pointer(stage, 'pointermove', 1, 300, 300, 'touch');
    await pointer(stage, 'pointermove', 2, 700, 300, 'touch');
    await pointer(stage, 'pointerup', 1, 300, 300, 'touch');
    await pointer(stage, 'pointerup', 2, 700, 300, 'touch');
    expect(view(img).scale).toBeCloseTo(1, 5);
    const zoomed = view(img);
    await pointer(stage, 'pointerdown', 3, 500, 300, 'touch');
    await pointer(stage, 'pointermove', 3, 440, 260, 'touch');
    await pointer(stage, 'pointerup', 3, 440, 260, 'touch');
    expect(view(img).x).toBeCloseTo(zoomed.x - 60, 5);
    expect(view(img).y).toBeCloseTo(zoomed.y - 40, 5);
  });

  test('a comment\'s drawing lies over the image in its transform, at any zoom and pan', async () => {
    await mount({ annotations: [marked], selectedId: null });
    const { stage, img } = await load();
    await wheel(stage, -100, { ctrlKey: true, x: 300, y: 200 });
    await rerender({ annotations: [marked], selectedId: marked.id });
    expect(host!.querySelector('[data-showing-markup]')).not.toBeNull();
    const layer = host!.querySelector<HTMLElement>('[data-zoom-overlay]')!;
    const drawing = layer.querySelector<HTMLImageElement>('[data-markup-overlay]')!;
    expect(drawing.getAttribute('src')).toContain('abc.png');
    // The same size and the same transform as the image (not reset to Fit).
    expect(layer.style.width).toBe('2000px');
    expect(layer.style.height).toBe('1000px');
    expect(layer.style.transform).toBe(img.style.transform);
    expect(view(img).scale).toBeGreaterThan(0.5);
    await wheel(stage, -100, { ctrlKey: true, x: 800, y: 400 });
    await pointer(stage, 'pointerdown', 1, 500, 300);
    await pointer(stage, 'pointermove', 1, 420, 330);
    await pointer(stage, 'pointerup', 1, 420, 330);
    expect(layer.style.transform).toBe(img.style.transform);
    // "Show the image" takes the drawing away; the zoom stays.
    const zoom = img.style.transform;
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-showing-markup] button')!.click());
    expect(host!.querySelector('[data-zoom-overlay]')).toBeNull();
    expect(img.style.transform).toBe(zoom);
  });

  test('a tall screenshot fits its width from the top, a panorama its height from the left; both pinch out to the whole image', async () => {
    await mount();
    const tall = await load(500, 3000);
    // Width fit: 1000 / 500 is above 1, so its own size, from the top.
    expect(view(tall.img)).toEqual({ x: 250, y: 0, scale: 1 });
    for (let i = 0; i < 30; i += 1) await wheel(tall.stage, 100, { ctrlKey: true });
    expect(view(tall.img).scale).toBeCloseTo(0.2, 5);
    await act(async () => root!.unmount());
    root = null;
    host!.remove();
    await mount();
    const wide = await load(6000, 1000);
    expect(outer().getAttribute('data-wide')).toBe('true');
    expect(view(wide.img)).toEqual({ x: 0, y: 0, scale: 0.6 });
  });

  test('what a phone\'s swipe asks the image (approval "inbox-image-swipe"): zoomed, it pans to its edge before a swipe steps; a drag down closes only at Fit', async () => {
    const edges: { current: ImageSwipeEdges | null } = { current: null };
    let shown = 0;
    await mount({ edgesRef: edges, onShown: () => shown++ });
    expect(shown).toBe(0);
    const { stage } = await load();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // Loaded and laid out: a swipe's picture of it can go.
    expect(shown).toBe(1);
    // At Fit the whole image shows: a swipe either way steps, and a drag down closes.
    expect(edges.current!.keeps(1)).toBe(false);
    expect(edges.current!.keeps(-1)).toBe(false);
    expect(edges.current!.canDismiss()).toBe(true);
    // Zoomed about the middle: more to see both ways, so a swipe pans; a drag down pans too.
    await wheel(stage, -100, { ctrlKey: true });
    expect(edges.current!.keeps(1)).toBe(true);
    expect(edges.current!.keeps(-1)).toBe(true);
    expect(edges.current!.canDismiss()).toBe(false);
    // Panned to its right edge: the next swipe toward more of the right steps; back toward the left still pans.
    await pointer(stage, 'pointerdown', 1, 900, 300);
    await pointer(stage, 'pointermove', 1, -3000, 300);
    await pointer(stage, 'pointerup', 1, -3000, 300);
    expect(edges.current!.keeps(1)).toBe(false);
    expect(edges.current!.keeps(-1)).toBe(true);
    await act(async () => fitButton().click());
    expect(edges.current!.keeps(1)).toBe(false);
    expect(edges.current!.canDismiss()).toBe(true);
    act(() => root!.unmount());
    root = null;
    host!.remove();
    // A panorama at Fit reads from its left edge: a swipe toward more of it pans first, back the other way steps.
    await mount({ edgesRef: edges });
    await load(6000, 1000);
    expect(edges.current!.keeps(1)).toBe(true);
    expect(edges.current!.keeps(-1)).toBe(false);
  });

  test('a horizontal swipe steps only at Fit; a second finger is never a swipe', async () => {
    const swipes: number[] = [];
    await mount({ onSwipe: (dir) => swipes.push(dir) });
    const { stage } = await load();
    const touch = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 1, target: stage }) as unknown as Touch;
    const swipe = async (fromX: number, toX: number) => {
      await act(async () => {
        const start = new TouchEvent('touchstart', { bubbles: true });
        Object.defineProperty(start, 'touches', { value: [touch(fromX, 300)] });
        stage.dispatchEvent(start);
        const end = new TouchEvent('touchend', { bubbles: true });
        Object.defineProperty(end, 'touches', { value: [] });
        Object.defineProperty(end, 'changedTouches', { value: [touch(toX, 300)] });
        stage.dispatchEvent(end);
      });
    };
    await swipe(700, 500);
    expect(swipes).toEqual([1]);
    await wheel(stage, -100, { ctrlKey: true });
    await swipe(700, 500);
    expect(swipes).toEqual([1]);
    await act(async () => fitButton().click());
    await act(async () => {
      const start = new TouchEvent('touchstart', { bubbles: true });
      Object.defineProperty(start, 'touches', { value: [touch(700, 300)] });
      stage.dispatchEvent(start);
      const move = new TouchEvent('touchmove', { bubbles: true });
      Object.defineProperty(move, 'touches', { value: [touch(690, 300), touch(400, 300)] });
      stage.dispatchEvent(move);
      const end = new TouchEvent('touchend', { bubbles: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [touch(400, 300)] });
      stage.dispatchEvent(end);
    });
    expect(swipes).toEqual([1]);
  });

  test('the stage padding is read again when the phone breakpoint is crossed, and Fit refits to it', async () => {
    const listeners: (() => void)[] = [];
    const realMatch = window.matchMedia;
    const realStyle = window.getComputedStyle;
    let padding = '0px';
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    window.getComputedStyle = ((el: Element) => {
      const style = realStyle(el);
      if (!(el as HTMLElement).classList?.contains('ib-imgstage')) return style;
      return new Proxy(style, { get: (target, key) => (key === 'paddingTop' ? padding : Reflect.get(target, key)) });
    }) as typeof window.getComputedStyle;
    try {
      await mount();
      const { img } = await load();
      expect(view(img).scale).toBe(0.5);
      // A phone-sized window: 100 px of padding on every side leaves 800 × 400 for Fit.
      padding = '100px';
      await act(async () => {
        for (const fn of listeners) fn();
      });
      expect(view(img)).toEqual({ x: 100, y: 100, scale: 0.4 });
    } finally {
      window.matchMedia = realMatch;
      window.getComputedStyle = realStyle;
    }
  });

  test('Ctrl + wheel over the size bar never zooms the page', async () => {
    await mount();
    await load();
    const bar = host!.querySelector<HTMLElement>('.ib-imgbar')!;
    const event = await wheel(bar, -100, { ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
  });
});
