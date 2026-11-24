/**
 * The sidebar's section headings stay at the top of its one scroll while their own rows pass under them (approval
 * "inbox-sidebar-sticky-headings"), on a computer as on a phone's sheet. What is proved on the window's own Sidebar,
 * at both widths: every section is a block of its own with its heading in a row of its own (so CSS sticky holds it
 * only while its own rows pass); the heading at the top while its section runs on under it is marked stuck (its
 * hairline), and the header's line shows only while rows are under the header and no heading is stuck, never both;
 * a heading pressed while stuck folds its section and stays where it was. The real sticking and spacing are drawn by
 * the browser: tests/e2e/inbox-sidebar-spacing.spec.ts.
 *
 * happy-dom does no layout: each box's place is given here, from where the scroll is.
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

let root: Root | null = null;
let host: HTMLElement | null = null;
let phone = false;
let savedMatchMedia: typeof window.matchMedia | undefined;
let savedRect: typeof Element.prototype.getBoundingClientRect | undefined;
let savedHeight: PropertyDescriptor | undefined;
const stored = new Map<string, string>();
/** Where each box is, from the top of the scroll's box, at the scroll's current place. */
let place: (el: Element) => { top: number; bottom: number } | null = () => null;

beforeEach(() => {
  if (!hasDom) return;
  phone = false;
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ media: query, matches: query === PHONE_QUERY && phone, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  savedRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const at = place(this) ?? { top: 0, bottom: 0 };
    return { top: at.top, bottom: at.bottom, left: 0, right: 200, x: 0, y: at.top, width: 200, height: at.bottom - at.top, toJSON() {} } as DOMRect;
  };
  // A heading is 30 px tall.
  savedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.classList.contains('ib-secrow') ? 30 : 0; } });
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
  if (savedRect) Element.prototype.getBoundingClientRect = savedRect;
  if (savedHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', savedHeight);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  place = () => null;
});

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
            pins={[pin('t_a'), pin('t_b'), pin('t_c')]}
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
}
const one = (selector: string) => document.querySelector<HTMLElement>(selector)!;
const scroll = () => one('.ib-sidescroll');
const heading = (section: 'pinned' | 'projects') => one(`[data-sidebar-section="${section}"]`).closest<HTMLElement>('.ib-secrow')!;
const stuck = () => [...document.querySelectorAll('.ib-secrow[data-stuck]')].map((row) => row.querySelector('[data-sidebar-section]')!.getAttribute('data-sidebar-section'));
const edge = () => scroll().hasAttribute('data-edge');
/** Scrolls to `top` and lets the sidebar read the result. */
function scrollTo(top: number) {
  act(() => {
    scroll().scrollTop = top;
    scroll().dispatchEvent(new Event('scroll'));
  });
}

/**
 * A stand-in for the browser's layout: Starred's block from 12 to 132 and Projects' from 144 to 300, each heading 30 px
 * at the top of its block, held at the scroll's top (0) while its block runs on below it, as `position: sticky` does.
 */
function layout(pinnedRows = 90) {
  const blocks = { pinned: { top: 12, bottom: 42 + pinnedRows }, projects: { top: 54 + pinnedRows, bottom: 210 + pinnedRows } };
  place = (el) => {
    const at = scroll().scrollTop;
    if (el === scroll()) return { top: 0, bottom: 400 };
    for (const name of ['pinned', 'projects'] as const) {
      const block = heading(name).parentElement!;
      const top = blocks[name].top - at;
      const bottom = blocks[name].bottom - at;
      if (el === block) return { top, bottom };
      if (el === heading(name)) {
        const held = Math.min(Math.max(top, 0), bottom - 30);
        return { top: held, bottom: held + 30 };
      }
    }
    return null;
  };
}

for (const width of ['computer', 'phone'] as const) {
  test.skipIf(!hasDom)(`${width}: each section is a block with its heading in a row of its own, so the heading sticks only while its own rows pass`, () => {
    phone = width === 'phone';
    draw();
    for (const section of ['pinned', 'projects'] as const) {
      const block = heading(section).parentElement!;
      expect(block.classList.contains('ib-sheet-sec')).toBe(true);
      expect(block.parentElement).toBe(scroll());
      // The heading and its rows, and nothing of another section.
      expect(block.querySelector(section === 'pinned' ? '.ib-pins' : '.ib-projs')).not.toBeNull();
      expect(block.querySelectorAll('.ib-secrow')).toHaveLength(1);
    }
  });

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
    // Never both lines, all the way down and back.
    for (let at = 0; at <= 300; at += 3) {
      scrollTo(at);
      expect(stuck().length + (edge() ? 1 : 0)).toBeLessThanOrEqual(1);
    }
  });

  test.skipIf(!hasDom)(`${width}: a heading pressed while stuck folds its section and stays where it was`, () => {
    phone = width === 'phone';
    draw();
    // Folded (as drawn), Starred keeps no row: its block is its heading alone.
    layout();
    const open = place;
    place = (el) => {
      if (!one('.ib-pins').hasAttribute('data-closed')) return open(el);
      const at = scroll().scrollTop;
      if (el === heading('pinned') || el === heading('pinned').parentElement) return { top: 12 - at, bottom: 42 - at };
      return open(el);
    };
    scrollTo(60);
    expect(stuck()).toEqual(['pinned']);
    const button = one('[data-sidebar-section="pinned"]');
    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Still at the top of the scroll, where it was pressed: the scroll moved up under it instead of leaving it above.
    expect(heading('pinned').getBoundingClientRect().top).toBe(0);
    expect(scroll().scrollTop).toBe(12);
  });
}

test.skipIf(!hasDom)('a heading pressed at rest folds its section and nothing scrolls', () => {
  draw();
  layout();
  scrollTo(0);
  act(() => one('[data-sidebar-section="projects"]').click());
  expect(one('[data-sidebar-section="projects"]').getAttribute('aria-expanded')).toBe('false');
  expect(scroll().scrollTop).toBe(0);
});
