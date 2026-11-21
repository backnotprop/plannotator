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
 * Distances are on screen: on a page the host draws at 0.3, a finger that
 * moves 5 screen px (17 of the page's own) is still a tap. Opt-in: before the
 * host's `set-page-reports` nothing listens or posts, and each report posts
 * only when asked for.
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
  setPageReports: (data: Asked) => void;
  postContentWidth: () => void;
}

interface Asked {
  contentWidth?: boolean;
  scrollUp?: boolean;
  tap?: boolean;
  scale?: unknown;
}

/** The bridge's page reports. `ask`: the host's set-page-reports (default: scroll ups and taps, unscaled); null: never asked. */
function bridge(options: { live?: boolean; ask?: Asked | null } = {}) {
  const posted: Record<string, unknown>[] = [];
  const listened: string[] = [];
  const clock = { now: 1_000_000 };
  const page = { nodeType: 1, scrollTop: 0, scrollWidth: 1180, clientWidth: 390 };
  const fakeDocument = { scrollingElement: page, documentElement: page, body: null };
  const fakeWindow = { innerWidth: 390, addEventListener: (type: string) => listened.push(type) };
  const api = new Function(
    'window',
    'document',
    'Date',
    'LIVE',
    'PREFIX',
    'postToParent',
    `var pageReports = { contentWidth: false, scrollUp: false, tap: false, scale: 1 };
     var pageReportListeners = { contentWidth: false, motion: false };
     var lastContentWidth = '';
     var scrollTops = new WeakMap();
     var scrollUpRun = 0;
     var lastScrollUpPost = 0;
     var tapStart = null;
     ${extractFunction('postContentWidth')}
     ${extractFunction('noteScrollForHost')}
     ${extractFunction('noteTapStart')}
     ${extractFunction('noteTapEnd')}
     ${extractFunction('setPageReports')}
     return { noteScrollForHost: noteScrollForHost, noteTapStart: noteTapStart, noteTapEnd: noteTapEnd, setPageReports: setPageReports, postContentWidth: postContentWidth };`,
  )(
    fakeWindow,
    fakeDocument,
    { now: () => clock.now },
    options.live ? { token: 't' } : null,
    'plannotator-bridge-',
    (msg: Record<string, unknown>) => posted.push(msg),
  ) as Api;
  const ask = options.ask === undefined ? { scrollUp: true, tap: true } : options.ask;
  if (ask) api.setPageReports(ask);
  /** The page scrolls to `top` (the document's scroll event targets the document, not an element). */
  const scrollPage = (top: number) => {
    page.scrollTop = top;
    api.noteScrollForHost({ target: fakeDocument });
  };
  return { ...api, posted, listened, clock, page, scrollPage };
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

describe('on a page the host draws scaled', () => {
  test('a tap is measured on screen: 5 screen px of movement at 0.3 is a tap, 12 is not', () => {
    const scaled = bridge({ ask: { tap: true, scale: 0.3 } });
    // 17 page px = about 5 px on screen: a finger's ordinary jiggle.
    scaled.noteTapStart({ clientX: 200, clientY: 40 });
    scaled.noteTapEnd({ clientX: 217, clientY: 57 });
    expect(scaled.posted).toEqual([{ type: 'plannotator-bridge-page-tap', y: 57 }]);
    // 40 page px = 12 px on screen: a drag.
    scaled.noteTapStart({ clientX: 200, clientY: 40 });
    scaled.noteTapEnd({ clientX: 200, clientY: 80 });
    expect(scaled.posted.length).toBe(1);

    // Unscaled, the same 17 px is a drag, as it always was.
    const plain = bridge({ ask: { tap: true } });
    plain.noteTapStart({ clientX: 200, clientY: 40 });
    plain.noteTapEnd({ clientX: 217, clientY: 57 });
    expect(plain.posted).toEqual([]);
  });

  test('a scroll up is measured on screen too', () => {
    const b = bridge({ ask: { scrollUp: true, scale: 0.25 } });
    b.scrollPage(800);
    // 40 page px = 10 screen px: under 16.
    b.scrollPage(760);
    expect(ups(b.posted)).toBe(0);
    // 32 more page px: 18 screen px in one go.
    b.scrollPage(728);
    expect(ups(b.posted)).toBe(1);
  });

  test('a scale that is not a positive number counts as 1', () => {
    for (const scale of [0, -1, Number.NaN, '0.3']) {
      const b = bridge({ ask: { tap: true, scale } });
      b.noteTapStart({ clientX: 200, clientY: 40 });
      b.noteTapEnd({ clientX: 217, clientY: 40 });
      expect(b.posted).toEqual([]);
    }
  });
});

describe('opt-in', () => {
  test('never asked: no listeners, and nothing posts on a scroll, a tap or a resize', () => {
    const b = bridge({ ask: null });
    b.scrollPage(800);
    b.scrollPage(0);
    b.noteTapStart({ clientX: 100, clientY: 30 });
    b.noteTapEnd({ clientX: 100, clientY: 30 });
    b.postContentWidth();
    expect(b.listened).toEqual([]);
    expect(b.posted).toEqual([]);
  });

  test('each report posts only when asked for, and a repeated ask adds no second listener', () => {
    const b = bridge({ ask: { contentWidth: true } });
    expect(b.posted).toEqual([{ type: 'plannotator-bridge-content-width', width: 1180, viewport: 390 }]);
    expect(b.listened.sort()).toEqual(['load', 'resize']);
    b.noteTapStart({ clientX: 100, clientY: 30 });
    b.noteTapEnd({ clientX: 100, clientY: 30 });
    expect(b.posted.length).toBe(1);

    b.setPageReports({ contentWidth: true, tap: true, scale: 0.3 });
    b.setPageReports({ contentWidth: true, tap: true, scale: 1 });
    expect(b.listened.sort()).toEqual(['load', 'pointercancel', 'pointerdown', 'pointerup', 'resize', 'scroll']);
    // A fresh ask hears the width again, even unchanged.
    expect(b.posted.filter((m) => m.type === 'plannotator-bridge-content-width').length).toBe(3);
    b.noteTapStart({ clientX: 100, clientY: 30 });
    b.noteTapEnd({ clientX: 100, clientY: 30 });
    expect(b.posted.at(-1)).toEqual({ type: 'plannotator-bridge-page-tap', y: 30 });
    // Scroll ups were not asked for.
    b.scrollPage(800);
    b.scrollPage(0);
    expect(ups(b.posted)).toBe(0);
  });

  test('a live session adds no listeners and posts nothing, even asked', () => {
    const b = bridge({ live: true, ask: { contentWidth: true, scrollUp: true, tap: true } });
    expect(b.listened).toEqual([]);
    expect(b.posted).toEqual([]);
  });
});
