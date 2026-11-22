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
import { FAR_REMOTE_UNKNOWN, farProjectMatches, farScopeFromQuery, type FarProjectAsk, type FarRemote, type FarSearchAnswer, type FarSearchRow, type FarThreadsAnswer } from "./inbox-machine-agent-find";
import { agentThreadRow, listScopedRows } from "./inbox-mcp";
import { rowOf } from "./inbox-mcp-search";

/** How long a far ask waits for this index's first build: under the asker's own bound (5 s), and never past its `wait_ms`. */
const FAR_SEARCH_BUILD_WAIT_MS = 3_000;
/** How long the projects' remotes git has not named yet are waited for (a restart's cold cache), all at once. */
const FAR_DOOR_REMOTE_WAIT_MS = 1_000;

export interface AgentFindHost {
  store: InboxStore;
  searchIndex?: InboxSearchIndex;
  /**
   * A project root's git remote as `farRemoteKey` writes it: the cache's, else git's within `waitMs`, else
   * `FAR_REMOTE_UNKNOWN` (`farRemoteOf`). Absent: every remote is unknown.
   */
  remoteOf?: (root: string, waitMs: number) => Promise<FarRemote>;
}

const answer = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refusal = (status: number, code: string, error: string): Response => answer({ code, error }, status);

/**
 * This Inbox's projects the ask names, as the canonical project of each group (a combined project's folders together).
 * A project whose remote git has not named within the wait is unknown, so it is matched by nothing.
 */
async function projectsOf(host: AgentFindHost, scope: readonly FarProjectAsk[], waitMs: number): Promise<string[]> {
  const { store } = host;
  if (scope.length === 0) return [];
  const projects = store.allProjects();
  const remotes = await Promise.all(projects.map((project) => (host.remoteOf ? host.remoteOf(project.root, waitMs).catch(() => FAR_REMOTE_UNKNOWN) : FAR_REMOTE_UNKNOWN)));
  const ids = new Set<string>();
  projects.forEach((project, i) => {
    if (farProjectMatches(scope, { name: project.name, remote: remotes[i]! })) ids.add(store.canonicalProjectId(project.id));
  });
  return [...ids];
}

/** The asker's `wait_ms`: how long this answer may take before it gives up (its bound, less the way back). */
const waitOf = (value: string | null): number => {
  const n = Number(value);
  return value !== null && Number.isFinite(n) && n >= 0 ? Math.min(n, FAR_SEARCH_BUILD_WAIT_MS + FAR_DOOR_REMOTE_WAIT_MS) : FAR_SEARCH_BUILD_WAIT_MS + FAR_DOOR_REMOTE_WAIT_MS;
};

const boundedLimit = (value: string | null, fallback: number, max: number): number | null => {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? Math.min(n, max) : null;
};

/**
 * `GET agent-search?q=&limit=&scope=|all=1&wait_ms=`: the agents' search over this Inbox's messages, with each row's
 * rank. An index still building past the wait is `503 search_indexing` (the asker asks again while its bound lasts).
 */
export async function agentSearchDoorAnswer(host: AgentFindHost, url: URL): Promise<Response> {
  const started = Date.now();
  const wait = waitOf(url.searchParams.get("wait_ms"));
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, INBOX_SEARCH_QUERY_MAX);
  if (inboxSearchTerms(q).length === 0) return refusal(422, "validation_error", "q: words to search for.");
  const limit = boundedLimit(url.searchParams.get("limit"), 10, INBOX_SEARCH_LIMIT_MAX);
  if (limit === null) return refusal(422, "validation_error", "limit: a whole number from 1 to 100.");
  const index = host.searchIndex;
  if (!index) return refusal(503, "search_unavailable", "This Inbox has no search index.");
  const scope = farScopeFromQuery(url.searchParams);
  const projects = scope === null ? [null] : await projectsOf(host, scope, Math.min(FAR_DOOR_REMOTE_WAIT_MS, wait));
  if (projects.length === 0) return answer({ total: 0, results: [] } satisfies FarSearchAnswer);
  if (!index.ready()) {
    const left = Math.max(0, Math.min(FAR_SEARCH_BUILD_WAIT_MS, wait - (Date.now() - started)));
    await Promise.race([index.ensureBuilt(), new Promise((resolve) => setTimeout(resolve, left))]);
    if (!index.ready()) return refusal(503, "search_indexing", "The search index is still being built.");
  }
  let total = 0;
  const seen = new Set<string>();
  const ranked: { row: InboxSearchMessageRow; score: number }[] = [];
  for (const project of projects) {
    const found = index.search({ q, project, group: "messages", offset: 0, limit, scores: true });
    total += found.totals?.messages ?? 0;
    const scores = found.scores?.messages ?? [];
    (found.groups?.messages ?? []).forEach((row, i) => {
      // A combined project's folders searched apart never list one message twice.
      if (row.type === "message" && !seen.has(row.id)) {
        seen.add(row.id);
        ranked.push({ row, score: scores[i] ?? 0 });
      }
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  const results: FarSearchRow[] = ranked.slice(0, limit).map(({ row, score }) => ({ ...rowOf(row, true), project: row.project.name, score }));
  return answer({ total, results } satisfies FarSearchAnswer);
}

/**
 * `GET agent-threads?limit=&include_resolved=1&scope=|all=1`: read_thread's list of this Inbox's threads, every
 * agent's. A row carries no `unread`: read here with no session, it would not say what the asking agent has read.
 */
export async function agentThreadsDoorAnswer(host: AgentFindHost, url: URL): Promise<Response> {
  const { store } = host;
  const limit = boundedLimit(url.searchParams.get("limit"), 20, 100);
  if (limit === null) return refusal(422, "validation_error", "limit: a whole number from 1 to 100.");
  const scope = farScopeFromQuery(url.searchParams);
  const projectIds = scope === null ? null : new Set((await projectsOf(host, scope, FAR_DOOR_REMOTE_WAIT_MS)).flatMap((id) => store.projectGroup(id)));
  if (projectIds?.size === 0) return answer({ total: 0, threads: [] } satisfies FarThreadsAnswer);
  let rows = listScopedRows(store, projectIds, null);
  // As this Inbox's own list: a thread an agent wrote in after its archive line is listed like an open one.
  if (url.searchParams.get("include_resolved") !== "1") rows = rows.filter((t) => t.resolved_at === null || t.agent_after_archive === true);
  const threads = rows.slice(0, limit).map((row) => {
    const { unread: _unread, ...rest } = agentThreadRow(store, row, null);
    return { ...rest, project: row.project.name };
  });
  return answer({ total: rows.length, threads } satisfies FarThreadsAnswer);
}
