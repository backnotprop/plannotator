/**
 * The reply box's + (compose/ReplyPlusMenu.tsx), in place of its paperclip: the menu holds "Attach a file" then
 * "Canvas", and no Sketch; Attach a file opens the paperclip's own picker (the hidden input, which stays when the
 * menu closes, and whose choice reaches the box); Canvas opens the thread's canvas; a thread that can have no canvas
 * gets Attach a file alone. The keys are Base UI's (↓ moves, Escape closes and focus goes back to +).
 *
 * What regresses: a Sketch row back in the menu, the order turned, Attach a file that opens nothing or a picker that
 * is gone once the menu closes, a Canvas row on a box with no canvas.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ReplyPlusMenu } = (hasDom ? await import('./ReplyPlusMenu') : {}) as typeof import('./ReplyPlusMenu');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

function mount(props: Partial<Parameters<typeof ReplyPlusMenu>[0]>) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<ReplyPlusMenu phone={false} iconSize={16} onFiles={() => {}} onCanvas={null} {...props} />);
  });
}

const plus = () => document.querySelector<HTMLButtonElement>('[data-reply-plus]')!;
const menu = () => document.querySelector<HTMLElement>('[data-reply-plus-menu]');
const rows = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const input = () => document.querySelector<HTMLInputElement>('input[type="file"][data-reply-attach]');

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

async function key(k: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)('the + opens a menu of Attach a file then Canvas, with no Sketch; Canvas opens the canvas', async () => {
  let opened = 0;
  mount({ onCanvas: () => opened++ });
  expect(plus().getAttribute('aria-label')).toBe('Add');
  expect(menu()).toBeNull();
  await press(plus());
  await until(() => rows().length > 0, 'the menu');
  expect(rows().map((row) => row.textContent?.trim())).toEqual(['Attach a file', 'Canvas']);
  expect(plus().hasAttribute('data-open')).toBe(true);
  await act(async () => rows()[1]!.click());
  expect(opened).toBe(1);
  await until(() => menu() === null, 'the menu to close');
});

test.skipIf(!hasDom)("Attach a file opens the paperclip's picker, which stays after the menu closes and hands its files to the box", async () => {
  const chosen: string[][] = [];
  mount({ onCanvas: () => {}, onFiles: (files) => chosen.push([...files].map((f) => f.name)) });
  const picker = input()!;
  expect(picker).not.toBeNull();
  expect(picker.multiple).toBe(true);
  // The picker is not inside the menu: it is there before the menu opens and after it closes.
  expect(picker.closest('[data-reply-plus-menu]')).toBeNull();
  let clicks = 0;
  picker.addEventListener('click', (event) => {
    clicks++;
    event.preventDefault();
  });
  await press(plus());
  await until(() => rows().length > 0, 'the menu');
  await act(async () => rows()[0]!.click());
  expect(clicks).toBe(1);
  await until(() => menu() === null, 'the menu to close');
  expect(input()).toBe(picker);
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['# notes'], 'harbor-notes.md', { type: 'text/markdown' })] });
  act(() => {
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(chosen).toEqual([['harbor-notes.md']]);
});

test.skipIf(!hasDom)('a box whose thread can have no canvas: Attach a file alone; a phone picker offers the photo library', async () => {
  mount({ onCanvas: null, phone: true });
  expect(input()!.accept).toBe('image/*,*/*');
  await press(plus());
  await until(() => rows().length > 0, 'the menu');
  expect(rows().map((row) => row.textContent?.trim())).toEqual(['Attach a file']);
});

test.skipIf(!hasDom)('the keys are the menu\'s own: Attach a file first, ↓ moves to Canvas, Escape closes it and focus goes back to +', async () => {
  mount({ onCanvas: () => {} });
  plus().focus();
  await press(plus());
  await until(() => rows().length === 2, 'the menu');
  await until(() => menu()!.contains(document.activeElement), 'focus in the menu');
  // Attach a file, the most common, is first and has focus as the menu opens; ↓ goes to Canvas.
  expect(document.activeElement?.getAttribute('data-reply-plus-item')).toBe('attach');
  await key('ArrowDown');
  expect(document.activeElement?.getAttribute('data-reply-plus-item')).toBe('canvas');
  await key('Escape');
  await until(() => menu() === null, 'the menu to close');
  await until(() => document.activeElement === plus(), 'focus back on +');
});
