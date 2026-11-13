/**
 * Inbox search's routes (the approved "inbox-search" brief, section 11):
 *
 * - `GET /api/inbox/search`: read-only. `q` (trimmed, 200 characters at
 *   most, 8 terms), `project=prj_…`, `status=waiting|new|sent|quiet|archived`,
 *   `from=agent|me`, `group=` with `offset=` for "Show all", `limit` (per
 *   group, at most 50), `current=prj_…` (the project open in the list: a tie
 *   boost, never a filter), `sort=best|newest` (best match, the default;
 *   newest: each group by its latest message first). The index (packages/shared/inbox/search.ts) is
 *   built on the first call, in slices that yield, so every other route keeps
 *   answering; a call that finds it still building waits a moment, then
 *   answers `indexing: true` with no groups, and the window asks again. An
 *   empty `q` with no filters answers `recent` (the threads the person looked
 *   at last) and `recent_searches`. With `machines=1` (the window's merged
 *   view) the search asks every linked machine online too; see
 *   `searchWithMachines` below and "Search across machines" in
 *   docs/agent-guides/inbox-machines.md.
 * - `POST /api/inbox/search/recent`: the window's recent searches, written
 *   only when the person opens a result (`{ q }`) or clears them
 *   (`{ clear: true }`): the last 6 in `inbox/recent-searches.json`.
 *
 * Both answer the loopback window and the owner over the tailnet listener,
 * like every read route and the window's own writes. The phone's device door
 * carries the search (`GET search`, contract 7.42), not the recent searches.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_SEARCH_QUERY_MAX } from "@plannotator/core/inbox-search";
import { isInboxId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";
import {
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  INBOX_SEARCH_SORTS,
  INBOX_SEARCH_STATUSES,
  InboxSearchIndex,
  type InboxSearchAnswer,
  type InboxSearchFrom,
  type InboxSearchGroupId,
  type InboxSearchIndexOptions,
  type InboxSearchRow,
  type InboxSearchSort,
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
/** How long a merged search (`machines=1`) waits for each linked machine; past it, the others' rows alone. */
export const INBOX_SEARCH_MACHINE_WAIT_MS = 2_500;

/** The linked machines a merged search (`machines=1`) asks too (inbox-machines.ts). */
export interface InboxSearchMachines {
  /** The linked machines online now, in link order. */
  online(): string[];
  /** The linked machine that holds a project (the merged list's), or null. */
  projectOwner(projectId: string): string | null;
  /** The forward's answer to `/api/inbox/m/<machine>/search?…` (the door's `GET search`). */
  forward(req: Request, url: URL): Promise<Response | null>;
}

export interface InboxSearchRoutes {
  index: InboxSearchIndex;
  /**
   * The route's answer, or null for a path that is not search's. `machines`: the linked machines a request with
   * `machines=1` asks too; without it every search is this Inbox's own.
   */
  handle(req: Request, url: URL, machines?: InboxSearchMachines | null): Promise<Response | null>;
  dispose(): void;
}

type SearchBody = InboxSearchAnswer & { serverSession: string; recent_searches?: string[] };

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

  const answerOf = async (url: URL): Promise<SearchBody> => {
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
    const sort = oneOf<InboxSearchSort>(url, "sort", INBOX_SEARCH_SORTS);
    const recentSearches = (answer: InboxSearchAnswer) => (answer.recent ? { recent_searches: readRecentSearches(store.dir) } : {});
    if (!index.ready()) {
      // The build runs in slices; give a short query a chance to land on a finished index.
      const building = index.ensureBuilt();
      await Promise.race([building, new Promise((resolve) => setTimeout(resolve, INBOX_SEARCH_BUILD_WAIT_MS))]);
      if (!index.ready()) {
        return { serverSession, q, terms: [], took_ms: 0, indexing: true, threads: index.threadCount(), totals: null, groups: null, recent: null };
      }
    }
    const answer = index.search({ q, project, status, from, group, offset, limit, current, sort });
    return { serverSession, ...answer, ...recentSearches(answer) };
  };

  /**
   * The merged search (`machines=1`): this Inbox's answer and every linked machine's online, asked through the
   * forward at once, each at most INBOX_SEARCH_MACHINE_WAIT_MS. A machine that is away, too slow, refuses or is
   * still indexing adds nothing. Every row of another machine says `project.machine`.
   *
   * - A first answer: totals summed; each group's rows ranked together by `score`, up to the group's cap.
   * - "Show all" (`group`): this Inbox's rows, then each machine's in link order; `offset` runs across them.
   * - Recent (no words, no filters): every machine's looked-at threads, newest activity first.
   * - Another machine's project as the filter: that machine alone answers (nothing while it is away).
   */
  const searchWithMachines = async (req: Request, url: URL, machines: InboxSearchMachines): Promise<Response> => {
    const own = new URL(url);
    own.searchParams.delete("machines");
    const ask = async (machine: string, params: URLSearchParams): Promise<InboxSearchAnswer | null> => {
      const target = new URL(`/api/inbox/m/${machine}/search?${params}`, url);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const asking = (async () => {
        const response = await machines.forward(new Request(target, { headers: req.headers, signal: AbortSignal.any([controller.signal, req.signal]) }), target);
        if (!response?.ok) return null;
        const body = (await response.json()) as InboxSearchAnswer | null;
        return body && typeof body === "object" && !body.indexing ? body : null;
      })().catch(() => null);
      try {
        return await Promise.race([asking, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), INBOX_SEARCH_MACHINE_WAIT_MS)))]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    };
    const paramsWith = (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(own.searchParams);
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) params.delete(name);
        else params.set(name, value);
      }
      return params;
    };
    const tagged = <T extends InboxSearchRow>(rows: readonly T[] | undefined, machine: string): T[] => (rows ?? []).map((row) => ({ ...row, project: { ...row.project, machine } }));

    const project = own.searchParams.get("project");
    if (project && isInboxId("prj", project) && !store.project(project)) {
      const owner = machines.projectOwner(project);
      if (owner) {
        const share = machines.online().includes(owner) ? await ask(owner, paramsWith({})) : null;
        const totals = share?.totals ?? Object.fromEntries(INBOX_SEARCH_GROUPS.map((id) => [id, 0]));
        const groups = share?.groups ? Object.fromEntries(Object.entries(share.groups).map(([id, rows]) => [id, tagged(rows, owner)])) : { threads: [] };
        const answer: SearchBody = { serverSession, q: share?.q ?? own.searchParams.get("q") ?? "", terms: share?.terms ?? [], took_ms: share?.took_ms ?? 0, indexing: false, threads: share?.threads ?? 0, totals: totals as SearchBody["totals"], groups, recent: null };
        return json(answer);
      }
    }
    const answer = await answerOf(own);
    const online = machines.online();
    if (project || answer.indexing || online.length === 0) return json(answer);

    if (answer.recent) {
      const shares = await Promise.all(online.map(async (machine) => ({ machine, share: await ask(machine, paramsWith({})) })));
      const theirs = shares.flatMap(({ machine, share }) => tagged(share?.recent ?? undefined, machine));
      if (theirs.length > 0) {
        const time = (at: string) => Date.parse(at) || 0;
        answer.recent = [...answer.recent, ...theirs].map((row, at) => ({ row, at })).sort((a, b) => time(b.row.at) - time(a.row.at) || a.at - b.at).map(({ row }) => row).slice(0, INBOX_SEARCH_RECENT_THREADS);
      }
      return json(answer);
    }
    if (!answer.totals || !answer.groups) return json(answer);
    const totals = { ...answer.totals };
    const groups = { ...answer.groups };
    const add = (share: InboxSearchAnswer | null) => {
      for (const id of INBOX_SEARCH_GROUPS) totals[id] += share?.totals?.[id] ?? 0;
    };

    const group = own.searchParams.get("group") as InboxSearchGroupId | null;
    if (group) {
      // "Show all": this Inbox's rows came first; each machine's follow in link order, the offset running across them.
      const limit = Number(own.searchParams.get("limit")) || INBOX_SEARCH_LIMIT_MAX;
      const rows = [...(groups[group] ?? [])];
      let skip = (Number(own.searchParams.get("offset")) || 0) - answer.totals[group];
      for (const machine of online) {
        const wanted = limit - rows.length;
        const share = await ask(machine, paramsWith({ offset: skip > 0 ? String(skip) : null, limit: String(Math.max(1, wanted)) }));
        add(share);
        if (wanted > 0) rows.push(...tagged(share?.groups?.[group], machine).slice(0, wanted));
        skip -= share?.totals?.[group] ?? 0;
      }
      groups[group] = rows;
    } else {
      // A first answer: each group's rows from every machine, ranked together by score.
      const shares = await Promise.all(online.map(async (machine) => ({ machine, share: await ask(machine, paramsWith({})) })));
      const limit = Number(own.searchParams.get("limit")) || null;
      for (const id of INBOX_SEARCH_GROUPS) {
        const shown = groups[id];
        if (!shown) continue;
        const cap = Math.min(INBOX_SEARCH_LIMIT_MAX, limit ?? (answer.terms.length === 0 ? INBOX_SEARCH_BROWSE_LIMIT : INBOX_SEARCH_CAPS[id]));
        const all = [...shown, ...shares.flatMap(({ machine, share }) => tagged(share?.groups?.[id], machine))];
        groups[id] = all.map((row, at) => ({ row, at })).sort((a, b) => (b.row.score ?? 0) - (a.row.score ?? 0) || a.at - b.at).map(({ row }) => row).slice(0, cap);
      }
      for (const { share } of shares) add(share);
    }
    return json({ ...answer, totals, groups });
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
    async handle(req, url, machines) {
      if (url.pathname !== INBOX_SEARCH_PATH && url.pathname !== INBOX_SEARCH_RECENT_PATH) return null;
      // Another site (or another localhost port: same-site) never reaches search. It could not read
      // the answer, but it picks the query, and how long a search takes says whether it found anything.
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      if (url.pathname === INBOX_SEARCH_PATH) {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (machines && url.searchParams.get("machines") === "1") return searchWithMachines(req, url, machines);
        return json(await answerOf(url));
      }
      if (url.pathname === INBOX_SEARCH_RECENT_PATH) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        return saveRecent(req);
      }
      return null;
    },
  };
}
