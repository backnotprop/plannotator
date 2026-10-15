/**
 * The project menu's pure rules (projectMenu.ts): which projects the sidebar
 * draws (automatic hiding, the project on screen held), where Mark all as
 * read has work to do, and what the batch's toast reports. The toast's
 * numbers and warnings are the facts asserted; its sentence shape is the
 * approved one-line toast style's and is pinned only where it carries them.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from './api';
import { projectAllArchived, projectBatchToast, projectsWithReadable, shownProjects } from './projectMenu';

const folder = (id: string, listed: number | undefined, archived = 0): ProjectFolder => ({
  id,
  key: `${id}-abc123`,
  name: id,
  root: `/work/${id}`,
  created_at: '2026-10-14T10:00:00.000Z',
  threads: (listed ?? 0) + archived,
  unread: 0,
  ...(listed === undefined ? {} : { listed, archived }),
});

function row(over: Partial<Omit<InboxListRow, 'project'>> & { project?: string }): InboxListRow {
  const { project = 'a', ...rest } = over;
  return {
    thread_id: `msg_${Math.random().toString(36).slice(2)}`,
    subject: 'S',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    created_at: '2026-10-14T10:00:00.000Z',
    last_at: '2026-10-14T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, sent: 0, closed: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: project, name: project },
    thread_name: null,
    section: 'new',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 1,
    sent: null,
    guide: false,
    ...rest,
  } as InboxListRow;
}

describe('shownProjects', () => {
  test('a project with nothing listed leaves; the one on screen stays; an older Inbox shows every folder', () => {
    const projects = [folder('a', 2), folder('b', 0, 3), folder('c', undefined), folder('d', 0, 1)];
    expect(shownProjects(projects, null).map((p) => p.id)).toEqual(['a', 'c']);
    expect(shownProjects(projects, 'b').map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(projectAllArchived(folder('b', 0, 3))).toBe(true);
    expect(projectAllArchived(folder('a', 2))).toBe(false);
    expect(projectAllArchived(folder('c', undefined))).toBe(false);
  });
});

test('projectsWithReadable: a project counts when single Mark read is offered on one of its rows', () => {
  const sections: InboxListSection[] = [
    { id: 'new', label: 'New', threads: [row({ project: 'a' })] },
    { id: 'sent', label: 'Sent', threads: [row({ project: 'b', section: 'sent', unseen: 0 })] },
    { id: 'quiet', label: 'Quiet', threads: [row({ project: 'c', section: 'quiet', unseen: 0, read_at: '2026-10-14T10:00:00.000Z' })] },
  ];
  expect([...projectsWithReadable(sections)]).toEqual(['a']);
});

describe('projectBatchToast', () => {
  test("the count is the server's: a thread taken that the window's last read did not hold still counts", () => {
    const copy = projectBatchToast('archive', 'pando', 3, [row({})]);
    expect(copy.lead).toBe('Archived 3 threads');
  });

  const asks = (over: Partial<InboxListRow['questions']>) => ({ open: 1, picked: 0, sent: 0, closed: 0, stopped: false, holds_up: [] as string[], prompt: 'Q?', ...over });

  test('Mark all as read: the count, the questions it closed; a phone line', () => {
    const rows = [row({ section: 'waiting', questions: asks({ open: 2 }) }), row({ questions: asks({ open: 0, picked: 1 }), answered_not_sent: true })];
    const copy = projectBatchToast('read', 'pando', rows.length, rows);
    expect(copy.lead).toContain('2 threads');
    expect(copy.detail).toContain('pando');
    expect(copy.detail).toContain('3 questions');
    expect(copy.icon).toBe('check');
    expect(copy.phoneLead).toContain('2 threads');
    // The phone's word for Mark read is "read", never "Marked".
    expect(copy.phoneLead).not.toContain('Marked');
  });

  test('an agent stopped, or work held up, makes it a warning naming that', () => {
    const stopped = projectBatchToast('read', 'pando', 2, [row({ section: 'stopped', questions: asks({ stopped: true }) }), row({})]);
    expect(stopped.icon).toBe('warn');
    expect(stopped.detail).toContain('Claude Code was stopped');
    const two = projectBatchToast('archive', 'pando', 2, [row({ section: 'stopped', questions: asks({ stopped: true }) }), row({ section: 'stopped', questions: asks({ stopped: true }) })]);
    expect(two.detail).toContain('2 agents were stopped');
    const held = projectBatchToast('read', 'pando', 1, [row({ section: 'holding', questions: asks({ holds_up: ['deploy', 'billing'] }) })]);
    expect(held.icon).toBe('warn');
    expect(held.detail).toContain('2 things');
  });

  test('Archive all says the project comes back, with nothing closed; one thread is singular', () => {
    const copy = projectBatchToast('archive', 'ux-meeting', 1, [row({ section: 'quiet', unseen: 0 })]);
    expect(copy.lead).toBe('Archived 1 thread');
    expect(copy.detail).toContain('ux-meeting');
    expect(copy.icon).toBe('archive');
    // The warning or the questions come before the project, so a long project name is what "…" cuts.
    const warned = projectBatchToast('archive', 'a-very-long-project-name', 1, [row({ section: 'stopped', questions: asks({ stopped: true }) })]);
    expect(warned.detail.indexOf('was stopped')).toBeLessThan(warned.detail.indexOf('a-very-long-project-name'));
  });
});
