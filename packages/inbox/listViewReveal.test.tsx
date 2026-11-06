/**
 * The List view's one-time announcement in a DOM (approval "inbox-list-view", the owner's ask, 2026-11-05): the reveals'
 * calm moment (reveal.ts `useListViewReveal`) driving `ListViewIntro`, as App wires them.
 *
 * What regresses: the dialog showing on load, or with any one blocker present (under five rows, a dev build, the list
 * already List, another one-time dialog or reveal this load, a toast, something typed or open, a thread open or left
 * for another thread); "Simple list" not switching the list at once or not remembering it as the ⋮ menu does; "Smart
 * groups" or Escape switching anything; the dialog showing a second time in the same browser (a reload, after any
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
const { ThemeProvider } = (hasDom ? await import('@plannotator/ui/components/ThemeProvider') : {}) as typeof import('@plannotator/ui/components/ThemeProvider');
const { readListLook } = await import('./listLook');
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

/** App's wiring (App.tsx): due read once per load, the cookie written as it opens, "Simple list" through the menu's setter. */
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
    <ThemeProvider>
      <ListViewIntro
        groups={[{ id: 'new', label: 'New since you looked', count: FIVE.length, rows: FIVE }]}
        flat={FIVE.map((row) => ({ row, drawn: 'new' as const }))}
        look={readListLook()}
        phone={false}
        current={view}
        onSmart={r.close}
        onSimple={() => {
          setView('list');
          r.close();
        }}
      />
    </ThemeProvider>
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
  test('never on load; back on the list after reading a thread it opens once, and "Simple list" switches the list at once, remembered', async () => {
    const set = mount({ ...BASE, thread: 'a' });
    await wait(TIMES.pageAgeMs + 100);
    expect(dialog()).toBeNull();
    set({ thread: null });
    await until(() => dialog() !== null);
    expect(dialog()).not.toBeNull();
    // Spent as it opens: a reload now would not show it again.
    expect(stored.has(listView.LIST_VIEW_INTRO_COOKIE)).toBe(true);
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
    // Nothing on the Inbox: the choice and the latch are this browser's.
    expect(fetched).toEqual([]);
  });

  test('"Smart groups" and Escape leave the groups; it never shows again in this browser', async () => {
    await leave();
    await until(() => dialog() !== null);
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-list-view-choice="smart"]')!.click());
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
      unmount();
    }
  });

  test('releaseVersion: only a release build', () => {
    expect(reveal.releaseVersion('0.28.47')).toBe(true);
    expect(reveal.releaseVersion('0.0.0-dev')).toBe(false);
    expect(reveal.releaseVersion('dev')).toBe(false);
    expect(reveal.releaseVersion(undefined)).toBe(false);
  });
});
