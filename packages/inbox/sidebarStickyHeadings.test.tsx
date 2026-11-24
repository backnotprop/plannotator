/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them (approval
 * "inbox-sidebar-sticky-headings"), on a computer as on a phone's sheet. What is proved on the window's own Sidebar,
 * at both widths: the heading at the top while its section runs on under it is marked stuck (its hairline), and the
 * header's line shows only while rows are under the header and no heading is stuck, never both; a section that appears
 * later is watched too; a heading pressed while stuck folds its section and stays where it was. And what it costs: the
 * marks are set up once and read no layout, so a render of the window (a poll, a live event, J/K) or a scroll adds no
 * listener and forces no layout. The real sticking and spacing are drawn by the browser:
 * tests/e2e/inbox-sidebar-sticky-headings.spec.ts and tests/e2e/inbox-sidebar-spacing.spec.ts.
 *
 * happy-dom does no layout and has no IntersectionObserver to watch: each box's place is given here, from where the
 * scroll is, and a stand-in observer tells the sidebar what the browser's would (the box, the observer's own box, how
 * much of it shows), never through the layout reads it counts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { SidebarProps } from './components/Sidebar';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { PHONE_QUERY } = await import('./phone');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

interface Box {
  top: number;
  bottom: number;
}

/** A stand-in IntersectionObserver: `flush()` tells each one what a browser's would after drawing. */
class Watcher {
  static all: Watcher[] = [];
  readonly targets = new Set<Element>();
  observed = 0;
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    Watcher.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
    this.observed++;
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let phone = false;
let savedMatchMedia: typeof window.matchMedia | undefined;
let savedRect: typeof Element.prototype.getBoundingClientRect | undefined;
let savedHeight: PropertyDescriptor | undefined;
let savedIO: unknown;
const stored = new Map<string, string>();
/** Where the scroll is: the test's own, so its stand-ins never read the scroll. */
let at = 0;
/** Layout reads by the sidebar: getBoundingClientRect and offsetHeight of any box, and the scroll's scrollTop. */
let reads = 0;
let tops = 0;
/** Where each box is, from the top of the scroll's box, at the scroll's current place. */
let place: (el: Element) => Box | null = () => null;

beforeEach(() => {
  if (!hasDom) return;
  phone = false;
  at = 0;
  reads = 0;
  Watcher.all = [];
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ media: query, matches: query === PHONE_QUERY && phone, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Watcher;
  savedRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    reads++;
    const box = where(this);
    return { top: box.top, bottom: box.bottom, left: 0, right: 200, x: 0, y: box.top, width: 200, height: box.bottom - box.top, toJSON() {} } as DOMRect;
  };
  savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      reads++;
      const box = where(this);
      return box.bottom - box.top;
    },
  });
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  resetStorageBackend();
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = savedIO;
  if (savedRect) Element.prototype.getBoundingClientRect = savedRect;
  if (savedHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  place = () => null;
});

/** The scroll's box is 400 px; its first pixel scrolls with it; the rest is the layout's. */
function where(el: Element): Box {
  if (el.classList.contains('ib-sidescroll')) return { top: 0, bottom: 400 };
  if (el.hasAttribute('data-scroll-top')) return { top: -at, bottom: 1 - at };
  return place(el) ?? { top: 0, bottom: 0 };
}

/**
 * What each watcher's browser would tell it now: every box it watches, against its own box (the scroll, less its margin).
 * With `only`, just the boxes it picks, in a batch of their own, as a browser can tell of one box a frame before another.
 */
function flush(only?: (el: Element) => boolean) {
  act(() => {
    for (const watcher of Watcher.all) {
      const targets = only ? [...watcher.targets].filter(only) : [...watcher.targets];
      if (targets.length === 0) continue;
      const inset = -parseFloat(String(watcher.options.rootMargin ?? '0px').split(' ')[0]!);
      const bounds = { top: inset, bottom: 400, left: 0, right: 200, x: 0, y: inset, width: 200, height: 400 - inset } as DOMRectReadOnly;
      const entries = targets.map((target) => {
        const box = where(target);
        const height = box.bottom - box.top;
        const shown = Math.max(0, Math.min(box.bottom, bounds.bottom) - Math.max(box.top, bounds.top));
        const isIntersecting = box.bottom >= bounds.top && box.top <= bounds.bottom;
        return {
          target,
          rootBounds: bounds,
          boundingClientRect: { top: box.top, bottom: box.bottom, height } as DOMRectReadOnly,
          intersectionRatio: height > 0 ? shown / height : isIntersecting ? 1 : 0,
          isIntersecting,
        } as unknown as IntersectionObserverEntry;
      });
      watcher.cb(entries, watcher as unknown as IntersectionObserver);
    }
  });
}

const folder = (id: string, name: string) => ({ id, key: `${id}-abc123`, name, root: `/tmp/${id}`, created_at: '2026-10-11T10:00:00.000Z', threads: 1, unread: 0, listed: 1 });
const PROJECTS = [folder('prj_a', 'harbor'), folder('prj_b', 'fern-api'), folder('prj_c', 'quill-docs'), folder('prj_d', 'ledger')];
const pin = (id: string) =>
  ({
    thread_id: id,
    subject: `Thread ${id}`,
    project: { id: 'prj_a', name: 'harbor' },
    author: { kind: 'agent', host: 'claude-code', session: 's', name: null },
    section: 'quiet',
    unread: false,
    unseen: 0,
    read_at: null,
    resolved_at: null,
    back_from_archive: false,
    questions: { open: 0, holds_up: [] },
  }) as unknown as InboxListRow;
const PINS = [pin('t_a'), pin('t_b'), pin('t_c')];

const noop = () => {};
function draw(over: Partial<SidebarProps> = {}) {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <SidebarProvider>
        <div className={phone ? 'ib-sb-sheet-in' : 'ib-sb-inner'}>
          <Sidebar
            page="inbox"
            projectId={null}
            inboxCount={3}
            projects={PROJECTS as never}
            projectCounts={new Map()}
            update={null}
            restarting={false}
            updated={null}
            pins={PINS}
            onInbox={noop}
            onProject={noop}
            onSettings={noop}
            onUpdate={noop}
            onWhatsNew={noop}
            {...over}
          />
        </div>
      </SidebarProvider>,
    ),
  );
  // The scroll's place is the test's: writes move it, and every read is counted.
  const scroller = scroll();
  if (!Object.getOwnPropertyDescriptor(scroller, 'scrollTop')) {
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() {
        tops++;
        return at;
      },
      set(value: number) {
        at = value;
      },
    });
  }
}
const one = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const scroll = () => one('.ib-sidescroll');
const heading = (section: 'pinned' | 'projects') => document.querySelector(`[data-sidebar-section="${section}"]`)?.closest<HTMLElement>('.ib-secrow') ?? null;
const stuck = () => [...document.querySelectorAll('.ib-secrow[data-stuck]')].map((row) => row.querySelector('[data-sidebar-section]')!.getAttribute('data-sidebar-section'));
const edge = () => scroll().hasAttribute('data-edge');
/** Scrolls to `top` and lets the browser tell the sidebar what it drew. */
function scrollTo(top: number) {
  at = top;
  act(() => void scroll().dispatchEvent(new Event('scroll')));
  flush();
}

/**
 * A stand-in for the browser's layout: Starred's block from 12 to 132 and Projects' from 144 to 300 (Projects' alone
 * from 12 when Starred is not drawn), each heading 30 px at the top of its block, held at the scroll's top (0) while
 * its block runs on below it, as `position: sticky` does.
 */
function layout(pinnedRows = 90) {
  place = (el) => {
    const starred = heading('pinned');
    const blocks = starred
      ? { pinned: { top: 12, bottom: 42 + pinnedRows }, projects: { top: 54 + pinnedRows, bottom: 210 + pinnedRows } }
      : { projects: { top: 12, bottom: 168 } };
    for (const [name, block] of Object.entries(blocks) as ['pinned' | 'projects', Box][]) {
      const head = heading(name)!;
      const top = block.top - at;
      const bottom = block.bottom - at;
      if (el === head.parentElement) return { top, bottom };
      if (el === head) {
        const held = Math.min(Math.max(top, 0), bottom - 30);
        return { top: held, bottom: held + 30 };
      }
    }
    return null;
  };
}

for (const width of ['computer', 'phone'] as const) {
  test.skipIf(!hasDom)(`${width}: the heading at the top takes its hairline while its rows pass under it; the header's line shows only while none does`, () => {
    phone = width === 'phone';
    draw();
    layout();
    // At rest: nothing under the header, no line.
    scrollTo(0);
    expect(stuck()).toEqual([]);
    expect(edge()).toBe(false);
    // A few pixels down, before Starred's heading reaches the top: rows are not yet under it, the header has the line.
    scrollTo(6);
    expect(stuck()).toEqual([]);
    expect(edge()).toBe(true);
    // Starred's rows pass under its heading: the heading's hairline, and not the header's.
    scrollTo(60);
    expect(stuck()).toEqual(['pinned']);
    expect(edge()).toBe(false);
    // Projects pushes Starred off: Starred is no longer stuck, the header shows the line until Projects reaches the top.
    scrollTo(110);
    expect(stuck()).toEqual([]);
    expect(edge()).toBe(true);
    scrollTo(200);
    expect(stuck()).toEqual(['projects']);
    expect(edge()).toBe(false);
    // Never both lines, all the way down and back; and back at the top, none.
    for (let top = 0; top <= 300; top += 3) {
      scrollTo(top);
      expect(stuck().length + (edge() ? 1 : 0)).toBeLessThanOrEqual(1);
    }
    scrollTo(0);
    expect(stuck().length + (edge() ? 1 : 0)).toBe(0);
  });

  test.skipIf(!hasDom)(`${width}: when the browser tells of one heading a batch before the other, never two are stuck`, () => {
    phone = width === 'phone';
    draw();
    layout();
    const of = (section: 'pinned' | 'projects') => (el: Element) => el === heading(section) || el === heading(section)!.parentElement;
    // Down from Starred's rows into Projects', and back up, with either heading's news first.
    for (const [from, to, first, then, want] of [
      [60, 200, 'projects', 'pinned', 'projects'],
      [60, 200, 'pinned', 'projects', 'projects'],
      [200, 60, 'pinned', 'projects', 'pinned'],
      [200, 60, 'projects', 'pinned', 'pinned'],
    ] as const) {
      scrollTo(from);
      expect(stuck()).toEqual([from === 60 ? 'pinned' : 'projects']);
      at = to;
      flush(of(first));
      expect(stuck().length).toBeLessThanOrEqual(1);
      expect(stuck().length + (edge() ? 1 : 0)).toBe(1);
      flush(of(then));
      expect(stuck()).toEqual([want]);
      expect(edge()).toBe(false);
    }
  });

  test.skipIf(!hasDom)(`${width}: renders and scrolls add no listener and read no layout`, () => {
    phone = width === 'phone';
    draw();
    layout();
    scrollTo(60);
    expect(stuck()).toEqual(['pinned']);
    const scroller = scroll();
    const listeners: string[] = [];
    const add = scroller.addEventListener.bind(scroller);
    const remove = scroller.removeEventListener.bind(scroller);
    scroller.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, AddEventListenerOptions?]) => {
      listeners.push(`+${type}`);
      add(type, ...rest);
    }) as typeof scroller.addEventListener;
    scroller.removeEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, EventListenerOptions?]) => {
      listeners.push(`-${type}`);
      remove(type, ...rest);
    }) as typeof scroller.removeEventListener;
    const watchers = Watcher.all.length;
    const observed = Watcher.all.reduce((sum, w) => sum + w.observed, 0);
    reads = 0;
    tops = 0;
    // The window draws again and again with nothing new for the sidebar (a poll, a live event, J/K in the list).
    for (let i = 0; i < 5; i++) draw({ inboxCount: 3 + i });
    expect(listeners).toEqual([]);
    expect(Watcher.all.length).toBe(watchers);
    expect(Watcher.all.reduce((sum, w) => sum + w.observed, 0)).toBe(observed);
    expect(reads).toBe(0);
    expect(tops).toBe(0);
    // A scroll measures no box either: the browser tells where things are, after it has drawn. (The fade at the
    // scroll's foot reads its own scrollTop on scroll, as before: useMoreBelow.)
    scrollTo(200);
    expect(stuck()).toEqual(['projects']);
    expect(reads).toBe(0);
  });

  test.skipIf(!hasDom)(`${width}: a section drawn later is watched too`, async () => {
    phone = width === 'phone';
    draw({ pins: [] });
    layout();
    expect(heading('pinned')).toBeNull();
    // Stars arrive: Starred's block is drawn above Projects, and its heading sticks like the others.
    draw();
    await act(async () => {
      await Promise.resolve();
    });
    scrollTo(60);
    expect(stuck()).toEqual(['pinned']);
    scrollTo(200);
    expect(stuck()).toEqual(['projects']);
  });

  test.skipIf(!hasDom)(`${width}: a heading pressed while stuck folds its section and stays where it was`, () => {
    phone = width === 'phone';
    draw();
    // Folded (as drawn), Starred keeps no row: its block is its heading alone.
    layout();
    const open = place;
    place = (el) => {
      if (!one('.ib-pins').hasAttribute('data-closed')) return open(el);
      if (el === heading('pinned') || el === heading('pinned')!.parentElement) return { top: 12 - at, bottom: 42 - at };
      return open(el);
    };
    scrollTo(60);
    expect(stuck()).toEqual(['pinned']);
    const button = one('[data-sidebar-section="pinned"]');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Still at the top of the scroll, where it was pressed: the scroll moved up under it instead of leaving it above.
    expect(heading('pinned')!.getBoundingClientRect().top).toBe(0);
    expect(at).toBe(12);
    // Folded, its section is its heading alone: nothing passes under it, so the header's line shows instead of its own.
    flush();
    expect(stuck()).toEqual([]);
    expect(edge()).toBe(true);
  });
}

test.skipIf(!hasDom)('a heading pressed at rest folds its section and nothing scrolls', () => {
  draw();
  layout();
  scrollTo(0);
  act(() => one('[data-sidebar-section="projects"]').click());
  expect(one('[data-sidebar-section="projects"]').getAttribute('aria-expanded')).toBe('false');
  expect(at).toBe(0);
});
