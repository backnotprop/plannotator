/**
 * The held list (the approved Workspaces behaviour): while the person reads,
 * the list on screen does not move. New agent activity waits behind the
 * "N new" notice until they press Show or act. Pure.
 */

import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

export interface HeldNotice {
  count: number;
  /** "1 new in docs-site", or "3 new" across projects; null when nothing waits. */
  text: string | null;
}

function rowsById(sections: readonly InboxListSection[]): Map<string, InboxListRow> {
  const out = new Map<string, InboxListRow>();
  for (const section of sections) for (const row of section.threads) out.set(row.thread_id, row);
  return out;
}

/**
 * The threads in `latest` with agent activity the list on screen does not
 * show: a thread it lacks, or one whose last message is a newer agent
 * message. The person's own picks, replies and looks never count.
 */
export function heldNotice(shown: readonly InboxListSection[], latest: readonly InboxListSection[]): HeldNotice {
  const before = rowsById(shown);
  const projects = new Set<string>();
  let count = 0;
  for (const row of rowsById(latest).values()) {
    const old = before.get(row.thread_id);
    const fresh = old === undefined ? row.last_author === 'agent' : row.last_author === 'agent' && row.last_at > old.last_at;
    if (!fresh) continue;
    count += 1;
    projects.add(row.project.name);
  }
  if (count === 0) return { count, text: null };
  return { count, text: projects.size === 1 ? `${count} new in ${[...projects][0]}` : `${count} new` };
}

/** One project's rows only; the sections stay, empty ones included. */
export function filterSections(sections: readonly InboxListSection[], projectId: string | null): InboxListSection[] {
  if (!projectId) return sections.map((s) => ({ ...s }));
  return sections.map((s) => ({ ...s, threads: s.threads.filter((row) => row.project.id === projectId) }));
}

/** The rows that wait on the person (Stopped, Holding, Waiting): the sidebar counts. */
export function waitingCount(sections: readonly InboxListSection[], projectId?: string): number {
  let n = 0;
  for (const section of sections) {
    if (section.id !== 'stopped' && section.id !== 'holding' && section.id !== 'waiting') continue;
    for (const row of section.threads) if (!projectId || row.project.id === projectId) n += 1;
  }
  return n;
}
