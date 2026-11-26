/**
 * A thread where someone tagged you counts in the numbers at the left, exactly like one waiting on you (the owner's
 * decision, 2026-11-25: "A · It counts"). The one rule is core's `inboxSectionWaitsOnPerson`; every count and order
 * of what waits on the person reads it: the sidebar's Inbox count and its project's count, the machine and tag
 * counts, Mark read, the phone's badge (`inboxRowWaitsOnPerson`), the Agents view's opening of a folded agent, the
 * board's "Waiting on you" and a pinned row's calm. An Inbox that never receives the section counts as before.
 */
import { expect, test } from 'bun:test';
import { inboxRowOffersMarkRead, inboxRowWaitsOnPerson, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import { inboxListSections } from '../shared/inbox/list';
import { waitingCount } from './held';
import { machineCounts, type MachinesModel } from './machines';
import { tagWaitingCounts } from './threadTags';
import { rowWaits } from './agentsView/model';
import { waitingThread } from './board/model';
import { pinnedState } from './pins';

const AT = '2026-11-25T10:00:00.000Z';
function row(id: string, section: InboxListRow['section'], unseen: number, project = 'prj_1'): InboxListRow {
  return {
    thread_id: id,
    project_id: project,
    subject: `Thread ${id}`,
    author: { kind: 'person' },
    created_at: AT,
    last_at: AT,
    last_author: 'person',
    message_count: 1,
    resolved_at: null,
    questions: { open: section === 'waiting' ? 1 : 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: section === 'waiting',
    project: { id: project, name: project },
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

/** This Inbox's list: one thread waiting on you in harbor, news in docs. */
const local = (): InboxListSection[] => inboxListSections([row('t_wait', 'waiting', 0, 'prj_1'), row('t_news', 'new', 1, 'prj_2')]);
/** The same list as a Spaces server sends it, with one seen Tagged you row in harbor, fourth. */
function withTagged(tagged: InboxListRow): InboxListSection[] {
  const sections = local();
  sections.splice(3, 0, { id: 'tagged', label: 'Tagged you', threads: [tagged] });
  return sections;
}
const seen = row('t_seen', 'tagged', 0, 'prj_1');
const model: MachinesModel = { self: 'ibx_self', all: [{ id: 'ibx_self' } as MachinesModel['all'][number]], linked: [], names: new Map(), away: new Set() };

test('a Tagged you row raises the Inbox count and its project’s count by one, and no other project’s', () => {
  const before = local();
  const after = withTagged(seen);
  expect(waitingCount(after)).toBe(waitingCount(before) + 1);
  expect(waitingCount(after, 'prj_1')).toBe(waitingCount(before, 'prj_1') + 1);
  expect(waitingCount(after, 'prj_2')).toBe(waitingCount(before, 'prj_2'));
  expect(machineCounts(after, model).get('ibx_self')).toBe(machineCounts(before, model).get('ibx_self')! + 1);
  expect(tagWaitingCounts(after).get('ini_field')).toBe(tagWaitingCounts(before).get('ini_field')! + 1);
});

test('an Inbox that never receives Tagged you counts as before: only what waits on you', () => {
  const sections = local();
  expect(sections.map((s) => s.id)).not.toContain('tagged');
  expect(waitingCount(sections)).toBe(1);
  expect(waitingCount(sections, 'prj_1')).toBe(1);
  expect(waitingCount(sections, 'prj_2')).toBe(0);
});

test('a Tagged you row waits on the person everywhere that asks, even once its news is seen', () => {
  expect(inboxRowWaitsOnPerson(seen)).toBe(true);
  expect(inboxRowOffersMarkRead(seen)).toBe(true);
  expect(rowWaits('tagged')).toBe(true);
  expect(waitingThread({ column: 'todo', threads: [seen.thread_id] }, () => seen)).toBe(seen.thread_id);
  expect(pinnedState(seen).calm).toBe(false);
});
