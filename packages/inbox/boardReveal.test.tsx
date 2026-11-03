/**
 * The Board reveal in a DOM (approval "inbox-feature-reveal", 2026-11-03): the calm-moment gate (reveal.ts
 * `useBoardReveal`) driving the Board's existing first-visit dialog (board/BoardIntro.tsx), as App wires them.
 *
 * What regresses: the dialog showing on load, or with any one blocker present (a thread left too soon or for another
 * thread, too young a page, under five rows, the tour or another one-time dialog this load, a toast, something typed
 * or open, a page not clear, not armed); the Board not turned on with it; a second claim after any way out (Not now,
 * Escape, a click outside, a reload); the Board turned back off by a way out; a dialog drawn the Inbox did not grant.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { BoardIntro } = (hasDom ? await import('./board/BoardIntro') : {}) as typeof import('./board/BoardIntro');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: unknown }[] = [];
/** The Inbox's compare-and-set: the first claim shows it. */
let stamped = false;
/** Whether the Inbox grants the claim at all (false: another tab won, or it is no longer next). */
let grants = true;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  stamped = false;
  grants = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if ((init?.method ?? 'GET') === 'POST') posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    if (path.endsWith('/api/inbox/reveal')) {
      const show = grants && !stamped;
      stamped = true;
      return new Response(JSON.stringify({ show, reveal: { next: null }, board: { on: show } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="board-intro"]');

function row(id: string): InboxListRow {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    thread_id: id,
    project_id: 'prj_1',
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
    project: { id: 'prj_1', name: 'billing' },
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

const ROWS = ['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e'].map(row);

interface State {
  due: boolean;
  blocked: boolean;
  rows: InboxListRow[];
  toast: boolean;
  thread: string | null;
  clear: boolean;
  held: boolean;
  firstRun: boolean;
}

const BASE: State = { due: true, blocked: false, rows: ROWS, toast: false, thread: null, clear: true, held: false, firstRun: false };

/** What App holds: whether the Board is on (the sidebar's row reads it). */
let boardOn = false;

function Harness({ state }: { state: State }) {
  const [on, setOn] = useState(false);
  boardOn = on;
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
    onBoardOn: () => setOn(true),
  });
  return (
    <>
      {on && <a href="#board" data-sidebar-board="">Board</a>}
      {r.stage === 'open' && <BoardIntro mcpCommand={null} phone={false} onClose={r.close} />}
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

/** The calm moment: the page past its age, msg_a opened and read, then back to the list. `state` applies a blocker. */
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
  test('back on the list after reading a thread: one claim for the Board, the Board turned on, then its first-visit dialog', async () => {
    const set = mount({ ...BASE, thread: 'msg_a' });
    // Never on load, however long the thread stays open.
    await wait(TIMES.pageAgeMs + 100);
    expect(claims()).toHaveLength(0);
    set({ thread: null });
    await until(() => dialog() !== null);
    expect(claims().map((c) => c.body)).toEqual([{ id: 'board' }]);
    expect(boardOn).toBe(true);
    expect(document.querySelector('[data-sidebar-board]')).not.toBeNull();
    expect(dialog()!.querySelector('[data-board-intro-copy]')).not.toBeNull();
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

  test('a claim the Inbox refuses (another tab won): nothing drawn, the Board left as it was', async () => {
    grants = false;
    await leave();
    await until(() => claims().length === 1);
    await wait(150);
    expect(dialog()).toBeNull();
    expect(boardOn).toBe(false);
  });
});

describe.skipIf(!hasDom)('every way out is final, and the Board stays on', () => {
  const PATHS: [string, (d: HTMLDialogElement) => void][] = [
    ['Not now', (d) => d.querySelector<HTMLButtonElement>('[data-board-intro-close]')!.click()],
    ['Escape', (d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))],
    ['a click outside (the backdrop)', (d) => d.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
  ];
  for (const [name, dismiss] of PATHS) {
    test(`${name}: closed, the Board still on, never claimed again`, async () => {
      const set = await leave();
      await until(() => dialog() !== null);
      expect(stamped).toBe(true);
      act(() => dismiss(dialog()!));
      expect(dialog()).toBeNull();
      expect(boardOn).toBe(true);
      // Another calm moment on this load: nothing.
      set({ thread: 'msg_b' });
      await wait(TIMES.readMs + 20);
      set({ thread: null });
      await wait(TIMES.settledMs + 200);
      expect(claims()).toHaveLength(1);
      expect(dialog()).toBeNull();
      expect(boardOn).toBe(true);
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
