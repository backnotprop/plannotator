import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover } from './CommentPopover';
import { resetCommentCardPolicy, setCommentCardEnabled } from '../utils/commentCardPolicy';
import { resetSkillCatalogCache, resetSkillCatalogTransport, setSkillCatalogTransport } from '../utils/skillCatalog';

const hasDom = typeof document !== 'undefined';
const ANCHOR = { top: 120, bottom: 140, left: 300, right: 420, width: 120 } as DOMRect;

let root: Root | null = null;
let host: HTMLElement | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;
let originalWidth = 0;
let originalHeight = 0;

function mediaList(matches: (query: string) => boolean) {
  return (query: string): MediaQueryList => ({
    matches: matches(query), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  }) as unknown as MediaQueryList;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

const box = () => document.querySelector<HTMLElement>('[data-comment-popover]');
const textarea = () => box()?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
const buttonByText = (text: string) =>
  [...(box()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === text) ?? null;

async function type(words: string): Promise<void> {
  const field = textarea();
  if (!field) throw new Error('no field');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await act(async () => {
    setter?.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Typing as a keyboard does it: the caret at the end, then the keyup React reads the caret from. */
async function typeAtCaret(words: string): Promise<void> {
  const field = textarea()!;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  await act(async () => {
    setter?.call(field, words);
    field.selectionStart = field.selectionEnd = words.length;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: words.slice(-1), bubbles: true }));
  });
}

function giveLayout(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () => new DOMRect(parseFloat(el.style.left) || 0, parseFloat(el.style.top) || 0, width, height);
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

function pointer(type: string, target: EventTarget, x: number, y: number): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
}

async function drag(handle: Element, dx: number, dy: number): Promise<void> {
  await act(async () => pointer('pointerdown', handle, 400, 200));
  await act(async () => pointer('pointermove', document, 400 + dx, 200 + dy));
  await act(async () => pointer('pointerup', document, 400 + dx, 200 + dy));
}

const place = () => ({ left: parseFloat(box()!.style.left), top: parseFloat(box()!.style.top) });

async function escape(): Promise<void> {
  await act(async () => {
    textarea()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  if (!hasDom) return;
  originalMatchMedia = window.matchMedia;
  originalWidth = window.innerWidth;
  originalHeight = window.innerHeight;
  window.matchMedia = mediaList(() => false) as typeof window.matchMedia;
  setViewport(1200, 800);
});

afterEach(async () => {
  await unmount();
  resetCommentCardPolicy();
  if (hasDom) {
    document.body.replaceChildren();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    setViewport(originalWidth, originalHeight);
  }
});

describe.if(hasDom)('CommentPopover without the opt-in (every host but the Inbox)', () => {
  test('a selection draws today’s popover: the quoted header, Expand, Close and Save', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    expect(box()).not.toBeNull();
    expect(box()!.hasAttribute('data-comment-card')).toBe(false);
    expect(box()!.querySelector('button[title="Expand"]')).not.toBeNull();
    expect(box()!.querySelector('button[title="Close"]')).not.toBeNull();
    expect(box()!.textContent).toContain('"the words"');
    expect(buttonByText('Save')).not.toBeNull();
    expect(buttonByText('Comment')).toBeNull();
    expect(box()!.querySelector('.pn-cbox, [data-comment-card-close]')).toBeNull();
  });

  test('a global comment still says Add, and a phone still opens the full-screen dialog', async () => {
    window.matchMedia = mediaList((q) => q.includes('coarse')) as typeof window.matchMedia;
    setViewport(390, 760);
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="" isGlobal onSubmit={() => {}} onClose={() => {}} />);
    expect(buttonByText('Add')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Dismiss comment"]')).not.toBeNull();
  });
});

describe.if(hasDom)('CommentPopover as the comment card (the Inbox opts in)', () => {
  beforeEach(() => setCommentCardEnabled(true));

  test('the button says Comment, for a selection and for a global comment; no header line, no Save', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    expect(box()!.hasAttribute('data-comment-card')).toBe(true);
    expect(box()!.querySelector('[data-comment-card-submit]')!.textContent).toBe('Comment');
    expect(buttonByText('Save')).toBeNull();
    expect(box()!.querySelector('button[title="Expand"]')).toBeNull();
    expect(box()!.querySelector('[data-comment-card-submit]')!.hasAttribute('disabled')).toBe(true);
    await type('Say which plans.');
    expect(box()!.querySelector('[data-comment-card-submit]')!.hasAttribute('disabled')).toBe(false);
    await unmount();

    await mount(<CommentPopover anchorRect={ANCHOR} contextText="" isGlobal onSubmit={() => {}} onClose={() => {}} />);
    expect(box()!.querySelector('[data-comment-card-submit]')!.textContent).toBe('Comment');
    expect(buttonByText('Add')).toBeNull();
  });

  test('Comment sends the words; the bin drops them and the next open is empty', async () => {
    const sent: string[] = [];
    let closes = 0;
    const card = () => <CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} draftKey="card:bin" onSubmit={(t) => sent.push(t)} onClose={() => { closes += 1; }} />;
    await mount(card());
    expect(box()!.querySelector('[data-comment-card-discard]')).toBeNull();
    await type('Drop me');
    await act(async () => box()!.querySelector<HTMLButtonElement>('[data-comment-card-discard]')!.click());
    expect(closes).toBe(1);
    await unmount();
    await mount(card());
    expect(textarea()!.value).toBe('');
    await type('Send me');
    await act(async () => box()!.querySelector<HTMLButtonElement>('[data-comment-card-submit]')!.click());
    expect(sent).toEqual(['Send me']);
  });

  test('the chevron closes the card and keeps the words: they are back on the next open', async () => {
    let closes = 0;
    const card = () => <CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} draftKey="card:chevron" onSubmit={() => {}} onClose={() => { closes += 1; }} />;
    await mount(card());
    await type('Kept words');
    const chevron = box()!.querySelector<HTMLButtonElement>('[data-comment-card-close]')!;
    expect(chevron.getAttribute('aria-label')).toBe('Close (your words are kept)');
    await act(async () => chevron.click());
    expect(closes).toBe(1);
    await unmount();
    await mount(card());
    expect(textarea()!.value).toBe('Kept words');
  });

  test('Escape takes a card opened to full back to small first, then closes it with the words kept', async () => {
    let closes = 0;
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} draftKey="card:esc" onSubmit={() => {}} onClose={() => { closes += 1; }} />);
    await type('Half a thought');
    await act(async () => box()!.querySelector<HTMLButtonElement>('button[aria-label="Open it to full"]')!.click());
    expect(box()!.hasAttribute('data-expanded')).toBe(true);
    expect(box()!.hasAttribute('data-docked')).toBe(true);
    await escape();
    expect(closes).toBe(0);
    expect(box()!.hasAttribute('data-expanded')).toBe(false);
    await escape();
    expect(closes).toBe(1);
  });

  test('a phone docks the card at the foot: no blurred page behind it', async () => {
    window.matchMedia = mediaList((q) => q.includes('coarse')) as typeof window.matchMedia;
    setViewport(390, 760);
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    expect(box()!.hasAttribute('data-comment-card')).toBe(true);
    expect(box()!.hasAttribute('data-docked')).toBe(true);
    expect(box()!.hasAttribute('data-phone')).toBe(true);
    expect(document.querySelector('button[aria-label="Dismiss comment"]')).toBeNull();
    expect(document.querySelector('.backdrop-blur-sm')).toBeNull();
  });

  test('the card keeps a box\'s extra action, and it gets the words', async () => {
    const got: string[] = [];
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} extraAction={{ label: 'Show me', onAction: (t) => got.push(t) }} />);
    expect(box()!.hasAttribute('data-comment-card')).toBe(true);
    await type('how it flows');
    await act(async () => box()!.querySelector<HTMLButtonElement>('[data-comment-extra-action]')!.click());
    expect(got).toEqual(['how it flows']);
  });

  test('allowCard={false} draws the popover as before, its own labels and all', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} allowCard={false} submitLabel="Change it" onSubmit={() => {}} onClose={() => {}} />);
    expect(box()!.hasAttribute('data-comment-card')).toBe(false);
    expect(box()!.querySelector('[data-comment-card-close]')).toBeNull();
    expect(buttonByText('Change it')).not.toBeNull();
  });
});

describe.if(hasDom)('The comment card: "/" lists the skills, and its words drag it', () => {
  beforeEach(() => {
    setCommentCardEnabled(true);
    resetSkillCatalogCache();
    setSkillCatalogTransport(async () => [
      { name: 'tidy-notes', root: 'claude', description: 'Tidy a page of notes.', humanOnly: false },
      { name: 'check-figures', root: 'claude', humanOnly: false },
    ]);
  });
  afterEach(() => {
    resetSkillCatalogCache();
    resetSkillCatalogTransport();
  });

  test('"/" opens the skill list outside the scrolling field, and a pick writes the reference into the words', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} skillReferences onSubmit={() => {}} onClose={() => {}} />);
    await typeAtCaret('Before the inspector comes /');
    const menu = document.querySelector<HTMLElement>('[data-skill-menu]');
    expect(menu !== null).toBe(true);
    expect([...menu!.querySelectorAll('[data-skill-item]')].map((row) => row.getAttribute('data-skill-item'))).toEqual(['tidy-notes', 'check-figures']);
    // The field scrolls (overflow-y: auto in comment-card.css), so a list inside it is clipped
    // away whole: it hangs off the card, which stops clipping while the list is open.
    expect(menu!.closest('.pn-cbox-field') === null).toBe(true);
    expect(menu!.parentElement === box()).toBe(true);
    expect(box()!.style.overflow).toBe('visible');
    await act(async () => {
      menu!.querySelector('[data-skill-item="check-figures"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(textarea()!.value).toBe('Before the inspector comes /check-figures ');
    expect(document.querySelector('[data-skill-menu]')).toBeNull();
  });

  test('dragging the quoted words moves the card that far, open, with its words', async () => {
    let closes = 0;
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => { closes += 1; }} />);
    await type('Half a thought');
    giveLayout(box()!, 352, 120);
    const from = place();
    await drag(box()!.querySelector('.pn-cbox-quote')!, 60, 80);
    expect(place()).toEqual({ left: from.left + 60, top: from.top + 80 });
    expect(closes).toBe(0);
    expect(textarea()!.value).toBe('Half a thought');
    expect(box()!.style.bottom).toBe('');
  });

  test('a card dragged past a corner stays whole inside the window', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    giveLayout(box()!, 352, 120);
    await drag(box()!.querySelector('.pn-cbox-quote')!, 5000, 5000);
    expect(place()).toEqual({ left: 1200 - 352, top: 800 - 120 });
    await drag(box()!.querySelector('.pn-cbox-quote')!, -5000, -5000);
    expect(place()).toEqual({ left: 0, top: 0 });
  });

  test('opened to full, a dragged card docks at the foot again', async () => {
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    giveLayout(box()!, 352, 120);
    await drag(box()!.querySelector('.pn-cbox-quote')!, 60, 80);
    expect(box()!.style.top).not.toBe('');
    await act(async () => box()!.querySelector<HTMLButtonElement>('button[aria-label="Open it to full"]')!.click());
    expect(box()!.hasAttribute('data-docked')).toBe(true);
    expect(box()!.style.top).toBe('');
    expect(box()!.style.bottom).not.toBe('');
  });

  test('a phone\'s docked card does not move', async () => {
    window.matchMedia = mediaList((q) => q.includes('coarse')) as typeof window.matchMedia;
    setViewport(390, 760);
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    giveLayout(box()!, 374, 160);
    const bottom = box()!.style.bottom;
    await drag(box()!.querySelector('.pn-cbox-quote')!, -40, -200);
    expect(box()!.style.bottom).toBe(bottom);
    expect(box()!.style.top).toBe('');
  });

  test('without the opt-in the popover drags as it did: 50 px of it may stay on screen', async () => {
    resetCommentCardPolicy();
    await mount(<CommentPopover anchorRect={ANCHOR} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    giveLayout(box()!, 384, 200);
    const header = [...box()!.querySelectorAll<HTMLElement>('div')].find((el) => el.style.cursor === 'grab');
    await drag(header!, 5000, 5000);
    expect(place()).toEqual({ left: 1200 - 50, top: 800 - 50 });
  });
});
