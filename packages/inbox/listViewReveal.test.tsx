/**
 * The List view's one-time choice in a DOM (approval "inbox-list-view-dialog"), registered with the Inbox's schedule
 * of one-time dialogs (approval "inbox-one-time-dialogs", the change): the line's hook (reveal.ts `useLineReveal`)
 * with List view's own moment and need, driving `ListViewIntro`, as App wires them.
 *
 * What regresses: the dialog arming without the line (settings `reveal.next` is not `list_view` and `reveal.ahead`
 * does not name it, or an older Inbox reports no line); opening without the line's claim (`POST /api/inbox/reveal`
 * `list_view`) or after the Inbox refused it; showing on load, or with any one blocker present (the list not taller
 * than the screen, the list already Simple, another one-time dialog this load, a toast, something typed or open, a
 * thread left for another thread while the page is not idle); the page going idle not being its moment in a split
 * view, where a thread stays open beside the list and the person goes thread to thread, never back to the list (the
 * owner, 2026-11-08: "Some people may never see them"), or an idle page claiming before the page's age; "Simple list"
 * not switching the list at once or not remembering it as the ⋮ menu
 * does; Escape or a click outside not counting as the line's Not now, or a pick counting as one.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxRevealId } from './api';
import type { ListView } from './listView';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const idleClock = (hasDom ? await import('./idleClock') : {}) as typeof import('./idleClock');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { ListViewIntro } = (hasDom ? await import('./components/ListViewIntro') : {}) as typeof import('./components/ListViewIntro');
const listView = await import('./listView');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const { readListLook } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedIdleMs = 0;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];
/** Whether the Inbox grants the claim (false: not its turn any more, or another tab won). */
let grants = true;

beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
  listView.resetListViewForTests();
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedIdleMs = idleClock.IDLE_CLOCK.idleMs;
  // The tab in front (the idle clock counts only then).
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  savedFetch = globalThis.fetch;
  posts = [];
  grants = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body });
    if (path.endsWith('/api/inbox/reveal')) {
      const show = body.answer === undefined && grants;
      return new Response(JSON.stringify({ show, reveal: { next: null }, board: { on: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  resetStorageBackend();
  listView.resetListViewForTests();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  idleClock.IDLE_CLOCK.idleMs = savedIdleMs;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (document as unknown as Record<string, unknown>).hasFocus;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="list-view-intro"]');
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === undefined);
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === 'not_now');

function row(id: string, n: number): InboxListRow {
  const at = `2026-11-05T09:0${n}:00.000Z`;
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section: 'new',
    unread: true,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
  } as unknown as InboxListRow;
}
const FIVE = ['a', 'b', 'c', 'd', 'e'].map(row);

/** The settings' line for this load: `reveal` as the Inbox reports it (none: an older Inbox). */
type Line = { next: InboxRevealId | null; ahead?: InboxRevealId[] } | undefined;

interface State {
  blocked: boolean;
  /** The list is taller than the screen (App: `listTallerThanScreen` of the list's body). */
  taller: boolean;
  toast: boolean;
  thread: string | null;
  held: boolean;
}
const BASE: State = { blocked: false, taller: true, toast: false, thread: null, held: false };

/** The view the list would draw (App reads the same hook). */
let drawn: ListView = 'grouped';

/** App's wiring (App.tsx): armed from the load's latch of `reveal`, the line's claim, Not now from Escape. */
function Harness({ state, line }: { state: State; line: Line }) {
  const [view, setView] = listView.useListView();
  drawn = view;
  const armed = reveal.revealArmed({ reveal: line });
  const idle = idleClock.useIdleClock({ enabled: true });
  const r = reveal.useLineReveal({
    id: 'list_view',
    due: armed.next === 'list_view' || armed.ahead.includes('list_view'),
    blocked: state.blocked,
    rows: FIVE,
    toast: state.toast,
    thread: state.thread,
    clear: reveal.listViewRevealClear(true, state.thread, idle),
    place: state.thread ?? '',
    heldBack: () => state.held,
    leaveCounts: (_visit, _now, _row, next) => reveal.listViewRevealLeaveCounts(next),
    idle,
    mayClaim: (pageAge) => reveal.listViewRevealMayClaim({ listLoaded: true, firstRun: false, grouped: view === 'grouped', taller: state.taller }, pageAge),
    holds: () => view === 'grouped',
  });
  return r.stage === 'open' ? (
    <ThemeProvider>
      <ListViewIntro
        groups={[{ id: 'new', label: 'New since you looked', count: FIVE.length, rows: FIVE }]}
        flat={FIVE.map((row) => ({ row, drawn: 'new' as const }))}
        look={readListLook()}
        phone={false}
        current={view}
        onSmart={r.close}
        onDismiss={() => {
          void inboxApi.revealNotNow('list_view');
          r.close();
        }}
        onSimple={() => {
          setView('list');
          r.close();
        }}
      />
    </ThemeProvider>
  ) : null;
}

function mount(state: State, line: Line) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} line={line} />);
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(<Harness state={state} line={line} />));
  };
}

const NEXT: Line = { next: 'list_view', ahead: [] };

/** The calm moment: the page past its age, a thread opened, then back to the list (or on to `to`). */
async function leave(line: Line, state: Partial<State> = {}, to: string | null = null) {
  const set = mount({ ...BASE, ...state }, line);
  await wait(TIMES.pageAgeMs + 20);
  set({ thread: 'a' });
  await wait(TIMES.readMs + 20);
  set({ thread: to });
  await wait(TIMES.settledMs + 150);
  return set;
}

describe.skipIf(!hasDom)('the List view choice, through the line', () => {
  test('never on load; next in the line, back on the list it claims list_view, opens, and "Simple list" switches the list at once, remembered', async () => {
    const set = mount({ ...BASE, thread: 'a' }, NEXT);
    await wait(TIMES.pageAgeMs + 100);
    expect(dialog()).toBeNull();
    set({ thread: null });
    await until(() => dialog() !== null);
    // The line's claim, with the page's key: the Inbox stamps it and decides the day.
    expect(claims().map((c) => c.body)).toEqual([{ id: 'list_view', key: expect.any(String) }]);
    // Named and described for a screen reader; focus on the question, so neither choice looks picked.
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Which view do you prefer?');
    expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)?.textContent).toBe('You can change this any time in the ⋮ menu.');
    expect(document.activeElement?.id).toBe('ib-lvc-title');
    // Two equals, each with the person's own rows in its picture: the groups with their band, the list without.
    const col = (key: string) => dialog()!.querySelector(`[data-list-view-choice="${key}"]`)!.closest('.ib-lvc-col')!;
    expect(dialog()!.querySelectorAll('.ib-lvc-col [data-list-intro-preview]').length).toBe(2);
    expect(col('smart').querySelector('.ib-band')).not.toBeNull();
    expect(col('simple').querySelector('.ib-band')).toBeNull();
    expect(col('simple').querySelectorAll('[data-thread-id]').length).toBe(FIVE.length);
    // Smart groups' button is the primary one (the owner's pick); Simple list's is plain.
    expect(dialog()!.querySelector('[data-list-view-choice="smart"]')!.classList.contains('ib-pri')).toBe(true);
    expect(dialog()!.querySelector('[data-list-view-choice="simple"]')!.classList.contains('ib-pri')).toBe(false);
    // What the list draws now is marked "In use": the groups.
    expect([...dialog()!.querySelectorAll('[data-list-view-in-use]')].map((tag) => tag.closest('.ib-lvc-col')?.querySelector('[data-list-view-choice]')?.getAttribute('data-list-view-choice'))).toEqual(['smart']);
    expect(drawn).toBe('grouped');
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="simple"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('list');
    expect(stored.get(listView.LIST_VIEW_COOKIE)).toBe('list');
    // A pick is an answer, not a Not now.
    await wait(50);
    expect(notNows()).toHaveLength(0);
  });

  test('ahead at its moment: armed while another offer is next, when the line names it in `ahead`', async () => {
    await leave({ next: 'board', ahead: ['list_view'] });
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['list_view']);
  });

  const unarmed: [string, Line][] = [
    ['another offer is next and the line does not name it ahead', { next: 'board', ahead: [] }],
    ['nothing is next', { next: null, ahead: [] }],
    ['an older Inbox with no line', undefined],
  ];
  for (const [what, line] of unarmed) {
    test(`never armed when ${what}: no claim at its moment, no dialog`, async () => {
      await leave(line);
      await wait(400);
      expect(claims()).toHaveLength(0);
      expect(dialog()).toBeNull();
    });
  }

  test('the Inbox refuses the claim (not its day): no dialog', async () => {
    grants = false;
    await leave(NEXT);
    await until(() => claims().length === 1);
    await wait(300);
    expect(dialog()).toBeNull();
  });

  test('"Smart groups" leaves the groups and is no Not now; Escape keeps the view and is the line\'s Not now', async () => {
    await leave(NEXT);
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="smart"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('grouped');
    await wait(50);
    expect(notNows()).toHaveLength(0);
    act(() => root?.unmount());
    host?.remove();
    listView.resetListViewForTests();
    await leave(NEXT);
    await until(() => dialog() !== null);
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await until(() => dialog() === null);
    expect(drawn).toBe('grouped');
    await until(() => notNows().length === 1);
    expect(notNows().map((p) => p.body)).toEqual([{ id: 'list_view', answer: 'not_now' }]);
  });

  const blockers: [string, Partial<State>, string | null][] = [
    ['the list no taller than the screen', { taller: false }, null],
    ['another one-time dialog this load', { blocked: true }, null],
    ['a toast up', { toast: true }, null],
    ['something typed or open', { held: true }, null],
    ['a thread left for another thread (still open)', {}, 'b'],
  ];
  for (const [what, state, to] of blockers) {
    test(`not with ${what}`, async () => {
      await leave(NEXT, state, to);
      await wait(400);
      expect(dialog()).toBeNull();
      expect(claims()).toHaveLength(0);
    });
  }

  test('split view: a thread kept open beside the list, thread to thread, never back on the list: the page going idle is the moment', async () => {
    idleClock.IDLE_CLOCK.idleMs = 150;
    const set = mount({ ...BASE, thread: 'a' }, NEXT);
    // Busy reading and moving between threads: no idle, no moment, past the page's age.
    for (const thread of ['b', 'c', 'd']) {
      await wait(100);
      act(() => void window.dispatchEvent(new Event('pointerdown')));
      set({ thread });
    }
    await wait(60);
    expect(claims()).toHaveLength(0);
    // Then the page rests on thread d: the moment, the line's claim, and the dialog over the open thread.
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body)).toEqual([{ id: 'list_view', key: expect.any(String) }]);
  });

  test('an idle page waits for the page\'s age before it claims', async () => {
    idleClock.IDLE_CLOCK.idleMs = 100;
    mount({ ...BASE, thread: 'a' }, NEXT);
    // Idle from 100 ms, but the page is younger than its age (300 ms): no claim yet.
    await wait(230);
    expect(claims()).toHaveLength(0);
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('idle with the real list on the page: an open Smart group band and a sidebar section (aria-expanded, no popup) never keep it away', async () => {
    idleClock.IDLE_CLOCK.idleMs = 100;
    // InboxList.tsx's band (groups open by default) and Sidebar.tsx's section toggle, as they render.
    document.body.insertAdjacentHTML(
      'beforeend',
      '<nav><button type="button" aria-expanded="true" data-sidebar-section="">Projects</button></nav><div class="ib-listcol"><div class="ib-lbody"><div class="ib-group" data-section-id="new"><button type="button" class="ib-band" aria-expanded="true">New since you looked</button></div></div></div>',
    );
    mount({ ...BASE, thread: 'a' }, NEXT);
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  test('idle with the Ask AI window open over the thread: no claim', async () => {
    idleClock.IDLE_CLOCK.idleMs = 100;
    document.body.insertAdjacentHTML('beforeend', '<div data-popover-layer=""><section data-chat-window="">Ask AI</section></div>');
    mount({ ...BASE, thread: 'a' }, NEXT);
    await wait(TIMES.pageAgeMs + 400);
    expect(claims()).toHaveLength(0);
  });

  test("App's clock runs only while a reveal that takes idle is armed (next, List view ahead, or the list options due)", () => {
    expect(reveal.idleClockArmed(null, true)).toBe(false);
    for (const next of ['list_view', 'board', 'steps', 'bro'] as const) expect(reveal.idleClockArmed({ next, ahead: [] }, false)).toBe(true);
    expect(reveal.idleClockArmed({ next: 'snooze', ahead: ['list_view'] }, false)).toBe(true);
    expect(reveal.idleClockArmed({ next: null, ahead: [] }, true)).toBe(true);
    for (const next of ['snooze', 'code_review', 'voice', 'sound', null] as const) expect(reveal.idleClockArmed({ next, ahead: [] }, false)).toBe(false);
  });

    test('idle with a blocker present (the list no taller than the screen, something open): no claim', async () => {
    idleClock.IDLE_CLOCK.idleMs = 100;
    mount({ ...BASE, thread: 'a', taller: false }, NEXT);
    await wait(TIMES.pageAgeMs + 400);
    expect(claims()).toHaveLength(0);
    act(() => root?.unmount());
    host?.remove();
    mount({ ...BASE, thread: 'a', held: true }, NEXT);
    await wait(TIMES.pageAgeMs + 400);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('not once the list is Simple: the choice is for the groups', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'list');
    await leave(NEXT);
    await wait(400);
    expect(dialog()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('"In use" follows the view the list draws: Simple list when the list is List', () => {
    for (const current of ['grouped', 'list'] as const) {
      host = document.createElement('div');
      host.className = 'pn-inbox';
      document.body.appendChild(host);
      act(() => {
        root = createRoot(host!);
        root.render(
          <ThemeProvider>
            <ListViewIntro groups={[]} flat={[]} look={readListLook()} phone={false} current={current} onSmart={() => {}} onSimple={() => {}} />
          </ThemeProvider>,
        );
      });
      const marked = [...dialog()!.querySelectorAll('[data-list-view-in-use]')];
      expect(marked.map((tag) => tag.textContent)).toEqual(['In use']);
      const choice = marked[0]!.closest('.ib-lvc-col')?.querySelector('[data-list-view-choice]');
      expect(choice?.getAttribute('data-list-view-choice')).toBe(current === 'grouped' ? 'smart' : 'simple');
      act(() => root?.unmount());
      host.remove();
      root = null;
      host = null;
    }
  });

  test('taller than the screen: the list body holds more than it shows', () => {
    const body = (scroll: number, client: number) => {
      const el = document.createElement('div');
      Object.defineProperty(el, 'scrollHeight', { value: scroll });
      Object.defineProperty(el, 'clientHeight', { value: client });
      return el;
    };
    expect(reveal.listTallerThanScreen(body(900, 600))).toBe(true);
    expect(reveal.listTallerThanScreen(body(600, 600))).toBe(false);
    expect(reveal.listTallerThanScreen(null)).toBe(false);
  });
});
