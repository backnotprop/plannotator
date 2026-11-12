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

const layout = {
  innerHeight: 800,
  seen: { top: 0, bottom: 800 } as Box,
  header: { top: 0, bottom: 56 } as Box,
  foot: { top: 260, bottom: 800 } as Box,
  field: { top: 300, bottom: 360 } as Box,
  cover: null as Element | null,
};

const rect = (box: Box, left = 16, width = 360): DOMRect =>
  ({ x: left, y: box.top, top: box.top, bottom: box.bottom, left, right: left + width, width, height: box.bottom - box.top, toJSON: () => ({}) }) as DOMRect;

let root: Root | null = null;
let mount: HTMLElement | null = null;
let restoreRect: (() => void) | null = null;
let viewport: (EventTarget & { height: number; offsetTop: number; width: number; offsetLeft: number }) | null = null;
const original = hasDom ? { innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'), visualViewport: Object.getOwnPropertyDescriptor(window, 'visualViewport') } : null;

function stubRects() {
  const proto = HTMLElement.prototype;
  const own = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains('ib-skanchor')) {
      const top = parseFloat(this.style.top) || 0;
      return rect({ top, bottom: top + (parseFloat(this.style.height) || 0) }, parseFloat(this.style.left) || 0, parseFloat(this.style.width) || 0);
    }
    if (this.closest('.ib-cfield')) return rect(layout.field);
    if (this.matches('.ib-phead')) return rect(layout.header, 0, 400);
    if (this.matches('.ib-pfoot')) return rect(layout.foot, 0, 400);
    if (this.matches('.ib-pane, .pn-inbox')) return rect({ top: 0, bottom: layout.innerHeight }, 0, 400);
    return rect({ top: 0, bottom: 0 }, 0, 0);
  };
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
  await act(async () => {});
  const field = foot.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => field.focus());
  return field;
}

const textSetter = () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;

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
    expect(menu() !== null).toBe(true);
    expect(menu()!.closest('.ib-pfoot') === null).toBe(true);
    expect(menu()!.closest('.pn-inbox') !== null).toBe(true);
  });

  test('opening above, it stops under the thread header, never under or over it', async () => {
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
    expect(document.querySelector('[data-skill-item]') === null).toBe(true);
    expect(field.getAttribute('aria-expanded') === 'true').toBe(false);
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
