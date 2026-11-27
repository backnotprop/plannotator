/**
 * A list watches the session names its rows' slots show once, not once per row. A list mounts every row of its
 * open groups (about 2,200 on a large Inbox, the memory soak's store): three store subscriptions in each row's slot
 * were 12 closures and three listeners per row, 26,000 closures held from the moment the window opened, all for the
 * same three values. The rows' agent tiles read the same labels (RowAgents.tsx). What would regress: the watchers
 * growing with the rows again, or a slot or a row's agent tiles not showing a name set after the list was drawn.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { RowAgentTiles } = (hasDom ? await import('./components/RowAgents') : {}) as typeof import('./components/RowAgents');
const { setInboxAgents } = (hasDom ? await import('./agentsList') : {}) as typeof import('./agentsList');
const { setSessionTitles, sessionTitlesWatchersForTests } = (hasDom ? await import('./sessionTitles') : {}) as typeof import('./sessionTitles');
const { rowSessionsWatchersForTests } = (hasDom ? await import('./severalSessions') : {}) as typeof import('./severalSessions');
const { setSessionLabels, sessionLabelsWatchersForTests } = (hasDom ? await import('./sessionLabels') : {}) as typeof import('./sessionLabels');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => {
    setInboxAgents(null);
    setSessionTitles({});
    setSessionLabels({});
  });
});

const SESSIONS = ['ses_a', 'ses_b'];

function listRow(id: string, n: number): InboxListRow {
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
  } as InboxListRow;
}

/** Two live sessions in the project, so its rows name them: the first by its label, the second by none yet. */
const AGENTS = [
  {
    agents: SESSIONS.map((session, i) => ({
      id: `agt_${i}`,
      session,
      host: 'claude-code',
      state: 'working',
      live: true,
      label: i === 0 ? 'Billing fix' : '',
      project: { id: 'prj_a', name: 'api' },
      last_seen_at: '2026-11-07T10:00:00.000Z',
    })),
    total: 2,
    ended_today: 0,
  },
];

const none = () => {};

test.skipIf(!hasDom)('a list of 60 rows watches the session names once; a title set after it drew shows in its rows', async () => {
  const titlesBefore = sessionTitlesWatchersForTests();
  const sessionsBefore = rowSessionsWatchersForTests();
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: Array.from({ length: 60 }, (_, i) => listRow(`thr_${i}`, i)) }];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => setInboxAgents(AGENTS as never));
  await act(async () =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={false} onRowAction={none} />
      </SidebarProvider>,
    ),
  );
  const slots = () => [...host!.querySelectorAll('[data-session-slot]')].map((el) => el.textContent ?? '');
  expect(slots().length).toBe(60);
  // One watcher for the whole list, whatever its length (it was one per row: 60 here, 2,200 on a large Inbox).
  expect(sessionTitlesWatchersForTests() - titlesBefore).toBeLessThanOrEqual(1);
  expect(rowSessionsWatchersForTests() - sessionsBefore).toBeLessThanOrEqual(1);
  // The second session gets its title from its transcript after the list drew: its 30 rows name it.
  await act(async () => setSessionTitles({ ses_b: 'Ledger sweep' }));
  expect(slots().filter((text) => text.includes('Ledger sweep')).length).toBe(30);
  expect(slots().filter((text) => text.includes('Billing fix')).length).toBe(30);
});

test.skipIf(!hasDom)('a list of 60 rows watches the session labels once; a label set after it drew shows in its slots and agent tiles', async () => {
  const labelsBefore = sessionLabelsWatchersForTests();
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: Array.from({ length: 60 }, (_, i) => listRow(`thr_${i}`, i)) }];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => setInboxAgents(AGENTS as never));
  await act(async () =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={false} onRowAction={none} />
      </SidebarProvider>,
    ),
  );
  const slots = () => [...host!.querySelectorAll('[data-session-slot]')].map((el) => el.textContent ?? '');
  const tiles = () => [...host!.querySelectorAll('[data-row-agents]')].map((el) => el.getAttribute('aria-label') ?? '');
  expect(tiles().length).toBe(60);
  // The slots and the agent tiles share one watcher for the whole list (the tiles had one per row: 60 here).
  expect(sessionLabelsWatchersForTests() - labelsBefore).toBeLessThanOrEqual(1);
  // The second session's poll brings its label after the list drew: its 30 rows say it, in the slot and the tiles' name.
  await act(async () => setSessionLabels({ ses_b: 'Docs pass' }));
  expect(slots().filter((text) => text.includes('Docs pass')).length).toBe(30);
  expect(tiles().filter((label) => label.includes('Docs pass')).length).toBe(30);
  // Renamed again: every one of its rows follows, none keeps the old name.
  await act(async () => setSessionLabels({ ses_b: 'Docs pass 2' }));
  expect(tiles().filter((label) => label.includes('Docs pass 2')).length).toBe(30);
  expect(slots().filter((text) => text.includes('Docs pass 2')).length).toBe(30);
});

test.skipIf(!hasDom)("a phone's rows read the labels from the list too; a label set after it drew shows in their agent tiles", async () => {
  const labelsBefore = sessionLabelsWatchersForTests();
  const sections: InboxListSection[] = [{ id: 'new', label: 'New', threads: Array.from({ length: 60 }, (_, i) => listRow(`thr_${i}`, i)) }];
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => setInboxAgents(AGENTS as never));
  await act(async () =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={none} onOpen={none} phone={true} onRowAction={none} />
      </SidebarProvider>,
    ),
  );
  const tiles = () => [...host!.querySelectorAll('[data-row-agents]')].map((el) => el.getAttribute('aria-label') ?? '');
  expect(tiles().length).toBe(60);
  expect(sessionLabelsWatchersForTests() - labelsBefore).toBeLessThanOrEqual(1);
  await act(async () => setSessionLabels({ ses_b: 'Docs pass' }));
  expect(tiles().filter((label) => label.includes('Docs pass')).length).toBe(30);
});

test.skipIf(!hasDom)("agent tiles drawn outside a list watch the labels themselves; a label set after they drew shows", async () => {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: 'claude-code', session: 'ses_b' }} />));
  const tiles = () => host!.querySelector('[data-row-agents]')?.getAttribute('aria-label') ?? '';
  expect(tiles()).not.toContain('Docs pass');
  await act(async () => setSessionLabels({ ses_b: 'Docs pass' }));
  expect(tiles()).toContain('Docs pass');
});
