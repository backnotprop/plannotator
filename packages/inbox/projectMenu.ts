/**
 * The project menu (design record "inbox-project-menu", approved 2026-10-14;
 * not in this repo): which projects the sidebar shows, whether "Mark all as
 * read" has anything to do, and what the batch's toast says. Pure.
 *
 * Hiding is automatic and derived: a project with no thread in the window's
 * list (every thread archived, none come back) leaves PROJECTS. Nothing is
 * stored for it, and it comes back with the next thread that puts it in the
 * list (a new message, a `reply_to` that brings a thread back, Unarchive).
 * The project the list is filtered to stays until the person leaves it.
 */

import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { ProjectFolder } from './api';
import { agentName, plural } from './format';
import { offersRowMarkRead } from './markRead';

export type ProjectAction = 'read' | 'archive';

/**
 * The projects the sidebar draws, in the server's order: those with a
 * thread in the list, and the one the list shows (`held`) even when it has
 * none. A folder from an Inbox older than `listed` is always drawn.
 */
export function shownProjects(projects: readonly ProjectFolder[], held: string | null): ProjectFolder[] {
  return projects.filter((project) => project.listed === undefined || project.listed > 0 || project.id === held);
}

/** The project has no thread in the list, but has archived ones: the list's "Everything in … is archived" state. */
export function projectAllArchived(project: ProjectFolder | null): boolean {
  return project !== null && project.listed === 0 && (project.archived ?? 0) > 0;
}

/** The projects where Mark all as read has something to do (single Mark read is offered on one of their rows). */
export function projectsWithReadable(sections: readonly InboxListSection[]): Set<string> {
  const out = new Set<string>();
  for (const section of sections) for (const row of section.threads) if (offersRowMarkRead(row)) out.add(row.project.id);
  return out;
}

export interface ProjectBatchToast {
  /** The lead: what happened. */
  text: string;
  /** The detail: the warning, the questions closed, or when it comes back. */
  sub: string;
  /** A phone's one line. */
  short: string;
  /** An agent was stopped or held up on a thread the batch took: the warning icon (no Reply: several threads). */
  warn: boolean;
}

/**
 * The toast after a batch, from the rows as they were before it (`rows`:
 * the threads the batch took). Worded in the approved one-line toast style
 * (`.product/approved/inbox-toast/`): a lead and a short detail, no periods.
 */
export function projectBatchToast(action: ProjectAction, projectName: string, rows: readonly InboxListRow[]): ProjectBatchToast {
  const n = rows.length;
  const threads = plural(n, 'thread');
  // Questions still waiting on the person in the threads taken: Mark read and the archive close them.
  const questions = rows.reduce((sum, row) => sum + row.questions.open + row.questions.picked, 0);
  const stopped = rows.filter((row) => row.questions.stopped && row.questions.open > 0);
  const holds = rows.reduce((sum, row) => sum + (row.questions.open > 0 ? row.questions.holds_up.length : 0), 0);
  const closed = questions > 0 ? `Closed ${plural(questions, 'open question')}` : '';
  let warning = '';
  if (stopped.length === 1) warning = `${agentName(stopped[0]!.author)} was stopped`;
  else if (stopped.length > 1) warning = `${stopped.length} agents were stopped`;
  else if (holds > 0) warning = `Held up ${plural(holds, 'thing')}`;
  const warn = warning !== '';
  if (action === 'read') {
    return {
      text: `Marked ${threads} in ${projectName} read`,
      sub: warning || closed || 'They come back when an agent writes',
      short: `${threads} read`,
      warn,
    };
  }
  return {
    text: `Archived ${threads} in ${projectName}`,
    sub: warning || closed || 'The project comes back when an agent writes there',
    short: `${projectName} archived`,
    warn,
  };
}

/** A key for one batch, so a retried request answers what the first did (the server's `batch_id`). */
export function newBatchId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `b-${random}`;
}
