/**
 * The agents' read-only search (approval "inbox-agent-search", 2026-10-19):
 * the person's ⌘K index (packages/shared/inbox/search.ts), over messages, in
 * the caller's project unless it asks for every project. It answers compact
 * rows (thread id, message id, author, time, snippet) and writes nothing: no
 * recent-searches entry, no read mark, no new storage (the index is the
 * window's own, in memory). Why it exists: an agent hunting a reply it may
 * have missed read eight whole threads (~400 KB) where one search settles it.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { inboxSearchTerms, INBOX_SEARCH_LIMIT_MAX, INBOX_SEARCH_QUERY_MAX, type InboxSearchMessageRow } from "@plannotator/core/inbox-search";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { INBOX_SEARCH_FIRST_RULE } from "@plannotator/shared/inbox/connection";
import { clip, shortTime } from "./inbox-mcp-read";
import { guarded, okComplete, PROJECT_PATH_DESCRIPTION } from "./inbox-mcp-result";
import type { InboxMcpContext } from "./inbox-mcp";
import { farSearchFor } from "./inbox-mcp-far-find";
import type { InboxProject } from "@plannotator/core/inbox-types";

/** Results the search answers by default. */
export const INBOX_AGENT_SEARCH_LIMIT = 10;
/** How long a search waits for the index's first build before it says to try again. */
export const INBOX_AGENT_SEARCH_BUILD_WAIT_MS = 10_000;

export const SEARCH_DESCRIPTION =
  `Search the Inbox's messages (yours, other agents' and the person's) by words, read-only: in this project unless all_projects. Up to \`limit\` results (default 10, at most 50; a larger limit answers 50). Every word must match (the last may be the start of a word), questions' prompts, choices and answers included. Each result is one line: the thread, the message, who wrote it, when, and the words around the match. read_thread with that thread_id and message_id shows the message in full. ${INBOX_SEARCH_FIRST_RULE}`;

export interface InboxAgentSearchRow {
  thread_id: string;
  message_id: string;
  /** "person", or the agent's name as the person sees it. */
  author: string;
  at: string;
  /** The thread's subject. */
  subject: string;
  snippet: string;
  /** The match is in this question (its prompt, choices or answer). */
  question?: string;
  project?: string;
  /** The linked computer the message is on (absent: this one). */
  machine?: { id: string; name: string };
}

export function rowOf(row: InboxSearchMessageRow, withProject: boolean): InboxAgentSearchRow {
  return {
    thread_id: row.thread_id,
    message_id: row.id,
    author: row.author.kind === "me" ? "person" : row.author.name,
    at: row.at,
    subject: row.title,
    snippet: row.snippet.text,
    ...(row.question ? { question: row.question.key } : {}),
    ...(withProject ? { project: row.project.name } : {}),
  };
}

export function searchRowText(row: InboxAgentSearchRow): string {
  const parts = [`- ${row.message_id} in thread ${row.thread_id} (${JSON.stringify(clip(row.subject, 80))})`];
  if (row.machine) parts.push(`on ${row.machine.name}`);
  parts.push(row.author, shortTime(row.at));
  if (row.project) parts.push(`project ${row.project}`);
  if (row.question) parts.push(`question ${row.question}`);
  parts.push(JSON.stringify(row.snippet));
  return parts.join(" · ");
}

export function registerInboxSearchTool(server: McpServer, context: InboxMcpContext): void {
  server.registerTool(
    "search",
    {
      title: "Search the Inbox's messages",
      description: SEARCH_DESCRIPTION,
      inputSchema: z
        .object({
          query: z.string().min(1).describe("Words to find."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          all_projects: z.boolean().optional().describe("Search every project."),
          limit: z.number().int().min(1).max(100).optional().describe(`Results (default ${INBOX_AGENT_SEARCH_LIMIT}, at most ${INBOX_SEARCH_LIMIT_MAX}).`),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const index = context.searchIndex;
        if (!index) throw new InboxError("search_unavailable", "This Inbox has no search index.");
        const q = input.query.trim().slice(0, INBOX_SEARCH_QUERY_MAX);
        if (inboxSearchTerms(q).length === 0) throw new InboxError("validation_error", "query: words to search for (letters or digits).");
        let projectIds: string[] | null = null;
        let found: { projects: InboxProject[]; unresolved: boolean } | null = null;
        let scope = "every project";
        let note = "";
        if (!input.all_projects) {
          if (!input.project_path) throw new InboxError("validation_error", "project_path: required unless all_projects (the connection fills it).");
          // Looked up, never made: a search writes nothing, and a folder the Inbox has never seen has no messages.
          found = context.findProjects ? await context.findProjects(input.project_path) : { projects: [], unresolved: false };
          // One search per group: a search of one folder of a combined project covers them all.
          projectIds = [...new Set(found.projects.map((project) => context.store.canonicalProjectId(project.id)))];
          scope = found.projects[0]?.name ?? input.project_path;
          if (found.unresolved) note = " Git did not answer in time, so the project of this folder is not known yet: nothing was searched. Try again, or pass all_projects.";
          else if (projectIds.length === 0) note = " No Inbox thread has been written from this folder's project yet; pass all_projects to search every project.";
        }
        const limit = Math.min(input.limit ?? INBOX_AGENT_SEARCH_LIMIT, INBOX_SEARCH_LIMIT_MAX);
        // The linked machines are asked at once, beside this search (inbox-mcp-far-find.ts); none linked: null.
        const far = found?.unresolved
          ? Promise.resolve(null)
          : farSearchFor(context, { q, limit, all: input.all_projects === true, projectPath: input.project_path, projects: found?.projects ?? [] });
        let total = 0;
        // This computer's rows in the order it always gave them (project by project), and each with its rank.
        const ranked: { row: InboxAgentSearchRow; score: number }[] = [];
        if (projectIds === null || projectIds.length > 0) {
          if (!index.ready()) {
            await Promise.race([index.ensureBuilt(), new Promise((resolve) => setTimeout(resolve, INBOX_AGENT_SEARCH_BUILD_WAIT_MS))]);
            if (!index.ready()) throw new InboxError("search_indexing", "The search index is still being built; try again in a moment.");
          }
          // The caller's project (and the one an older Inbox kept for its worktree, threadReadScope), or every project.
          for (const project of projectIds ?? [null]) {
            const answer = index.search({ q, project, group: "messages", offset: 0, limit, scores: true });
            total += answer.totals?.messages ?? 0;
            const scores = answer.scores?.messages ?? [];
            (answer.groups?.messages ?? []).forEach((row, i) => {
              if (row.type === "message") ranked.push({ row: rowOf(row, projectIds === null), score: scores[i] ?? 0 });
            });
          }
        }
        const away = await far;
        if (away) total += away.total;
        // With far rows, one order across every machine: the index's rank (match, then newest), this computer's first
        // on a tie. Without any, this computer's rows exactly as before.
        if (away && away.rows.length > 0) {
          // A far row names its project whenever it is not this one's name (the same repository in another folder there).
          for (const { score, project, ...row } of away.rows) ranked.push({ row: projectIds === null || project.toLowerCase() !== scope.toLowerCase() ? { ...row, project } : row, score });
          ranked.sort((a, b) => b.score - a.score);
        }
        const results = ranked.slice(0, limit).map(({ row }) => row);
        const lines = away?.lines.length ? `\n${away.lines.join("\n")}` : "";
        const head =
          results.length === 0
            ? `No message matches ${JSON.stringify(q)} in ${scope}.${note}`
            : `${total} message${total === 1 ? " matches" : "s match"} ${JSON.stringify(q)} in ${scope}${total > results.length ? `; the best ${results.length}` : ""}:`;
        const text = results.length === 0 ? `${head}${lines}` : `${head}\n${results.map(searchRowText).join("\n")}\nread_thread with a thread_id and its message_id shows that message in full.${lines}`;
        return okComplete(text, { query: q, scope, total, results, ...(results.length === 0 && note ? { note: note.trim() } : {}), ...(away?.lines.length ? { not_searched: away.lines } : {}) });
      }),
  );
}
