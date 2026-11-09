/**
 * What a page load arms of the line of one-time dialogs, as time passes on a tab left loaded (reveal.ts
 * `useLineLatch`), wired to a line dialog as App wires it (`useLineReveal`, List view's moment).
 *
 * What regresses: a tab loaded while the line was held (the day after a dialog, the spacing not over) never arming
 * the dialog the Inbox names later, so someone whose tab stays loaded for days never sees a one-time dialog (the
 * owner, 2026-11-09: "never saw the List view dialog"); the tab never asking the Inbox again as time passes, or asking
 * while it is hidden, or not asking when it comes back in front; a tab still armed for a dialog the line has moved
 * past; a load that already showed a dialog arming another (one dialog a load), or still asking; a tab on an Inbox
 * that keeps no line asking at all.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { InboxRevealId } from './api';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');

const TIMES = { pageAgeMs: 100, readMs: 40, settledMs: 40, momentMs: 1500, recheckMs: 20, claimRetryMs: 30, lineReadMs: 150 };

type Line = { next: InboxRevealId | null; ahead?: InboxRevealId[]; line?: boolean };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedFetch: typeof fetch;
/** What the Inbox would answer a settings read now: the line as the server has it. */
let server: Line = { next: null, line: true };
/** How many times the page asked for the line again. */
let rereads = 0;
let claims: string[] = [];
let visible = true;

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  server = { next: null, line: true };
  rereads = 0;
  claims = [];
  visible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (path.endsWith('/api/inbox/reveal') && init?.method === 'POST') {
      claims.push((JSON.parse(String(init.body)) as { id: string }).id);
      return new Response(JSON.stringify({ show: true, reveal: { next: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}

const ROWS = ['a', 'b', 'c', 'd', 'e'].map(
  (id) =>
    ({
      thread_id: id,
      project: { id: 'prj_a', name: 'billing-svc' },
      subject: `Thread ${id}`,
      section: 'new',
      unseen: 0,
      questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    }) as unknown as InboxListRow,
);

interface State {
  /** The settings the page holds (its newest read). */
  settings: { reveal: Line };
  thread: string | null;
  /** This load showed or claimed another one-time dialog. */
  spent: boolean;
}

/** App's wiring: the latch over the page's settings, a reread that reads the Inbox's line into them, List view armed from it. */
function Harness({ state, onSettings }: { state: State; onSettings: (line: Line) => void }) {
  const latch = reveal.useLineLatch({
    read: reveal.revealArmed(state.settings),
    spent: state.spent,
    line: state.settings.reveal.line === true,
    reread: () => {
      rereads += 1;
      onSettings(server);
    },
  });
  reveal.useLineReveal({
    id: 'list_view',
    due: latch?.next === 'list_view' || (latch?.ahead.includes('list_view') ?? false),
    blocked: false,
    rows: ROWS,
    toast: false,
    thread: state.thread,
    clear: state.thread === null,
    place: state.thread ?? '',
    heldBack: () => false,
    leaveCounts: (_visit, _now, _row, next) => reveal.listViewRevealLeaveCounts(next),
    mayClaim: (pageAge) => pageAge >= TIMES.pageAgeMs,
    holds: () => true,
  });
  return null;
}

function mount(first: Line, spent = false) {
  let state: State = { settings: { reveal: first }, thread: null, spent };
  const draw = () => act(() => root!.render(<Harness state={state} onSettings={(line) => set({ settings: { reveal: line } })} />));
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    if (root) draw();
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
  });
  draw();
  return set;
}

/** The moment: a thread read, then back on the list, and the settling wait. */
async function readAndLeave(set: (next: Partial<State>) => void) {
  set({ thread: 'a' });
  await wait(TIMES.readMs + 20);
  set({ thread: null });
  await wait(TIMES.settledMs + 120);
}

describe.skipIf(!hasDom)('what a load arms of the line, on a tab left loaded', () => {
  test('a tab loaded while the line was held arms the dialog the Inbox names later, and claims it at its moment', async () => {
    const set = mount({ next: null, line: true });
    await wait(TIMES.pageAgeMs + 20);
    await readAndLeave(set);
    expect(claims).toEqual([]);
    // Time passes: the day after the last dialog, the Inbox has List view for this page.
    server = { next: null, ahead: ['list_view'], line: true };
    rereads = 0;
    await until(() => rereads > 0);
    await readAndLeave(set);
    await until(() => claims.length > 0);
    expect(claims).toEqual(['list_view']);
  });

  test('the line moved past the dialog this tab was armed for (shown elsewhere): it is not claimed here', async () => {
    const set = mount({ next: 'list_view', line: true });
    await wait(TIMES.pageAgeMs + 20);
    server = { next: null, line: true };
    rereads = 0;
    await until(() => rereads > 0);
    await readAndLeave(set);
    expect(claims).toEqual([]);
  });

  test('a hidden tab does not ask; back in front after that long it asks at once', async () => {
    visible = false;
    mount({ next: null, line: true });
    await wait(TIMES.lineReadMs * 3);
    expect(rereads).toBe(0);
    visible = true;
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(rereads).toBe(1);
  });

  test('a load that already showed a one-time dialog keeps what it held and asks no more', async () => {
    const set = mount({ next: null, line: true }, true);
    await wait(TIMES.pageAgeMs + 20);
    server = { next: 'list_view', line: true };
    await wait(TIMES.lineReadMs * 3);
    expect(rereads).toBe(0);
    // A settings read for another reason (the stream reconnected) names List view: this load still arms nothing.
    set({ settings: { reveal: server } });
    await readAndLeave(set);
    expect(claims).toEqual([]);
  });

  test('an Inbox that keeps no line (a dev build, an older Inbox) is never asked again', async () => {
    mount({ next: null });
    await wait(TIMES.lineReadMs * 3);
    expect(rereads).toBe(0);
  });
});
