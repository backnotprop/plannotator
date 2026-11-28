/**
 * The comment card docked on a phone or tablet while the on-screen keyboard is up (DOM_TESTS=1). A card under the
 * keyboard makes Safari pan the page to its field on every key while phone.ts pans it back: the screen jumps and
 * typing lags.
 *
 * iOS 26 Safari, as the owner's probe read it: the keyboard takes 403 px, the visual viewport and `innerHeight`
 * lose them, `documentElement.clientHeight` keeps the layout viewport's full height, and a docked card's
 * `bottom` is measured from that full height.
 *
 * Failures to catch:
 * - the docked card, or any part of it, outside what the keyboard leaves: in portrait, on its side, on an iPad,
 *   with the page panned or not, for words near the top, the middle or the bottom of the thread;
 * - the card's place computed from `innerHeight` (the card ends under the keyboard);
 * - a desktop window's numbers changed (`innerHeight` is kept when it is the larger);
 * - typing in the card redrawing the document it comments on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';

// React's DevTools hook, read by react-dom when it loads: it must be in place before the first import of react-dom.
interface Committed { inDocument: number; inCard: number }
const commits: Committed[] = [];
type Fiber = { tag: number; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; stateNode: unknown };
function firstHost(fiber: Fiber): Element | null {
  for (let c = fiber.child; c; c = c.child) if (c.tag === 5) return c.stateNode as Element;
  return null;
}
(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  isDisabled: false,
  renderers: new Map(),
  inject(renderer: unknown) { this.renderers.set(1, renderer); return 1; },
  checkDCE() {},
  onScheduleFiberRoot() {},
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  // DevTools' own rule: a component rendered when it mounted or did work; a subtree whose children are the same
  // fibers as before was skipped whole.
  onCommitFiberRoot(_id: number, root: { current: Fiber }) {
    const seen: Committed = { inDocument: 0, inCard: 0 };
    const stack: Fiber[] = [root.current];
    while (stack.length) {
      const fiber = stack.pop()!;
      const before = fiber.alternate;
      const component = fiber.tag === 0 || fiber.tag === 1 || fiber.tag === 11 || fiber.tag === 14 || fiber.tag === 15;
      if (component && (before === null || (fiber.flags & 1) === 1)) {
        const el = firstHost(fiber);
        if (el?.closest('[data-comment-popover]')) seen.inCard++;
        else if (el?.closest('article')) seen.inDocument++;
      }
      if (before && fiber.child === before.child) continue;
      for (let c = fiber.child; c; c = c.sibling) stack.push(c);
    }
    commits.push(seen);
  },
};

const hasDom = typeof document !== 'undefined';
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const popoverModule = await import('./CommentPopover');
const viewport = await import('../hooks/useViewportEnvironment');
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const policy = await import('../utils/commentCardPolicy');
const { computeCommentCardGeometry } = popoverModule;
const { calculateViewportEnvironment, calculateVisibleViewportBounds, layoutViewportHeight } = viewport;

interface Screen {
  width: number;
  /** The layout viewport's full height (`documentElement.clientHeight`). */
  height: number;
  /** What the keyboard covers; iOS 26 takes it off `innerHeight` too. */
  keyboard: number;
  /** How far Safari has panned the page to the field (the visual viewport's `offsetTop`). */
  pan: number;
}

/** Where the docked card ends up, in the layout viewport's px, against what the person sees. */
function dockedCard(screen: Screen, anchorTop: number) {
  const visible = screen.height - screen.keyboard;
  const win = { innerHeight: visible, document: { documentElement: { clientHeight: screen.height } } } as unknown as Window;
  const layoutHeight = layoutViewportHeight(win);
  const env = calculateViewportEnvironment({
    layoutWidth: screen.width,
    layoutHeight,
    visualViewport: { width: screen.width, height: visible, offsetTop: screen.pan, offsetLeft: 0, scale: 1 },
  });
  const bounds = calculateVisibleViewportBounds(env, 16);
  const anchor = { top: anchorTop, bottom: anchorTop + 24, left: 40, right: 300, width: 260 };
  const geo = computeCommentCardGeometry(anchor, bounds, { phone: true, expanded: false, pane: null, viewportHeight: layoutHeight });
  const bottom = layoutHeight - (geo.style.bottom as number);
  return { geo, top: bottom - (geo.style.maxHeight as number), bottom, seenTop: screen.pan, seenBottom: screen.pan + visible };
}

const IPHONE = { width: 390, height: 844 };
const IPHONE_SAFARI = { width: 393, height: 660 };
const IPHONE_SIDE = { width: 844, height: 390 };
const IPAD = { width: 820, height: 1180 };

describe('the docked card with the keyboard up', () => {
  const cases: [string, Screen][] = [
    ['iPhone, installed app, the pan undone', { ...IPHONE, keyboard: 403, pan: 0 }],
    ['iPhone, installed app, mid-pan', { ...IPHONE, keyboard: 403, pan: 270 }],
    ['iPhone in Safari (the probe: 257 of 660 left)', { ...IPHONE_SAFARI, keyboard: 403, pan: 0 }],
    ['iPhone in Safari, panned', { ...IPHONE_SAFARI, keyboard: 403, pan: 403 }],
    ['iPhone on its side (140 left)', { ...IPHONE_SIDE, keyboard: 250, pan: 0 }],
    ['iPad, panned to the field', { ...IPAD, keyboard: 380, pan: 245 }],
    ['iPad, not panned', { ...IPAD, keyboard: 380, pan: 0 }],
  ];
  for (const [name, screen] of cases) {
    for (const [where, anchorTop] of [['top', 80], ['middle', screen.height / 2], ['bottom', screen.height - 60]] as const) {
      test(`${name}, words near the ${where}: the whole card is in what the keyboard leaves`, () => {
        const card = dockedCard(screen, anchorTop);
        expect(card.geo.docked).toBe(true);
        expect(card.bottom).toBeLessThanOrEqual(card.seenBottom);
        expect(card.top).toBeGreaterThanOrEqual(card.seenTop);
        // Docked at the foot of what is seen, not floating somewhere above it.
        expect(card.seenBottom - card.bottom).toBeLessThanOrEqual(24);
      });
    }
  }

  test('no keyboard: the card docks at the foot as before', () => {
    const card = dockedCard({ ...IPHONE, keyboard: 0, pan: 0 }, 400);
    expect(card.geo.style.bottom).toBe(24);
    expect(card.geo.style.maxHeight).toBeCloseTo((844 - 32) * 0.6, 5);
  });

  test('the layout height is the larger of innerHeight and clientHeight', () => {
    const win = (innerHeight: number, clientHeight: number) =>
      ({ innerHeight, document: { documentElement: { clientHeight } } }) as unknown as Window;
    // iOS 26 with the keyboard up: innerHeight follows the visual viewport.
    expect(layoutViewportHeight(win(257, 660))).toBe(660);
    // A desktop window with a horizontal scrollbar: innerHeight, as it always was.
    expect(layoutViewportHeight(win(900, 885))).toBe(900);
    // A document without layout (clientHeight 0).
    expect(layoutViewportHeight(win(800, 0))).toBe(800);
  });
});

const originals: { prop: string; target: object; descriptor: PropertyDescriptor | undefined }[] = [];
function stub(target: object, prop: string, value: unknown): void {
  originals.push({ prop, target, descriptor: Object.getOwnPropertyDescriptor(target, prop) });
  Object.defineProperty(target, prop, { configurable: true, get: () => value });
}
function mediaList(matches: (query: string) => boolean) {
  return (query: string): MediaQueryList => ({
    matches: matches(query), media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  }) as unknown as MediaQueryList;
}

let root: import('react-dom/client').Root | null = null;
let host: HTMLElement | null = null;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const box = () => document.querySelector<HTMLElement>('[data-comment-popover]');

beforeEach(() => {
  if (!hasDom) return;
  stub(window, 'matchMedia', mediaList((q) => q.includes('coarse')));
  policy.setCommentCardEnabled(true);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  policy.resetCommentCardPolicy();
  for (const { target, prop, descriptor } of originals.splice(0).reverse()) {
    if (descriptor) Object.defineProperty(target, prop, descriptor);
    else delete (target as Record<string, unknown>)[prop];
  }
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await settle();
}

describe.if(hasDom)('the card in the window', () => {
  async function openWithKeyboard(pan: number): Promise<HTMLElement> {
    const vv = Object.assign(new EventTarget(), { width: 390, height: 441, offsetTop: pan, offsetLeft: 0, scale: 1 });
    stub(window, 'visualViewport', vv);
    stub(window, 'innerWidth', 390);
    stub(window, 'innerHeight', 441);
    stub(document.documentElement, 'clientHeight', 844);
    const CommentPopover = popoverModule.CommentPopover;
    await mount(<CommentPopover anchorRect={new DOMRect(40, 300, 260, 24)} contextText="the words" isGlobal={false} onSubmit={() => {}} onClose={() => {}} />);
    const card = box()!;
    expect(card.hasAttribute('data-docked')).toBe(true);
    expect(parseFloat(card.style.maxHeight)).toBeLessThanOrEqual(441 - 32);
    return card;
  }

  test('iOS 26 with the keyboard up: the docked card ends above the keyboard, not under it', async () => {
    const card = await openWithKeyboard(0);
    // bottom is measured from the layout viewport (844): the card's foot sits 8 px over the visible part's padded
    // edge (441 - 16), so 844 - 425 + 8. From innerHeight it was 24 px: 820 px down, under the keyboard.
    expect(card.style.bottom).toBe('427px');
  });

  test('iOS 26, the page panned 270 px to the field: the card follows what is seen', async () => {
    const card = await openWithKeyboard(270);
    // What is seen runs from 270 to 711: 844 - (711 - 16) + 8.
    expect(card.style.bottom).toBe('157px');
  });

  test('typing in the card redraws the card only, never the words it is about', async () => {
    const MARKDOWN = ['# Checkout', '', 'The payment sheet slides over the cart on small screens.', '', 'The receipt keeps the header.', ''].join('\n');
    const Viewer = viewerModule!.Viewer;
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <Viewer
          blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
          markdown={MARKDOWN}
          annotations={[]}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={null}
          mode="comment"
          inputMethod="drag"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          sourceInfo="/docs/checkout.md"
        />,
      );
    });
    await settle();
    const phrase = 'payment sheet slides';
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) { node = n as Text; break; }
    const range = document.createRange();
    range.setStart(node!, node!.textContent!.indexOf(phrase));
    range.setEnd(node!, node!.textContent!.indexOf(phrase) + phrase.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => { node!.parentElement!.closest('article')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); });
    await settle();
    const field = box()?.querySelector<HTMLTextAreaElement>('textarea');
    expect(field).toBeTruthy();

    const words = 'make the sheet short';
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field!), 'value')!.set!;
    const perKey: Committed[] = [];
    for (let i = 1; i <= words.length; i++) {
      commits.length = 0;
      await act(async () => {
        setter.call(field, words.slice(0, i));
        field!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      perKey.push(commits.reduce((sum, c) => ({ inDocument: sum.inDocument + c.inDocument, inCard: sum.inCard + c.inCard }), { inDocument: 0, inCard: 0 }));
    }
    expect(field!.value).toBe(words);
    // The counter saw the card redraw on every key (so it is attached), and nothing in the document.
    expect(perKey.every((k) => k.inCard > 0)).toBe(true);
    expect(perKey.map((k) => k.inDocument)).toEqual(perKey.map(() => 0));
  });
});
