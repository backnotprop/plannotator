/**
 * The skill (/) list in the Inbox's composer stays inside what the person can
 * see (the owner's iPhone, a thread open, the keyboard up: the list opened
 * above the reply box and only the bottom of its last row showed, cut at the
 * reply foot's top edge and covered by the thread).
 *
 * The causes this file pins down: the list was drawn inside the reply foot,
 * which scrolls in its own box on an iPhone with the keyboard up and is its
 * own stacking context (so the list was cut and covered); its room was the
 * layout viewport from y 0 (`innerHeight`, which keeps the full height under
 * the iOS keyboard, and the thread's header counted as room); and the keyboard
 * opening after the list did not move it.
 *
 * happy-dom does no layout: each box the composer measures gets a rect here,
 * the list its natural height (rows × 44), and the menu's on-screen rect is
 * derived from the placement it committed (side + max-height), as the CSS
 * resolves it (6 px from the box it hangs off).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';

const hasDom = typeof document !== 'undefined';
const { InboxComposerField } = (hasDom ? await import('./components/ComposerField') : {}) as typeof import('./components/ComposerField');
const catalogMod = (hasDom ? await import('@plannotator/ui/utils/skillCatalog') : {}) as typeof import('@plannotator/ui/utils/skillCatalog');

const ROW = 44;
const GAP = 6;
const SKILLS: SkillCatalogEntry[] = Array.from({ length: 84 }, (_, i) => ({
  name: `skill-${String(i).padStart(2, '0')}-with-a-long-name`,
  root: 'claude' as const,
  description: 'Write or rewrite technical text with the rules of ASD-STE100 Simplified Technical English so it is clear.',
  humanOnly: false,
}));

interface Box {
  top: number;
  bottom: number;
}

/** The layout this test lays out: the window, what is visible of it, the thread's header and the reply field. */
const layout = {
  innerHeight: 800,
  seen: { top: 0, bottom: 800 } as Box,
  header: { top: 0, bottom: 56 } as Box,
  foot: { top: 260, bottom: 800 } as Box,
  field: { top: 300, bottom: 360 } as Box,
  /** Something drawn over the field (full view, a sheet), as hit-testing finds it; null: the field is on top. */
  cover: null as Element | null,
};

const rect = (box: Box, left = 16, width = 360): DOMRect =>
  ({ x: left, y: box.top, top: box.top, bottom: box.bottom, left, right: left + width, width, height: box.bottom - box.top, toJSON: () => ({}) }) as DOMRect;

let root: Root | null = null;
let mount: HTMLElement | null = null;
let restoreRect: (() => void) | null = null;
let viewport: (EventTarget & { height: number; offsetTop: number; width: number; offsetLeft: number }) | null = null;
const original = hasDom ? { innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'), visualViewport: Object.getOwnPropertyDescriptor(window, 'visualViewport') } : null;

/** Every box the composer and the menu measure, by what it is; anything else has no size. */
function stubRects() {
  const proto = HTMLElement.prototype;
  const own = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-skanchor')) {
      // Laid out where its style puts it, in the root's coordinates (the root sits at 0, 0).
      const top = parseFloat(this.style.top) || 0;
      return rect({ top, bottom: top + (parseFloat(this.style.height) || 0) }, parseFloat(this.style.left) || 0, parseFloat(this.style.width) || 0);
    }
    // The field and every box of its own (the token textarea's wrapper clips like a scroll box).
    if (this.closest('.ib-cfield')) return rect(layout.field);
    if (this.matches('.ib-phead')) return rect(layout.header, 0, 400);
    if (this.matches('.ib-pfoot')) return rect(layout.foot, 0, 400);
    if (this.matches('.ib-pane, .pn-inbox')) return rect({ top: 0, bottom: layout.innerHeight }, 0, 400);
    return rect({ top: 0, bottom: 0 }, 0, 0);
  };
  // Hit-testing: whatever covers the field, else the field itself.
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: () => layout.cover ?? document.querySelector('.ib-cfield textarea'),
  });
  restoreRect = () => {
    proto.getBoundingClientRect = own;
    delete (document as unknown as Record<string, unknown>).elementFromPoint;
  };
}

function setViewport(innerHeight: number, seen: Box) {
  layout.innerHeight = innerHeight;
  layout.seen = seen;
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => layout.innerHeight });
  if (!viewport) {
    viewport = Object.assign(new EventTarget(), { height: 0, offsetTop: 0, width: 400, offsetLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
  }
  viewport.offsetTop = seen.top;
  viewport.height = seen.bottom - seen.top;
}

function Reply() {
  const [value, setValue] = useState('');
  return <InboxComposerField value={value} onChange={setValue} placeholder="Write a reply" ariaLabel="Reply" destination="your reply" />;
}

/** The Inbox's shape around the reply box: the root, a thread pane with its header, body, and the reply foot that scrolls in its own box (iOS, keyboard up). */
async function drawThread() {
  mount = document.createElement('div');
  mount.className = 'pn-inbox';
  mount.style.position = 'relative';
  document.body.appendChild(mount);
  const pane = document.createElement('section');
  pane.className = 'ib-pane';
  pane.innerHTML = '<div class="ib-phead"></div><div class="ib-pbody"></div>';
  const foot = document.createElement('div');
  foot.className = 'ib-pfoot';
  foot.style.overflowY = 'auto';
  pane.appendChild(foot);
  mount.appendChild(pane);
  await act(async () => {
    root = createRoot(foot);
    root.render(<Reply />);
  });
  await act(async () => {}); // the catalog's fetch
  const field = foot.querySelector('textarea') as HTMLTextAreaElement;
  // The person types in it: it has focus.
  await act(async () => field.focus());
  return field;
}

const textSetter = () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

/** One key typed where the caret is, as the browser does it: no act around it beyond React's own commit. */
function typeAtCaret(el: HTMLTextAreaElement, ch: string) {
  act(() => {
    const at = el.selectionStart;
    textSetter().call(el, el.value.slice(0, at) + ch + el.value.slice(el.selectionEnd));
    el.setSelectionRange(at + ch.length, at + ch.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

const menu = () => document.querySelector<HTMLElement>('[data-skill-menu]');

/** The list's rows are 44 px; its natural height follows the rows it holds. */
function stubListHeight() {
  const list = document.querySelector<HTMLElement>('[data-skill-menu-list]')!;
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => list.querySelectorAll('[data-skill-item]').length * ROW });
}

async function settle() {
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
  });
  await act(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}

/** Where the menu is on screen, from what it committed: its side, and its list's height (natural, capped). */
function menuBox(): Box & { side: string } {
  const el = menu()!;
  const list = el.querySelector<HTMLElement>('[data-skill-menu-list]')!;
  const side = el.getAttribute('data-skill-menu-placement')!;
  const height = Math.min(list.querySelectorAll('[data-skill-item]').length * ROW, parseFloat(list.style.maxHeight));
  const anchor = (el.parentElement as HTMLElement).getBoundingClientRect();
  const top = side === 'above' ? anchor.top - GAP - height : anchor.bottom + GAP;
  return { side, top, bottom: top + height };
}

beforeEach(() => {
  if (!hasDom) return;
  catalogMod.resetSkillCatalogCache();
  catalogMod.setSkillCatalogTransport(async () => SKILLS);
  layout.header = { top: 0, bottom: 56 };
  layout.foot = { top: 260, bottom: 800 };
  layout.field = { top: 300, bottom: 360 };
  layout.cover = null;
  setViewport(800, { top: 0, bottom: 800 });
  stubRects();
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  root = null;
  mount?.remove();
  mount = null;
  restoreRect?.();
  restoreRect = null;
  catalogMod.resetSkillCatalogCache();
  catalogMod.resetSkillCatalogTransport();
  if (original?.innerHeight) Object.defineProperty(window, 'innerHeight', original.innerHeight);
  if (original?.visualViewport) Object.defineProperty(window, 'visualViewport', original.visualViewport);
  else delete (window as unknown as Record<string, unknown>).visualViewport;
  viewport = null;
});

describe.skipIf(!hasDom)('the skill list in the reply box', () => {
  test('is drawn outside the reply foot, so the foot scrolling in its own box (iOS, keyboard up) cannot cut it', async () => {
    const field = await drawThread();
    await type(field, '/');
    // Booleans, never elements: a failing match on a happy-dom element hangs bun's diff printer.
    expect(menu() !== null).toBe(true);
    // The owner's picture: inside `.ib-pfoot` (overflow-y: auto under the keyboard) the list above the box was cut at the foot's top.
    expect(menu()!.closest('.ib-pfoot') === null).toBe(true);
    expect(menu()!.closest('.pn-inbox') !== null).toBe(true);
  });

  test('opening above, it stops under the thread header, never under or over it', async () => {
    // The keyboard is up and the box sits on it: the room is above the box, between it and the header.
    setViewport(800, { top: 0, bottom: 380 });
    layout.foot = { top: 280, bottom: 380 };
    const field = await drawThread();
    await type(field, '/');
    stubListHeight();
    await settle();
    const box = menuBox();
    expect(box.side).toBe('above');
    expect(box.top).toBeGreaterThanOrEqual(layout.header.bottom);
    expect(box.bottom).toBeLessThanOrEqual(layout.field.top);
  });

  test('with the keyboard up, it fits in the visual viewport, not the layout viewport (innerHeight keeps the full height)', async () => {
    // iOS: the keyboard covers 440 of 800; innerHeight still reads 800. The box sits high, just under the header.
    setViewport(800, { top: 0, bottom: 360 });
    layout.field = { top: 70, bottom: 130 };
    layout.foot = { top: 60, bottom: 360 };
    const field = await drawThread();
    await type(field, '/');
    stubListHeight();
    await settle();
    const box = menuBox();
    expect(box.side).toBe('below');
    expect(box.top).toBeGreaterThanOrEqual(layout.field.bottom);
    expect(box.bottom).toBeLessThanOrEqual(360);
  });

  test('the keyboard opening after the list is open moves and shrinks it to what is left', async () => {
    layout.field = { top: 70, bottom: 130 };
    layout.foot = { top: 60, bottom: 800 };
    const field = await drawThread();
    await type(field, '/');
    stubListHeight();
    await settle();
    expect(menuBox().bottom).toBeLessThanOrEqual(800);
    // The keyboard: only the visual viewport changes, and only it says so.
    await act(async () => {
      layout.seen = { top: 0, bottom: 380 };
      viewport!.height = 380;
      viewport!.dispatchEvent(new Event('resize'));
    });
    await act(async () => {
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    const box = menuBox();
    expect(box.top).toBeGreaterThanOrEqual(layout.header.bottom);
    expect(box.bottom).toBeLessThanOrEqual(380);
  });

  test('one match, the box high under the header: the row shows whole, below the box (the owner\'s one-row case)', async () => {
    setViewport(800, { top: 0, bottom: 420 });
    layout.field = { top: 90, bottom: 150 };
    layout.foot = { top: 80, bottom: 420 };
    const field = await drawThread();
    await type(field, '/skill-07');
    stubListHeight();
    await settle();
    const box = menuBox();
    expect(document.querySelectorAll('[data-skill-item]').length).toBe(1);
    expect(box.bottom - box.top).toBe(ROW);
    expect(box.top).toBeGreaterThanOrEqual(layout.header.bottom);
    expect(box.bottom).toBeLessThanOrEqual(420);
  });
});

describe.skipIf(!hasDom)('the skill list is drawn only while its field is in sight', () => {
  test('full view opening over the reply box takes the list away, and its rows with it', async () => {
    // The review's case: "Hi /b" in a thread's reply box, then the attachment opens in full view. At the Inbox's root
    // the list was above the whole shell: it stayed over the document, and a press on a row wrote into the hidden reply.
    const field = await drawThread();
    await type(field, 'Hi /skill-0');
    expect(menu() !== null).toBe(true);
    const full = document.createElement('div');
    full.className = 'ib-view ib-full';
    await act(async () => {
      layout.cover = full;
      mount!.querySelector('.ib-pane')!.appendChild(full);
    });
    await settle();
    expect(menu() === null).toBe(true);
    // Nothing to press, and the arrows are the field's again: none moves through a list nobody sees.
    expect(document.querySelector('[data-skill-item]') === null).toBe(true);
    expect(field.getAttribute('aria-expanded') === 'true').toBe(false);
    // Full view closes: the list is back where it was.
    await act(async () => {
      layout.cover = null;
      full.remove();
    });
    await settle();
    expect(menu() !== null).toBe(true);
  });

  test('a card tucked away (inert) takes its list with it', async () => {
    const field = await drawThread();
    await type(field, '/skill-0');
    expect(menu() !== null).toBe(true);
    await act(async () => {
      field.closest('.ib-pfoot')!.setAttribute('inert', '');
    });
    await settle();
    expect(menu() === null).toBe(true);
  });

  test('focus leaving for another field (a phone: an action item\'s note, which hides the reply foot) takes the list away', async () => {
    const field = await drawThread();
    await type(field, '/skill-0');
    expect(menu() !== null).toBe(true);
    const note = document.createElement('textarea');
    mount!.querySelector('.ib-pbody')!.appendChild(note);
    await act(async () => note.focus());
    await settle();
    expect(menu() === null).toBe(true);
  });
});

describe.skipIf(!hasDom)('a pick by press', () => {
  test('a key typed right after the press lands after the inserted name, not one place back', async () => {
    // The caret was put back from a 0 ms timer: a key typed before it ran landed at the end, then the timer pulled
    // the caret back over it, so a quick "/b" came out "b/".
    const field = await drawThread();
    await type(field, 'Use /skill-07');
    const row = document.querySelector<HTMLElement>('[data-skill-item]')!;
    act(() => {
      row.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(field.value.startsWith('Use /skill-07-with-a-long-name')).toBe(true);
    typeAtCaret(field, '/');
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
    typeAtCaret(field, 'b');
    expect(field.value.endsWith('/b')).toBe(true);
    expect(field.value.endsWith('b/')).toBe(false);
  });
});
