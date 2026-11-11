
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { selectionToolbarShowing } from '../selectionToolbar';
import { inOverlay, modalOpen } from './guards';
import { useSheetEscape } from './useSheetEscape';

const hasDom = typeof document !== 'undefined';

function Sheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useSheetEscape(open, onClose);
  return null;
}

describe.skipIf(!hasDom)('useSheetEscape', () => {
  let root: Root;
  let host: HTMLElement;
  let closed = 0;

  const mount = async (open = true) => {
    await act(async () => root.render(<Sheet open={open} onClose={() => closed++} />));
  };
  const add = (html: string) => {
    host.insertAdjacentHTML('beforeend', html);
    return host.lastElementChild as HTMLElement;
  };
  const escape = (target: EventTarget, init: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true, ...init }));

  beforeEach(() => {
    closed = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  test('closes from the page, from a button, and marks the key used', async () => {
    await mount();
    expect(escape(document.body)).toBe(false);
    expect(closed).toBe(1);
    escape(add('<button>Collapse diff</button>'));
    expect(closed).toBe(2);
  });

  test("a PR description's raw HTML cannot act as the annotator or a popover layer; the real stage keeps the key", async () => {
    await mount();
    const body = add('<div class="html-block"><div data-pn-image-annotator-stage>x</div><div data-popover-layer><a href="#y">y</a></div></div>');
    expect(modalOpen()).toBe(false);
    escape(body.querySelector('a')!);
    expect(closed).toBe(1);
    add('<div class="pn-visible-viewport-overlay"><div data-pn-image-annotator-stage></div></div>');
    expect(modalOpen()).toBe(true);
    escape(document.body);
    expect(closed).toBe(1);
  });

  test("a PR description's own markup stands for nothing, wherever it sits; the same marks outside it do", async () => {
    await mount();
    const marks = '<div data-pn-annotation-toolbar-row></div><div data-quick-label-picker></div><div class="pn-visible-viewport-overlay"><div data-pn-image-annotator-stage><a href="#y">y</a></div></div>';
    const body = add(`<section class="ib-prr-desc">${marks}</section>`);
    for (const el of body.querySelectorAll('div')) el.getClientRects = () => [{}] as unknown as DOMRectList;
    expect(modalOpen()).toBe(false);
    expect(selectionToolbarShowing()).toBe(false);
    expect(inOverlay(body.querySelector('a'))).toBe(false);
    escape(body.querySelector('a')!);
    expect(closed).toBe(1);
    const own = add(`<section>${marks}</section>`);
    for (const el of own.querySelectorAll('div')) el.getClientRects = () => [{}] as unknown as DOMRectList;
    expect(modalOpen()).toBe(true);
    expect(selectionToolbarShowing()).toBe(true);
    expect(inOverlay(own.querySelector('a'))).toBe(true);
  });

  test('another key, or a sheet that is closed, does nothing', async () => {
    await mount();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(closed).toBe(0);
    await mount(false);
    escape(document.body);
    expect(closed).toBe(0);
  });

  test('an Escape something used, or an input method mid-composition, stays theirs', async () => {
    await mount();
    const card = add('<div></div>');
    card.addEventListener('keydown', (event) => event.preventDefault());
    escape(card);
    escape(document.body, { isComposing: true });
    expect(closed).toBe(0);
  });

  test('a place to type, a dialog or a popover keeps it; a modal over the window keeps it from anywhere', async () => {
    await mount();
    for (const html of ['<textarea></textarea>', '<input type="text" />', '<div contenteditable="true"></div>', '<div role="dialog"><button>Send</button></div>', '<div data-popover-layer><button>Label</button></div>']) {
      const el = add(html);
      escape(el.querySelector('button') ?? el);
    }
    expect(closed).toBe(0);
    const modal = add('<dialog open></dialog>');
    escape(document.body);
    expect(closed).toBe(0);
    modal.remove();
    escape(document.body);
    expect(closed).toBe(1);
  });
});
