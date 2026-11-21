/**
 * The door's answers to a linked machine's agent search and thread list (inbox-machine-agent-find.ts says why and how
 * the asking machine merges them). Both are reads only, as a guest's: the ⌘K index's own search (in memory, no recent
 * search kept) and the list rows, with no session of this computer (`caller: null`), so nothing is marked read,
 * settled, delivered or written.
 *
 * The ask names projects by git remote, else by folder name (`farProjectMatches`); this Inbox maps them onto its own
 * projects, a combined project's folders together, as its own agents' search and list read them.
 */

import { inboxSearchTerms, INBOX_SEARCH_LIMIT_MAX, INBOX_SEARCH_QUERY_MAX, type InboxSearchMessageRow } from "@plannotator/core/inbox-search";
import type { InboxSearchIndex } from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { farProjectMatches, farScopeOf, type FarProjectAsk, type FarSearchAnswer, type FarSearchRow, type FarThreadsAnswer } from "./inbox-machine-agent-find";
import { agentThreadRow, listScopedRows } from "./inbox-mcp";
import { rowOf } from "./inbox-mcp-search";

/** How long a far ask waits for this index's first build: under the asker's own bound (5 s). */
const FAR_SEARCH_BUILD_WAIT_MS = 3_000;

export interface AgentFindHost {
  store: InboxStore;
  searchIndex?: InboxSearchIndex;
  /** A project root's git remote as `farRemoteKey` writes it, from what is cached (never waits for git); null: none known. */
  remoteKeyOf?: (root: string) => string | null;
}

const answer = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refusal = (status: number, code: string, error: string): Response => answer({ code, error }, status);

/** This Inbox's projects the ask names, as the canonical project of each group (a combined project's folders together). */
function projectsOf(host: AgentFindHost, scope: readonly FarProjectAsk[]): string[] {
  const { store } = host;
  const ids = new Set<string>();
  for (const project of store.allProjects()) {
    if (farProjectMatches(scope, { name: project.name, remote: host.remoteKeyOf?.(project.root) ?? null })) ids.add(store.canonicalProjectId(project.id));
  }
  return [...ids];
}

const boundedLimit = (value: string | null, fallback: number, max: number): number | null => {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? Math.min(n, max) : null;
};

/** `GET agent-search?q=&limit=&scope=|all=1`: the agents' search over this Inbox's messages, with each row's rank. */
export async function agentSearchDoorAnswer(host: AgentFindHost, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, INBOX_SEARCH_QUERY_MAX);
  if (inboxSearchTerms(q).length === 0) return refusal(422, "validation_error", "q: words to search for.");
  const limit = boundedLimit(url.searchParams.get("limit"), 10, INBOX_SEARCH_LIMIT_MAX);
  if (limit === null) return refusal(422, "validation_error", "limit: a whole number from 1 to 100.");
  const index = host.searchIndex;
  if (!index) return refusal(503, "search_unavailable", "This Inbox has no search index.");
  const scope = farScopeOf(url.searchParams);
  const projects = scope === null ? [null] : projectsOf(host, scope);
  if (projects.length === 0) return answer({ total: 0, results: [] } satisfies FarSearchAnswer);
  if (!index.ready()) {
    await Promise.race([index.ensureBuilt(), new Promise((resolve) => setTimeout(resolve, FAR_SEARCH_BUILD_WAIT_MS))]);
    if (!index.ready()) return refusal(503, "search_indexing", "The search index is still being built.");
  }
  let total = 0;
  const ranked: { row: InboxSearchMessageRow; score: number }[] = [];
  for (const project of projects) {
    const found = index.search({ q, project, group: "messages", offset: 0, limit, scores: true });
    total += found.totals?.messages ?? 0;
    const scores = found.scores?.messages ?? [];
    (found.groups?.messages ?? []).forEach((row, i) => {
      if (row.type === "message") ranked.push({ row, score: scores[i] ?? 0 });
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  const results: FarSearchRow[] = ranked.slice(0, limit).map(({ row, score }) => ({ ...rowOf(row, true), project: row.project.name, score }));
  return answer({ total, results } satisfies FarSearchAnswer);
}

/** `GET agent-threads?limit=&include_resolved=1&scope=|all=1`: read_thread's list of this Inbox's threads, every agent's. */
export function agentThreadsDoorAnswer(host: AgentFindHost, url: URL): Response {
  const { store } = host;
  const limit = boundedLimit(url.searchParams.get("limit"), 20, 100);
  if (limit === null) return refusal(422, "validation_error", "limit: a whole number from 1 to 100.");
  const scope = farScopeOf(url.searchParams);
  const projectIds = scope === null ? null : new Set(projectsOf(host, scope).flatMap((id) => store.projectGroup(id)));
  if (projectIds?.size === 0) return answer({ total: 0, threads: [] } satisfies FarThreadsAnswer);
  let rows = listScopedRows(store, projectIds, null);
  // As this Inbox's own list: a thread an agent wrote in after its archive line is listed like an open one.
  if (url.searchParams.get("include_resolved") !== "1") rows = rows.filter((t) => t.resolved_at === null || t.agent_after_archive === true);
  const threads = rows.slice(0, limit).map((row) => ({ ...agentThreadRow(store, row, null), project: row.project.name }));
  return answer({ total: rows.length, threads } satisfies FarThreadsAnswer);
}
