/**
 * Inbox search's routes (the approved "inbox-search" brief, section 11):
 *
 * - `GET /api/inbox/search`: read-only. `q` (trimmed, 200 characters at
 *   most, 8 terms), `project=prj_…`, `status=waiting|new|sent|quiet|archived`,
 *   `from=agent|me`, `group=` with `offset=` for "Show all", `limit` (per
 *   group, at most 50), `current=prj_…` (the project open in the list: a tie
 *   boost, never a filter). The index (packages/shared/inbox/search.ts) is
 *   built on the first call, in slices that yield, so every other route keeps
 *   answering; a call that finds it still building waits a moment, then
 *   answers `indexing: true` with no groups, and the window asks again. An
 *   empty `q` with no filters answers `recent` (the threads the person looked
 *   at last) and `recent_searches`.
 * - `POST /api/inbox/search/recent`: the window's recent searches, written
 *   only when the person opens a result (`{ q }`) or clears them
 *   (`{ clear: true }`): the last 6 in `inbox/recent-searches.json`.
 *
 * Both answer the loopback window and the owner over the tailnet listener,
 * like every read route and the window's own writes. The phone's device door
 * does not carry them (its allowlist is explicit).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_SEARCH_QUERY_MAX } from "@plannotator/core/inbox-search";
import { isInboxId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";
import {
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_STATUSES,
  InboxSearchIndex,
  type InboxSearchAnswer,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchIndexOptions,
  type InboxSearchStatus,
} from "@plannotator/shared/inbox/search";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_SEARCH_PATH = "/api/inbox/search";
export const INBOX_SEARCH_RECENT_PATH = "/api/inbox/search/recent";
/** Recent searches kept. */
export const INBOX_RECENT_SEARCHES_MAX = 6;
export const INBOX_RECENT_SEARCHES_FILE = "recent-searches.json";
/** How long a search waits for a build in progress before answering `indexing: true`. */
export const INBOX_SEARCH_BUILD_WAIT_MS = 250;

export interface InboxSearchRoutes {
  index: InboxSearchIndex;
  /** The route's answer, or null for a path that is not search's. */
  handle(req: Request, url: URL): Promise<Response | null>;
  dispose(): void;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const CROSS_SITE_BODY = INBOX_CROSS_SITE_BODY;
/** A request another site, or another localhost port, made (inbox-cross-site.ts). */
const crossSite = isCrossSiteRequest;

/** The recent searches on disk, newest first; anything unreadable reads as none. */
export function readRecentSearches(storeDir: string): string[] {
  try {
    const value = JSON.parse(readFileSync(join(storeDir, INBOX_RECENT_SEARCHES_FILE), "utf8")) as { searches?: unknown };
    if (!Array.isArray(value.searches)) return [];
    return value.searches.filter((s): s is string => typeof s === "string" && s.trim() !== "").slice(0, INBOX_RECENT_SEARCHES_MAX);
  } catch {
    return [];
  }
}

function writeRecentSearches(storeDir: string, searches: string[]): void {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const path = join(storeDir, INBOX_RECENT_SEARCHES_FILE);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, searches })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function oneOf<T extends string>(url: URL, name: string, values: readonly T[]): T | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  if (!(values as readonly string[]).includes(value)) throw new InboxError("validation_error", `${name}: one of ${values.join(", ")}.`, { field: name });
  return value as T;
}

function count(url: URL, name: string, min: number, max: number): number | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new InboxError("validation_error", `${name}: a whole number from ${min} to ${max}.`, { field: name });
  return n;
}

export function createInboxSearchRoutes(input: { store: InboxStore; serverSession: string; index?: InboxSearchIndexOptions }): InboxSearchRoutes {
  const { store, serverSession } = input;
  const index = new InboxSearchIndex(store, input.index);

  const search = async (url: URL): Promise<Response> => {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, INBOX_SEARCH_QUERY_MAX);
    const projectParam = url.searchParams.get("project");
    let project: string | null = null;
    if (projectParam) {
      if (!isInboxId("prj", projectParam)) throw new InboxError("validation_error", "project: a prj_ id.", { field: "project" });
      if (!store.project(projectParam)) throw new InboxError("project_not_found", `No project ${projectParam}.`);
      project = projectParam;
    }
    const currentParam = url.searchParams.get("current");
    const current = currentParam && isInboxId("prj", currentParam) ? currentParam : null;
    const status = oneOf<InboxSearchStatus>(url, "status", INBOX_SEARCH_STATUSES);
    const from = oneOf<InboxSearchFrom>(url, "from", ["agent", "me"]);
    const group = oneOf<InboxSearchGroupId>(url, "group", INBOX_SEARCH_GROUPS);
    const offset = count(url, "offset", 0, 1_000_000) ?? 0;
    const limit = count(url, "limit", 1, INBOX_SEARCH_LIMIT_MAX);
    const recentSearches = (answer: InboxSearchAnswer) => (answer.recent ? { recent_searches: readRecentSearches(store.dir) } : {});
    if (!index.ready()) {
      // The build runs in slices; give a short query a chance to land on a finished index.
      const building = index.ensureBuilt();
      await Promise.race([building, new Promise((resolve) => setTimeout(resolve, INBOX_SEARCH_BUILD_WAIT_MS))]);
      if (!index.ready()) {
        const answer: InboxSearchAnswer = { q, terms: [], took_ms: 0, indexing: true, threads: index.threadCount(), totals: null, groups: null, recent: null };
        return json({ serverSession, ...answer });
      }
    }
    const answer = index.search({ q, project, status, from, group, offset, limit, current });
    return json({ serverSession, ...answer, ...recentSearches(answer) });
  };

  const saveRecent = async (req: Request): Promise<Response> => {
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (body.clear === true) {
      writeRecentSearches(store.dir, []);
      return json({ recent_searches: [] });
    }
    if (typeof body.q !== "string" || body.q.trim() === "") throw new InboxError("validation_error", "q: the search to remember, or clear: true.", { field: "q" });
    const q = body.q.trim().replace(/\s+/g, " ").slice(0, INBOX_SEARCH_QUERY_MAX);
    const key = q.toLowerCase();
    const searches = [q, ...readRecentSearches(store.dir).filter((s) => s.toLowerCase() !== key)].slice(0, INBOX_RECENT_SEARCHES_MAX);
    writeRecentSearches(store.dir, searches);
    return json({ recent_searches: searches });
  };

  return {
    index,
    dispose: () => index.dispose(),
    async handle(req, url) {
      if (url.pathname !== INBOX_SEARCH_PATH && url.pathname !== INBOX_SEARCH_RECENT_PATH) return null;
      // Another site (or another localhost port: same-site) never reaches search. It could not read
      // the answer, but it picks the query, and how long a search takes says whether it found anything.
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      if (url.pathname === INBOX_SEARCH_PATH) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        return search(url);
      }
      if (url.pathname === INBOX_SEARCH_RECENT_PATH) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        return saveRecent(req);
      }
      return null;
    },
  };
}
