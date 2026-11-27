/**
 * The list's Agents view (agentsView/, design A "Agents that open"), drawn by the real InboxList.
 *
 * What this catches: the view not drawing each agent with its threads under it; an agent with something for the person
 * not first or not open; a folded agent drawing rows (40 agents and 572 threads must stay light); a fold not kept for
 * the next load; "N more" missing after five threads or not showing the rest; a thread with several agents drawn twice;
 * the Ended and No agent bands missing; the rows leaving the list's DOM shape (a row's button in `.ib-rw[data-row]`
 * right in a group right in the body: the swipe, the row menu and the settle read it), a row not opening its thread,
 * the agent's face not at 44, and rows moving under the reader before the list is sorted whole.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. No server, no fetch.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAgent, InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { TidyController } from '../components/Tidy';
import type { BulkWrites } from '../bulkWrites';
import * as format from '../format';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { setInboxAgents } = (hasDom ? await import('../agentsList') : {}) as typeof import('../agentsList');
const { LIST_VIEW_COOKIE, resetListViewForTests } = await import('../listView');
const { AGENT_FOLDS_COOKIE, resetAgentFoldsForTests } = await import('./folds');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const stored = new Map<string, string>();
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  stored.clear();
  stored.set(LIST_VIEW_COOKIE, 'agents');
  setStorageBackend({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) });
  resetListViewForTests();
  resetAgentFoldsForTests();
  if (hasDom) setInboxAgents(AGENTS);
});

afterEach(() => {
  resetStorageBackend();
  resetListViewForTests();
  resetAgentFoldsForTests();
  if (!hasDom) return;
  setInboxAgents(null);
  unmount();
  document.body.innerHTML = '';
});

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

const TIDY: TidyController = { surface: 'list', scope: null, plan: null, run: null, start: async () => null, refresh: () => {} };
// In the past, so a fold made now (folds.ts keeps when) comes after every thread of the fixture.
const T = (minute: number) => `2026-01-05T10:${String(minute).padStart(2, '0')}:00Z`;
const SOON = () => new Date(Date.now() + 60_000).toISOString();

function row(id: string, minute: number, section: InboxListRow['section'], session: string | null, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project: { id: 'prj_a', name: 'harbor-ops' },
    subject: `Thread ${id}`,
    thread_name: null,
    author: session ? { kind: 'agent', host: 'claude-code', session, name: null } : { kind: 'person' },
    last_at: T(minute),
    last_agent_at: T(minute),
    last_author: 'agent',
    section,
    unread: false,
    unseen: 0,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [] },
    sent: null,
    resolved_at: null,
    ...extra,
  } as unknown as InboxListRow;
}

function agent(id: string, label: string, state: InboxAgent['state']): InboxAgent {
  return { id, session: id, host: 'claude-code', label, project: { id: 'prj_a', name: 'harbor-ops' }, state, waiting: state === 'waiting' ? 1 : 0, live: state !== 'ended', started_at: null, last_seen_at: T(1) };
}

const AGENTS = [{ agents: [agent('ses_ops', 'Ops', 'waiting'), agent('ses_docs', 'Docs pass', 'idle'), agent('ses_old', 'Search index', 'ended')], total: 3, ended_today: 1 }];

function sections(byGroup: Partial<Record<InboxListGroupId, InboxListRow[]>>): InboxListSection[] {
  const ids: InboxListGroupId[] = ['stopped', 'holding', 'waiting', 'new', 'sent', 'quiet', 'snoozed'];
  return ids.map((id) => ({ id, label: id, threads: byGroup[id] ?? [] })) as InboxListSection[];
}

const shared = { addressee: { session: 'ses_ops', host: 'claude-code' }, participants: [{ session: 'ses_ops', host: 'claude-code' }, { session: 'ses_docs', host: 'claude-code' }] } as Partial<InboxListRow>;
const LIST = sections({
  waiting: [row('ops-wait', 30, 'waiting', 'ses_ops', { unread: true, questions: { open: 1, picked: 0, stopped: false, holds_up: [] } } as unknown as Partial<InboxListRow>)],
  quiet: [
    row('ops-1', 20, 'quiet', 'ses_docs', shared),
    row('ops-2', 19, 'quiet', 'ses_ops'),
    row('ops-3', 18, 'quiet', 'ses_ops'),
    row('ops-4', 17, 'quiet', 'ses_ops'),
    row('ops-5', 16, 'quiet', 'ses_ops'),
    row('ops-6', 15, 'quiet', 'ses_ops'),
    row('docs-1', 25, 'quiet', 'ses_docs'),
    row('old-1', 5, 'quiet', 'ses_old'),
    row('mine', 4, 'quiet', null),
  ],
});

interface Options {
  sections?: InboxListSection[];
  epoch?: number;
  onOpen?: (id: string) => void;
  bulk?: BulkWrites;
  notice?: { count: number; project?: string | null } | null;
  onShowNew?: () => void;
}

function render(options: Options = {}): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <InboxList
          title="Inbox"
          path={null}
          sections={options.sections ?? LIST}
          sort={{ epoch: options.epoch ?? 1, keep: null }}
          filtered={false}
          narrow={false}
          phone={false}
          selectedThreadId={null}
          notice={options.notice ?? null}
          onShowNew={options.onShowNew ?? (() => {})}
          onOpen={(row: InboxListRow) => options.onOpen?.(row.thread_id)}
          tidy={TIDY}
          bulk={options.bulk}
        />
      </SidebarProvider>,
    );
  });
  return host!;
}

const agentsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ib-lbody > [data-agent]')].map((g) => g.querySelector('.ib-agh-n')!.textContent);
const rowsOf = (el: HTMLElement, name: string) => {
  const group = [...el.querySelectorAll<HTMLElement>('.ib-lbody > [data-agent]')].find((g) => g.querySelector('.ib-agh-n')!.textContent === name)!;
  return [...group.querySelectorAll('[data-thread-id]')].map((node) => node.getAttribute('data-thread-id'));
};
const head = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLButtonElement>('[data-agent-head]')].find((b) => b.querySelector('.ib-agh-n')!.textContent === name)!;

describe.skipIf(!hasDom)('the Agents view', () => {
  test('each agent with its threads under it: the one waiting on the person first and open, the others folded with no rows', () => {
    const el = render();
    expect(agentsOf(el)).toEqual(['Ops', 'Docs pass', 'Search index']);
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('true');
    expect(head(el, 'Docs pass').getAttribute('aria-expanded')).toBe('false');
    // Five threads, the one waiting first; the thread sent to Ops with Docs pass in it is drawn once, under Ops.
    expect(rowsOf(el, 'Ops')).toEqual(['ops-wait', 'ops-1', 'ops-2', 'ops-3', 'ops-4']);
    expect(rowsOf(el, 'Docs pass')).toEqual([]);
    expect(el.querySelectorAll('[data-thread-id="ops-1"]').length).toBe(1);
    // The face at 44, the state word on its line.
    expect(el.querySelector('[data-agent] .am')!.getAttribute('data-size')).toBe('44');
    expect(el.querySelector('[data-agent] .ib-agh-m')!.textContent).toContain('Waiting on you');
  });

  test('"N more" after five threads shows the rest', () => {
    const el = render();
    const more = el.querySelector<HTMLButtonElement>('[data-agent-more]')!;
    expect(more.textContent).toBe('2 more');
    act(() => more.click());
    expect(rowsOf(el, 'Ops')).toEqual(['ops-wait', 'ops-1', 'ops-2', 'ops-3', 'ops-4', 'ops-5', 'ops-6']);
    expect(el.querySelector('[data-agent-more]')).toBeNull();
  });

  test('a fold or an open is kept for that agent on the next load', () => {
    let el = render();
    act(() => head(el, 'Ops').click());
    act(() => head(el, 'Docs pass').click());
    expect(rowsOf(el, 'Ops')).toEqual([]);
    expect(rowsOf(el, 'Docs pass')).toEqual(['docs-1']);
    expect(stored.get(AGENT_FOLDS_COOKIE)).toBeTruthy();
    unmount();
    el = render();
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('false');
    expect(rowsOf(el, 'Docs pass')).toEqual(['docs-1']);
  });

  test('an ended agent sits under Ended; a thread with no agent under No agent', () => {
    const el = render();
    const ended = el.querySelector<HTMLElement>('[data-section-id="agents-ended"]')!;
    expect(ended.textContent).toContain('Ended');
    expect(el.querySelector('[data-agent][data-agent-ended] .ib-agh-n')!.textContent).toBe('Search index');
    const none = el.querySelector<HTMLElement>('[data-section-id="agents-none"]')!;
    expect(none.textContent).toContain('No agent');
    // Folded at first; open, its thread is there.
    expect(none.querySelector('[data-thread-id="mine"]')).toBeNull();
    act(() => none.querySelector<HTMLButtonElement>('button.ib-band')!.click());
    expect(el.querySelector('[data-section-id="agents-none"] [data-thread-id="mine"]')).not.toBeNull();
  });

  test("a row keeps the list's shape and opens its thread", () => {
    const opened: string[] = [];
    const el = render({ onOpen: (id) => opened.push(id) });
    const button = el.querySelector<HTMLElement>('[data-thread-id="ops-2"]')!;
    const wrap = button.closest('.ib-rw[data-row]')!;
    expect(wrap.parentElement!.classList.contains('ib-group')).toBe(true);
    expect(wrap.parentElement!.parentElement!.classList.contains('ib-lbody')).toBe(true);
    act(() => button.click());
    expect(opened).toEqual(['ops-2']);
    // Unread reads bold.
    expect(el.querySelector('[data-thread-id="ops-wait"]')!.classList.contains('ib-u')).toBe(true);
  });

  test('rows and agents stay put while the list is held, and take their places when it is sorted', () => {
    const el = render();
    act(() => head(el, 'Docs pass').click());
    const moved = sections({ ...Object.fromEntries(LIST.map((s) => [s.id, s.threads])), quiet: LIST.find((s) => s.id === 'quiet')!.threads.map((r) => (r.thread_id === 'ops-4' ? { ...r, last_at: T(29), last_agent_at: T(29) } : r)) });
    render({ sections: moved });
    expect(rowsOf(el, 'Ops')).toEqual(['ops-wait', 'ops-1', 'ops-2', 'ops-3', 'ops-4']);
    render({ sections: moved, epoch: 2 });
    expect(rowsOf(el, 'Ops')).toEqual(['ops-wait', 'ops-4', 'ops-1', 'ops-2', 'ops-3']);
  });

  test('"N more" moves focus to the first row it shows', () => {
    const el = render();
    const more = el.querySelector<HTMLButtonElement>('[data-agent-more]')!;
    more.focus();
    act(() => more.click());
    expect(document.activeElement?.getAttribute('data-thread-id')).toBe('ops-5');
  });

  test('the Ended band owns the ended agents for a screen reader', () => {
    const el = render();
    const band = el.querySelector<HTMLElement>('[data-section-id="agents-ended"]')!;
    const owned = el.querySelector<HTMLElement>('[data-agent][data-agent-ended]')!;
    expect(owned.id).toBeTruthy();
    expect(band.getAttribute('aria-owns')!.split(' ')).toContain(owned.id);
  });
});

describe.skipIf(!hasDom)('what the Agents view hides stays out of reach', () => {
  const bulk = { archive: async () => {}, snooze: async () => {}, markRead: async () => {}, markUnread: async () => {}, star: async () => {}, priority: async () => {} } as unknown as BulkWrites;
  const click = (el: Element, init: MouseEventInit = {}) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })));
  const count = () => document.querySelector('[data-pick-bar] [role="status"]')?.textContent ?? null;

  test('Select all picks the rows on screen only: not a folded agent, not the rows behind "N more", not a folded band', () => {
    const el = render({ bulk });
    click(el.querySelector('[data-thread-id="ops-wait"]')!, { metaKey: true });
    expect(count()).toBe('1 selected');
    click(document.querySelector('[data-pick-bar] [data-pick-box]')!);
    // Ops shows five of its seven; Docs pass and Search index are folded; No agent is folded.
    expect(count()).toBe('5 selected');
    // Folding Ops and opening Docs pass: Select all now means Docs pass's one thread.
    click(document.querySelector('[data-pick-bar] [data-pick-box]')!);
    act(() => head(el, 'Ops').click());
    act(() => head(el, 'Docs pass').click());
    expect(count()).toBe('Click threads to select them');
    click(document.querySelector('[data-pick-bar] [data-pick-box]')!);
    expect(count()).toBe('1 selected');
    expect(el.querySelector('[data-thread-id="docs-1"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe.skipIf(!hasDom)('a fold gives way to new work', () => {
  const withRow = (extra: InboxListRow, group: 'waiting' | 'quiet') =>
    sections(Object.fromEntries(LIST.map((s) => [s.id, s.id === group ? [extra, ...s.threads] : s.threads])));

  const fresh = () => row('docs-new', 59, 'quiet', 'ses_docs', { last_agent_at: SOON(), last_at: SOON() } as Partial<InboxListRow>);
  const noneBand = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-section-id="agents-none"] button.ib-band')!;
  // Show as the window does it: the list sorted whole in the same render as the press (App.tsx settleList).
  const showWith = (next: InboxListSection[]) => {
    const el = render({ notice: { count: 1 }, onShowNew: () => void render({ sections: next, epoch: 2, notice: null }) });
    act(() => el.querySelector<HTMLButtonElement>('[data-inbox-notice]')!.click());
    return el;
  };

  test('Show opens the agents its rows land under, and they are on screen; a folded No agent band it brings nothing to stays folded', () => {
    const el = render();
    expect(rowsOf(el, 'Docs pass')).toEqual([]);
    expect(noneBand(el).getAttribute('aria-expanded')).toBe('false');
    showWith(withRow(fresh(), 'quiet'));
    expect(head(el, 'Docs pass').getAttribute('aria-expanded')).toBe('true');
    expect(rowsOf(el, 'Docs pass')).toContain('docs-new');
    // No agent's thread was there before the Show: its band stays folded, and no choice is kept for it.
    expect(noneBand(el).getAttribute('aria-expanded')).toBe('false');
    expect(stored.get(AGENT_FOLDS_COOKIE) ?? '').not.toContain('~none');
  });

  test('a Show that sorted nothing opens nothing at a later, unrelated sort', () => {
    const el = render({ notice: { count: 1 } });
    act(() => el.querySelector<HTMLButtonElement>('[data-inbox-notice]')!.click());
    // Later the list is sorted whole for another reason (a thread closed), with a new thread under Docs pass.
    render({ sections: withRow(fresh(), 'quiet'), epoch: 2, notice: null });
    expect(head(el, 'Docs pass').getAttribute('aria-expanded')).toBe('false');
  });

  test('a folded agent opens again when a thread that waits on the person comes after the fold; an older one does not', () => {
    const el = render();
    act(() => head(el, 'Ops').click());
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('false');
    // A newer message in a thread that does not wait on the person: still folded.
    const quiet = row('ops-quiet', 58, 'quiet', 'ses_ops', { last_agent_at: SOON(), last_at: SOON() } as Partial<InboxListRow>);
    render({ sections: withRow(quiet, 'quiet') });
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('false');
    const asks = row('ops-asks', 57, 'waiting', 'ses_ops', { last_agent_at: SOON(), last_at: SOON() } as Partial<InboxListRow>);
    render({ sections: withRow(asks, 'waiting') });
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('true');
    expect(rowsOf(el, 'Ops')).toContain('ops-asks');
  });

  test('a fold made over a waiting row a moment ahead of this clock holds', () => {
    const ahead = row('ops-ahead', 56, 'waiting', 'ses_ops', { last_agent_at: SOON(), last_at: SOON() } as Partial<InboxListRow>);
    const el = render({ sections: withRow(ahead, 'waiting') });
    act(() => head(el, 'Ops').click());
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('false');
    render({ sections: withRow(ahead, 'waiting') });
    expect(head(el, 'Ops').getAttribute('aria-expanded')).toBe('false');
  });
});

describe.skipIf(!hasDom)('a list read draws only what changed', () => {
  test('one thread changed: that row and its agent row draw again, nothing else', () => {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
    const copy = () => LIST.map((s) => ({ ...s, threads: s.threads.map((r) => ({ ...r, questions: { ...r.questions } })) })) as InboxListSection[];
    const shortTime = spyOn(format, 'shortTime');
    try {
      const el = render({ sections: copy() });
      expect(shortTime.mock.calls.length).toBeGreaterThan(0);
      shortTime.mockClear();
      render({ sections: copy() });
      // Same content in new objects: no row and no agent row draws again.
      expect(shortTime.mock.calls.length).toBe(0);
      shortTime.mockClear();
      const changed = copy();
      const quiet = changed.find((s) => s.id === 'quiet')!;
      quiet.threads = quiet.threads.map((r) => (r.thread_id === 'ops-2' ? { ...r, subject: 'Thread ops-2, revised', last_at: T(45) } : r));
      render({ sections: changed });
      // The row's time, and its agent's newest time.
      expect(shortTime.mock.calls.length).toBe(2);
      expect(el.textContent).toContain('Thread ops-2, revised');
    } finally {
      shortTime.mockRestore();
    }
  });
});

