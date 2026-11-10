/**
 * The list's own "N new" pill (components/ListNewPill.tsx; the owner's pick "A · Pill"): the list holds still, so
 * the only sign of news is the "N new · Show" line at its top, and a reader scrolled down saw nothing arrive. What
 * is proved, on the window's own InboxList fed as App feeds it (held.ts `heldNotice`, `heldNews`, `showLandsIn`;
 * Show adopts the latest read):
 *  - the pill shows only while that line is out of view, and never for news the reader already had a sign of;
 *  - it counts one burst: each arrival adds to it and starts its five seconds again, and news after it has gone
 *    starts a pill at its own count;
 *  - a press is Show (the row drawn, a folded group it lands in opened), asking for the row in the middle;
 *  - news that lands in Quiet or Sent shows none;
 *  - it leaves at once when the line comes into view, holds under the pointer, and waits while the list is covered
 *    or the tab is hidden;
 *  - reduced motion: no fade;
 *  - its name is whole, and it is said once per burst.
 *
 * happy-dom has no layout: a stand-in IntersectionObserver says where the line and the landing place are, and the
 * clock is bun's fake one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { LIST_NEW_PILL_MS, LIST_NEW_PILL_FADE_MS } = (hasDom ? await import('./components/ListNewPill') : {}) as typeof import('./components/ListNewPill');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_GROUPS_COOKIE } = await import('./listGroups');
const { writeListView } = await import('./listView');
const { heldNews, heldNotice, showLandsIn } = await import('./held');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

/** The browser's observer, told by the test where things are. One is alive at a time: the pill's. */
class FakeObserver {
  static live: FakeObserver | null = null;
  targets: Element[] = [];
  constructor(
    readonly notify: (entries: IntersectionObserverEntry[]) => void,
    readonly options: IntersectionObserverInit,
  ) {
    FakeObserver.live = this;
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    if (FakeObserver.live === this) FakeObserver.live = null;
  }
  takeRecords() {
    return [];
  }
}

const VIEW = { top: 100, bottom: 700 };
type Place = 'above' | 'in view' | 'below';
const TOPS: Record<Place, number> = { above: 20, 'in view': 300, below: 900 };

/**
 * The browser reports: the "N new" line is in view or scrolled away above, and the header of the group the row
 * lands in is above, in or below the view. The same report again is a scroll that changed neither.
 */
function see(line: 'in view' | 'out of view', landing: Place = 'below'): void {
  const observer = FakeObserver.live;
  // Nothing is watched while no news could show a pill: a scroll then reports nothing.
  if (!observer) return;
  const entry = (target: Element, place: Place) =>
    ({
      target,
      intersectionRatio: place === 'in view' ? 1 : 0,
      isIntersecting: place === 'in view',
      boundingClientRect: { top: TOPS[place], bottom: TOPS[place] + 38 },
      rootBounds: VIEW,
    }) as unknown as IntersectionObserverEntry;
  act(() =>
    observer.notify(observer.targets.map((target) => (target.matches('[data-inbox-notice]') ? entry(target, line === 'in view' ? 'in view' : 'above') : entry(target, landing)))),
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
const realObserver = globalThis.IntersectionObserver;
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
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
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
  globalThis.IntersectionObserver = realObserver;
  window.matchMedia = realMatchMedia!;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  FakeObserver.live = null;
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
const shows: boolean[] = [];

function HeldList() {
  const [shown, setShown] = useState(() => sections(ON_SCREEN));
  const [latest, setLatest] = useState(shown);
  const [covered, cover] = useState(false);
  arrive = (...rows) => act(() => setLatest((was) => sections([...was.flatMap((s) => s.threads).filter((old) => !rows.some((r) => r.thread_id === old.thread_id)), ...rows])));
  setCovered = (next) => act(() => cover(next));
  const held = heldNotice(shown, latest);
  return (
    <SidebarProvider>
      <div className="pn-inbox">
        <InboxList
          title="Inbox"
          path={null}
          sections={shown}
          filtered={false}
          narrow={false}
          selectedThreadId={null}
          notice={held.text ? { count: held.count, project: held.project ?? null, lands: showLandsIn(shown, latest), news: heldNews(shown, latest) } : null}
          covered={covered}
          onShowNew={(centre) => {
            shows.push(centre === true);
            setShown(latest);
          }}
          onOpen={() => {}}
        />
      </div>
    </SidebarProvider>
  );
}

function draw(): void {
  shows.length = 0;
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
const point = (type: 'pointerenter' | 'pointerleave') => act(() => void pill().dispatchEvent(new PointerEvent(type === 'pointerenter' ? 'pointerover' : 'pointerout', { bubbles: true, pointerType: 'mouse' })));

test.skipIf(!hasDom)('news shows the pill only while the "N new" line is out of view', () => {
  draw();
  expect(pillOn()).toBe(false);

  // The reader is at the top: the line says it, and no pill.
  arrive(row('t_a', 'new', later()));
  expect(line()!.textContent).toContain('1 new');
  see('in view');
  expect(pillOn()).toBe(false);
  // They scroll down afterwards: that news had its sign, so still none.
  see('out of view');
  expect(pillOn()).toBe(false);

  // More arrives while the line is out of view: the pill, counting only what the reader has had no sign of.
  arrive(row('t_b', 'new', later()));
  see('out of view');
  expect(line()!.textContent).toContain('2 new');
  expect(pillOn()).toBe(true);
  expect(pill().textContent).toBe('1 new');
  expect(pill().getAttribute('aria-label')).toBe('1 new message below, show');
  // The list did not move: the row is not drawn until Show.
  expect(drawn('t_b')).toBe(false);
});

test.skipIf(!hasDom)('arrivals add up and start the five seconds again; news after it has gone starts at its own count', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(pill().textContent).toBe('1 new');

  pass(LIST_NEW_PILL_MS - 1000);
  arrive(row('t_b', 'new', later()));
  expect(pill().textContent).toBe('2 new');
  // A second message in a thread already counted is an arrival too: the count stays, the time starts again.
  pass(LIST_NEW_PILL_MS - 1000);
  expect(fading()).toBe(false);
  arrive(row('t_b', 'new', later()));
  expect(pill().textContent).toBe('2 new');
  pass(LIST_NEW_PILL_MS - 1000);
  arrive(row('t_c', 'waiting', later()));
  expect(pill().textContent).toBe('3 new');
  expect(pill().getAttribute('aria-label')).toBe('3 new messages below, show');

  // Five seconds after the last arrival it fades, and then it is over.
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);
  pass(1);
  expect(pillOn() && fading()).toBe(true);
  // An arrival during the fade brings it back whole.
  arrive(row('t_d', 'new', later()));
  expect(fading()).toBe(false);
  expect(pill().textContent).toBe('4 new');
  pass(LIST_NEW_PILL_MS + LIST_NEW_PILL_FADE_MS);
  expect(pillOn()).toBe(false);

  // The line still counts everything that waits; a new pill counts only what came after the last one.
  arrive(row('t_e', 'new', later()));
  see('out of view');
  expect(line()!.textContent).toContain('5 new');
  expect(pillOn()).toBe(true);
  expect(pill().textContent).toBe('1 new');
});

test.skipIf(!hasDom)('a press is Show: the row is drawn, the folded group it lands in opens, and the row is asked to the middle', () => {
  // The person closed New since you looked.
  stored.set(LIST_GROUPS_COOKIE, 'new:1762400000000');
  draw();
  expect(isOpen('new')).toBe(false);
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(pillOn()).toBe(true);

  act(() => pill().click());
  expect(shows).toEqual([true]);
  expect(line()).toBeNull();
  expect(isOpen('new')).toBe(true);
  expect(drawn('t_a')).toBe(true);
  expect(pillOn()).toBe(false);
  // Focus is not left on a pill that is gone.
  expect(document.activeElement).not.toBe(pill());

  // The line's own Show still asks only for the row in view.
  arrive(row('t_b', 'new', later()));
  act(() => line()!.click());
  expect(shows).toEqual([true, false]);
});

test.skipIf(!hasDom)('news that lands in Quiet or Sent shows no pill; the line still counts it', () => {
  draw();
  arrive(row('t_quiet', 'quiet', later()), row('t_sent', 'sent', later()));
  expect(line()!.textContent).toContain('2 new');
  see('out of view');
  expect(pillOn()).toBe(false);

  // One that waits on the person arrives too: the pill counts that one alone.
  arrive(row('t_a', 'waiting', later()));
  see('out of view');
  expect(line()!.textContent).toContain('3 new');
  expect(pill().textContent).toBe('1 new');
});

test.skipIf(!hasDom)('it leaves at once when the reader scrolls the line into view, and does not come back', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(pillOn()).toBe(true);

  pass(1000);
  see('in view');
  expect(pillOn()).toBe(false);
  see('out of view');
  pass(LIST_NEW_PILL_MS);
  expect(pillOn()).toBe(false);
});

test.skipIf(!hasDom)('the pointer on it holds it; leaving it starts the fade', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view');
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

test.skipIf(!hasDom)('reduced motion: there for five seconds, then gone, with no fade', () => {
  window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view');
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);
  pass(1);
  expect(pillOn()).toBe(false);
  expect(fading()).toBe(false);
});

test.skipIf(!hasDom)('it points to where the row will land: below the view, else up to the line', () => {
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view', 'below');
  expect(edge()).toBe('bottom');
  expect(pill().getAttribute('aria-label')).toBe('1 new message below, show');

  // The reader scrolls on past the group's header: the same pill, now at the top edge.
  see('out of view', 'above');
  expect(pillOn()).toBe(true);
  expect(edge()).toBe('top');
  expect(pill().getAttribute('aria-label')).toBe('1 new message above, show');
});

test.skipIf(!hasDom)('a group with no row yet is not drawn: the next group drawn stands for where the row lands', () => {
  draw();
  // Holding up work is empty, so it has no header; the row will land above Waiting on you.
  expect(host!.querySelector('[data-section-id="holding"]')).toBeNull();
  arrive(row('t_a', 'holding', later()));
  expect(FakeObserver.live!.targets.map((target) => target.closest('[data-section-id]')?.getAttribute('data-section-id') ?? 'line')).toEqual(['line', 'waiting']);
});

test.skipIf(!hasDom)('the List view has no groups: news lands at its top, so the pill is at the top edge', () => {
  writeListView('list');
  draw();
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(pillOn()).toBe(true);
  expect(edge()).toBe('top');
});

test.skipIf(!hasDom)('it waits while a thread covers the list or the tab is hidden, and shows when the reader is back', () => {
  draw();
  setCovered(true);
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(pillOn()).toBe(false);
  pass(LIST_NEW_PILL_MS * 2);

  // Back on the list: the pill, for its whole time.
  setCovered(false);
  expect(pillOn()).toBe(true);
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);

  // The tab goes to the background: its time stops, and starts again when the tab is back.
  hidden = true;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
  expect(pillOn()).toBe(false);
  pass(LIST_NEW_PILL_MS * 2);
  hidden = false;
  act(() => void document.dispatchEvent(new Event('visibilitychange')));
  expect(pillOn()).toBe(true);
  pass(LIST_NEW_PILL_MS - 1);
  expect(pillOn() && !fading()).toBe(true);
});

test.skipIf(!hasDom)('it is said once as it comes, not again as its count grows', () => {
  draw();
  const region = host!.querySelector('[data-list-new-said]')!;
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(said()).toBe('');
  arrive(row('t_a', 'new', later()));
  see('out of view');
  expect(said()).toBe('1 new message below');
  arrive(row('t_b', 'new', later()));
  expect(pill().getAttribute('aria-label')).toBe('2 new messages below, show');
  expect(said()).toBe('1 new message below');
  // Gone: the region is empty, so the next pill is said afresh.
  pass(LIST_NEW_PILL_MS + LIST_NEW_PILL_FADE_MS);
  expect(said()).toBe('');
});
