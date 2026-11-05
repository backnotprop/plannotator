import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEdgeSwipe } from './useEdgeSwipe';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) window.getSelection()?.removeAllRanges();
});

function touch(target: Element, type: string, x: number, y = 100, fingers = 1) {
  const point = { identifier: 7, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : Array(fingers).fill(point) },
    changedTouches: { value: [point] },
  });
  target.dispatchEvent(event);
  return event;
}

async function mount() {
  const opened: string[] = [];
  function Harness({ enabled = true, side }: { enabled?: boolean; side?: 'left' | 'right' }) {
    useEdgeSwipe({
      enabled, onOpenLeft: () => opened.push('left'), onOpenRight: () => opened.push('right'),
      panel: side ? { side, selector: '#test-panel', onClose: () => opened.push('closed') } : undefined,
    });
    return <main data-pn-compact-touch-layout="true"><p>Review text</p><textarea />
      {side && <section id="test-panel" role="dialog" aria-modal="true"><p>Panel text</p><textarea /></section>}
    </main>;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  return { opened, target: host.querySelector('p')!, Harness };
}

describe.skipIf(!hasDom)('compact panel edge swipes', () => {
  for (const side of ['left', 'right'] as const) {
    test(`${side} panel: an outward swipe from its center dismisses only on release`, async () => {
      const { opened, target, Harness } = await mount();
      await act(async () => root?.render(<Harness side={side} />));
      const panel = host!.querySelector('#test-panel p')!;
      const end = side === 'left' ? 100 : 300;
      // The artifact underneath the panel never handles its closing gesture.
      touch(target, 'touchstart', 200);
      expect(touch(target, 'touchmove', end).defaultPrevented).toBe(false);
      touch(target, 'touchend', end);
      expect(opened).toEqual([]);
      touch(panel, 'touchstart', 200);
      expect(touch(panel, 'touchmove', end).defaultPrevented).toBe(true);
      expect(opened).toEqual([]);
      touch(panel, 'touchend', end);
      expect(opened).toEqual(['closed']);
    });

    test(`${side} panel: wrong direction, scrolling, short drags and cancelled touches do not dismiss`, async () => {
      const { opened, Harness } = await mount();
      await act(async () => root?.render(<Harness side={side} />));
      const panel = host!.querySelector('#test-panel p')!;
      const end = side === 'left' ? 100 : 300;
      for (const reason of ['inward', 'vertical', 'short', 'cancel', 'multitouch']) {
        const direction = side === 'left' ? -1 : 1;
        const distance = reason === 'inward' ? -100 : reason === 'short' ? 30 : 100;
        const x = 200 + direction * distance;
        const y = reason === 'vertical' ? 250 : 100;
        touch(panel, 'touchstart', 200);
        touch(panel, 'touchmove', x, y);
        if (reason === 'cancel') touch(panel, 'touchcancel', x, y);
        if (reason === 'multitouch') touch(panel, 'touchmove', x, y, 2);
        touch(panel, 'touchend', x, y);
      }
      expect(opened).toEqual([]);
    });

    test(`${side} panel: input, horizontal scroll, selection and nested modals retain ownership`, async () => {
      const { opened, Harness } = await mount();
      await act(async () => root?.render(<Harness side={side} />));
      const panel = host!.querySelector('#test-panel')!;
      const text = panel.querySelector('p')!;
      const end = side === 'left' ? 100 : 300;
      const swipe = (element: Element) => {
        touch(element, 'touchstart', 200);
        expect(touch(element, 'touchmove', end).defaultPrevented).toBe(false);
        touch(element, 'touchend', end);
      };
      swipe(panel.querySelector('textarea')!);
      text.style.overflowX = 'auto';
      Object.defineProperties(text, { scrollWidth: { value: 800 }, clientWidth: { value: 300 } });
      text.scrollLeft = 100;
      swipe(text);
      text.style.overflowX = 'visible';
      const range = document.createRange();
      range.selectNodeContents(text);
      window.getSelection()!.addRange(range);
      swipe(text);
      window.getSelection()!.removeAllRanges();
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      panel.appendChild(modal);
      swipe(text);
      modal.remove();
      touch(text, 'touchstart', 200);
      touch(text, 'touchmove', end);
      panel.appendChild(modal);
      touch(text, 'touchend', end);
      expect(opened).toEqual([]);
    });
  }

  test('opening a panel cancels an unfinished edge gesture', async () => {
    const { opened, target, Harness } = await mount();
    touch(target, 'touchstart', 8);
    touch(target, 'touchmove', 90);
    await act(async () => root?.render(<Harness side="right" />));
    touch(target, 'touchend', 90);
    expect(opened).toEqual([]);
  });

  test('opens the corresponding side only after a completed inward edge swipe', async () => {
    const { opened, target } = await mount();
    for (const [x, end, side] of [[8, 90, 'left'], [window.innerWidth - 8, window.innerWidth - 90, 'right']] as const) {
      touch(target, 'touchstart', x);
      expect(touch(target, 'touchmove', end).defaultPrevented).toBe(true);
      expect(opened).not.toContain(side);
      touch(target, 'touchend', end);
    }
    expect(opened).toEqual(['left', 'right']);
  });

  test('leaves center swipes, vertical scrolling, outward and short drags alone', async () => {
    const { opened, target } = await mount();
    for (const [x, mx, my] of [[100, 180, 100], [8, 10, 150], [8, -50, 100], [8, 35, 100]]) {
      touch(target, 'touchstart', x);
      const move = touch(target, 'touchmove', mx, my);
      if (mx !== 35) expect(move.defaultPrevented).toBe(false);
      // A vertical gesture cannot turn into a panel swipe later.
      if (my === 150) touch(target, 'touchmove', 120, 155);
      touch(target, 'touchend', mx, my);
    }
    expect(opened).toEqual([]);
  });

  test('cancels on extra fingers, touchcancel, reversal, and browser ownership', async () => {
    const { opened, target } = await mount();
    for (const reason of ['multitouch', 'cancel', 'reverse', 'browser']) {
      touch(target, 'touchstart', 8);
      touch(target, 'touchmove', 90);
      if (reason === 'multitouch') touch(target, 'touchmove', 95, 100, 2);
      if (reason === 'cancel') touch(target, 'touchcancel', 90);
      if (reason === 'browser') {
        const event = new Event('touchmove', { bubbles: true, cancelable: false });
        Object.defineProperty(event, 'touches', { value: [{ identifier: 7, clientX: 95, clientY: 100 }] });
        target.dispatchEvent(event);
      }
      touch(target, 'touchend', reason === 'reverse' ? 10 : 95);
    }
    expect(opened).toEqual([]);
  });

  test('respects fields, selected text, modals, and touches outside the app', async () => {
    const { opened, target } = await mount();
    const swipe = (element: Element) => {
      touch(element, 'touchstart', 8);
      expect(touch(element, 'touchmove', 90).defaultPrevented).toBe(false);
      touch(element, 'touchend', 90);
    };
    swipe(host!.querySelector('textarea')!);
    swipe(document.body);
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    swipe(target);
    window.getSelection()!.removeAllRanges();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    host!.appendChild(modal);
    swipe(target);
    expect(opened).toEqual([]);
  });

  test('preserves horizontal scrolling inside code blocks', async () => {
    const { opened, target } = await mount();
    target.style.overflowX = 'auto';
    Object.defineProperties(target, { scrollWidth: { value: 800 }, clientWidth: { value: 300 } });
    target.scrollLeft = 100;
    touch(target, 'touchstart', 8);
    expect(touch(target, 'touchmove', 90).defaultPrevented).toBe(false);
    touch(target, 'touchend', 90);
    expect(opened).toEqual([]);
  });

  test('disabling mid-gesture removes listeners and discards the pending swipe', async () => {
    const { opened, target, Harness } = await mount();
    touch(target, 'touchstart', 8);
    touch(target, 'touchmove', 90);
    await act(async () => root?.render(<Harness enabled={false} />));
    touch(target, 'touchend', 90);
    touch(target, 'touchstart', 8);
    expect(touch(target, 'touchmove', 90).defaultPrevented).toBe(false);
    touch(target, 'touchend', 90);
    expect(opened).toEqual([]);
  });
});
