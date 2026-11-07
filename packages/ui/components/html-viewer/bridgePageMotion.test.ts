/**
 * The bridge telling its host that the person scrolled back up, or tapped
 * (`page-scroll-up`, `page-tap`). A host with a control that fades over the
 * page (the Inbox's size icon on a phone) shows it again on either.
 *
 * These evaluate the SHIPPED functions out of the bridge's string with small
 * fakes. Guards: a scroll down, or a small jiggle up, posts nothing; a scroll
 * up of 16 px or more posts once, and a run of scroll events posts at most
 * every 200 ms; each scroller is followed on its own; a press and a lift close
 * together is a tap, posted with where it landed, while a drag, a long press
 * or a lift with no press is not; a live session posts neither.
 */
import { describe, expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

interface Api {
  noteScrollForHost: (e: { target: unknown }) => void;
  noteTapStart: (e: { clientX: number; clientY: number; isPrimary?: boolean }) => void;
  noteTapEnd: (e: { clientX: number; clientY: number }) => void;
}

function bridge(options: { live?: boolean } = {}) {
  const posted: Record<string, unknown>[] = [];
  const clock = { now: 1_000_000 };
  const page = { nodeType: 1, scrollTop: 0 };
  const fakeDocument = { scrollingElement: page, documentElement: page };
  const api = new Function(
    'document',
    'Date',
    'LIVE',
    'PREFIX',
    'postToParent',
    `var scrollTops = new WeakMap();
     var scrollUpRun = 0;
     var lastScrollUpPost = 0;
     var tapStart = null;
     ${extractFunction('noteScrollForHost')}
     ${extractFunction('noteTapStart')}
     ${extractFunction('noteTapEnd')}
     return { noteScrollForHost: noteScrollForHost, noteTapStart: noteTapStart, noteTapEnd: noteTapEnd };`,
  )(
    fakeDocument,
    { now: () => clock.now },
    options.live ? { token: 't' } : null,
    'plannotator-bridge-',
    (msg: Record<string, unknown>) => posted.push(msg),
  ) as Api;
  /** The page scrolls to `top` (the document's scroll event targets the document, not an element). */
  const scrollPage = (top: number) => {
    page.scrollTop = top;
    api.noteScrollForHost({ target: fakeDocument });
  };
  return { ...api, posted, clock, page, scrollPage };
}

const ups = (posted: Record<string, unknown>[]) => posted.filter((m) => m.type === 'plannotator-bridge-page-scroll-up').length;

describe('page-scroll-up', () => {
  test('a scroll down, or a jiggle up, posts nothing; 16 px up posts once', () => {
    const b = bridge();
    b.scrollPage(0);
    b.scrollPage(400);
    b.scrollPage(800);
    b.scrollPage(790);
    expect(ups(b.posted)).toBe(0);
    b.scrollPage(784);
    expect(b.posted).toEqual([{ type: 'plannotator-bridge-page-scroll-up' }]);
  });

  test('a long scroll up posts at most every 200 ms', () => {
    const b = bridge();
    b.scrollPage(2000);
    for (let top = 1960; top >= 1000; top -= 40) {
      b.clock.now += 16;
      b.scrollPage(top);
    }
    // 25 frames over 400 ms: the first, then one per 200 ms.
    expect(ups(b.posted)).toBe(2);
  });

  test('a scroller inside the page is followed on its own', () => {
    const b = bridge();
    const panel = { nodeType: 1, scrollTop: 300 };
    b.scrollPage(500);
    b.noteScrollForHost({ target: panel });
    // The page down, the panel up: only the panel moved up.
    b.scrollPage(900);
    panel.scrollTop = 200;
    b.noteScrollForHost({ target: panel });
    expect(ups(b.posted)).toBe(1);
  });

  test('a live session posts nothing', () => {
    const b = bridge({ live: true });
    b.scrollPage(800);
    b.scrollPage(0);
    expect(b.posted).toEqual([]);
  });
});

describe('page-tap', () => {
  test('a press and a lift close together is a tap, with where it landed', () => {
    const b = bridge();
    b.noteTapStart({ clientX: 100, clientY: 30.4 });
    b.clock.now += 120;
    b.noteTapEnd({ clientX: 104, clientY: 33.6 });
    expect(b.posted).toEqual([{ type: 'plannotator-bridge-page-tap', y: 34 }]);
  });

  test('a drag, a long press, a lift with no press and a second finger are not taps', () => {
    const b = bridge();
    b.noteTapStart({ clientX: 100, clientY: 300 });
    b.noteTapEnd({ clientX: 100, clientY: 260 });
    b.noteTapStart({ clientX: 100, clientY: 300 });
    b.clock.now += 900;
    b.noteTapEnd({ clientX: 100, clientY: 300 });
    b.noteTapEnd({ clientX: 100, clientY: 300 });
    b.noteTapStart({ clientX: 100, clientY: 300, isPrimary: false });
    b.noteTapEnd({ clientX: 100, clientY: 300 });
    expect(b.posted).toEqual([]);
  });

  test('a live session posts nothing', () => {
    const b = bridge({ live: true });
    b.noteTapStart({ clientX: 100, clientY: 30 });
    b.noteTapEnd({ clientX: 100, clientY: 30 });
    expect(b.posted).toEqual([]);
  });
});
