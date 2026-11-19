/**
 * A list read that changes one thread redraws that thread's row, not every row's agent slot. Every agent message in
 * any thread reads the list again, and the read carries the agents, whose last poll moves every time: the rows' slots
 * took a new sessions object on each read and all drew again (2,366 components a refresh on a 548-thread list). What
 * would regress: every slot drawing on such a read again, or a slot not drawing when a name it shows changes.
 *
 * Counted as React's devtools count a render (a commit in which a RowSlot did work), over the real InboxList.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';

// React DOM reports each commit to a devtools hook it finds when it loads: set before it loads (the imports below).
type Fiber = { type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
let onCommit: (current: Fiber) => void = () => {};
if (hasDom) {
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => onCommit(root.current),
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
  };
}
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { RowSlot } = (hasDom ? await import('./components/RowSlot') : {}) as typeof import('./components/RowSlot');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { setInboxAgents } = (hasDom ? await import('./agentsList') : {}) as typeof import('./agentsList');

/** React's PerformedWork flag: the component rendered in that commit (a bail-out leaves it unset). */
const PERFORMED_WORK = 1;
let slotRenders = 0;
// Read at the commit itself: the next one reuses the fibers. A subtree React skipped keeps its children as they were
// (the same child as before) with the flags of the render that drew them, so it is not walked (as the devtools do).
onCommit = (current) => {
  const stack: Fiber[] = [current];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (fiber.type === RowSlot && (fiber.flags & PERFORMED_WORK) !== 0) slotRenders++;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child && fiber.child !== fiber.alternate?.child) stack.push(fiber.child);
  }
};
const takeSlotRenders = () => {
  const count = slotRenders;
  slotRenders = 0;
  return count;
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => setInboxAgents(null));
});

const SESSIONS = ['ses_a', 'ses_b'];

function listRow(id: string, n: number, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_a',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: SESSIONS[n % 2]!, name: null },
    created_at: '2026-11-07T10:00:00.000Z',
    last_at: '2026-11-07T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_a', name: 'api' },
    thread_name: null,
    section: 'new',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  } as InboxListRow;
}

/** The list read's agents: two live sessions in the project, so its rows name them. */
const agents = (seenAt: string, label = 'Billing fix') => [
  {
    agents: SESSIONS.map((session, i) => ({
      id: `agt_${i}`,
      session,
      host: 'claude-code',
      state: 'working',
      live: true,
      label: i === 0 ? label : 'Docs pass',
      project: { id: 'prj_a', name: 'api' },
      last_seen_at: seenAt,
    })),
    total: 2,
    ended_today: 0,
  },
];

// The window's handlers keep their identity across reads (App.tsx), so a row whose content is the same is not drawn again.
const none = () => {};
function List({ sections }: { sections: InboxListSection[] }) {
  return (
    <SidebarProvider>
      <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={false} onRowAction={none} />
    </SidebarProvider>
  );
}

test.skipIf(!hasDom)('a list read that changes one thread redraws one row’s slot; a name the rows show still redraws them', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => listRow(`thr_${i}`, i));
  const sections = (list: InboxListRow[]): InboxListSection[] => [{ id: 'new', label: 'New', threads: list }];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => setInboxAgents(agents('2026-11-07T10:00:00.000Z')));
  await act(async () => root!.render(<List sections={sections(rows)} />));
  const slots = () => [...host!.querySelectorAll('[data-session-slot]')].map((el) => el.textContent);
  expect(slots().length).toBe(8);
  takeSlotRenders();
  // An agent wrote in thread 3: the read brings that row changed, and every agent's last poll moved.
  const next = rows.map((row, i) => (i === 3 ? { ...row, last_at: '2026-11-07T10:05:00.000Z', message_count: 2 } : row));
  await act(async () => {
    setInboxAgents(agents('2026-11-07T10:05:00.000Z'));
    root!.render(<List sections={sections(next)} />);
  });
  expect(takeSlotRenders()).toBe(1);
  // A session's name changes: every row it names draws again, with the new name.
  await act(async () => setInboxAgents(agents('2026-11-07T10:06:00.000Z', 'Refund path')));
  expect(takeSlotRenders()).toBe(8);
  expect(slots().filter((text) => text?.includes('Refund path')).length).toBe(4);
});
