/**
 * The held list (the approved Workspaces behaviour): while the person reads,
 * the list on screen does not move. New agent activity waits behind the
 * "N new" notice until they press Show, change folder or page. The person's
 * own reads and actions wait too while a thread is open, and settle when it
 * closes (`settleOwn`; when that happens and how it moves: settle.ts). Pure.
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

/** `row` carries agent activity the row on screen (`old`) lacks: a thread an agent started, or a newer agent message. */
function hasNewAgentActivity(old: InboxListRow | undefined, row: InboxListRow): boolean {
  return old === undefined ? row.last_author === 'agent' : row.last_author === 'agent' && row.last_at > old.last_at;
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
    if (!hasNewAgentActivity(before.get(row.thread_id), row)) continue;
    count += 1;
    projects.add(row.project.name);
  }
  if (count === 0) return { count, text: null };
  return { count, text: projects.size === 1 ? `${count} new in ${[...projects][0]}` : `${count} new` };
}

/**
 * The held list with each row's own state brought up to date in place. The
 * rows keep their sections and their order, which wait for an action; but a
 * row whose thread changed without new agent activity (the reply was
 * delivered, an agent read it, the thread was resolved) shows its state as it
 * now is, so a Sent row stops saying "Saved for" once the agent has the
 * reply. A row with new agent activity keeps what was on screen: that change
 * waits behind "N new". A row whose thread is gone stays as it was.
 */
export function refreshHeldRows(shown: readonly InboxListSection[], latest: readonly InboxListSection[]): InboxListSection[] {
  const fresh = rowsById(latest);
  return shown.map((section) => ({
    ...section,
    threads: section.threads.map((row) => {
      const next = fresh.get(row.thread_id);
      return next && !hasNewAgentActivity(row, next) ? next : row;
    }),
  }));
}

/** The list's own order within a section (packages/shared/inbox/list.ts): newest first, ties on the thread id. */
function newestFirst(left: InboxListRow, right: InboxListRow): number {
  return right.last_at.localeCompare(left.last_at) || left.thread_id.localeCompare(right.thread_id);
}

/**
 * The list settled for the person's own reads and actions only (design
 * record "inbox-open-stays-put", approved 2026-10-12): every row takes the
 * section and the place `latest` gives it, except what an agent did since the
 * list on screen was drawn, which still waits behind "N new · Show". A thread
 * the list on screen lacks and an agent started stays out; a row with a newer
 * agent message keeps the state it had on screen and the place that state
 * gives it. A thread gone from `latest` leaves. Show adopts `latest` whole.
 */
export function settleOwn(shown: readonly InboxListSection[], latest: readonly InboxListSection[]): InboxListSection[] {
  const before = rowsById(shown);
  const known = new Set(latest.map((section) => section.id));
  const buckets = new Map<string, InboxListRow[]>();
  const put = (sectionId: string, row: InboxListRow) => {
    const bucket = buckets.get(sectionId);
    if (bucket) bucket.push(row);
    else buckets.set(sectionId, [row]);
  };
  for (const section of latest) {
    for (const row of section.threads) {
      const old = before.get(row.thread_id);
      if (!hasNewAgentActivity(old, row)) put(section.id, row);
      // Held: the state on screen, in the section that state sits in.
      else if (old) put(known.has(old.section) ? old.section : section.id, old);
    }
  }
  return latest.map((section) => ({ ...section, threads: (buckets.get(section.id) ?? []).sort(newestFirst) }));
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
