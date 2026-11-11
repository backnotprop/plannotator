import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { SnoozeIntro } = (hasDom ? await import('./components/SnoozeIntro') : {}) as typeof import('./components/SnoozeIntro');
const intro = (hasDom ? await import('./snoozeIntro') : {}) as typeof import('./snoozeIntro');
const { openSnoozeMenu } = (hasDom ? await import('./snoozeIntroTry') : {}) as typeof import('./snoozeIntroTry');
const { ThreadMore } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');
const { ThreadRowMenu } = (hasDom ? await import('./components/RowMenu') : {}) as typeof import('./components/RowMenu');

const DAY = 24 * 60 * 60 * 1000;
const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof intro.SNOOZE_INTRO_TIMES;
let posts: string[] = [];
let stamped = false;
let claimHeld: Promise<void> | null = null;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...intro.SNOOZE_INTRO_TIMES };
  Object.assign(intro.SNOOZE_INTRO_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  claimHeld = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? 'GET') === 'POST') posts.push(path.replace(/^https?:\/\/[^/]+/, ''));
    if (path.endsWith('/api/inbox/snooze-intro')) {
      const show = !stamped;
      stamped = true;
      if (claimHeld) await claimHeld;
      return new Response(JSON.stringify({ show, snooze_intro: { due: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  Object.assign(intro.SNOOZE_INTRO_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
/**
 * Waits until `done` holds, or two seconds pass: what must happen is awaited, not timed, so a slow runner's late timers
 * cannot fail it. What must not happen is still checked after a fixed wait.
 */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const SLOW_SETTLE_MS = 600;
const claims = () => posts.filter((p) => p.endsWith('/api/inbox/snooze-intro')).length;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="snooze-intro"]');

function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  const old = new Date(Date.now() - 2 * DAY).toISOString();
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: old,
    last_at: old,
    last_agent_at: old,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing' },
    thread_name: `name-${id}`,
    section: 'waiting',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    unsent: null,
    sent: null,
    guide: false,
    ...over,
  };
}

const ROWS = [row('msg_a'), row('msg_b'), row('msg_c')];

interface State {
  due: boolean;
  blocked: boolean;
  snoozedHere: boolean;
  rows: InboxListRow[];
  toast: boolean;
  thread: string | null;
  clear: boolean;
  held: boolean;
}

const BASE: State = { due: true, blocked: false, snoozedHere: false, rows: ROWS, toast: false, thread: 'msg_a', clear: true, held: false };

function Harness({ state, onTry }: { state: State; onTry?: (target: string | null, close: () => void) => void }) {
  const z = intro.useSnoozeIntro({
    due: state.due,
    listLoaded: true,
    firstRun: false,
    blocked: state.blocked,
    snoozedHere: state.snoozedHere,
    rows: state.rows,
    toast: state.toast,
    thread: state.thread,
    clear: state.clear,
    place: state.thread ?? '',
    heldBack: () => state.held,
  });
  return z.stage === 'open' ? <SnoozeIntro rows={state.rows.slice(0, 2)} phone={false} onClose={z.close} onTry={() => (onTry ? onTry(z.target, z.close) : z.close())} /> : null;
}

function mount(state: State, onTry?: (target: string | null, close: () => void) => void) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} onTry={onTry} />);
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(<Harness state={state} onTry={onTry} />));
  };
}

async function leave(state: Partial<State> = {}, options: { early?: boolean; young?: boolean } = {}) {
  const set = mount({ ...BASE, ...state, thread: null });
  if (!options.young) await wait(TIMES.pageAgeMs + 20);
  set({ thread: 'msg_a' });
  await wait(options.early ? 10 : TIMES.readMs + 20);
  set({ thread: null });
  await wait(TIMES.settledMs + 120);
  return set;
}

describe.skipIf(!hasDom)('the calm moment', () => {
  test('leaving a waiting thread after reading it, on a settled page past its age: claimed once, then drawn', async () => {
    mount({ ...BASE });
    await wait(TIMES.pageAgeMs + 100);
    expect(claims()).toBe(0);
    expect(dialog()).toBeNull();
    act(() => root!.render(<Harness state={{ ...BASE, thread: null }} />));
    await until(() => dialog() !== null);
    expect(claims()).toBe(1);
    expect(dialog()).not.toBeNull();
  });

  const BLOCKERS: [string, Partial<State>, { early?: boolean; young?: boolean }?][] = [
    ['the thread was open under the read time', {}, { early: true }],
    ['the page is younger than its age', {}, { young: true }],
    ['the thread left no longer waits (the person answered)', { rows: [row('msg_a', { section: 'sent', waiting_on_person: false }), ROWS[1]!, ROWS[2]!] }],
    ['words were left in its box', { rows: [row('msg_a', { unsent: { reply_at: new Date().toISOString(), picks: 0, comments: 0 } as never }), ROWS[1]!, ROWS[2]!] }],
    ['under two threads read and left a day (the one just left counts as one)', { rows: [ROWS[0]!, row('msg_b', { unseen: 1 }), row('msg_c', { last_agent_at: new Date().toISOString() })] }],
    ['under three rows', { rows: [ROWS[0]!, ROWS[1]!] }],
    ['the tour, an update or another one-time dialog this load', { blocked: true }],
    ['a toast is up', { toast: true }],
    ['something is typed or open', { held: true }],
    ['the Inbox page is not clear (a search, a file, Settings)', { clear: false }],
    ['this page snoozed something', { snoozedHere: true }],
    ['the Inbox has it not due', { due: false }],
  ];
  for (const [name, state, options] of BLOCKERS) {
    test(`blocked: ${name}`, async () => {
      await leave(state, options);
      await wait(200);
      expect(claims()).toBe(0);
      expect(dialog()).toBeNull();
    });
  }

  test('App\'s "another one-time dialog this load": each one alone holds it back', () => {
    const none = { tour: false, updating: false, sound: 'none', agentNote: 'none', listIntroWant: false, listIntro: 'none', voiceWanted: false, voiceStage: 'none', board: false };
    expect(intro.snoozeIntroBlockedBy(none)).toBe(false);
    const each = { tour: true, updating: true, sound: 'open', agentNote: 'open', listIntroWant: true, listIntro: 'open', voiceWanted: true, voiceStage: 'open', board: true };
    for (const key of Object.keys(each) as (keyof typeof each)[]) {
      expect([key, intro.snoozeIntroBlockedBy({ ...none, [key]: each[key] })]).toEqual([key, true]);
    }
  });

  // A reply draft saves 500 ms after the last key, so the list can learn of it only after the person left the thread.
  const DRAFTED = [row('msg_a', { unsent: { reply_at: new Date().toISOString(), picks: 0, comments: 0 } as never }), ROWS[1]!, ROWS[2]!];
  async function leaveClean() {
    const set = mount({ ...BASE, thread: null });
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    set({ thread: null });
    return set;
  }

  test('a draft that reaches the list after the leave: never claimed', async () => {
    intro.SNOOZE_INTRO_TIMES.settledMs = SLOW_SETTLE_MS;
    const set = await leaveClean();
    await wait(20);
    set({ rows: DRAFTED });
    await wait(SLOW_SETTLE_MS + 200);
    expect(claims()).toBe(0);
    expect(dialog()).toBeNull();
  });

  test('a draft that reaches the list while the claim is on its way: never drawn', async () => {
    let answer = () => {};
    claimHeld = new Promise<void>((resolve) => (answer = resolve));
    const set = await leaveClean();
    await until(() => claims() === 1);
    expect(claims()).toBe(1);
    set({ rows: DRAFTED });
    await act(async () => answer());
    await wait(100);
    expect(dialog()).toBeNull();
  });

  test('blocked until the list settles: a list still changing keeps it waiting', async () => {
    intro.SNOOZE_INTRO_TIMES.settledMs = SLOW_SETTLE_MS;
    const set = mount({ ...BASE });
    await wait(TIMES.pageAgeMs + 20);
    set({ thread: null });
    for (let i = 0; i < 6; i++) {
      await wait(SLOW_SETTLE_MS / 6);
      set({ rows: [ROWS[0]!, ROWS[1]!, row('msg_c'), row(`msg_new${i}`, { section: 'new', unseen: 1 })] });
    }
    expect(claims()).toBe(0);
    await until(() => claims() === 1);
    expect(claims()).toBe(1);
  });
});

describe.skipIf(!hasDom)('every dismiss is final', () => {
  const PATHS: [string, (d: HTMLDialogElement) => void][] = [
    ['Got it', (d) => d.querySelector<HTMLButtonElement>('[data-snooze-intro-close]')!.click()],
    ['Escape', (d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside (the backdrop)', (d) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ];
  for (const [name, dismiss] of PATHS) {
    test(`${name}: stamped by the claim before it drew, closed, and never claimed again`, async () => {
      const set = await leave();
      await until(() => dialog() !== null);
      expect(dialog()).not.toBeNull();
      expect(stamped).toBe(true);
      expect(claims()).toBe(1);
      act(() => dismiss(dialog()!));
      expect(dialog()).toBeNull();
      set({ thread: 'msg_a' });
      await wait(TIMES.readMs + 20);
      set({ thread: null });
      await wait(TIMES.settledMs + 200);
      expect(claims()).toBe(1);
      expect(dialog()).toBeNull();
    });
  }

  test('a reload: the next page claims at its moment, the Inbox answers no, and nothing draws', async () => {
    await leave();
    await until(() => dialog() !== null);
    expect(dialog()).not.toBeNull();
    act(() => root!.unmount());
    host!.remove();
    await leave();
    await until(() => claims() === 2);
    await wait(100);
    expect(claims()).toBe(2);
    expect(dialog()).toBeNull();
  });
});

const THREAD = { thread_id: 'msg_a', subject: 'Which index?', messages: [], project: { id: 'prj_1', name: 'billing' } } as unknown as InboxThread;

describe.skipIf(!hasDom)('Try it opens the real Snooze menu and snoozes nothing', () => {
  function frame(children: ReactNode) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(children);
    });
    return host;
  }

  test('a thread open: its header ⋯ menu at the times, from the dialog’s Try it', async () => {
    const picked: string[] = [];
    const snooze = { snoozed: false, onPick: (until: string) => picked.push(until), onUnsnooze: () => picked.push('unsnooze') };
    let opened: Promise<boolean> | null = null;
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <section className="ib-pane">
            <ThreadMore thread={THREAD} linkOf={() => ''} phone={false} snooze={snooze} />
          </section>
          {open && (
            <SnoozeIntro
              rows={ROWS.slice(0, 2)}
              phone={false}
              onClose={() => setOpen(false)}
              onTry={() => {
                setOpen(false);
                opened = openSnoozeMenu({ root: host!, phone: false, openThread: 'msg_a', left: 'msg_b', openLeft: () => {} });
              }}
            />
          )}
        </>
      );
    }
    frame(<Page />);
    await act(async () => {
      dialog()!.querySelector<HTMLButtonElement>('[data-snooze-intro-try]')!.click();
      expect(await opened!).toBe(true);
    });
    expect(document.querySelectorAll('[data-thread-menu] [data-snooze-choice]').length).toBeGreaterThan(1);
    await wait(100);
    expect(picked).toEqual([]);
    expect(posts.filter((p) => p.includes('/snooze'))).toEqual([]);
  });

  test('a phone, a thread open: its ⋯ sheet, swapped to the times', async () => {
    const picked: string[] = [];
    frame(
      <section className="ib-pane">
        <ThreadMore thread={THREAD} linkOf={() => ''} phone snooze={{ snoozed: false, onPick: (until) => picked.push(until), onUnsnooze: () => picked.push('unsnooze') }} />
      </section>,
    );
    let ok = false;
    await act(async () => {
      ok = await openSnoozeMenu({ root: host!, phone: true, openThread: 'msg_a', left: null, openLeft: () => {} });
    });
    expect(ok).toBe(true);
    expect(document.querySelectorAll('[data-thread-menu] [data-snooze-choice]').length).toBeGreaterThan(1);
    await wait(100);
    expect(picked).toEqual([]);
  });

  test('no thread open: the right-click menu of the row just left, swapped to the times', async () => {
    const picked: string[] = [];
    const target = row('msg_a');
    frame(
      <ThreadRowMenu className="ib-lbody" rowOf={(id) => (id === 'msg_a' ? target : null)} canMarkRead={false} onSnooze={(_r, until) => picked.push(until)} onAction={(_r, action) => picked.push(action)} onTarget={() => {}} held={false}>
        <div data-row="msg_a">
          <button type="button" data-thread-id="msg_a">
            Which index?
          </button>
        </div>
      </ThreadRowMenu>,
    );
    let ok = false;
    await act(async () => {
      ok = await openSnoozeMenu({ root: host!, phone: false, openThread: null, left: 'msg_a', openLeft: () => {} });
    });
    expect(ok).toBe(true);
    expect(document.querySelectorAll('[data-row-menu="msg_a"] [data-snooze-choice]').length).toBeGreaterThan(1);
    await wait(100);
    expect(picked).toEqual([]);
  });
});
