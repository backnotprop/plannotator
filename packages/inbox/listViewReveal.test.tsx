/**
 * The List view's one-time announcement in a DOM (approval "inbox-list-view", the owner's ask, 2026-11-05): the reveals'
 * calm moment (reveal.ts `useListViewReveal`) driving `ListViewIntro`, as App wires them.
 *
 * What regresses: the dialog showing on load, or with any one blocker present (under five rows, a dev build, the list
 * already List, another one-time dialog or reveal this load, a toast, something typed or open, a thread open or left
 * for another thread); "Use List" not switching the list at once or not remembering it as the ⋮ menu does; "Keep
 * Grouped" or Escape switching anything; the dialog showing a second time in the same browser (a reload, after any
 * way out); a keyboard shortcut or a server call of its own.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { ListView } from './listView';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { ListViewIntro } = (hasDom ? await import('./components/ListViewIntro') : {}) as typeof import('./components/ListViewIntro');
const listView = await import('./listView');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30 };

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedTimes: typeof reveal.REVEAL_TIMES;
let savedFetch: typeof fetch;
let fetched: string[] = [];

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
  savedFetch = globalThis.fetch;
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response('{}', { status: 404 });
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
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="list-view-intro"]');

function row(id: string): InboxListRow {
  return { thread_id: id, section: 'new', unseen: 0 } as unknown as InboxListRow;
}
const FIVE = ['a', 'b', 'c', 'd', 'e'].map(row);

interface State {
  release: boolean;
  blocked: boolean;
  rows: InboxListRow[];
  toast: boolean;
  thread: string | null;
  held: boolean;
}
const BASE: State = { release: true, blocked: false, rows: FIVE, toast: false, thread: null, held: false };

/** The view the list would draw (App reads the same hook). */
let drawn: ListView = 'grouped';

/** App's wiring (App.tsx): due read once per load, the cookie written as it opens, "Use List" through the menu's setter. */
function Harness({ state, due }: { state: State; due: boolean }) {
  const [view, setView] = listView.useListView();
  drawn = view;
  const r = reveal.useListViewReveal({
    due,
    release: state.release,
    listLoaded: true,
    firstRun: false,
    blocked: state.blocked,
    grouped: view === 'grouped',
    rows: state.rows,
    toast: state.toast,
    thread: state.thread,
    clear: true,
    place: state.thread ?? '',
    heldBack: () => state.held,
  });
  const open = r.stage === 'open';
  useEffect(() => {
    if (open) listView.markListViewIntroSeen();
  }, [open]);
  return open ? (
    <ListViewIntro
      phone={false}
      onKeep={r.close}
      onUseList={() => {
        setView('list');
        r.close();
      }}
    />
  ) : null;
}

function mount(state: State) {
  // A load reads "due" once, as App's latch does.
  const due = !listView.listViewIntroSeen();
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} due={due} />);
  });
  return (next: Partial<State>) => {
    state = { ...state, ...next };
    act(() => root!.render(<Harness state={state} due={due} />));
  };
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  listView.resetListViewForTests();
}

/** The calm moment: the page past its age, a thread opened and read, then back to the list (or on to `to`). */
async function leave(state: Partial<State> = {}, to: string | null = null) {
  const set = mount({ ...BASE, ...state });
  await wait(TIMES.pageAgeMs + 20);
  set({ thread: 'a' });
  await wait(TIMES.readMs + 20);
  set({ thread: to });
  await wait(TIMES.settledMs + 150);
  return set;
}

describe.skipIf(!hasDom)('the List view announcement', () => {
  test('never on load; back on the list after reading a thread it opens once, and "Use List" switches the list at once, remembered', async () => {
    const set = mount({ ...BASE, thread: 'a' });
    await wait(TIMES.pageAgeMs + 100);
    expect(dialog()).toBeNull();
    set({ thread: null });
    await until(() => dialog() !== null);
    expect(dialog()).not.toBeNull();
    // Spent as it opens: a reload now would not show it again.
    expect(stored.has(listView.LIST_VIEW_INTRO_COOKIE)).toBe(true);
    // Named and described for a screen reader; focus on its main button.
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe('List view');
    expect(document.getElementById(dialog()!.getAttribute('aria-describedby')!)?.textContent).toBe('Every thread in one list, newest first.');
    expect(document.activeElement?.hasAttribute('data-list-view-intro-use')).toBe(true);
    expect(drawn).toBe('grouped');
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-intro-use]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('list');
    expect(stored.get(listView.LIST_VIEW_COOKIE)).toBe('list');
    // Nothing on the Inbox: the choice and the latch are this browser's.
    expect(fetched).toEqual([]);
  });

  test('"Keep Grouped" and Escape leave the groups; it never shows again in this browser', async () => {
    await leave();
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-intro-keep]')!.click());
    expect(dialog()).toBeNull();
    expect(drawn).toBe('grouped');
    expect(stored.has(listView.LIST_VIEW_COOKIE)).toBe(false);
    unmount();
    // A reload, the same moment again: nothing.
    await leave();
    await wait(300);
    expect(dialog()).toBeNull();
    unmount();
    // Escape, in a browser that has not had it.
    stored.clear();
    await leave();
    await until(() => dialog() !== null);
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await until(() => dialog() === null);
    expect(dialog()).toBeNull();
    expect(drawn).toBe('grouped');
  });

  const blockers: [string, Partial<State>, string | null][] = [
    ['under five rows', { rows: FIVE.slice(0, 4) }, null],
    ['a dev or test build', { release: false }, null],
    ['another one-time dialog or reveal this load', { blocked: true }, null],
    ['a toast up', { toast: true }, null],
    ['something typed or open', { held: true }, null],
    ['a thread left for another thread (still open)', {}, 'b'],
  ];
  for (const [what, state, to] of blockers) {
    test(`not with ${what}`, async () => {
      await leave(state, to);
      await wait(400);
      expect(dialog()).toBeNull();
      expect(stored.has(listView.LIST_VIEW_INTRO_COOKIE)).toBe(false);
    });
  }

  test('not once the list is List: the announcement is for the groups', async () => {
    stored.set(listView.LIST_VIEW_COOKIE, 'list');
    await leave();
    await wait(400);
    expect(dialog()).toBeNull();
  });

  test('releaseVersion: only a release build', () => {
    expect(reveal.releaseVersion('0.28.47')).toBe(true);
    expect(reveal.releaseVersion('0.0.0-dev')).toBe(false);
    expect(reveal.releaseVersion('dev')).toBe(false);
    expect(reveal.releaseVersion(undefined)).toBe(false);
  });
});
