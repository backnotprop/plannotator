/**
 * #1647: scroll keys do nothing on load because the document scrolls inside
 * <main>, not the window. These tests guard the routing that fills that gap
 * and, just as much, every owner it must stay out of the way of.
 *
 * DOM-gated: run with DOM_TESTS=1 (listed in .github/workflows/test.yml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { scrollKeyAction, useScrollKeyRouting, type ScrollKeyInput } from './useScrollKeyRouting';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

interface ScrollCall { readonly top?: number }

/** A viewport that reports overflow and records the scrolls asked of it. */
function makeViewport(): { el: HTMLElement; calls: ScrollCall[] } {
  const el = document.createElement('main');
  el.style.overflowY = 'auto';
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 5000 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 800 });
  const calls: ScrollCall[] = [];
  el.scrollBy = ((options: ScrollToOptions) => { calls.push({ top: options.top }); }) as HTMLElement['scrollBy'];
  el.scrollTo = ((options: ScrollToOptions) => { calls.push({ top: options.top }); }) as HTMLElement['scrollTo'];
  const paragraph = document.createElement('p');
  paragraph.textContent = 'Document text';
  el.appendChild(paragraph);
  document.body.appendChild(el);
  return { el, calls };
}

function Harness({ viewport, enabled }: { viewport: HTMLElement; enabled: boolean }) {
  useScrollKeyRouting({ viewport, enabled });
  return null;
}

async function mount(viewport: HTMLElement, enabled = true): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness viewport={viewport} enabled={enabled} />));
}

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function pointerDown(target: EventTarget): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}

// Plain objects, not `new KeyboardEvent`: this block runs in the non-DOM job too.
const k = (init: Partial<ScrollKeyInput> & { key: string }) => scrollKeyAction({
  isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
});

describe('scrollKeyAction', () => {
  test('maps the plain scroll keys and Shift+Space', () => {
    expect(k({ key: 'ArrowDown' })).toEqual({ kind: 'line', direction: 1 });
    expect(k({ key: 'ArrowUp' })).toEqual({ kind: 'line', direction: -1 });
    expect(k({ key: 'PageDown' })).toEqual({ kind: 'page', direction: 1 });
    expect(k({ key: 'PageUp' })).toEqual({ kind: 'page', direction: -1 });
    expect(k({ key: ' ' })).toEqual({ kind: 'page', direction: 1 });
    expect(k({ key: ' ', shiftKey: true })).toEqual({ kind: 'page', direction: -1 });
    expect(k({ key: 'Home' })).toEqual({ kind: 'edge', edge: 'start' });
    expect(k({ key: 'End' })).toEqual({ kind: 'edge', edge: 'end' });
  });

  test('leaves chords, selection-extending keys and IME composition alone', () => {
    expect(k({ key: 'ArrowDown', metaKey: true })).toBeNull();
    expect(k({ key: 'ArrowDown', ctrlKey: true })).toBeNull();
    expect(k({ key: 'ArrowDown', altKey: true })).toBeNull();
    expect(k({ key: 'ArrowDown', shiftKey: true })).toBeNull();
    expect(k({ key: 'End', shiftKey: true })).toBeNull();
    expect(k({ key: ' ', isComposing: true })).toBeNull();
    expect(k({ key: 'Enter' })).toBeNull();
    expect(k({ key: 'j' })).toBeNull();
  });
});

describe('useScrollKeyRouting', () => {
  afterEach(async () => {
    const mounted = root;
    if (mounted) await act(async () => mounted.unmount());
    root = null;
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('scrolls the document viewport when nothing owns the key', async () => {
    const { el, calls } = makeViewport();
    await mount(el);

    const pageDown = key(document.body, { key: 'PageDown' });
    expect(pageDown.defaultPrevented).toBe(true);
    key(document.body, { key: 'ArrowDown' });
    key(document.body, { key: ' ', shiftKey: true });

    expect(calls.map(c => Math.sign(c.top ?? 0))).toEqual([1, 1, -1]);
    expect(calls[0].top).toBeGreaterThan(calls[1].top ?? 0);
  });

  test.skipIf(!hasDom)('never takes a key from a focused control, input or editor', async () => {
    const { el, calls } = makeViewport();
    await mount(el);

    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();
    const space = key(input, { key: ' ' });
    expect(space.defaultPrevented).toBe(false);

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(key(button, { key: ' ' }).defaultPrevented).toBe(false);

    expect(calls).toEqual([]);
  });

  test.skipIf(!hasDom)('yields to a listener that already handled the key', async () => {
    const { el, calls } = makeViewport();
    await mount(el);
    const consume = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', consume, true);
    try {
      key(document.body, { key: 'ArrowDown' });
    } finally {
      window.removeEventListener('keydown', consume, true);
    }
    expect(calls).toEqual([]);
  });

  test.skipIf(!hasDom)('does not scroll the document behind a dialog, menu or listbox', async () => {
    const { el, calls } = makeViewport();
    await mount(el);

    for (const role of ['dialog', 'menu', 'listbox']) {
      const overlay = document.createElement('div');
      overlay.setAttribute('role', role);
      document.body.appendChild(overlay);
      expect(key(document.body, { key: 'PageDown' }).defaultPrevented).toBe(false);
      overlay.remove();
    }
    const legacyModal = document.createElement('div');
    legacyModal.className = 'fixed inset-0';
    document.body.appendChild(legacyModal);
    key(document.body, { key: ' ' });
    legacyModal.remove();

    expect(calls).toEqual([]);
  });

  test.skipIf(!hasDom)('leaves the key to the browser once a click gave it a scroll target', async () => {
    const { el, calls } = makeViewport();
    await mount(el);

    // A click in the document: the browser now scrolls <main> natively, so
    // routing too would move it twice.
    pointerDown(el.querySelector('p')!);
    expect(key(document.body, { key: 'PageDown' }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);

    // A click on chrome with nothing scrollable above it (the header).
    const header = document.createElement('header');
    document.body.appendChild(header);
    pointerDown(header);
    key(document.body, { key: 'PageDown' });
    expect(calls).toHaveLength(1);

    // A click on a node that then goes away (a dismissed first-run dialog).
    const dialogButton = document.createElement('button');
    el.appendChild(dialogButton);
    pointerDown(dialogButton);
    dialogButton.remove();
    key(document.body, { key: 'PageDown' });
    expect(calls).toHaveLength(2);
  });

  test.skipIf(!hasDom)('does nothing while disabled', async () => {
    const { el, calls } = makeViewport();
    await mount(el, false);
    expect(key(document.body, { key: 'PageDown' }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
