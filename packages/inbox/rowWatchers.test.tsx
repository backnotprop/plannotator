/**
 * What a list's rows hold while they wait: a list mounts every row of its open groups (about 2,200 on a large Inbox,
 * the memory soak's store), so anything one row subscribes to or sets up is paid 2,200 times from the moment the
 * window opens, whether or not the person uses the feature behind it. Values the same for every row are read once by
 * the list (rowParts.tsx `ListRows`). What would regress: a per-row watcher coming back (the count growing with the
 * rows), or a row not following a change made after the list drew.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InboxAgent, InboxAgentsGroup, InboxListRow, InboxListSection, InboxRexMark } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxList, ListRow } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { adoptSavedRows, listLookWatchersForTests, resetListLookForTests } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
const { setInboxAgents } = (hasDom ? await import('./agentsList') : {}) as typeof import('./agentsList');
const { agentStatusWatchersForTests } = (hasDom ? await import('./agents/agentStatus') : {}) as typeof import('./agents/agentStatus');
const { setSessionLabels } = (hasDom ? await import('./sessionLabels') : {}) as typeof import('./sessionLabels');
const { hover, openTooltips, settle, unhover } = await import('./testing/tooltip');
const { undeliveredLabel } = await import('./deliveryLine');

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  // Nothing here asks the server; a stray request answers empty rather than reaching a network.
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => {
    resetListLookForTests();
    setInboxAgents(null);
    setSessionLabels({});
  });
});

const ROWS = 60;

function listRow(n: number, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: `thr_${n}`,
    project_id: 'prj_billing',
    subject: `Fix the totals ${n}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${n % 3}`, name: null },
    created_at: '2026-11-07T10:00:00.000Z',
    last_at: '2026-11-07T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_billing', name: 'billing-svc' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  } as InboxListRow;
}

const none = () => {};

function mount(rows: InboxListRow[] = Array.from({ length: ROWS }, (_, i) => listRow(i))): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  draw(rows);
  return host;
}

/** The list drawn again with `rows`, as the next list read would. */
function draw(rows: InboxListRow[]): void {
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: rows }];
  act(() =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={false} onRowAction={none} />
      </SidebarProvider>,
    ),
  );
}

const rowEls = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-thread-id]')];

test.skipIf(!hasDom)('the rows read the Rows look once for the list; letter marks turned on after it drew show on every row', () => {
  const before = listLookWatchersForTests();
  const el = mount();
  expect(rowEls(el).length).toBe(ROWS);
  // The list's own few watchers, whatever its length (each row had four: its title's, avatar's, project's and icon's).
  expect(listLookWatchersForTests() - before).toBeLessThanOrEqual(3);
  expect(el.querySelectorAll('.ib-lm-tt, .ib-lm-rowp, .ib-lm-av').length).toBe(0);
  // Settings → Rows, after the list drew: Inline marks for threads and projects.
  act(() => adoptSavedRows(['smallNames', 'marksThreads', 'marksProjects', 'markInline'], 1));
  expect(rowEls(el).filter((row) => row.querySelector('.ib-lm-tt[data-take="inline"]') && row.querySelector('.ib-lm-rowp')).length).toBe(ROWS);
  // Then Avatar: every row swaps to the avatar, none keeps the title's tile.
  act(() => adoptSavedRows(['smallNames', 'marksThreads', 'marksProjects'], 2));
  expect(rowEls(el).filter((row) => row.querySelector('.ib-lm-av') && !row.querySelector('.ib-lm-tt')).length).toBe(ROWS);
});

/** Three sessions' agents, `marks` giving each one's Rex record (none: today's icon). */
function agentsWith(marks: Partial<Record<string, InboxRexMark>>): InboxAgentsGroup[] {
  const agents = ['ses_0', 'ses_1', 'ses_2'].map(
    (id): InboxAgent => ({ id, session: id, host: 'claude-code', project: { id: 'prj_billing', name: 'billing-svc' }, state: 'idle', waiting: 0, live: true, started_at: null, last_seen_at: null, ...(marks[id] ? { rex_mark: marks[id] } : {}) }),
  );
  return [{ agents, total: agents.length, ended_today: 0 }];
}

const rexOf = (row: HTMLElement) => row.querySelector<HTMLElement>('.ib-rxm')?.dataset.rxState ?? null;

test.skipIf(!hasDom)("the rows' agent icons watch the agents' Rex marks once for the list; a mark that comes or changes after it drew shows on all of that agent's rows", () => {
  act(() => setInboxAgents(agentsWith({ ses_0: { state: 'working' } })));
  const before = agentStatusWatchersForTests();
  const el = mount();
  // One watcher for the list, whatever its length (each row's icon had its own: 60 here).
  expect(agentStatusWatchersForTests() - before).toBeLessThanOrEqual(1);
  const states = () => rowEls(el).map(rexOf);
  expect(states().filter((state) => state === 'working').length).toBe(ROWS / 3);
  expect(states().filter((state) => state !== null).length).toBe(ROWS / 3);
  // After it drew: the first agent stops, the second asks for permission. Every row of each follows; none keeps the old mark.
  act(() => setInboxAgents(agentsWith({ ses_1: { state: 'blocked', kind: 'permission' } })));
  const rows = rowEls(el);
  expect(rows.filter((row, i) => i % 3 === 1 && rexOf(row) === 'permission').length).toBe(ROWS / 3);
  expect(rows.filter((row, i) => i % 3 !== 1 && rexOf(row) !== null).length).toBe(0);
});

type Fiber = { tag: number; elementType: unknown; memoizedState: { next: unknown } | null; child: Fiber | null; sibling: Fiber | null; return: Fiber | null };
const fiberOf = (el: Element) => (el as unknown as Record<string, Fiber>)[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))!]!;
const isComponent = (f: Fiber) => f.tag === 0 || f.tag === 11 || f.tag === 15;
const hooksOf = (f: Fiber) => {
  let n = 0;
  for (let h = f.memoizedState as { next: unknown } | null; h; h = h.next as typeof h) n++;
  return n;
};

/** Hooks of the component that draws `el` (the nearest one above its element in React's tree). */
function ownerHooks(el: Element): number {
  let f = fiberOf(el).return!;
  while (!isComponent(f)) f = f.return!;
  return hooksOf(f);
}

/** Hooks a row holds: every hook of every component under its `ListRow` (React's own tree, read from the row's element). */
function rowHooks(row: HTMLElement): number {
  let top = fiberOf(row);
  while (top.elementType !== ListRow) top = top.return!;
  let hooks = 0;
  const walk = (fiber: Fiber | null) => {
    for (let f = fiber; f; f = f.sibling) {
      if (isComponent(f)) hooks += hooksOf(f);
      walk(f.child);
    }
  };
  walk(top.child);
  return hooks;
}

test.skipIf(!hasDom)('a row with no pull request sets up no PR card; a PR that comes after the list drew shows its mark, and goes again', () => {
  const pr = { count: 1, headline: { key: 'github.com/acme/app#7', state: 'open' as const } };
  const el = mount([listRow(0, { pulls: pr }), listRow(1)]);
  const [withPr, plain] = rowEls(el);
  expect(withPr!.querySelector('[data-pr-mark="open"]')).not.toBeNull();
  expect(plain!.querySelector('[data-pr-mark]')).toBeNull();
  // The card's hooks (its popover and its read: eleven) are only in the row that has a PR to show.
  expect(rowHooks(withPr!) - rowHooks(plain!)).toBeGreaterThanOrEqual(11);
  // The next list read brings a PR on the second thread, then takes the first one's away.
  draw([listRow(0), listRow(1, { pulls: { ...pr, count: 2, headline: { key: 'github.com/acme/app#8', state: 'merged' as const } } })]);
  const [first, second] = rowEls(el);
  expect(second!.querySelector('[data-pr-mark="merged"]')?.getAttribute('data-pr-n')).toBe('2');
  expect(first!.querySelector('[data-pr-mark]')).toBeNull();
});

test.skipIf(!hasDom)("a row's tooltips wait with two hooks each and one handler; one hovered after the list drew opens with the words it has now", async () => {
  const el = mount([listRow(0), listRow(1)]);
  const plain = rowEls(el)[1]!;
  const waiting = [...plain.querySelectorAll<HTMLElement>('[data-base-ui-tooltip-trigger]')];
  expect(waiting.length).toBeGreaterThanOrEqual(3);
  // Each waiting tooltip's own component holds two hooks (it held six, with nine closures and an effect).
  expect(waiting.map(ownerHooks)).toEqual(waiting.map(() => 2));
  // And one handler for the seven events it waits on.
  const handlers = (node: HTMLElement) => {
    const props = (node as unknown as Record<string, Record<string, unknown>>)[Object.keys(node).find((k) => k.startsWith('__reactProps$'))!]!;
    return new Set(['onPointerEnter', 'onPointerOver', 'onMouseOver', 'onMouseMove', 'onPointerLeave', 'onPointerDown', 'onFocus'].map((name) => props[name])).size;
  };
  expect(waiting.map(handlers)).toEqual(waiting.map(() => 1));
  // The session gets its label after the list drew: its tiles' tooltip, first hovered now, says it.
  await act(async () => setSessionLabels({ ses_1: 'Docs pass' }));
  const tiles = () => rowEls(el)[1]!.querySelector<HTMLElement>('[data-row-agents]')!;
  hover(tiles());
  await settle();
  expect(openTooltips()).toEqual(['Docs pass (Claude Code)']);
  unhover(tiles());
  await settle();
  expect(openTooltips()).toEqual([]);
});

/**
 * Every hook a plain wide row holds (no PR, no waiting reply, relative time off): its tooltips waiting (two each),
 * its focus and menu state, its agent icon's face. Each was paid on every row a list mounts.
 */
const PLAIN_ROW_HOOKS = 15;

/** A reply waiting on a busy agent since `minutes` ago (approval "inbox-busy-agent-reply"). */
const waitingReply = (minutes: number): InboxListRow['delivery'] => ({ kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_r', at: null, host: 'claude-code', name: null, waiting_since: new Date(Date.now() - minutes * 60_000).toISOString() }) as InboxListRow['delivery'];

test.skipIf(!hasDom)('only a row whose reply waits keeps a minute clock; a wait that starts after the list drew counts its minutes', () => {
  const el = mount([listRow(0), listRow(1, { section: 'sent', delivery: waitingReply(7.5) })]);
  const [plain, waiting] = rowEls(el);
  expect(waiting!.querySelector('[data-count-words]')?.getAttribute('data-count-words')).toBe(undeliveredLabel(new Date(Date.now() - 7.5 * 60_000).toISOString(), Date.now()));
  // The clock (its state and its timer's effect) is in the waiting row only: a plain row holds what every row needs.
  expect(rowHooks(plain!)).toBeLessThanOrEqual(PLAIN_ROW_HOOKS);
  // The next list read: the first row's reply now waits too, the second's went in.
  draw([listRow(0, { section: 'sent', delivery: waitingReply(12.5) }), listRow(1, { section: 'sent' })]);
  const [first, second] = rowEls(el);
  expect(first!.querySelector('[data-undelivered]')).not.toBeNull();
  expect(first!.querySelector('[data-count-words]')?.getAttribute('data-count-words')).toBe(undeliveredLabel(new Date(Date.now() - 12.5 * 60_000).toISOString(), Date.now()));
  expect(second!.querySelector('[data-undelivered]')).toBeNull();
});

test.skipIf(!hasDom)('with relative time off a row keeps no clock; turned on after the list drew, every row says it in words and back off', () => {
  const recent = new Date(Date.now() - 5.5 * 60_000).toISOString();
  const el = mount(Array.from({ length: ROWS }, (_, i) => listRow(i, { created_at: recent, last_at: recent })));
  expect(rowHooks(rowEls(el)[0]!)).toBeLessThanOrEqual(PLAIN_ROW_HOOKS);
  expect(el.querySelectorAll('[data-relative-time]').length).toBe(0);
  act(() => adoptSavedRows(['smallNames', 'relativeTime'], 1));
  const relative = [...el.querySelectorAll<HTMLElement>('[data-relative-time]')];
  expect(relative.length).toBe(ROWS);
  // Its words for a screen reader, and the clock time in the pointer's tooltip.
  expect(relative.every((time) => time.querySelector('.ib-sr')!.textContent === '5 minutes ago' && !!time.title)).toBe(true);
  act(() => adoptSavedRows(['smallNames'], 2));
  expect(el.querySelectorAll('[data-relative-time]').length).toBe(0);
});
