/**
 * A routine's run that starts while the window is open comes into the held list at once, under New with its Running
 * mark (the owner, 2026-11-24: "while a routine's run is going, its thread sits under New, with its Running mark,
 * until the run ends"). The list read is put on screen the way the window puts every read that is not an action
 * (held.ts `shownAfter`), then drawn by the real list. What regresses: a later run's thread left folded in Quiet, a
 * first run's thread not drawn at all, until a reload (release QA, 0.29.4); the run held behind "N new" or counted
 * (the sidebar's waiting count, the tab's count); this path letting other news out of hold, moving a row the person
 * is reading or a row in a section above New; a run's end moving the row under the pointer; a routine on a linked
 * computer drawn differently, or an older linked computer's rows moved.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';
import { INBOX_LOCAL_SECTIONS } from '@plannotator/core/inbox-types';
import type { BulkWrites } from '../bulkWrites';
import { drawnSection, heldNotice, listGroups, settleOwn, shownAfter, waitingCount, type OpenThread } from '../held';
import { inboxTabCount } from '../tabCount';
import { lastRun, scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };
const RUN1 = '2026-11-24T09:00:00.000Z';
const RUN1_REPLY = '2026-11-24T09:02:00.000Z';
const RUN2 = '2026-11-24T10:00:00.000Z';

function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_api',
    subject: `Subject ${id}`,
    author: AGENT,
    created_at: RUN1,
    last_at: RUN1_REPLY,
    last_author: 'agent',
    last_agent_at: RUN1_REPLY,
    message_count: 2,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: 'prj_api', name: 'acme-api' },
    thread_name: id.replace('msg_', ''),
    section: 'quiet',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...over,
  };
}

/** The read: rows in the sections their own `section` names. */
const model = (rows: InboxListRow[]) => ({ sections: INBOX_LOCAL_SECTIONS.map(({ id, label }): InboxListSection => ({ id, label, threads: rows.filter((r) => r.section === id) })) });

/** The routine's thread after Run 1, read: Quiet. */
const read = row('msg_nightly');
/** Its divider taken by the run's session (the person's message the agent has): New for the run, not bold, nothing unseen. */
const running = (over: Partial<InboxListRow> = {}) =>
  row('msg_nightly', { section: 'new', scheduled_running: true, run: 'working', last_at: RUN2, last_author: 'person', sent: { at: RUN2, checked_at: RUN2, wakes: true }, ...over });
/** Plain agent news in another thread: it waits behind "N new". */
const news = row('msg_alpha', { section: 'new', unread: true, unseen: 1, last_at: RUN1_REPLY });

const routine = (state: 'running' | 'ended', machine?: string) =>
  scheduledRow('sch_nightly', {
    name: 'Nightly ledger check',
    thread_id: 'msg_nightly',
    ...(machine ? { machine } : {}),
    ...(state === 'running' ? { state: 'running', runs: 2, running_since: RUN2, last_run: lastRun(2, RUN2, 'running') } : { state: 'on', runs: 2, last_run: lastRun(2, RUN2, 'didnt_finish') }),
  });

/** A list read that is not an action, put on screen as the window does (App.tsx `refreshList`, `takeRecordList`). */
const after = (shown: InboxListSection[], rows: InboxListRow[], open: OpenThread | null = null) => shownAfter(shown, listGroups(model(rows)), { adopt: false, keep: null, open, gone: new Set() });

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetScheduledForTests(null, false);
});

function draw(sections: InboxListSection[], phone = false): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={phone} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={phone} onRowAction={() => {}} bulk={{} as BulkWrites} onMarkRead={() => {}} />
        </div>
      </SidebarProvider>,
    ),
  );
  return host;
}
const inNew = (el: HTMLElement, id = 'msg_nightly') => el.querySelector(`[data-section-id="new"] [data-thread-id="${id}"]`);
const badge = (el: HTMLElement) => inNew(el)?.querySelector('[data-scheduled-badge]')?.getAttribute('data-scheduled-badge') ?? null;
const newCount = (el: HTMLElement) => el.querySelector('[data-section-id="new"] .ib-n')?.textContent ?? null;
const placed = (sections: InboxListSection[], id = 'msg_nightly'): InboxSectionId | string | null => drawnSection(sections, id);

for (const phone of [false, true]) {
  test.skipIf(!hasDom)(`a later run (${phone ? 'phone' : 'desk'}): the thread drawn in folded Quiet comes up under New with Running at once; nothing counts, nothing waits behind "N new"`, () => {
    resetScheduledForTests([routine('running')], true);
    const shown = listGroups(model([read, news]));
    expect(placed(shown)).toBe('quiet');
    const next = after(shown, [running(), news]);
    expect(placed(next)).toBe('new');
    // Shown, not announced: the waiting count, the tab's count and "N new" are what they were.
    expect([waitingCount(next), inboxTabCount(next), heldNotice(next, listGroups(model([running(), news]))).count]).toEqual([waitingCount(shown), inboxTabCount(shown), 0]);
    const el = draw(next, phone);
    expect(badge(el)).toBe('running');
    // Not bold: every drawing of its row (the wide and the three-line one) reads as read.
    const rows = [...el.querySelectorAll('[data-section-id="new"] [data-thread-id="msg_nightly"]')];
    expect([rows.length > 0, rows.some((r) => r.classList.contains('ib-u'))]).toEqual([true, false]);
    // New's header counts the rows in it: the running one is one of them.
    expect(newCount(el)).toBe('2');
  });
}

test.skipIf(!hasDom)('a first run: a thread the list has never shown comes in under New, at its place by time', () => {
  resetScheduledForTests([routine('running')], true);
  const shown = listGroups(model([news]));
  const first = running({ thread_id: 'msg_nightly', created_at: RUN2, last_agent_at: null, message_count: 1 });
  const next = after(shown, [first, news]);
  expect(next.find((s) => s.id === 'new')!.threads.map((r) => r.thread_id)).toEqual(['msg_nightly', 'msg_alpha']);
  expect(badge(draw(next))).toBe('running');
});

test.skipIf(!hasDom)('nothing else comes out of hold: agent words not shown, a launched thread that is no routine, a row above New, the open thread', () => {
  const shown = listGroups(model([read, row('msg_asks', { section: 'waiting', unread: true })]));
  // The run's agent already wrote (news the list does not show): it waits behind "N new" as any agent's message does.
  const wrote = running({ last_author: 'agent', last_agent_at: RUN2, sent: null, unseen: 1, unread: true });
  expect(placed(after(shown, [wrote]))).toBe('quiet');
  expect(heldNotice(shown, listGroups(model([wrote]))).count).toBe(1);
  // A New message launch working (no routine): never brought in by this path.
  const launched = row('msg_launch', { section: 'new', run: 'working', last_agent_at: null, last_author: 'person', sent: { at: RUN2, checked_at: RUN2, wakes: true } });
  expect(placed(after(shown, [read, launched]), 'msg_launch')).toBeNull();
  // A row drawn above New keeps its place: New is a floor, never a demotion.
  const asks = running({ thread_id: 'msg_asks' });
  expect(placed(after(shown, [read, asks]), 'msg_asks')).toBe('waiting');
  // The thread the person has open never moves under them; it settles when it closes.
  const open = after(shown, [running()], { threadId: 'msg_nightly' });
  expect(placed(open)).toBe('quiet');
  expect(placed(settleOwn(open, listGroups(model([running()]))))).toBe('new');
});

test.skipIf(!hasDom)('the run ends: Running goes, the row keeps its place under New until the list settles, then Quiet', () => {
  resetScheduledForTests([routine('running')], true);
  const shown = after(listGroups(model([read, news])), [running(), news]);
  const ended = row('msg_nightly', { last_at: RUN2, last_author: 'person', sent: { at: RUN2, checked_at: RUN2, wakes: true }, run: null });
  const held = after(shown, [ended, news]);
  expect(placed(held)).toBe('new');
  resetScheduledForTests([routine('ended')], true);
  const el = draw(held);
  expect(inNew(el)).not.toBeNull();
  expect(badge(el)).not.toBe('running');
  expect(placed(settleOwn(held, listGroups(model([ended, news]))))).toBe('quiet');
});

test.skipIf(!hasDom)('a routine on a linked computer comes in the same way; an older linked computer (no run fact, Quiet) is left as it was', () => {
  resetScheduledForTests([routine('running', 'mac-studio')], true, [{ id: 'mac-studio', on: true, launch_on: true, away: false, read_at: RUN2 }]);
  const far = (r: InboxListRow) => ({ ...r, machine: 'mac-studio' });
  const shown = listGroups(model([far(read), news]));
  const next = after(shown, [far(running()), news]);
  expect(placed(next)).toBe('new');
  expect(badge(draw(next))).toBe('running');
  const older = row('msg_nightly', { machine: 'mac-studio', last_at: RUN2, last_author: 'person', sent: { at: RUN2, checked_at: RUN2, wakes: true } });
  expect(placed(after(shown, [older, news]))).toBe('quiet');
});
