/**
 * The page's idle clock (idleClock.ts), the calm moment for the one-time dialogs whose own moment is "back on the
 * list", which a person who keeps a thread open beside the list never reaches (the owner, 2026-11-08).
 *
 * What regresses: idle coming without the full quiet length, or input (a pointer move, a key, a scroll, a touch) not
 * starting the count again; idle while the tab is hidden or the window blurred, or the count carrying over a hidden
 * spell; idle while a field has focus, a dialog, menu or popover is open, or the page says it is busy; a clock that is
 * off still counting.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const clock = (hasDom ? await import('./idleClock') : {}) as typeof import('./idleClock');

const IDLE_MS = 120;

let root: Root | null = null;
let host: HTMLElement | null = null;
let saved = 0;
let visibility: DocumentVisibilityState = 'visible';
let focused = true;
let busy = false;
let idle = false;

beforeEach(() => {
  if (!hasDom) return;
  saved = clock.IDLE_CLOCK.idleMs;
  clock.IDLE_CLOCK.idleMs = IDLE_MS;
  visibility = 'visible';
  focused = true;
  busy = false;
  idle = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  clock.IDLE_CLOCK.idleMs = saved;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (document as unknown as Record<string, unknown>).hasFocus;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

function Harness({ enabled }: { enabled: boolean }) {
  idle = clock.useIdleClock({ enabled, busy: () => busy });
  return null;
}

function mount(enabled = true) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness enabled={enabled} />);
  });
}

function element(tag: string, name: string, value: string): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute(name, value);
  return el;
}

const fire = (type: string, target: EventTarget = window) => act(() => void target.dispatchEvent(new Event(type, { bubbles: true })));

describe.skipIf(!hasDom)('the idle clock', () => {
  test('idle after the full quiet length; each input starts the count again and ends idle', async () => {
    mount();
    await wait(IDLE_MS * 0.6);
    expect(idle).toBe(false);
    // Input just before the length: the count starts again from it.
    fire('pointermove');
    await wait(IDLE_MS * 0.6);
    expect(idle).toBe(false);
    await wait(IDLE_MS * 0.6);
    expect(idle).toBe(true);
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
      fire(type);
      expect(idle).toBe(false);
      await wait(IDLE_MS + 60);
      expect(idle).toBe(true);
    }
    // A scroll inside the page (it does not bubble): heard all the same.
    const pane = document.createElement('div');
    document.body.appendChild(pane);
    act(() => void pane.dispatchEvent(new Event('scroll')));
    expect(idle).toBe(false);
  });

  test('never while the tab is hidden or the window blurred; coming back counts afresh', async () => {
    mount();
    visibility = 'hidden';
    fire('visibilitychange', document);
    await wait(IDLE_MS * 2);
    expect(idle).toBe(false);
    visibility = 'visible';
    fire('visibilitychange', document);
    await wait(IDLE_MS * 0.6);
    // The hidden spell is no quiet: the full length again from the return.
    expect(idle).toBe(false);
    await wait(IDLE_MS * 0.6);
    expect(idle).toBe(true);
    // Blurred: idle ends at once and no count runs.
    focused = false;
    fire('blur');
    expect(idle).toBe(false);
    await wait(IDLE_MS * 2);
    expect(idle).toBe(false);
    focused = true;
    fire('focus');
    await wait(IDLE_MS + 60);
    expect(idle).toBe(true);
  });

  test('never while a field has focus (typing), and the count runs again once it is left', async () => {
    const box = document.createElement('textarea');
    document.body.appendChild(box);
    box.focus();
    mount();
    await wait(IDLE_MS * 2.5);
    expect(idle).toBe(false);
    box.blur();
    await wait(IDLE_MS * 2.5);
    expect(idle).toBe(true);
  });

  const overlays: [string, () => HTMLElement][] = [
    ['a dialog open', () => Object.assign(document.createElement('dialog'), { open: true })],
    ['a modal panel', () => element('div', 'aria-modal', 'true')],
    ['a menu', () => element('div', 'role', 'menu')],
    ['a list of choices', () => element('div', 'role', 'listbox')],
    ['a popover (its trigger expanded)', () => element('button', 'aria-expanded', 'true')],
  ];
  for (const [what, make] of overlays) {
    test(`never with ${what}; idle once it closes`, async () => {
      const el = make();
      document.body.appendChild(el);
      mount();
      await wait(IDLE_MS * 2.5);
      expect(idle).toBe(false);
      el.remove();
      await wait(IDLE_MS * 2.5);
      expect(idle).toBe(true);
    });
  }

  test("never while the page says it is busy (App: a composer, a search, a row's menu, a toast)", async () => {
    busy = true;
    mount();
    await wait(IDLE_MS * 2.5);
    expect(idle).toBe(false);
    busy = false;
    await wait(IDLE_MS * 2.5);
    expect(idle).toBe(true);
  });

  test('off: never idle', async () => {
    mount(false);
    await wait(IDLE_MS * 2.5);
    expect(idle).toBe(false);
  });
});
