/**
 * The archived threads across linked machines (`GET /api/inbox/threads/archived?machines=1`, the list's Archived group;
 * approval "inbox-archived-group"): this Inbox's and every linked machine's, newest archived first, each far row with
 * `machine`. A far machine is read through its door's `GET threads/archived` only when a window asks; an asleep one
 * answers with the page it last gave for the same ask (`away: true`), and one never read shows nothing.
 */
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { inboxArchivedRows } from "@plannotator/shared/inbox/list";

export interface ArchivedPage {
  serverSession: string;
  cursor: number;
  project: string | null;
  projects: { id: string; name: string; archived: number; machine?: string }[];
  total: number;
  offset: number;
  limit: number;
  threads: InboxListRow[];
}

/** One linked machine's answer for this ask: its page (null: none, ever), and whether it is the last-known one. */
export interface FarArchived {
  machine: string;
  page: { total: number; threads: InboxListRow[]; projects: ArchivedPage["projects"] } | null;
  away: boolean;
}

/** A far door's answer, picked by name: its rows with their machine, never one this Inbox holds. */
export function farArchivedPage(machine: string, body: unknown): FarArchived["page"] {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const threads = (Array.isArray(b.threads) ? b.threads : [])
    .filter((row): row is InboxListRow => !!row && typeof row === "object" && typeof (row as InboxListRow).thread_id === "string" && typeof (row as InboxListRow).resolved_at === "string")
    .map((row) => ({ ...row, machine }));
  const projects = (Array.isArray(b.projects) ? b.projects : [])
    .filter((p): p is ArchivedPage["projects"][number] => !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && typeof p.archived === "number")
    .map((p) => ({ id: p.id, name: p.name, archived: p.archived, machine }));
  return { total: typeof b.total === "number" && b.total >= threads.length ? b.total : threads.length, threads, projects };
}

/**
 * This Inbox's page and each linked machine's, as one: each was asked for its first `offset + limit` rows, so the
 * merged slice is exact. `holds`: an id this store holds never comes from another machine.
 */
export function mergeArchived(own: ArchivedPage, far: readonly FarArchived[], holds: (threadId: string) => boolean) {
  const rows: InboxListRow[] = [...own.threads];
  const projects = [...own.projects];
  const machines: Record<string, { away: boolean }> = {};
  let total = own.total;
  const seen = new Set(rows.map((row) => row.thread_id));
  for (const { machine, page, away } of far) {
    machines[machine] = { away };
    if (!page) continue;
    total += page.total;
    projects.push(...page.projects);
    for (const row of page.threads) {
      if (seen.has(row.thread_id) || holds(row.thread_id)) continue;
      seen.add(row.thread_id);
      rows.push(row);
    }
  }
  return { ...own, projects, total, threads: inboxArchivedRows(rows).slice(own.offset, own.offset + own.limit), machines };
}
