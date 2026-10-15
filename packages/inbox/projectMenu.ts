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
  /** The bold first words: what happened ("Marked 3 threads read", "Archived 5 threads"). */
  lead: string;
  /** A phone's lead ("Read" replaces "Marked read": "3 threads read"). */
  phoneLead: string;
  /** The muted rest of the line: the warning, the questions closed, or when it comes back, then the project. */
  detail: string;
  /** An agent was stopped or held up on a thread the batch took: the warning icon (no Reply: several threads). */
  icon: 'warn' | 'check' | 'archive';
}

/**
 * The toast after a batch: `taken` is how many threads the server says the
 * batch took (its answer's ids), and `rows` the list's rows for those as they
 * were before it (the window may not have every one: a thread that arrived
 * since its last read), which give the warning and the questions closed. In
 * the approved one-line toast style
 * (`.product/approved/inbox-toast/`: an icon, a bold lead, a muted detail
 * cut with "…"). The detail leads with what matters most (a warning, then
 * the questions closed), then the project, so a long project name is what
 * the "…" cuts.
 */
export function projectBatchToast(action: ProjectAction, projectName: string, taken: number, rows: readonly InboxListRow[]): ProjectBatchToast {
  const threads = plural(taken, 'thread');
  // Questions still waiting on the person in the threads taken: Mark read and the archive close them.
  const questions = rows.reduce((sum, row) => sum + row.questions.open + row.questions.picked, 0);
  const stopped = rows.filter((row) => row.questions.stopped && row.questions.open > 0);
  const holds = rows.reduce((sum, row) => sum + (row.questions.open > 0 ? row.questions.holds_up.length : 0), 0);
  let warning = '';
  if (stopped.length === 1) warning = `${agentName(stopped[0]!.author)} was stopped`;
  else if (stopped.length > 1) warning = `${stopped.length} agents were stopped`;
  else if (holds > 0) warning = `Held up ${plural(holds, 'thing')}`;
  const closed = questions > 0 ? `Closed ${plural(questions, 'question')}` : '';
  const why = warning || closed || (action === 'read' ? 'Back when an agent writes' : 'Back when an agent writes there');
  const detail = `${why} · ${projectName}`;
  if (action === 'read') {
    return { lead: `Marked ${threads} read`, phoneLead: `${threads} read`, detail, icon: warning ? 'warn' : 'check' };
  }
  return { lead: `Archived ${threads}`, phoneLead: `Archived ${threads}`, detail, icon: warning ? 'warn' : 'archive' };
}

/** A key for one batch, so a retried request answers what the first did (the server's `batch_id`). */
export function newBatchId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `b-${random}`;
}
