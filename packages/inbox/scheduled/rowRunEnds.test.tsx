/**
 * A routine's list row while its run ends, with the Routines page closed. A run's end writes no store line: only its
 * launch's run line moves, which the window hears as `event: deliveries`. So the row's Running must go on that frame,
 * on a reconnect (a `deliveries` sent while the stream was away is never replayed) and when the window is shown
 * again, without the thread being opened. What regresses: a row that keeps Running, with its dots, for hours after the
 * run ended, until the person opens the thread; or a read on every `deliveries` frame while nothing runs.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { BulkWrites } from '../bulkWrites';
import type { InboxEventFrame } from '../eventFrames';
import { lastRun, scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');
const { dispatchInboxFrame } = (hasDom ? await import('../eventFrames') : {}) as typeof import('../eventFrames');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const now = new Date().toISOString();

function row(id: string): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_api',
    subject: `Subject ${id}`,
    author: AGENT,
    created_at: now,
    last_at: now,
    last_author: 'agent',
    message_count: 2,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_api', name: 'acme-api' },
    thread_name: id.replace('msg_', ''),
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    run: null,
  };
}

const SECTIONS: InboxListSection[] = [{ id: 'new', label: 'New since you looked', threads: [row('msg_nightly')] }];
const running = scheduledRow('sch_nightly', { name: 'Nightly dependency check', thread_id: 'msg_nightly', state: 'running', runs: 13, running_since: now, last_run: lastRun(13, now, 'running') });
const ended = (outcome: 'replied' | 'didnt_finish'): InboxScheduledRow => ({ ...running, state: 'on', running_since: null, last_run: lastRun(13, now, outcome) });

const realFetch = globalThis.fetch;
const realVisibility = hasDom ? Object.getOwnPropertyDescriptor(document, 'visibilityState') : undefined;
let root: Root | null = null;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realVisibility) Object.defineProperty(document, 'visibilityState', realVisibility);
  else delete (document as { visibilityState?: unknown }).visibilityState;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetScheduledForTests(null, false);
});

/** The Inbox's routines read, answering `server.rows`; counts the reads. */
function inbox(rows: InboxScheduledRow[]) {
  const server = { rows, reads: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    // The window's read also asks for the linked computers' routines (`?machines=1`); none are linked here.
    if (path.split('?')[0] === '/api/inbox/scheduled' && (init?.method ?? 'GET') === 'GET') {
      server.reads += 1;
      return new Response(JSON.stringify({ scheduled: server.rows, launch_on: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 'not_found', error: 'No route.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return server;
}

function render(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} onRowAction={() => {}} bulk={{} as BulkWrites} onMarkRead={() => {}} />
        </div>
      </SidebarProvider>,
    ),
  );
  return host;
}

const frame = (name: InboxEventFrame['name'], data = ''): InboxEventFrame => ({ name, data, id: null });
/** One frame from the stream, then the read it starts lands. */
async function hear(f: InboxEventFrame) {
  await act(async () => {
    dispatchInboxFrame(f, { onRecord: () => {}, onStatus: () => {} });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const badge = (el: HTMLElement) => el.querySelector('[data-thread-id="msg_nightly"] [data-scheduled-badge]')?.getAttribute('data-scheduled-badge') ?? null;

test.skipIf(!hasDom)("a run's end (its run line moving) takes Running off the row, with the Routines page closed", async () => {
  const server = inbox([running]);
  resetScheduledForTests([running], true);
  const el = render();
  expect(badge(el)).toBe('running');
  server.rows = [ended('replied')];
  await hear(frame('deliveries', '{}'));
  expect(badge(el)).toBeNull();
  expect(el.querySelector('[data-thread-id="msg_nightly"] .st-dots')).toBeNull();
});

test.skipIf(!hasDom)('a run stopped or failed: the row turns to the warn mark on the same frame', async () => {
  const server = inbox([running]);
  resetScheduledForTests([running], true);
  const el = render();
  server.rows = [ended('didnt_finish')];
  await hear(frame('deliveries', '{"sessions":true}'));
  expect(badge(el)).toBe('failed');
});

test.skipIf(!hasDom)("a reconnect reads again: the run ended while the stream was away (asleep, the Inbox restarted)", async () => {
  const server = inbox([running]);
  resetScheduledForTests([running], true);
  const el = render();
  server.rows = [ended('replied')];
  await hear(frame('hello'));
  expect(badge(el)).toBeNull();
});

test.skipIf(!hasDom)('the window shown again reads again while a run is under way', async () => {
  const server = inbox([running]);
  resetScheduledForTests([running], true);
  const el = render();
  server.rows = [ended('replied')];
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(server.reads).toBe(1);
  expect(badge(el)).toBeNull();
});

test.skipIf(!hasDom)('nothing running: a `deliveries` frame or the window shown reads nothing (a run start comes as its divider)', async () => {
  const idle = ended('replied');
  const server = inbox([idle]);
  resetScheduledForTests([idle], true);
  render();
  await hear(frame('deliveries', '{}'));
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(server.reads).toBe(0);
});
