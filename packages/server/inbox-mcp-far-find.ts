/**
 * `search` and read_thread's list reach the linked machines (inbox-machine-agent-find.ts): the far rows, cleaned and
 * marked with their computer, for the tools to merge with this Inbox's own. Nothing of them is kept, and no machine
 * linked means nothing changes: the tools answer exactly as before.
 *
 * "This project" on another machine (the window shows each machine's projects apart, so there is no shared id): the
 * project there whose git remote is this project's, else, when either side knows no remote, the one whose folder has
 * the same name (`farProjectMatches`). `all_projects` is every project on every machine.
 */

import { isInboxId, type InboxProject } from "@plannotator/core/inbox-types";
import { cleanStrings, oneLine } from "./inbox-far-read";
import type { FarFound, FarMachine, FarProjectAsk, FarSearchAnswer, FarSearchAsk, FarSearchRow, FarThreadRow, FarThreadsAnswer, FarThreadsAsk, MachineAgentFind } from "./inbox-machine-agent-find";
import { farNotAskedLines } from "./inbox-machine-agent-find";
import type { InboxMcpContext } from "./inbox-mcp";

export interface InboxFarFindMcpContext {
  /** Search and list every linked machine (inbox-machines.ts). Absent or null: no machines here. */
  findOnMachines?: () => MachineAgentFind | null;
  /** A project root's git remote as `farRemoteKey` writes it (a short wait for git when it is not cached), or null. */
  projectRemoteKey?: (root: string) => Promise<string | null>;
}

/** The linked machines to ask, or null when there are none: the tools then answer as before. */
function finder(context: InboxMcpContext): MachineAgentFind | null {
  const find = context.findOnMachines?.() ?? null;
  return find && find.any() ? find : null;
}

/**
 * The projects the other machines match for "this project": each of the folder's projects here (a combined project's
 * folders too) and the folder's own root, by folder name and git remote. A folder with no thread here yet still has a
 * name and a remote, so its threads on another machine are found.
 */
export async function farScopeOf(context: InboxMcpContext, projectPath: string, projects: readonly InboxProject[]): Promise<FarProjectAsk[]> {
  const roots = new Map<string, string>();
  for (const project of projects) {
    for (const id of context.store.projectGroup(project.id)) {
      const member = context.store.project(id);
      if (member) roots.set(member.root, member.name);
    }
  }
  const own = await context.projectRootOf?.(projectPath).catch(() => null);
  if (own && !roots.has(own.root)) roots.set(own.root, own.name);
  const asks = await Promise.all([...roots].map(async ([root, name]) => ({ name, remote: (await context.projectRemoteKey?.(root).catch(() => null)) ?? null })));
  const seen = new Set<string>();
  return asks.filter((a) => {
    const key = `${a.name}\n${a.remote ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A far string printed as it stands in a line: no escape, control character or line break. */
const line = (value: unknown, fallback = ""): string => (typeof value === "string" ? oneLine(value) || fallback : fallback);

/** Which far ids this Inbox prints: never one this store holds (another machine cannot claim this Inbox's threads). */
const farOnly = (context: InboxMcpContext, ...ids: string[]): boolean => ids.every((id) => !context.store.message(id));

export type FarSearchResult = Omit<FarSearchRow, "score"> & { machine: FarMachine; score: number };
export type FarThreadResult = FarThreadRow & { machine: FarMachine };

/** The far search rows, cleaned and marked, with every machine's total and the lines for the machines not reached. */
export async function farSearch(context: InboxMcpContext, ask: FarSearchAsk): Promise<{ rows: FarSearchResult[]; total: number; lines: string[] } | null> {
  const find = finder(context);
  if (!find) return null;
  const found: FarFound<FarSearchAnswer> = await find.search(ask);
  const rows: FarSearchResult[] = [];
  let total = 0;
  for (const { machine, answer } of found.answers) {
    total += answer.total;
    for (const raw of answer.results) {
      if (!farOnly(context, raw.thread_id, raw.message_id)) continue;
      const r = cleanStrings(raw) as FarSearchRow;
      rows.push({
        thread_id: r.thread_id,
        message_id: r.message_id,
        author: line(r.author, "agent"),
        at: r.at,
        subject: typeof r.subject === "string" ? r.subject : "",
        snippet: typeof r.snippet === "string" ? r.snippet : "",
        ...(typeof r.question === "string" && r.question ? { question: line(r.question) } : {}),
        project: line(r.project),
        score: r.score,
        machine,
      });
    }
  }
  return { rows, total, lines: farNotAskedLines(found.notAsked, "search") };
}

const SECTIONS = new Set(["stopped", "holding", "waiting", "new", "sent", "quiet"]);
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

/** The far list rows, cleaned and marked, with every machine's total and the lines for the machines not reached. */
export async function farThreads(context: InboxMcpContext, ask: FarThreadsAsk): Promise<{ rows: FarThreadResult[]; total: number; lines: string[] } | null> {
  const find = finder(context);
  if (!find) return null;
  const found: FarFound<FarThreadsAnswer> = await find.threads(ask);
  const rows: FarThreadResult[] = [];
  let total = 0;
  for (const { machine, answer } of found.answers) {
    total += answer.total;
    for (const raw of answer.threads) {
      if (!farOnly(context, raw.thread_id)) continue;
      const r = cleanStrings(raw) as FarThreadRow;
      const personId = isInboxId("msg", r.last_person_message_id) ? r.last_person_message_id : null;
      rows.push({
        thread_id: r.thread_id,
        subject: typeof r.subject === "string" ? r.subject : null,
        thread_name: typeof r.thread_name === "string" ? r.thread_name : null,
        section: (SECTIONS.has(r.section) ? r.section : "quiet") as FarThreadRow["section"],
        message_count: count(r.message_count),
        questions: { open: count(r.questions.open), picked: count(r.questions.picked), prompt: typeof r.questions.prompt === "string" ? r.questions.prompt : null },
        last_author: r.last_author === "person" ? "person" : "agent",
        last_at: r.last_at,
        last_person_at: personId && typeof r.last_person_at === "string" && Number.isFinite(Date.parse(r.last_person_at)) ? r.last_person_at : null,
        last_person_message_id: personId,
        unread: r.unread === true,
        ...(typeof r.resolved_at === "string" && Number.isFinite(Date.parse(r.resolved_at)) ? { resolved_at: r.resolved_at } : {}),
        project: line(r.project),
        machine,
      });
    }
  }
  return { rows, total, lines: farNotAskedLines(found.notAsked, "list") };
}

/** `search`'s far half: started beside the local search, scoped as it is (every project, or this folder's by name and remote). */
export async function farSearchFor(
  context: InboxMcpContext,
  ask: { q: string; limit: number; all: boolean; projectPath?: string; projects: readonly InboxProject[] },
): Promise<{ rows: FarSearchResult[]; total: number; lines: string[] } | null> {
  if (!finder(context)) return null;
  const scope = ask.all || !ask.projectPath ? null : await farScopeOf(context, ask.projectPath, ask.projects);
  return farSearch(context, { q: ask.q, limit: ask.limit, scope });
}

/** read_thread's list's far half, scoped as the local list is. */
export async function farThreadsFor(
  context: InboxMcpContext,
  ask: { limit: number; include_resolved: boolean; all: boolean; projectPath: string; projects: readonly InboxProject[] },
): Promise<{ rows: FarThreadResult[]; total: number; lines: string[] } | null> {
  if (!finder(context)) return null;
  const scope = ask.all ? null : await farScopeOf(context, ask.projectPath, ask.projects);
  return farThreads(context, { limit: ask.limit, include_resolved: ask.include_resolved, scope });
}

/**
 * The list with the far rows in it: this computer's rows owed to the reader (tagged, addressed) stay first, then every
 * other row by newest activity, this computer's in their own order; at most `limit`.
 */
export function mergedThreadRows<L extends { thread_id: string; last_at: string }, F extends { last_at: string }>(local: readonly L[], owed: (row: L) => boolean, far: readonly F[], limit: number): (L | F)[] {
  let first = 0;
  while (first < local.length && owed(local[first]!)) first++;
  const rest = local.slice(first);
  const away = [...far].sort((a, b) => b.last_at.localeCompare(a.last_at));
  const out: (L | F)[] = local.slice(0, first);
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < rest.length || j < away.length)) {
    if (j >= away.length || (i < rest.length && rest[i]!.last_at >= away[j]!.last_at)) out.push(rest[i++]!);
    else out.push(away[j++]!);
  }
  return out;
}
