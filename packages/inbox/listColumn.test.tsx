/**
 * The list column beside an open thread has the sidebar's resize edge
 * (shell/ListColumnEdge.tsx over the same useResizablePanel, CollapsibleEdge
 * and ResizeHandle). What this catches: the separator losing its keyboard
 * contract or its announced range, the width escaping [380, room - 480], the
 * width not persisting, the edge showing where it must not (the full list, a
 * phone), and the rows not following the column across the wide rows' width
 * (or swapping on every resize instead of once at the boundary). Pixel drags
 * on the compiled binary are proved in tests/e2e/inbox-list-resize.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { PHONE_QUERY } from './phone';

const hasDom = typeof document !== 'undefined';
const { InboxList, WIDE_ROWS_MIN_LIST_WIDTH } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_COLUMN_MIN, READING_PANE_MIN, LIST_COLUMN_WIDTH_KEY } = (hasDom ? await import('./shell/ListColumnEdge') : {}) as typeof import('./shell/ListColumnEdge');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

// The width persists through Plannotator's storage (cookies in the app); a map stands in for them here.
const stored = new Map<string, string>();

// The room `.ib-main` reports: happy-dom lays nothing out.
const ROOM = 1400;

function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing-svc' },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const SECTIONS: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [row('msg_a'), row('msg_b')] }];

// A ResizeObserver that reports what a browser would for the list: its border
// box (the inline width) and a content box 1px narrower (its right border).
const observed: Array<{ el: Element; callback: ResizeObserverCallback }> = [];
const savedObserver = hasDom ? globalThis.ResizeObserver : undefined;
function reportListWidth() {
  for (const { el, callback } of observed) {
    if (!el.classList.contains('ib-listcol')) continue;
    const width = parseFloat((el as HTMLElement).style.width) || LIST_COLUMN_MIN;
    callback([{ contentRect: { width: width - 1 }, borderBoxSize: [{ inlineSize: width, blockSize: 0 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  }
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedInnerWidth = 0;
let room = ROOM;
const clientWidthOf = hasDom ? Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth') : undefined;

beforeEach(() => {
  if (!hasDom) return;
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  savedInnerWidth = window.innerWidth;
  room = ROOM;
  // happy-dom lays nothing out: `.ib-main` reports the room from its first
  // layout, as a browser's would (the edge measures it before the first paint).
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ib-main') ? room : 0;
    },
  });
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(el: Element) {
      observed.push({ el, callback: this.callback });
    }
    unobserve() {}
    disconnect() {
      for (let i = observed.length - 1; i >= 0; i--) if (observed[i]!.callback === this.callback) observed.splice(i, 1);
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  observed.length = 0;
  globalThis.ResizeObserver = savedObserver!;
  Object.defineProperty(window, 'innerWidth', { value: savedInnerWidth, configurable: true, writable: true });
  resetStorageBackend();
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (clientWidthOf) Object.defineProperty(Element.prototype, 'clientWidth', clientWidthOf);
});

function render(narrow: boolean): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  const draw = () =>
    root!.render(
      <SidebarProvider>
        <main className="ib-main">
          <InboxList
            title="Inbox"
            path={null}
            sections={SECTIONS}
            filtered={false}
            narrow={narrow}
            selectedThreadId={narrow ? 'msg_a' : null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
          />
        </main>
      </SidebarProvider>,
    );
  act(draw);
  return host;
}

function separator(el: HTMLElement): HTMLElement {
  const sep = el.querySelector<HTMLElement>('[role="separator"][aria-label="List width"]');
  expect(sep).not.toBeNull();
  return sep!;
}

function press(sep: HTMLElement, key: string) {
  act(() => {
    sep.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

const column = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-listcol')!;
const max = () => ROOM - READING_PANE_MIN;

describe.if(hasDom)('the list column beside an open thread', () => {
  test('announces its range: today’s width is the floor, the thread pane keeps its minimum', () => {
    const el = render(true);
    const sep = separator(el);
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('tabindex')).toBe('0');
    expect(sep.getAttribute('aria-valuemin')).toBe(String(LIST_COLUMN_MIN));
    expect(sep.getAttribute('aria-valuemax')).toBe(String(max()));
    expect(sep.getAttribute('aria-valuenow')).toBe(String(LIST_COLUMN_MIN));
    expect(column(el).style.width).toBe(`${LIST_COLUMN_MIN}px`);
    // It names the column it resizes.
    expect(column(el).id).not.toBe('');
    expect(sep.getAttribute('aria-controls')).toBe(column(el).id);
  });

  test('the range is measured from the column’s room on mount, with no resize event', () => {
    // The window is narrower than the room here, so a window-based max would differ.
    expect(window.innerWidth - READING_PANE_MIN).not.toBe(max());
    const el = render(true);
    expect(separator(el).getAttribute('aria-valuemax')).toBe(String(max()));
  });

  test('no separator when the window leaves no room to widen into', () => {
    room = LIST_COLUMN_MIN + READING_PANE_MIN;
    const el = render(true);
    expect(el.querySelector('[role="separator"]')).toBeNull();
    expect(column(el).classList.contains('ib-resizable')).toBe(true);
  });

  test('the wide rows start at a 900px border box (the content box is 899 there)', () => {
    const el = render(true);
    const sep = separator(el);
    for (let i = 0; LIST_COLUMN_MIN + 10 * i < WIDE_ROWS_MIN_LIST_WIDTH; i++) press(sep, 'ArrowRight');
    expect(column(el).style.width).toBe(`${WIDE_ROWS_MIN_LIST_WIDTH}px`);
    act(reportListWidth);
    expect(el.querySelectorAll('.ib-nrow').length).toBe(0);
    expect(el.querySelectorAll('.ib-row').length).toBe(2);
  });

  test('arrow keys resize in 10px steps, Home and End go to the ends, both clamped; the width persists', () => {
    const el = render(true);
    const sep = separator(el);
    press(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe('390');
    expect(column(el).style.width).toBe('390px');
    press(sep, 'End');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(max()));
    press(sep, 'ArrowRight');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(max()));
    press(sep, 'ArrowLeft');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(max() - 10));
    press(sep, 'Home');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(LIST_COLUMN_MIN));
    press(sep, 'ArrowLeft');
    expect(sep.getAttribute('aria-valuenow')).toBe(String(LIST_COLUMN_MIN));
    // Nothing to collapse: Enter leaves the width alone.
    press(sep, 'ArrowRight');
    press(sep, 'Enter');
    expect(sep.getAttribute('aria-valuenow')).toBe('390');
    expect(stored.get(LIST_COLUMN_WIDTH_KEY)).toBe('390');

    // A reload restores it.
    act(() => root?.unmount());
    host?.remove();
    const again = render(true);
    expect(separator(again).getAttribute('aria-valuenow')).toBe('390');
    expect(column(again).style.width).toBe('390px');
  });

  test('a stored width beyond the room is drawn and announced clamped', () => {
    stored.set(LIST_COLUMN_WIDTH_KEY, '5000');
    const el = render(true);
    expect(separator(el).getAttribute('aria-valuenow')).toBe(String(max()));
  });

  test('rows switch to the wide shape once the column crosses the wide rows’ width, and only then', () => {
    const el = render(true);
    const sep = separator(el);
    act(reportListWidth);
    expect(el.querySelectorAll('.ib-nrow').length).toBe(2);
    expect(el.querySelectorAll('.ib-row').length).toBe(0);
    // Just under the boundary: still two-line, and the same row elements.
    const before = el.querySelector('.ib-nrow[data-thread-id="msg_a"]');
    for (let i = 0; LIST_COLUMN_MIN + 10 * i < WIDE_ROWS_MIN_LIST_WIDTH - 10; i++) press(sep, 'ArrowRight');
    act(reportListWidth);
    expect(Number(sep.getAttribute('aria-valuenow'))).toBe(WIDE_ROWS_MIN_LIST_WIDTH - 10);
    expect(el.querySelector('.ib-nrow[data-thread-id="msg_a"]')).toBe(before);
    // Across it: wide rows, the open thread still marked.
    press(sep, 'ArrowRight');
    act(reportListWidth);
    expect(el.querySelectorAll('.ib-nrow').length).toBe(0);
    const wide = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_a"]')!;
    expect(wide.classList.contains('ib-sel')).toBe(true);
    expect(wide.getAttribute('aria-current')).toBe('true');
    press(sep, 'ArrowRight');
    act(reportListWidth);
    expect(el.querySelector('.ib-row[data-thread-id="msg_a"]')).toBe(wide);
    // And back.
    press(sep, 'Home');
    act(reportListWidth);
    expect(el.querySelectorAll('.ib-nrow').length).toBe(2);
  });

  test('no edge on the full list, and none on a phone', () => {
    const el = render(false);
    expect(el.querySelector('[role="separator"]')).toBeNull();
    expect(column(el).style.width).toBe('');
    act(() => root?.unmount());
    host?.remove();
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true, writable: true });
    // A phone is a media query (phone.ts); happy-dom does not evaluate it against innerWidth, so it answers here.
    const savedMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === PHONE_QUERY,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const phone = render(true);
      expect(phone.querySelector('[role="separator"]')).toBeNull();
      expect(column(phone).style.width).toBe('');
      expect(column(phone).classList.contains('ib-resizable')).toBe(false);
    } finally {
      window.matchMedia = savedMatchMedia;
    }
  });
});
