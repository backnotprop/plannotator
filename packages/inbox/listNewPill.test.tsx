/**
 * The list's own "N new" pill (components/ListNewPill.tsx; the owner's pick "A · Pill") and the held bar's words
 * for a screen reader, on the window's own InboxList fed as App feeds it (held.ts `heldNotice`, `showLandsIn`; Show
 * adopts the latest read). The rule is listNewState.ts (the owner, 2026-11-17). What is proved:
 *  - held news never shows the pill, wherever the reader is scrolled: the bar is its sign, and Show asks for no move;
 *  - after Show, the rows it brought in that are out of view are counted; a press goes there;
 *  - one direction at a time, the side with more (a tie is below), never one number for both;
 *  - it waits while the list is covered or the tab is hidden;
 *  - its name is whole, and it is said once as it comes;
 *  - the bar's count is said once each time it changes, politely, and not when Show takes the bar away;
 *  - the other answer to "how long" (`stays` false): five seconds from the last row, then a fade.
 *
 * The clock is bun's fake one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';
import type { UnseenRow } from './showLight';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { ListNewPill, LIST_NEW_PILL_MS, LIST_NEW_PILL_FADE_MS, LIST_NEW_PILL_STAYS } = (hasDom ? await import('./components/ListNewPill') : {}) as typeof import('./components/ListNewPill');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_GROUPS_COOKIE } = await import('./listGroups');
const { writeListView } = await import('./listView');
const { heldNotice, showLandsIn } = await import('./held');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
const realMatchMedia = hasDom ? window.matchMedia : undefined;
let hidden = false;

beforeEach(() => {
  if (!hasDom) return;
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  jest.useFakeTimers();
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  jest.useRealTimers();
  window.matchMedia = realMatchMedia!;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  writeListView('grouped');
  resetStorageBackend();
});

const LONG_AGO = '2026-10-10T10:00:00.000Z';
let clock = Date.parse('2026-11-08T10:00:00.000Z');
/** A later moment each time: every arrival is newer than what is on screen. */
const later = () => new Date((clock += 60_000)).toISOString();

function row(id: string, section: InboxSectionId, at = LONG_AGO): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: at,
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: section === 'waiting' ? 1 : 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: section === 'waiting',
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section,
    unread: section === 'waiting' || section === 'new',
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  } as InboxListRow;
}

const LABELS: Record<string, string> = { holding: 'Holding up work', waiting: 'Waiting on you', new: 'New since you looked', sent: 'Sent', quiet: 'Quiet' };
const ORDER: InboxSectionId[] = ['holding', 'waiting', 'new', 'sent', 'quiet'];
/** The list's sections, every one present (the empty ones too), each row in the section its state says. */
const sections = (rows: InboxListRow[]): InboxListSection[] =>
  ORDER.map((id) => ({ id, label: LABELS[id]!, threads: rows.filter((r) => r.section === id).sort((a, b) => b.last_at.localeCompare(a.last_at)) }));

const ON_SCREEN = [row('t_wait', 'waiting'), row('t_new', 'new'), row('t_sent', 'sent'), row('t_quiet', 'quiet')];

/** The test's hands on the list App would hold. */
let arrive: (...rows: InboxListRow[]) => void = () => {};
let setCovered: (covered: boolean) => void = () => {};
let setUnseen: (rows: UnseenRow[]) => void = () => {};
/** Another list (its title) in the same render as an arrival: a project or folder switched to. */
let switchTo: (title: string, ...rows: InboxListRow[]) => void = () => {};
const shows: string[] = [];
const goes: string[] = [];

function HeldList() {
  const [shown, setShown] = useState(() => sections(ON_SCREEN));
  const [latest, setLatest] = useState(shown);
  const [covered, cover] = useState(false);
  const [title, setTitle] = useState('Inbox');
  const add = (rows: InboxListRow[]) => setLatest((was) => sections([...was.flatMap((s) => s.threads).filter((old) => !rows.some((r) => r.thread_id === old.thread_id)), ...rows]));
  arrive = (...rows) => act(() => add(rows));
  switchTo = (next, ...rows) =>
    act(() => {
      setTitle(next);
      add(rows);
    });
  setCovered = (next) => act(() => cover(next));
  const [unseen, see] = useState<UnseenRow[]>([]);
  setUnseen = (next) => act(() => see(next));
  const held = heldNotice(shown, latest);
  return (
    <SidebarProvider>
      <div className="pn-inbox">
        <InboxList
          title={title}
          path={null}
          sections={shown}
          filtered={false}
          narrow={false}
          selectedThreadId={null}
          notice={held.text ? { count: held.count, project: held.project ?? null, lands: showLandsIn(shown, latest) } : null}
          covered={covered}
          onShowNew={() => {
            shows.push('show');
            setShown(latest);
          }}
          unseenNew={unseen}
          onGoNew={(edge) => goes.push(edge)}
          onOpen={() => {}}
        />
      </div>
    </SidebarProvider>
  );
}

function draw(): void {
  shows.length = 0;
  goes.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<HeldList />));
}

const pill = () => host!.querySelector<HTMLButtonElement>('[data-list-new-pill]')!;
/** On screen and usable: drawn, in the Tab order, not hidden from a screen reader. */
const pillOn = () => !pill().hasAttribute('data-off') && pill().tabIndex === 0 && pill().getAttribute('aria-hidden') !== 'true';
const fading = () => pill().hasAttribute('data-fading');
const edge = () => pill().parentElement!.getAttribute('data-edge');
const said = () => host!.querySelector('[data-list-new-said]')!.textContent;
const line = () => host!.querySelector<HTMLButtonElement>('[data-inbox-notice]');
const pass = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const isOpen = (id: InboxListGroupId) => host!.querySelector(`[data-section-id="${id}"] > .ib-band`)!.getAttribute('aria-expanded') === 'true';
const drawn = (threadId: string) => host!.querySelector(`[data-thread-id="${threadId}"]`) !== null;
const heard = () => host!.querySelector('[data-held-said]')!.textContent;
const point = (type: 'pointerenter' | 'pointerleave') => act(() => void pill().dispatchEvent(new PointerEvent(type === 'pointerenter' ? 'pointerover' : 'pointerout', { bubbles: true, pointerType: 'mouse' })));


/**
 * A browser that says everything it is asked about is scrolled away above: the reader is far down the list. Held
 * news must still show no pill (an earlier rule showed one while the bar was out of view).
 */
class ScrolledAway {
  constructor(readonly notify: (entries: IntersectionObserverEntry[]) => void) {}
  observe(target: Element) {
    queueMicrotask(() => this.notify([{ target, intersectionRatio: 0, isIntersecting: false, boundingClientRect: { top: 20, bottom: 58 }, rootBounds: { top: 100, bottom: 700 } } as unknown as IntersectionObserverEntry]));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

test.skipIf(!hasDom)('held news never shows the pill, wherever the reader is scrolled: the bar is its sign', async () => {
  const real = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = ScrolledAway as unknown as typeof IntersectionObserver;
  try {
    draw();
    arrive(row('t_a', 'new', later()), row('t_b', 'waiting', later()));
    await act(async () => {});
    expect(line()!.textContent).toContain('2 new');
    expect(pillOn()).toBe(false);
    expect(said()).toBe('');
    // It stays that way: no clock brings it.
    pass(LIST_NEW_PILL_MS * 4);
    expect(pillOn()).toBe(false);
    // The list did not move: the rows are not drawn until Show.
    expect(drawn('t_a')).toBe(false);
  } finally {
    globalThis.IntersectionObserver = real;
  }
});

test.skipIf(!hasDom)('Tab order: the pill, then the bar, then the rows; the bar is in the list\'s scroll box', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  setUnseen([{ id: 't_x', edge: 'bottom' }]);
  const order = [...host!.querySelectorAll<HTMLElement>('[data-list-new-pill], [data-inbox-notice], [data-thread-id]')].map((el) => (el.hasAttribute('data-list-new-pill') ? 'pill' : el.hasAttribute('data-inbox-notice') ? 'bar' : 'row'));
  expect(order.slice(0, 3)).toEqual(['pill', 'bar', 'row']);
  // A direct child of the scroll box: inbox.css keys the rows' scroll padding (↑ ↓, J/K, Tab stop below the bar) on it.
  expect(host!.querySelector('[data-held-bar]')!.parentElement!.classList.contains('ib-lbody')).toBe(true);
});

test.skipIf(!hasDom)('Show draws the rows and opens the folded group they land in, and asks for no move; the pill comes only for rows that landed out of view', () => {
  // The person closed New since you looked.
  stored.set(LIST_GROUPS_COOKIE, 'new:1762400000000');
  draw();
  expect(isOpen('new')).toBe(false);
  arrive(row('t_a', 'new', later()));
  expect(pillOn()).toBe(false);

  act(() => line()!.click());
  expect(shows).toEqual(['show']);
  expect(goes).toEqual([]);
  expect(line()).toBeNull();
  expect(isOpen('new')).toBe(true);
  expect(drawn('t_a')).toBe(true);
  // Landed in view: nothing to point at.
  expect(pillOn()).toBe(false);
  // Landed below the view: now the pill, to say where and take the reader there.
  setUnseen([{ id: 't_a', edge: 'bottom' }]);
  expect(pillOn()).toBe(true);
  expect(pill().getAttribute('aria-label')).toBe('1 new message below, go there');
});

test.skipIf(!hasDom)('it stays and counts: no clock takes it away', () => {
  expect(LIST_NEW_PILL_STAYS).toBe(true);
  draw();
  setUnseen([{ id: 't_a', edge: 'bottom' }]);
  expect(pill().textContent).toBe('1 new');
  pass(LIST_NEW_PILL_MS * 4);
  expect(pillOn() && !fading()).toBe(true);
});

test.skipIf(!hasDom)('after Show, the rows it brought in that are out of view are counted, the side with more first; a press goes there', () => {
  draw();
  expect(pillOn()).toBe(false);
  // Show brought three rows in: two past the bottom edge, one past the top. The side with more is counted.
  setUnseen([{ id: 't_a', edge: 'top' }, { id: 't_b', edge: 'bottom' }, { id: 't_c', edge: 'bottom' }]);
  expect(pillOn()).toBe(true);
  expect(pill().textContent).toBe('2 new');
  expect(edge()).toBe('bottom');
  expect(pill().getAttribute('aria-label')).toBe('2 new messages below, go there');

  act(() => pill().click());
  expect(goes).toEqual(['bottom']);
  expect(shows).toEqual([]);
  // Focus is not left on the pill.
  expect(document.activeElement).not.toBe(pill());
  // The reader is there: those two are seen. The one above is what is left.
  setUnseen([{ id: 't_a', edge: 'top' }]);
  expect(pill().textContent).toBe('1 new');
  expect(edge()).toBe('top');
  expect(pill().getAttribute('aria-label')).toBe('1 new message above, go there');
  // They scroll up to it themselves: gone.
  setUnseen([]);
  expect(pillOn()).toBe(false);
});

test.skipIf(!hasDom)('a tie is below; more above points up', () => {
  draw();
  setUnseen([{ id: 't_c', edge: 'bottom' }, { id: 't_d', edge: 'top' }]);
  expect(pill().textContent).toBe('1 new');
  expect(edge()).toBe('bottom');
  setUnseen([{ id: 't_c', edge: 'bottom' }, { id: 't_d', edge: 'top' }, { id: 't_e', edge: 'top' }]);
  expect(pill().textContent).toBe('2 new');
  expect(edge()).toBe('top');
});

test.skipIf(!hasDom)('it waits while a thread covers the list or the tab is hidden, and shows when the reader is back', () => {
  draw();
  setCovered(true);
  setUnseen([{ id: 't_a', edge: 'bottom' }]);
  expect(pillOn()).toBe(false);
  setCovered(false);
  expect(pillOn()).toBe(true);

  hidden = true;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
  expect(pillOn()).toBe(false);
  hidden = false;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
  expect(pillOn()).toBe(true);
});

test.skipIf(!hasDom)('it is said once as it comes, not again as its count grows', () => {
  draw();
  const region = host!.querySelector('[data-list-new-said]')!;
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(said()).toBe('');
  setUnseen([{ id: 't_a', edge: 'bottom' }]);
  expect(said()).toBe('1 new message below');
  setUnseen([{ id: 't_a', edge: 'bottom' }, { id: 't_b', edge: 'bottom' }]);
  expect(pill().getAttribute('aria-label')).toBe('2 new messages below, go there');
  expect(said()).toBe('1 new message below');
  // Gone: the region is empty, so the next pill is said afresh.
  setUnseen([]);
  expect(said()).toBe('');
});

test.skipIf(!hasDom)('the bar\'s count is said once per change, politely; a redraw says nothing again, and Show empties it', () => {
  draw();
  const region = host!.querySelector('[data-held-said]')!;
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(heard()).toBe('');
  arrive(row('t_a', 'new', later()));
  expect(heard()).toBe('1 new in alpha');
  // A redraw that changes no count (the list covered and back, a scroll's re-render) says it no more.
  setCovered(true);
  setCovered(false);
  expect(heard()).toBe('1 new in alpha');
  arrive(row('t_b', 'new', later()));
  expect(heard()).toBe('2 new in alpha');
  // Show takes the bar away: the region is emptied, which says nothing, so the next count is said afresh.
  act(() => line()!.click());
  expect(line()).toBeNull();
  expect(heard()).toBe('');
  arrive(row('t_c', 'new', later()));
  expect(heard()).toBe('1 new in alpha');
});

test.skipIf(!hasDom)('switching to another project or folder says nothing: that list\'s count is not news that arrived', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  expect(heard()).toBe('1 new in alpha');
  // Another list whose bar holds two: nothing is said, and the last words are not left behind.
  switchTo('alpha', row('t_b', 'new', later()));
  expect(line()!.textContent).toContain('2 new');
  expect(heard()).toBe('');
  // News that arrives there is said.
  arrive(row('t_c', 'new', later()));
  expect(heard()).toBe('3 new in alpha');
});

test.skipIf(!hasDom)('the List view: held news shows the bar and no pill', () => {
  writeListView('list');
  draw();
  arrive(row('t_a', 'new', later()));
  expect(line()!.textContent).toContain('1 new');
  expect(pillOn()).toBe(false);
});

// ---- The other answer to "how long does it stay" (`stays` false): five seconds, then a fade. ----

let setRows: (rows: UnseenRow[]) => void = () => {};
function FadingPill() {
  const [rows, set] = useState<UnseenRow[]>([]);
  setRows = (next) => act(() => set(next));
  return (
    <div className="pn-inbox">
      <ListNewPill unseen={rows} covered={false} onGo={() => {}} stays={false} />
    </div>
  );
}
function drawFading(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<FadingPill />));
}
const below = (id: string): UnseenRow => ({ id, edge: 'bottom' });

test.skipIf(!hasDom)('fading: rows add up and start the five seconds again; rows after it has gone start at their own count', () => {
  drawFading();
  setRows([below('a')]);
  expect(pill().textContent).toBe('1 new');
  pass(LIST_NEW_PILL_MS - 1000);
  setRows([below('a'), below('b')]);
  expect(pill().textContent).toBe('2 new');
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);
  pass(1);
  expect(pillOn() && fading()).toBe(true);
  // A row joining during the fade brings it back whole.
  setRows([below('a'), below('b'), below('c')]);
  expect(fading()).toBe(false);
  expect(pill().textContent).toBe('3 new');
  pass(LIST_NEW_PILL_MS + LIST_NEW_PILL_FADE_MS);
  expect(pillOn()).toBe(false);

  setRows([below('a'), below('b'), below('c'), below('d')]);
  expect(pillOn()).toBe(true);
  expect(pill().textContent).toBe('1 new');
});

test.skipIf(!hasDom)('fading: the pointer on it holds it; leaving it starts the fade', () => {
  drawFading();
  setRows([below('a')]);
  pass(LIST_NEW_PILL_MS - 500);
  point('pointerenter');
  pass(LIST_NEW_PILL_MS * 3);
  expect(pillOn() && !fading()).toBe(true);
  point('pointerleave');
  pass(1);
  expect(pillOn() && fading()).toBe(true);
  pass(LIST_NEW_PILL_FADE_MS);
  expect(pillOn()).toBe(false);
});

test.skipIf(!hasDom)('fading, reduced motion: there for five seconds, then gone, with no fade', () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  drawFading();
  setRows([below('a')]);
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);
  pass(1);
  expect(pillOn()).toBe(false);
  expect(fading()).toBe(false);
});
