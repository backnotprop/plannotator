/**
 * "Which view do you prefer?" in a DOM (reveals.ts `view_choice`), registered with the Inbox's schedule of one-time
 * dialogs: the line's hook (reveal.ts `useLineReveal`) with the view choice's own moment and need, driving
 * `ListViewIntro`, as App wires them.
 *
 * What regresses: the dialog arming without the line (settings `reveal.next` is not `view_choice` and `reveal.ahead`
 * does not name it, or an older Inbox reports no line) or after the Inbox refused it; showing on load, or with any one
 * blocker present (another one-time dialog this load, a toast, something typed or open, a thread left for another
 * thread while the page is not idle); the page going idle not being its moment in a split view (the owner, 2026-11-08:
 * "Some people may never see them"), or an idle page claiming before the page's age; the dialog not opening for
 * someone on Simple list, or opening for someone already on Agents (`viewChoiceWanted`); the view in use not being the
 * one tagged "In use" with the filled button; Smart groups still tagged for someone on Simple list
 * (`RECOMMEND_SMART_ON_SIMPLE`); a pick not switching the list at once or not remembering it as the ⋮ menu does;
 * Escape or a click outside changing the view or not counting as the line's Not now, or a pick counting as one; the
 * view in use's button not being the one that keeps it ("Keep", the others "Use"); the pictures not being the fixed
 * demo the owner approved (the four demo agents, Blastoise among them) whatever the person's own list holds, reading
 * or writing the person's agent folds, or asking the network for the demo's face.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxRevealId } from './api';
import type { ListView } from './listView';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const idleClock = (hasDom ? await import('./idleClock') : {}) as typeof import('./idleClock');
const { listIntroHeldBack } = (hasDom ? await import('./app/focus') : {}) as typeof import('./app/focus');
const { attachRowSwipe } = (hasDom ? await import('./rowSwipe') : {}) as typeof import('./rowSwipe');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { ListViewIntro, LIST_VIEW_INTRO_WORDS } = (hasDom ? await import('./components/ListViewIntro') : {}) as typeof import('./components/ListViewIntro');
const { FOLD_LOOP_MS } = await import('./components/viewChoiceFolds');
const { setInboxAgents } = (hasDom ? await import('./agentsList') : {}) as typeof import('./agentsList');
const { resetAgentFoldsForTests, AGENT_FOLDS_COOKIE } = await import('./agentsView/folds');
const listView = await import('./listView');
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
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
  resetAgentFoldsForTests();
  if (!hasDom) return;
  setInboxAgents(null);
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
  resetAgentFoldsForTests();
  if (!hasDom) return;
  act(() => root?.unmount());
  setInboxAgents(null);
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

function row(id: string, n: number, session: string | null = 'ses_1', section: InboxListGroupId = 'new'): InboxListRow {
  const at = `2026-11-05T09:0${n}:00.000Z`;
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'billing-svc' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: session ? { kind: 'agent', host: 'claude-code', session, name: 'Claude Code' } : { kind: 'person' },
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    section,
    unread: true,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
  } as unknown as InboxListRow;
}
const FIVE = ['a', 'b', 'c', 'd', 'e'].map((id, n) => row(id, n));

function agent(id: string, label: string, state: InboxAgent['state']): InboxAgent {
  return { id, session: id, host: 'claude-code', label, project: { id: 'prj_a', name: 'billing-svc' }, state, waiting: state === 'waiting' ? 1 : 0, live: state !== 'ended', started_at: null, last_seen_at: '2026-11-05T09:00:00.000Z' } as InboxAgent;
}

/** The settings' line for this load: `reveal` as the Inbox reports it (none: an older Inbox). */
type Line = { next: InboxRevealId | null; ahead?: InboxRevealId[] } | undefined;

interface State {
  blocked: boolean;
  toast: boolean;
  thread: string | null;
  held: boolean;
}
const BASE: State = { blocked: false, toast: false, thread: null, held: false };

/** The view the list would draw (App reads the same hook). */
let drawn: ListView = 'grouped';

/** App's wiring (App.tsx): armed from the load's latch of `reveal`, the line's claim, a pick through the ⋮ menu's setter, Not now from Escape. */
function Harness({ state, line }: { state: State; line: Line }) {
  const [view, setView] = listView.useListView();
  drawn = view;
  const armed = reveal.revealArmed({ reveal: line });
  const idle = idleClock.useIdleClock({ enabled: true });
  const r = reveal.useLineReveal({
    id: 'view_choice',
    due: armed.next === 'view_choice' || armed.ahead.includes('view_choice'),
    blocked: state.blocked,
    rows: FIVE,
    toast: state.toast,
    thread: state.thread,
    clear: reveal.viewChoiceRevealClear(true, state.thread, idle),
    place: state.thread ?? '',
    // App's hold (`oneTimeHeldBack`: listIntroHeldBack), with the test's own stand-in for the rest of it.
    heldBack: () => state.held || listIntroHeldBack(),
    leaveCounts: (_visit, _now, _row, next) => reveal.viewChoiceRevealLeaveCounts(next),
    idle,
    mayClaim: (pageAge) => reveal.viewChoiceRevealMayClaim({ listLoaded: true, firstRun: false, view }, pageAge),
    holds: () => reveal.viewChoiceWanted(view),
  });
  return r.stage === 'open' ? (
    <ThemeProvider>
      <ListViewIntro
        phone={false}
        current={view}
        onPick={(next) => {
          setView(next);
          r.close();
        }}
        onDismiss={() => {
          void inboxApi.revealNotNow('view_choice');
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

const NEXT: Line = { next: 'view_choice', ahead: [] };

const col = (key: string) => dialog()!.querySelector(`[data-list-view-choice="${key}"]`)!.closest('.ib-lvc-col')!;
/** The choices tagged "In use", and the ones whose button is the filled one. */
const inUse = () => [...dialog()!.querySelectorAll('[data-list-view-in-use]')].map((tag) => tag.closest('.ib-lvc-col')!.querySelector('[data-list-view-choice]')!.getAttribute('data-list-view-choice'));
const filled = () => [...dialog()!.querySelectorAll('[data-list-view-choice].ib-pri')].map((b) => b.getAttribute('data-list-view-choice'));
/** The choices whose button keeps the view ("Keep …"); every other one reads "Use …". */
const keeps = () => {
  const words = LIST_VIEW_INTRO_WORDS;
  const buttons = [...dialog()!.querySelectorAll<HTMLButtonElement>('[data-list-view-choice]')];
  for (const b of buttons) expect(b.textContent!.startsWith(`${words.keep} `) || b.textContent!.startsWith(`${words.use} `)).toBe(true);
  return buttons.filter((b) => b.textContent!.startsWith(`${words.keep} `)).map((b) => b.getAttribute('data-list-view-choice'));
};
/** A picture's agents (the Agents view's groups) and its threads, as drawn. */
const agentNames = (el: Element) => [...el.querySelectorAll('.ib-ag')].map((group) => group.getAttribute('aria-label'));
const threadIds = (el: Element) => [...el.querySelectorAll('[data-thread-id]')].map((row) => row.getAttribute('data-thread-id')!);
/** The demo's agents in the Agents picture, as the owner approved it (C-r3). */
const DEMO_AGENTS = ['Ops', 'Review', 'Tide', 'Search index'];
/** The tags beside a choice's name other than "In use" (Agents' New, Smart groups' Recommended). */
const tags = (key: string) => col(key).querySelectorAll('.ib-lvc-name .ib-lvc-tag:not(.ib-lvc-inuse)').length;

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

describe.skipIf(!hasDom)('the view choice, through the line', () => {
  test('never on load; next in the line, back on the list it claims view_choice and opens on Smart groups: three choices, the groups in use; "Use Agents" switches the list at once, remembered', async () => {
    const set = mount({ ...BASE, thread: 'a' }, NEXT);
    await wait(TIMES.pageAgeMs + 100);
    expect(dialog()).toBeNull();
    set({ thread: null });
    await until(() => dialog() !== null);
    // The line's claim, with the page's key: the Inbox stamps it and decides the day.
    expect(claims().map((c) => c.body)).toEqual([{ id: 'view_choice', key: expect.any(String) }]);
    // Open, named and described for a screen reader by its own heading and note; focus on the question, so no choice looks picked.
    expect(dialog()!.open).toBe(true);
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      const by = document.getElementById(dialog()!.getAttribute(attr) ?? '');
      expect(by !== null && dialog()!.contains(by)).toBe(true);
      expect(by!.textContent!.trim()).not.toBe('');
    }
    expect(document.activeElement?.id).toBe('ib-lvc-title');
    // Agents first (the larger picture), then Smart groups, then Simple list, each a picture of the demo, none of the person's rows.
    expect([...dialog()!.querySelectorAll('[data-list-view-choice]')].map((b) => b.getAttribute('data-list-view-choice'))).toEqual(['agents', 'smart', 'simple']);
    expect(col('agents').classList.contains('ib-lvc-lead')).toBe(true);
    expect(dialog()!.querySelectorAll('.ib-lvc-col [data-list-intro-preview]').length).toBe(3);
    expect(agentNames(col('agents'))).toEqual(DEMO_AGENTS);
    expect(col('smart').querySelector('.ib-band')).not.toBeNull();
    expect(col('simple').querySelector('.ib-band')).toBeNull();
    for (const key of ['agents', 'smart', 'simple']) {
      const ids = threadIds(col(key));
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.some((id) => FIVE.some((row) => row.thread_id === id))).toBe(false);
    }
    // The view in use, the groups, is tagged and its button, "Keep", is the filled one; Agents is tagged New, Smart groups Recommended.
    expect(inUse()).toEqual(['smart']);
    expect(filled()).toEqual(['smart']);
    expect(keeps()).toEqual(['smart']);
    expect(tags('agents')).toBe(1);
    expect(tags('smart')).toBe(1);
    expect(tags('simple')).toBe(0);
    expect(drawn).toBe('grouped');
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="agents"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('agents');
    expect(stored.get(listView.LIST_VIEW_COOKIE)).toBe('agents');
    // A pick is an answer, not a Not now.
    await wait(50);
    expect(notNows()).toHaveLength(0);
  });

  test('on Simple list it opens too, following that view: Simple list in use with the filled button, Smart groups untagged, and "Keep Simple list" keeps it', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'list');
    await leave(NEXT);
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
    expect(inUse()).toEqual(['simple']);
    expect(filled()).toEqual(['simple']);
    expect(keeps()).toEqual(['simple']);
    // As shipped (`RECOMMEND_SMART_ON_SIMPLE` off), someone on Simple list sees no "Recommended" on Smart groups.
    expect(tags('smart')).toBe(0);
    expect(tags('agents')).toBe(1);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="simple"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('list');
    expect(stored.get(listView.LIST_VIEW_COOKIE)).toBe('list');
    await wait(50);
    expect(notNows()).toHaveLength(0);
  });

  test('on Smart groups, "Keep Smart groups" leaves the view as it is and is an answer, not a Not now', async () => {
    await leave(NEXT);
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="smart"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('grouped');
    expect(stored.has(listView.LIST_VIEW_COOKIE)).toBe(false);
    await wait(50);
    expect(notNows()).toHaveLength(0);
  });

  test('on Simple list, "Use Smart groups" switches to the groups (the cookie goes)', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'list');
    await leave(NEXT);
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="smart"]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('grouped');
    expect(stored.has(listView.LIST_VIEW_COOKIE)).toBe(false);
  });

  test('someone already on Agents is not offered it (viewChoiceWanted): no claim at its moment, no dialog', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'agents');
    await leave(NEXT);
    await wait(400);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('ahead at its moment: armed while another offer is next, when the line names it in `ahead`', async () => {
    await leave({ next: 'board', ahead: ['view_choice'] });
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['view_choice']);
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

  test('Escape keeps the view in use and is the line\'s Not now', async () => {
    for (const view of ['grouped', 'list'] as const) {
      act(() => root?.unmount());
      host?.remove();
      posts = [];
      stored.clear();
      if (view === 'list') stored.set(listView.LIST_VIEW_COOKIE, 'list');
      listView.resetListViewForTests();
      await leave(NEXT);
      await until(() => dialog() !== null);
      act(() => {
        dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await until(() => dialog() === null);
      expect(drawn).toBe(view);
      await until(() => notNows().length === 1);
      expect(notNows().map((p) => p.body)).toEqual([{ id: 'view_choice', answer: 'not_now' }]);
    }
  });

  const blockers: [string, Partial<State>, string | null][] = [
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

  test('never under a finger: while a row is swiped, or rests open on Archive, the moment waits; once the row is at rest the dialog opens', async () => {
    // The list as rowSwipe.ts takes it: a phone's row in a group of the scroll box, and the action layer.
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div class="ib-lbody"><div class="ib-group"><div class="ib-mrow" data-thread-id="z">Thread z</div></div><div class="ib-swl" data-row-swipe-layer=""><button type="button" data-row-swipe="lead"><span class="ib-swa-in">Quiet</span></button><button type="button" data-row-swipe="trail"><span class="ib-swa-in">Archive</span></button></div></div>',
    );
    const body = document.querySelector<HTMLElement>('.ib-lbody')!;
    const face = document.querySelector<HTMLElement>('.ib-mrow[data-thread-id="z"]')!;
    const layer = document.querySelector<HTMLElement>('[data-row-swipe-layer]')!;
    const actions: string[] = [];
    const detach = attachRowSwipe(body, layer, { actionsOf: () => ({ lead: 'read', trail: 'archive', title: 'Thread z' }), onAction: (_id, action) => void actions.push(action), reduced: () => true });
    const touch = (target: Element, type: string, x: number) => {
      const point = { identifier: 1, clientX: x, clientY: 100, pageX: x, pageY: 100, target };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      target.dispatchEvent(event);
    };
    try {
      // A finger on the row, moving it left, still down while the moment comes and settles.
      touch(face, 'touchstart', 200);
      for (let i = 1; i <= 6; i++) {
        await wait(15);
        touch(face, 'touchmove', 200 - 15 * i);
      }
      expect(face.style.transform).not.toBe('');
      await leave(NEXT);
      await wait(150);
      expect(claims()).toHaveLength(0);
      expect(dialog()).toBeNull();
      // Held, then lifted short of the commit: the row rests open on Archive, and the moment still waits.
      await wait(120);
      touch(face, 'touchend', 110);
      await wait(150);
      expect(layer.dataset.side).toBe('trail');
      expect(actions).toEqual([]);
      expect(claims()).toHaveLength(0);
      expect(dialog()).toBeNull();
      // A touch elsewhere closes the row; at rest, within the same moment, the line's claim and the dialog.
      touch(document.body, 'touchstart', 20);
      touch(document.body, 'touchend', 20);
      await until(() => dialog() !== null);
      expect(face.style.transform).toBe('');
      expect(claims().map((c) => c.body.id)).toEqual(['view_choice']);
    } finally {
      detach();
    }
  });

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
    expect(claims().map((c) => c.body)).toEqual([{ id: 'view_choice', key: expect.any(String) }]);
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

  test("App's clock runs only while a reveal that takes idle is armed (next, the view choice ahead, the grill-me tip beside the line, or the list options due)", () => {
    expect(reveal.idleClockArmed(null, true)).toBe(false);
    for (const next of ['view_choice', 'board', 'steps', 'bro'] as const) expect(reveal.idleClockArmed({ next, ahead: [] }, false)).toBe(true);
    expect(reveal.idleClockArmed({ next: null, ahead: [], aside: ['grill_me_tip'] }, false)).toBe(true);
    expect(reveal.idleClockArmed({ next: null, ahead: [], aside: ['star'] }, false)).toBe(false);
    expect(reveal.idleClockArmed({ next: 'snooze', ahead: ['view_choice'] }, false)).toBe(true);
    expect(reveal.idleClockArmed({ next: null, ahead: [] }, true)).toBe(true);
    for (const next of ['snooze', 'code_review', 'voice', 'sound', null] as const) expect(reveal.idleClockArmed({ next, ahead: [] }, false)).toBe(false);
  });

  test('idle with something open: no claim', async () => {
    idleClock.IDLE_CLOCK.idleMs = 100;
    mount({ ...BASE, thread: 'a', held: true }, NEXT);
    await wait(TIMES.pageAgeMs + 400);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });
});

describe.skipIf(!hasDom)('the view choice dialog', () => {
  // On happy-dom's blank page a picture's path is no address, and the picture fails at once (a set face then draws the
  // agent's own mark): here the page has an address, as in a browser. happy-dom loads no picture either way.
  type HappyDom = { setURL: (url: string) => void };
  const happyDom = () => (window as unknown as { happyDOM: HappyDom }).happyDOM;
  let savedUrl = '';
  beforeEach(() => {
    savedUrl = window.location.href;
    happyDom().setURL('http://127.0.0.1:9/');
  });
  afterEach(() => {
    happyDom().setURL(savedUrl);
  });
  function draw(current: ListView = 'grouped') {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <ThemeProvider>
          <ListViewIntro phone={false} current={current} onPick={() => {}} onDismiss={() => {}} />
        </ThemeProvider>,
      );
    });
  }
  function clear() {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
  const picture = (key: string) => col(key).querySelector(`[data-view-picture="${key}"]`)!;
  /** What the three pictures show: the agents, each picture's threads and their titles, and every face drawn. */
  const shown = () =>
    JSON.stringify({
      agents: agentNames(picture('agents')),
      threads: ['agents', 'smart', 'simple'].map((key) => threadIds(picture(key))),
      titles: ['agents', 'smart', 'simple'].map((key) => [...picture(key).querySelectorAll('[data-thread-id]')].map((row) => row.querySelector('.ib-lrow-t, .ib-title')?.textContent ?? '')),
      bands: [...picture('smart').querySelectorAll('.ib-band')].map((band) => band.textContent),
      faces: [...dialog()!.querySelectorAll('[data-agent-face], img[data-set]')].map((el) => el.getAttribute('data-agent-face') ?? el.getAttribute('data-set')),
      marks: picture('agents').querySelectorAll('.am').length,
    });

  test('"In use", the filled button and "Keep" follow the view the list draws; the others read "Use"', () => {
    for (const current of ['grouped', 'list', 'agents'] as const) {
      draw(current);
      const key = current === 'grouped' ? 'smart' : current === 'list' ? 'simple' : 'agents';
      expect(inUse()).toEqual([key]);
      expect(filled()).toEqual([key]);
      expect(keeps()).toEqual([key]);
      clear();
    }
  });

  test('the pictures are the demo the owner approved: four agents (Blastoise on Tide, two threads under it, Search index last and folded), whatever the person has', () => {
    draw();
    expect(agentNames(picture('agents'))).toEqual(DEMO_AGENTS);
    const tide = picture('agents').querySelector('.ib-ag[aria-label="Tide"]')!;
    expect(tide.querySelectorAll('[data-thread-id]').length).toBe(2);
    expect(tide.querySelector('img[data-set="set:view-choice/blastoise"]')).not.toBeNull();
    expect(picture('agents').querySelector('.ib-ag[aria-label="Search index"]')!.querySelectorAll('[data-thread-id]').length).toBe(0);
    // The groups: Waiting on you, New since you looked, then Quiet's band alone.
    expect([...picture('smart').querySelectorAll('.ib-band')].map((band) => band.closest('[data-section-id]')!.getAttribute('data-section-id'))).toEqual(['waiting', 'new', 'quiet']);
    // Blastoise on the groups' and the list's rows too.
    for (const key of ['smart', 'simple']) expect(picture(key).querySelector('[data-agent-face="set:view-choice/blastoise"]')).not.toBeNull();
    const demo = shown();
    clear();

    // The person's own list, whatever it is, changes nothing: none, one agent, 150 agents with faces kept.
    const people: [string, unknown][] = [
      ['no agents', [{ agents: [], total: 0, ended_today: 0 }]],
      ['one agent', [{ agents: [agent('ses_tide', 'Tide', 'idle')], total: 1, ended_today: 0 }]],
      ['150 agents', [{ agents: Array.from({ length: 150 }, (_, i) => agent(`ses_e${i}`, `Agent ${i}`, i % 3 === 0 ? 'waiting' : 'idle')), total: 150, ended_today: 0 }]],
    ];
    for (const [, groups] of people) {
      setInboxAgents(groups);
      draw();
      expect(shown()).toBe(demo);
      // Bounded: the demo's few faces and rows, never the person's 150.
      expect(dialog()!.querySelectorAll('.am').length).toBeLessThanOrEqual(8);
      expect(dialog()!.querySelectorAll('[data-thread-id]').length).toBeLessThanOrEqual(20);
      clear();
    }
  });

  test("nothing in the dialog reads or writes the person's agent folds, even a click on a pictured agent", () => {
    const touched: string[] = [];
    setStorageBackend({
      getItem: (key) => (touched.push(key), stored.get(key) ?? null),
      setItem: (key, value) => (touched.push(key), void stored.set(key, value)),
      removeItem: (key) => (touched.push(key), void stored.delete(key)),
    });
    draw();
    act(() => picture('agents').querySelector<HTMLButtonElement>('[data-agent-head]')!.click());
    expect(touched.filter((key) => key === AGENT_FOLDS_COOKIE)).toEqual([]);
  });

  test("the demo's Blastoise is the window's own: no request for it, never the Inbox's icon address", async () => {
    const asked: string[] = [];
    const answer = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return answer(input, init);
    }) as typeof fetch;
    draw();
    await wait(100);
    const srcs = [...dialog()!.querySelectorAll<HTMLImageElement>('img[data-set="set:view-choice/blastoise"], [data-agent-face="set:view-choice/blastoise"] img')].map((img) => img.getAttribute('src') ?? '');
    expect(srcs.length).toBeGreaterThan(1);
    for (const src of srcs) expect(src).not.toContain('/icon-sets');
    expect(asked.filter((url) => url.includes('/icon-sets'))).toEqual([]);
  });

  describe('the Agents picture folds and opens its agents by itself', () => {
    // Fake timers, the fold at once (no Web Animations), and the picture on screen (no IntersectionObserver here).
    const g = globalThis as unknown as Record<string, unknown>;
    let saved: { animate: unknown; observer: unknown; matchMedia: typeof window.matchMedia } | null = null;
    beforeEach(() => {
      saved = { animate: Element.prototype.animate, observer: g.IntersectionObserver, matchMedia: window.matchMedia };
      (Element.prototype as unknown as Record<string, unknown>).animate = undefined;
      g.IntersectionObserver = undefined;
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
      (Element.prototype as unknown as Record<string, unknown>).animate = saved!.animate;
      g.IntersectionObserver = saved!.observer;
      window.matchMedia = saved!.matchMedia;
    });
    /** The agents that show their threads now (open), in order. */
    const open = () => [...picture('agents').querySelectorAll('.ib-ag')].filter((group) => group.querySelector('[data-thread-id]')).map((group) => group.getAttribute('aria-label'));
    const pass = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

    test('one agent at a time, Review then Tide, back open in the same order, again and again; never Ops, which waits on the person', () => {
      draw();
      expect(open()).toEqual(['Ops', 'Review', 'Tide']);
      for (let round = 0; round < 2; round++) {
        pass(FOLD_LOOP_MS.holdOpen);
        expect(open()).toEqual(['Ops', 'Tide']);
        // Folded as the view folds: its threads gone, its head with the count.
        expect(picture('agents').querySelector('.ib-ag[aria-label="Review"] [data-agent-threads="2"]')).not.toBeNull();
        pass(FOLD_LOOP_MS.between);
        expect(open()).toEqual(['Ops']);
        pass(FOLD_LOOP_MS.holdFolded);
        expect(open()).toEqual(['Ops', 'Review']);
        pass(FOLD_LOOP_MS.between);
        expect(open()).toEqual(['Ops', 'Review', 'Tide']);
      }
    });

    test("the person's agent folds are never read or written by the loop", () => {
      const touched: string[] = [];
      setStorageBackend({
        getItem: (key) => (touched.push(key), stored.get(key) ?? null),
        setItem: (key, value) => (touched.push(key), void stored.set(key, value)),
        removeItem: (key) => (touched.push(key), void stored.delete(key)),
      });
      draw();
      pass(FOLD_LOOP_MS.holdOpen + FOLD_LOOP_MS.between * 2 + FOLD_LOOP_MS.holdFolded);
      expect(touched.filter((key) => key === AGENT_FOLDS_COOKIE)).toEqual([]);
    });

    test('under reduced motion nothing folds: every agent open, still', () => {
      window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion: reduce'), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
      draw();
      for (let t = 0; t < 20_000; t += 500) {
        pass(500);
        expect(open()).toEqual(['Ops', 'Review', 'Tide']);
      }
    });

    test('closing the dialog leaves no timer behind', () => {
      draw();
      pass(FOLD_LOOP_MS.holdOpen);
      expect(open()).toEqual(['Ops', 'Tide']);
      clear();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
