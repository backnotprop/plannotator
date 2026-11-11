import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { BoardIntro } = (hasDom ? await import('./board/BoardIntro') : {}) as typeof import('./board/BoardIntro');
const { ChecklistIntro } = (hasDom ? await import('./steps/ChecklistIntro') : {}) as typeof import('./steps/ChecklistIntro');
const { inboxApi } = (hasDom ? await import('./api') : {}) as typeof import('./api');
const { turnOnFromReveal } = (hasDom ? await import('./revealTurnOn') : {}) as typeof import('./revealTurnOn');
const { withCapabilities } = (hasDom ? await import('./capabilities') : {}) as typeof import('./capabilities');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: unknown }[] = [];
let stamped = false;
let stampedKey: string | null = null;
let grants = true;
let onElsewhere = false;
let claimFails: ('lost' | number)[] = [];
let claimGate: Promise<void> | null = null;
let saveFails = false;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  stampedKey = null;
  grants = true;
  onElsewhere = false;
  claimFails = [];
  claimGate = null;
  saveFails = false;
  toasts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    if (path.endsWith('/api/inbox/reveal')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { key?: string };
      const fail = claimFails.shift();
      if (fail !== undefined && fail !== 'lost') return new Response(JSON.stringify({ error: 'down' }), { status: fail, headers: { 'Content-Type': 'application/json' } });
      const show = grants && (!stamped || (body.key !== undefined && body.key === stampedKey));
      if (!stamped && grants) stampedKey = body.key ?? null;
      stamped = true;
      if (fail === 'lost') throw new TypeError('Load failed');
      if (claimGate) await claimGate;
      return new Response(JSON.stringify({ show, reveal: { next: null }, board: { on: onElsewhere } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.endsWith('/api/inbox/settings') && init?.method === 'POST') {
      if (saveFails) throw new TypeError('Load failed');
      return new Response(JSON.stringify({ board: { on: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not in this test' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const claims = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const switchSaves = () => posts.filter((p) => p.path.endsWith('/api/inbox/settings'));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="board-intro"]');

function row(id: string, project: 1 | 2 = 1): InboxListRow {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    thread_id: id,
    project_id: `prj_${project}`,
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: at,
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: project === 1 ? { id: 'prj_1', name: 'billing' } : { id: 'prj_2', name: 'docs' },
    thread_name: `name-${id}`,
    section: 'sent',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    unsent: null,
    sent: null,
    guide: false,
  };
}

const ROWS = ['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e'].map((id, i) => row(id, i === 4 ? 2 : 1));

interface State {
  due: boolean;
  blocked: boolean;
  rows: InboxListRow[];
  toast: boolean;
  thread: string | null;
  clear: boolean;
  held: boolean;
  firstRun: boolean;
  idle?: boolean;
}

const BASE: State = { due: true, blocked: false, rows: ROWS, toast: false, thread: null, clear: true, held: false, firstRun: false };

let boardOn = false;
let toasts: string[] = [];
let hearFrame: (frame: { board?: { on: boolean } }) => void = () => {};

type HeldSettings = { serverSession: string; board?: { on: boolean } };

function Harness({ state }: { state: State }) {
  const [settings, setSettings] = useState<HeldSettings | null>({ serverSession: 's', board: { on: false } });
  const on = settings?.board?.on === true;
  boardOn = on;
  hearFrame = (frame) => setSettings((current) => (current ? withCapabilities(current, frame) : current));
  const r = reveal.useBoardReveal({
    due: state.due,
    listLoaded: true,
    firstRun: state.firstRun,
    blocked: state.blocked,
    rows: state.rows,
    toast: state.toast,
    thread: state.thread,
    clear: state.clear,
    place: state.thread ?? '',
    heldBack: () => state.held,
    idle: state.idle === true,
    on,
    onBoardOn: () => setSettings((current) => (current ? { ...current, board: { on: true } } : current)),
  });
  return (
    <>
      {on && <a href="#board" data-sidebar-board="">Board</a>}
      {r.stage === 'open' && (
        <BoardIntro
          mcpCommand={null}
          phone={false}
          onClose={r.close}
          onTurnOn={() =>
            void turnOnFromReveal('board', r.close, {
              save: () => inboxApi.saveBoard(true).then((saved) => saved.board),
              setSettings,
              showToast: (toast) => void toasts.push(`${toast.lead} · ${toast.action?.label ?? ''}`),
              dismissToast: () => {},
              refreshSettings: () => Promise.resolve(),
              openSettings: () => {},
            })
          }
        />
      )}
    </>
  );
}

function mount(state: State) {
  boardOn = false;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} />);
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(<Harness state={state} />));
  };
}

async function leave(state: Partial<State> = {}, options: { early?: boolean; young?: boolean; to?: string } = {}) {
  const set = mount({ ...BASE, ...state });
  if (!options.young) await wait(TIMES.pageAgeMs + 20);
  set({ thread: 'msg_a' });
  await wait(options.early ? 10 : TIMES.readMs + 20);
  set({ thread: options.to ?? null });
  await wait(TIMES.settledMs + 120);
  return set;
}

describe.skipIf(!hasDom)('the calm moment', () => {
  test('back on the list after reading a thread: one claim, its first-visit dialog as an offer, the Board still off; Turn it on turns it on', async () => {
    const set = mount({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.pageAgeMs + 100);
    expect(claims()).toHaveLength(0);
    set({ thread: null });
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body)).toEqual([{ id: 'board', key: expect.any(String) }]);
    expect(boardOn).toBe(false);
    expect(document.querySelector('[data-sidebar-board]')).toBeNull();
    expect(switchSaves()).toHaveLength(0);
    expect(dialog()!.querySelector('[data-board-intro-copy]')).toBeNull();
    expect(dialog()!.querySelector('.ib-bi-q')).toBeNull();
    expect(dialog()!.querySelector('[data-board-intro-close]')!.textContent).toBe('Not now');
    const on = dialog()!.querySelector<HTMLButtonElement>('[data-board-intro-on]')!;
    expect(on.textContent).toBe('Turn it on');
    act(() => on.click());
    expect(dialog()).toBeNull();
    expect(boardOn).toBe(true);
    expect(document.querySelector('[data-sidebar-board]')).not.toBeNull();
    await until(() => switchSaves().length === 1);
    expect(switchSaves().map((s) => s.body)).toEqual([{ board: { on: true } }]);
  });

  test('Turn it on, and the save fails (the network dropped): the row goes again, and the toast says it is not on', async () => {
    saveFails = true;
    await leave();
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-board-intro-on]')!.click());
    await until(() => toasts.length === 1);
    expect(boardOn).toBe(false);
    expect(document.querySelector('[data-sidebar-board]')).toBeNull();
    expect(toasts).toEqual(['The Board isn’t on · Open Settings']);
  });

  test('a lost answer (the Inbox stamped it, the answer never came): sent again once with the same key, and the offer opens', async () => {
    claimFails = ['lost'];
    await leave();
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(2);
    const [first, second] = claims().map((c) => c.body as { id: string; key: string });
    expect(first!.id).toBe('board');
    expect(first!.key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(second).toEqual(first);
    expect(boardOn).toBe(false);
  });

  test('an answer from the Inbox (a 500) is final: never sent again, nothing drawn', async () => {
    claimFails = [500];
    await leave();
    await until(() => claims().length === 1);
    await wait(TIMES.claimRetryMs + 150);
    expect(claims()).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  test('another window turns the Board on while the offer waits: its row shows here, and the offer never opens', async () => {
    let release = () => {};
    claimGate = new Promise((resolve) => (release = resolve));
    await leave();
    await until(() => claims().length === 1);
    act(() => hearFrame({ board: { on: true } }));
    expect(document.querySelector('[data-sidebar-board]')).not.toBeNull();
    release();
    await wait(200);
    expect(dialog()).toBeNull();
    expect(switchSaves()).toHaveLength(0);
  });

  test('settings already say the Board is on (turned on elsewhere this load): no claim at the moment, no offer', async () => {
    const set = mount({ ...BASE });
    act(() => hearFrame({ board: { on: true } }));
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    set({ thread: null });
    await wait(TIMES.settledMs + 200);
    expect(claims()).toHaveLength(0);
    expect(dialog()).toBeNull();
  });

  test('the Board first visit (on already, no onTurnOn): Copy prompt as before', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<BoardIntro mcpCommand={null} phone={false} onClose={() => {}} />);
    });
    expect(dialog()!.querySelector('[data-board-intro-copy]')).not.toBeNull();
    expect(dialog()!.querySelector('.ib-bi-q')).not.toBeNull();
    expect(dialog()!.querySelector('[data-board-intro-on]')).toBeNull();
  });

  test('leaving for another thread is not the moment; leaving that one for the list is', async () => {
    const set = await leave({}, { to: 'msg_b' });
    await wait(150);
    expect(claims()).toHaveLength(0);
    await wait(TIMES.readMs + 20);
    set({ thread: null });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
  });

  const BLOCKERS: [string, Partial<State>, { early?: boolean; young?: boolean }?][] = [
    ['the thread was open under the read time', {}, { early: true }],
    ['the page is younger than its age', {}, { young: true }],
    ['under five rows', { rows: ROWS.slice(0, 4) }],
    ['five rows in one project', { rows: ['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e'].map((id) => row(id)) }],
    ['the first-run screen', { firstRun: true }],
    ['the tour, an update or another one-time dialog this load', { blocked: true }],
    ['a toast is up', { toast: true }],
    ['something is typed or open', { held: true }],
    ['the Inbox page is not clear (a search, a file, Settings)', { clear: false }],
    ['the Inbox has another reveal next, or none', { due: false }],
  ];
  for (const [name, state, options] of BLOCKERS) {
    test(`blocked: ${name}`, async () => {
      await leave(state, options);
      await wait(200);
      expect(claims()).toHaveLength(0);
      expect(dialog()).toBeNull();
      expect(boardOn).toBe(false);
    });
  }

  test('a claim the Inbox refuses (no longer next): nothing drawn, the Board left as it was', async () => {
    grants = false;
    await leave();
    await until(() => claims().length === 1);
    await wait(150);
    expect(dialog()).toBeNull();
    expect(boardOn).toBe(false);
  });

  test('another tab or device won the claim: no dialog here, but the Board row shows now (the answer says it is on)', async () => {
    grants = false;
    onElsewhere = true;
    await leave();
    await until(() => claims().length === 1);
    await until(() => boardOn);
    await wait(150);
    expect(dialog()).toBeNull();
  });
});

describe('the load latch (App: revealArmed)', () => {
  test('only reveal.next is armed; Snooze only while it is next', async () => {
    const { revealArmed } = await import('./reveal');
    expect(revealArmed({ reveal: { next: 'board' }, snooze_intro: { due: true } })).toEqual({ next: 'board', snoozeDue: false, ahead: [], aside: [] });
    expect(revealArmed({ reveal: { next: 'snooze' }, snooze_intro: { due: true } })).toEqual({ next: 'snooze', snoozeDue: true, ahead: [], aside: [] });
    expect(revealArmed({ reveal: { next: null }, snooze_intro: { due: true } })).toEqual({ next: null, snoozeDue: false, ahead: [], aside: [] });
  });

  test('an ahead offer (List view) is latched beside next, so it can go at its own moment (approval "inbox-one-time-dialogs")', async () => {
    const { revealArmed } = await import('./reveal');
    const armed = revealArmed({ reveal: { next: 'board', ahead: ['steps'] }, snooze_intro: { due: false } });
    expect(armed.next).toBe('board');
    expect(armed.ahead).toEqual(['steps']);
  });

  test('an older Inbox (no reveal in settings): its Snooze rule alone, never the Board', async () => {
    const { revealArmed } = await import('./reveal');
    expect(revealArmed({ snooze_intro: { due: true } })).toEqual({ next: 'snooze', snoozeDue: true, ahead: [], aside: [] });
    expect(revealArmed({ snooze_intro: { due: false } })).toEqual({ next: null, snoozeDue: false, ahead: [], aside: [] });
    expect(revealArmed({})).toEqual({ next: null, snoozeDue: false, ahead: [], aside: [] });
  });
});

describe.skipIf(!hasDom)('every way out but Turn it on is Not now: final, and the Board stays off', () => {
  const PATHS: [string, (d: HTMLDialogElement) => void][] = [
    ['Not now', (d) => d.querySelector<HTMLButtonElement>('[data-board-intro-close]')!.click()],
    ['Escape', (d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside (the backdrop)', (d) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ];
  for (const [name, dismiss] of PATHS) {
    test(`${name}: closed, the Board still off, nothing saved, never claimed again`, async () => {
      const set = await leave();
      await until(() => dialog() !== null);
      expect(stamped).toBe(true);
      act(() => dismiss(dialog()!));
      expect(dialog()).toBeNull();
      expect(boardOn).toBe(false);
      set({ thread: 'msg_b' });
      await wait(TIMES.readMs + 20);
      set({ thread: null });
      await wait(TIMES.settledMs + 200);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
      expect(boardOn).toBe(false);
      expect(switchSaves()).toHaveLength(0);
    });
  }

  test('a reload: the next page claims at its moment, the Inbox answers no, nothing draws', async () => {
    await leave();
    await until(() => dialog() !== null);
    act(() => root!.unmount());
    host!.remove();
    root = null;
    await leave();
    await until(() => claims().length === 2);
    await wait(150);
    expect(dialog()).toBeNull();
  });
});

describe.skipIf(!hasDom)('the Checklist dialog (ChecklistIntro): an offer', () => {
  const checklist = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="checklist-intro"]');
  function render() {
    const calls: string[] = [];
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<ChecklistIntro phone={false} onClose={() => calls.push('close')} onTurnOn={() => calls.push('on')} />);
    });
    return calls;
  }

  test('Turn it on (the primary) is the only way on; Not now, Escape and a click outside close', () => {
    const calls = render();
    const on = checklist()!.querySelector<HTMLButtonElement>('[data-checklist-intro-on]')!;
    expect(on.textContent).toBe('Turn it on');
    expect(on.className).toContain('ib-pri');
    expect(checklist()!.querySelector('[data-checklist-intro-settings]')).toBeNull();
    const not = checklist()!.querySelector<HTMLButtonElement>('[data-checklist-intro-close]')!;
    expect(not.textContent).toBe('Not now');
    expect(not.className).toContain('ib-ghost');
    act(() => not.click());
    act(() => checklist()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    act(() => checklist()!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(calls).toEqual(['close', 'close', 'close']);
    act(() => on.click());
    expect(calls).toEqual(['close', 'close', 'close', 'on']);
  });
});

function Steps({ state }: { state: State }) {
  const r = reveal.useStepsReveal({
    due: state.due,
    listLoaded: true,
    firstRun: false,
    blocked: state.blocked,
    rows: state.rows,
    toast: false,
    thread: state.thread,
    clear: true,
    place: state.thread ?? '',
    heldBack: () => state.held,
    idle: state.idle === true,
    on: false,
    onStepsOn: () => {},
  });
  return r.stage === 'open' ? <div data-steps-offer="" /> : null;
}

function loadedRun(threadId: string, count: number) {
  const messages = Array.from({ length: count }, () => ({ author: { kind: 'agent', host: 'claude-code', session: 's1' }, body: 'step done' }));
  reveal.noteRevealThread({ thread_id: threadId, messages } as unknown as Parameters<typeof reveal.noteRevealThread>[0]);
}

describe.skipIf(!hasDom)('the page idle, with a thread kept open beside the list', () => {
  test('the Board: idle is its moment; never with a blocker present (under five rows, something open)', async () => {
    const set = mount({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: 'msg_b' });
    await wait(TIMES.settledMs + 120);
    expect(claims()).toHaveLength(0);
    set({ idle: true });
    await until(() => dialog() !== null);
    expect(claims()).toHaveLength(1);
    for (const blocker of [{ rows: ROWS.slice(0, 4) }, { held: true }]) {
      act(() => root?.unmount());
      host?.remove();
      posts = [];
      stamped = false;
      const again = mount({ ...BASE, ...blocker, thread: 'msg_a' });
      await wait(TIMES.pageAgeMs + 20);
      again({ idle: true });
      await wait(TIMES.settledMs + 200);
      expect(claims()).toHaveLength(0);
    }
  });

  test('the Checklist: idle on a long agent run is its moment; on a short thread it is not', async () => {
    loadedRun('msg_a', 5);
    loadedRun('msg_b', 4);
    for (const [thread, claimed] of [['msg_b', 0], ['msg_a', 1]] as const) {
      posts = [];
      host = document.createElement('div');
      document.body.appendChild(host);
      let state: State = { ...BASE, thread };
      act(() => {
        root = createRoot(host!);
        root.render(<Steps state={state} />);
      });
      await wait(TIMES.pageAgeMs + 20);
      state = { ...state, idle: true };
      act(() => root!.render(<Steps state={state} />));
      if (claimed) await until(() => document.querySelector('[data-steps-offer]') !== null);
      else await wait(TIMES.settledMs + 200);
      expect(claims()).toHaveLength(claimed);
      act(() => root?.unmount());
      host.remove();
    }
  });
});

function StarThenBoard({ state }: { state: State }) {
  const common = { listLoaded: true, firstRun: false, rows: state.rows, toast: false, thread: state.thread, clear: true, place: state.thread ?? '', heldBack: () => false };
  const star = reveal.useStarReveal({ ...common, due: true, blocked: false });
  const board = reveal.useBoardReveal({ ...common, due: true, blocked: reveal.oneTimeDialogShownThisLoad(), on: false, onBoardOn: () => {} });
  return (
    <>
      {star.stage === 'open' && <div data-star-card="" />}
      {board.stage === 'open' && <div data-board-offer="" />}
    </>
  );
}

describe.skipIf(!hasDom)('the star card holds the line’s reveals back for the load', () => {
  test('once the star card opens, the Board reveal never claims on this load, even at its own moment', async () => {
    expect(reveal.oneTimeDialogShownThisLoad()).toBe(false);
    let state: State = { ...BASE, rows: ROWS.slice(0, 2) };
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<StarThenBoard state={state} />);
    });
    const set = (next: Partial<State>) => {
      state = { ...state, ...next };
      act(() => root!.render(<StarThenBoard state={state} />));
    };
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    set({ thread: null });
    await until(() => document.querySelector('[data-star-card]') !== null);
    expect(claims().map((c) => (c.body as { id: string }).id)).toEqual(['star']);
    expect(reveal.oneTimeDialogShownThisLoad()).toBe(true);
    set({ rows: ROWS });
    set({ thread: 'msg_b' });
    await wait(TIMES.readMs + 20);
    set({ thread: null });
    await wait(TIMES.settledMs + 200);
    expect(claims().map((c) => (c.body as { id: string }).id)).toEqual(['star']);
    expect(document.querySelector('[data-board-offer]')).toBeNull();
  });
});
