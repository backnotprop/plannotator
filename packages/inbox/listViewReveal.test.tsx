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
 * Agents picture not drawing the person's own agents, drawing an empty frame for one agent or none, or mounting every
 * face and row of a long list.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { InboxRevealId } from './api';
import type { ListView } from './listView';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const idleClock = (hasDom ? await import('./idleClock') : {}) as typeof import('./idleClock');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { ListViewIntro } = (hasDom ? await import('./components/ListViewIntro') : {}) as typeof import('./components/ListViewIntro');
const { setInboxAgents } = (hasDom ? await import('./agentsList') : {}) as typeof import('./agentsList');
const { resetAgentFoldsForTests } = await import('./agentsView/folds');
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

function sectionsOf(byGroup: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: byGroup[id] ?? [] })) as InboxListSection[];
}

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
    heldBack: () => state.held,
    leaveCounts: (_visit, _now, _row, next) => reveal.viewChoiceRevealLeaveCounts(next),
    idle,
    mayClaim: (pageAge) => reveal.viewChoiceRevealMayClaim({ listLoaded: true, firstRun: false, view }, pageAge),
    holds: () => reveal.viewChoiceWanted(view),
  });
  return r.stage === 'open' ? (
    <ThemeProvider>
      <ListViewIntro
        groups={[{ id: 'new', label: 'New since you looked', count: FIVE.length, rows: FIVE }]}
        flat={FIVE.map((row) => ({ row, drawn: 'new' as const }))}
        sections={sectionsOf({ new: FIVE })}
        look={readListLook()}
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
    // Agents first (the larger picture), then Smart groups, then Simple list, each with the person's own rows.
    expect([...dialog()!.querySelectorAll('[data-list-view-choice]')].map((b) => b.getAttribute('data-list-view-choice'))).toEqual(['agents', 'smart', 'simple']);
    expect(col('agents').classList.contains('ib-lvc-lead')).toBe(true);
    expect(dialog()!.querySelectorAll('.ib-lvc-col [data-list-intro-preview]').length).toBe(3);
    expect(col('agents').querySelectorAll('.ib-ag').length).toBe(1);
    expect(col('agents').querySelectorAll('[data-thread-id]').length).toBe(FIVE.length);
    expect(col('smart').querySelector('.ib-band')).not.toBeNull();
    expect(col('simple').querySelector('.ib-band')).toBeNull();
    expect(col('simple').querySelectorAll('[data-thread-id]').length).toBe(FIVE.length);
    // The view in use, the groups, is tagged and its button is the filled one; Agents is tagged New, Smart groups Recommended.
    expect(inUse()).toEqual(['smart']);
    expect(filled()).toEqual(['smart']);
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

  test('on Simple list it opens too, following that view: Simple list in use with the filled button, Smart groups untagged, and "Use Simple list" keeps it', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'list');
    await leave(NEXT);
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
    expect(inUse()).toEqual(['simple']);
    expect(filled()).toEqual(['simple']);
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
  function draw(sections: InboxListSection[], current: ListView = 'grouped') {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(
        <ThemeProvider>
          <ListViewIntro groups={[]} flat={[]} sections={sections} look={readListLook()} phone={false} current={current} onPick={() => {}} onDismiss={() => {}} />
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
  const picture = () => col('agents').querySelector('[data-view-picture="agents"]')!;

  test('"In use" and the filled button follow the view the list draws', () => {
    for (const current of ['grouped', 'list', 'agents'] as const) {
      draw([], current);
      const key = current === 'grouped' ? 'smart' : current === 'list' ? 'simple' : 'agents';
      expect(inUse()).toEqual([key]);
      expect(filled()).toEqual([key]);
      clear();
    }
  });

  test("the Agents picture is the person's own agents, each with its threads, as the Agents view starts them", () => {
    setInboxAgents([{ agents: [agent('ses_ops', 'Ops', 'waiting'), agent('ses_rev', 'Review', 'working'), agent('ses_tide', 'Tide', 'idle')], total: 3, ended_today: 0 }]);
    draw(
      sectionsOf({
        waiting: [row('w1', 9, 'ses_ops', 'waiting')],
        new: [row('n1', 8, 'ses_rev'), row('n2', 7, 'ses_rev')],
        quiet: [row('q1', 6, 'ses_tide', 'quiet'), row('q2', 5, 'ses_tide', 'quiet'), row('q3', 4, 'ses_tide', 'quiet')],
      }),
    );
    // The agents the list names, in the view's order (something for the person first).
    expect([...picture().querySelectorAll('.ib-ag')].map((group) => group.getAttribute('aria-label'))).toEqual(['Ops', 'Review', 'Tide']);
    // Ops and Review start open (something for the person); Tide, with only quiet threads, starts folded.
    expect([...picture().querySelectorAll('[data-thread-id]')].map((el) => el.getAttribute('data-thread-id'))).toEqual(['w1', 'n1', 'n2']);
  });

  test('one agent with nothing for the person (folded as it starts): the picture opens it, never an empty frame', () => {
    setInboxAgents([{ agents: [agent('ses_tide', 'Tide', 'idle')], total: 1, ended_today: 0 }]);
    draw(sectionsOf({ quiet: [row('q1', 6, 'ses_tide', 'quiet'), row('q2', 5, 'ses_tide', 'quiet'), row('q3', 4, 'ses_tide', 'quiet')] }));
    expect(picture().querySelectorAll('.ib-ag').length).toBe(1);
    expect(picture().querySelectorAll('[data-thread-id]').length).toBe(3);
  });

  test('a long list (150 ended agents, 400 threads, every agent folded as it starts): the picture opens only the top, a few agents each with its first threads, never every face and row', () => {
    setInboxAgents([{ agents: Array.from({ length: 150 }, (_, i) => agent(`ses_e${i}`, `Ended ${i}`, 'ended')), total: 150, ended_today: 0 }]);
    const start = Date.parse('2026-11-05T09:00:00.000Z');
    const quiet = Array.from({ length: 400 }, (_, i) => {
      const at = new Date(start - i * 60_000).toISOString();
      return { ...row(`t${i}`, 0, `ses_e${i % 150}`, 'quiet'), last_at: at, last_agent_at: at };
    });
    draw(sectionsOf({ quiet }));
    const heads = picture().querySelectorAll('.ib-ag').length;
    const rows = picture().querySelectorAll('[data-thread-id]').length;
    // As the approved picture: four or five agents, each with threads under it, not empty heads.
    expect(heads).toBeGreaterThanOrEqual(4);
    expect(rows).toBeGreaterThanOrEqual(heads);
    // Bounded: a frame's worth of faces and rows, not 150 faces and 400 rows.
    expect(heads).toBeLessThanOrEqual(20);
    expect(picture().querySelectorAll('.am').length).toBeLessThanOrEqual(20);
    expect(rows).toBeLessThanOrEqual(20);
  });

  test('no agent at all (every thread under "No agent", folded as it starts): the picture opens the band and shows the threads', () => {
    setInboxAgents([{ agents: [], total: 0, ended_today: 0 }]);
    draw(sectionsOf({ quiet: [row('q1', 6, null, 'quiet'), row('q2', 5, null, 'quiet')], new: [row('n1', 8, null)] }));
    expect(picture().querySelectorAll('.ib-ag').length).toBe(0);
    expect(picture().querySelectorAll('[data-thread-id]').length).toBe(3);
  });
});
