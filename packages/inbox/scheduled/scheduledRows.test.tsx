/**
 * A routine's row in the Inbox list: the routine is the sender (the play mark, its name) and the
 * run is the subject. Only a run that didn't finish carries the warn mark; a running one carries Running with the
 * dots; a replied one carries neither. A row from another linked machine stays an ordinary row (its row carries no
 * scheduled field yet, UI-NEEDS.md). What regresses: the warn mark on a replied or running run, or none on a run that
 * didn't finish.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { BulkWrites } from '../bulkWrites';
import { lastRun, scheduledRow } from './testRows';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { SidebarProvider } = (hasDom ? await import('../shell/sidebar') : {}) as typeof import('../shell/sidebar');
const { resetScheduledForTests } = (hasDom ? await import('./store') : {}) as typeof import('./store');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };

function row(id: string, change: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_api',
    subject: `Subject ${id}`,
    author: AGENT,
    created_at: '2026-11-13T14:00:00.000Z',
    last_at: '2026-11-13T14:00:00.000Z',
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
    ...change,
  };
}

const now = new Date().toISOString();
const SCHEDULED = [
  scheduledRow('sch_replied', { name: 'Friday changelog draft', thread_id: 'msg_replied', runs: 4, last_run: lastRun(4, now, 'replied') }),
  scheduledRow('sch_running', { name: 'Nightly dependency check', thread_id: 'msg_running', state: 'running', runs: 13, running_since: now, last_run: lastRun(13, now, 'running') }),
  scheduledRow('sch_unfinished', { name: 'Weekday PR summary', thread_id: 'msg_unfinished', runs: 9, last_run: lastRun(9, now, 'didnt_finish') }),
];
const SECTIONS: InboxListSection[] = [
  {
    id: 'new',
    label: 'New since you looked',
    threads: [row('msg_replied'), row('msg_running'), row('msg_unfinished'), row('msg_plain'), row('msg_far', { machine: 'ibx_far' })],
  },
];

/** Picking on: the writes are never called here, only the boxes are read. */
const BULK = {} as BulkWrites;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetScheduledForTests(null, false);
});

function render(shape: 'wide' | 'narrow' | 'phone'): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={SECTIONS} filtered={false} narrow={shape === 'narrow'} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={shape === 'phone'} onRowAction={() => {}} bulk={BULK} onMarkRead={() => {}} />
        </div>
      </SidebarProvider>,
    ),
  );
  return host;
}

test.skipIf(!hasDom)('the warn mark only on the run that didn\'t finish, Running on the running one, in every row shape', () => {
  // The far thread matches nothing here (its routine lives on its own machine); give it a local match too,
  // to prove the row stays ordinary because it is another machine's, not because nothing matched.
  resetScheduledForTests([...SCHEDULED, scheduledRow('sch_far', { name: 'Far one', thread_id: 'msg_far', runs: 2, last_run: lastRun(2, now, 'didnt_finish') })], true);
  for (const shape of ['wide', 'narrow', 'phone'] as const) {
    const el = render(shape);
    const of = (id: string) => el.querySelector(`[data-thread-id="${id}"]`)!;
    expect(of('msg_unfinished').querySelectorAll('[data-scheduled-badge="failed"]').length).toBe(1);
    expect(of('msg_running').querySelector('[data-scheduled-badge="running"] .st-dots')).not.toBeNull();
    expect(of('msg_running').querySelector('[data-scheduled-badge="failed"]')).toBeNull();
    expect(of('msg_replied').querySelector('[data-scheduled-badge]')).toBeNull();
    expect(el.querySelectorAll('[data-scheduled-badge="failed"]').length).toBe(1);
    // The sender and the subject.
    expect(of('msg_unfinished').querySelector('[data-scheduled-tile]')).not.toBeNull();
    expect(of('msg_unfinished').querySelector('[data-scheduled-sender]')?.textContent).toBe('Weekday PR summary');
    expect(of('msg_unfinished').textContent).toContain('Run 9');
    // Ordinary rows: one with no routine, and another machine's.
    for (const id of ['msg_plain', 'msg_far']) {
      expect(of(id).querySelector('[data-scheduled-tile], [data-scheduled-badge], [data-scheduled-sender]')).toBeNull();
    }
    act(() => root?.unmount());
    document.body.innerHTML = '';
  }
});

test.skipIf(!hasDom)("a routine's row labels (its pick box, Mark read) name the routine, never its run", () => {
  resetScheduledForTests(SCHEDULED, true);
  const el = render('wide');
  // A row's other labels name it the same way.
  expect(el.querySelector('.ib-lbody [data-thread-id="msg_unfinished"]')!.parentElement!.querySelector('[aria-label^="Mark read:"]')?.getAttribute('aria-label')).toBe('Mark read: Weekday PR summary');
  act(() => void el.querySelector(`.ib-lbody [data-thread-id="msg_unfinished"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
  const box = (id: string) => el.querySelector(`.ib-lbody [data-thread-id="${id}"]`)!.parentElement!.querySelector(':scope > [data-pick-box="row"]')!.getAttribute('aria-label');
  expect(box('msg_unfinished')).toBe('Select Weekday PR summary');
  expect(box('msg_plain')).toBe('Select plain');
});

test.skipIf(!hasDom)("an agent's change line as the thread's latest: the row says that change, not the run", () => {
  const changed = scheduledRow('sch_changed', { name: 'Docs link sweep', thread_id: 'msg_replied', runs: 4, last_run: lastRun(4, now, 'replied'), last_change: { op: 'update', by: 'Codex', at: '2026-11-13T14:00:00.000Z' } });
  resetScheduledForTests([changed], true);
  const el = render('narrow');
  const of = el.querySelector('[data-thread-id="msg_replied"]')!;
  expect(of.textContent).toContain('Changed by Codex');
  expect(of.textContent).not.toContain('Run 4');
});
