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

/**
 * Which linked machines the merged read asks: every one for no project; for a project, only the machine it lives
 * on, and none when it lives here (or on no machine this Inbox knows). `{ owner: null }`: every machine; null: none.
 */
export function archivedAskOf(project: string | null, local: boolean, ownerOf: (project: string) => string | null): { owner: string | null } | null {
  if (project === null) return { owner: null };
  if (local) return null;
  const owner = ownerOf(project);
  return owner ? { owner } : null;
}

/**
 * A far row's tags as the merged list's (`idOn`, inboxMachineTags), so it takes its tag's colour as the list's rows do;
 * none from a machine that takes no tags from here (`taken`), as on the list.
 */
export function farRowTags(row: InboxListRow & { machine: string }, taken: ReadonlySet<string>, idOn: (machine: string, id: string) => string | null): InboxListRow {
  const { tags: farTags, ...rest } = row;
  const tags = taken.has(row.machine) ? [...new Set((farTags ?? []).flatMap((id) => idOn(row.machine, id) ?? []))] : [];
  return tags.length > 0 ? { ...rest, tags } : rest;
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
