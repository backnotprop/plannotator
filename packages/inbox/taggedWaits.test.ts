/**
 * Whether a Tagged you row waits on the person is ONE rule (core's `inboxSectionWaitsOnPerson`, by
 * `INBOX_TAGGED_WAITS_ON_PERSON`), still the owner's to decide. Every place in the window that counts or orders what
 * waits on the person reads it, so the decision is one line and no place is left behind: the sidebar's counts
 * (projects, machines, tags), Mark read, the Agents view's opening of a folded agent, the board's "Waiting on you"
 * and a pinned row's calm. Until it is decided, a Tagged you row adds to no count.
 */
import { expect, test } from 'bun:test';
import { INBOX_TAGGED_WAITS_ON_PERSON, inboxRowOffersMarkRead, inboxSectionWaitsOnPerson, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { waitingCount } from './held';
import { machineCounts, type MachinesModel } from './machines';
import { tagWaitingCounts } from './threadTags';
import { rowWaits } from './agentsView/model';
import { waitingThread } from './board/model';
import { pinnedState } from './pins';

const AT = '2026-11-25T10:00:00.000Z';
function row(id: string, section: InboxListRow['section'], unseen: number): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'person' },
    created_at: AT,
    last_at: AT,
    last_author: 'person',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: false,
    project: { id: 'prj_1', name: 'harbor' },
    thread_name: null,
    section,
    unread: unseen > 0,
    answered_not_sent: false,
    waiting_since: null,
    unseen,
    sent: null,
    guide: false,
    tags: ['ini_field'],
  } as InboxListRow;
}

const seen = row('t_seen', 'tagged', 0);
const fresh = row('t_fresh', 'tagged', 1);
const sections: InboxListSection[] = [{ id: 'tagged', label: 'Tagged you', threads: [seen, fresh] }];
const waits = inboxSectionWaitsOnPerson('tagged');

test('until the owner decides, a Tagged you row adds to no count', () => {
  expect(INBOX_TAGGED_WAITS_ON_PERSON).toBe(false);
  expect(waitingCount(sections)).toBe(0);
});

test('every count and order of what waits on the person reads the one rule', () => {
  const two = waits ? 2 : 0;
  expect(waitingCount(sections)).toBe(two);
  expect(waitingCount(sections, 'prj_1')).toBe(two);
  const model: MachinesModel = { self: 'ibx_self', all: [{ id: 'ibx_self' } as MachinesModel['all'][number]], linked: [], names: new Map(), away: new Set() };
  expect(machineCounts(sections, model).get('ibx_self')).toBe(two);
  expect(tagWaitingCounts(sections).get('ini_field') ?? 0).toBe(two);
  expect(rowWaits('tagged')).toBe(waits);
  expect(waitingThread({ column: 'todo', threads: [seen.thread_id] }, () => seen)).toBe(waits ? seen.thread_id : null);
  expect(pinnedState(seen).calm).toBe(!waits);
});

test('Mark read: always on a Tagged you row that waits on the person, else only while its news is unseen (as in New)', () => {
  expect(inboxRowOffersMarkRead(fresh)).toBe(true);
  expect(inboxRowOffersMarkRead(seen)).toBe(waits);
});
