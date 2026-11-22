/**
 * An agent on this computer finds threads on the linked machines (the owner, 2026-11-21: "An agent should be able to
 * read any thread across any computer if they're already connected"): its `search` and read_thread's list ask every
 * linked machine at once, beside this Inbox's own answer. Reading a thread by id is inbox-machine-agent-read.ts.
 *
 * The other machine answers two door routes only a linked machine's token reaches (`DOOR_OWN_ROUTES` in
 * inbox-devices.ts, mark `agent-search`; inbox-far-find.ts): `GET agent-search` and `GET agent-threads`, reads only,
 * as a guest's (nothing marked read, settled or written). The whole ask is bounded (`FAR_READ_WAIT_MS`, the far
 * read's, git's wait for this project's remote included), so a machine asleep or slow never holds the agent: the
 * answer comes back with this computer's rows and one line naming that machine. Nothing of a far answer is kept, in
 * memory or on disk.
 *
 * A project is a folder on one computer; the same repository usually sits at another path on the other. The window
 * shows each machine's projects apart ("api · Mini"), so there is no shared project id to send. The ask names the
 * project by what both machines can tell: its git remote (`farRemoteKey`), else its folder's name (`FarProjectAsk`).
 * A remote git has not named yet is unknown, never "none": then nothing is matched by folder name (two different
 * repositories may share one). `scope: null` is every project there.
 */

import { isInboxId } from "@plannotator/core/inbox-types";
import type { InboxRepoCache } from "./inbox-repos";
import { machineNameWords, oneLine } from "./inbox-far-read";
import { FAR_READ_WAIT_MS } from "./inbox-machine-agent-read";
import { readCapped, type PeerLink } from "./inbox-peer-link";
import type { InboxAgentSearchRow } from "./inbox-mcp-search";
import type { InboxAgentThreadRow } from "./inbox-mcp";

/** The door's route names (inbox-devices.ts `DOOR_OWN_ROUTES`). */
export const AGENT_SEARCH_ROUTE = "agent-search";
export const AGENT_THREADS_ROUTE = "agent-threads";
/** The mark a machine's list carries when it answers both (`INBOX_LINKED_MARKS`). */
export const AGENT_SEARCH_MARK = "agent-search";

/** The most a far list or search answer may be. */
const FAR_FIND_MAX_BYTES = 4 * 1024 * 1024;
/** The most a far refusal's body may be. */
const FAR_REFUSAL_MAX_BYTES = 64 * 1024;
/** What the far door keeps of the bound for itself: its answer still has to come back. */
const FAR_FIND_MARGIN_MS = 300;
/** A search still being prepared there is asked again only while this much of the bound is left, at most this often. */
const FAR_FIND_RETRY_MIN_MS = 500;
const FAR_FIND_ASKS_MAX = 3;

/** A remote git has not named yet (this computer's or the other's): never matched by folder name. A key holds a `/`. */
export const FAR_REMOTE_UNKNOWN = "unknown";
/** A project's git remote as an ask carries it: its key (`farRemoteKey`), null for none, or `FAR_REMOTE_UNKNOWN`. */
export type FarRemote = string | null;

/** One project of the ask, as the other machine can match it: its folder's name, and its git remote. */
export interface FarProjectAsk {
  name: string;
  remote: FarRemote;
}

/** A search there: `scope` null for every project. */
export interface FarSearchAsk {
  q: string;
  limit: number;
  scope: FarProjectAsk[] | null;
}

/** A list there: every thread (no session of this computer sent in one there), open ones unless `include_resolved`. */
export interface FarThreadsAsk {
  limit: number;
  include_resolved: boolean;
  scope: FarProjectAsk[] | null;
}

/** A far search row: what a local one says, with its project and its rank there (comparable: the index's score). */
export type FarSearchRow = InboxAgentSearchRow & { project: string; score: number };
export interface FarSearchAnswer {
  total: number;
  results: FarSearchRow[];
}
/** A far list row: no `unread`, which there is read with no session, so it would not say what this agent has read. */
export type FarThreadRow = Omit<InboxAgentThreadRow, "unread"> & { project: string };
export interface FarThreadsAnswer {
  total: number;
  threads: FarThreadRow[];
}

/** Which computer a far row is on. */
export interface FarMachine {
  id: string;
  name: string;
}

/**
 * A machine that was not asked or did not answer, by why: older, away (asleep, offline, connecting, or no answer in
 * time), still preparing its search, or refused in its own words (`words`, cleaned).
 */
export interface FarNotAsked {
  kind: "older" | "away" | "preparing" | "refused";
  name: string;
  words?: string;
}

/** DRAFT words (the owner's to approve): a linked machine that a search or a list could not reach. */
export const FAR_FIND_WORDS = {
  searchAway: (name: string) => `Not searched: ${name}, which cannot be reached now (asleep, offline or still connecting).`,
  searchOlder: (name: string) => `Not searched: ${name}, whose Plannotator is too old to share threads with agents (ask the person to update it there).`,
  searchPreparing: (name: string) => `Not searched: ${name}, which is still preparing its search (try again in a moment).`,
  searchRefused: (name: string, words: string) => `Not searched: ${name}: ${words}`,
  listAway: (name: string) => `Not listed: ${name}, which cannot be reached now (asleep, offline or still connecting).`,
  listOlder: (name: string) => `Not listed: ${name}, whose Plannotator is too old to share threads with agents (ask the person to update it there).`,
  listRefused: (name: string, words: string) => `Not listed: ${name}: ${words}`,
} as const;

/** The lines a search or a list adds for the machines it could not reach, one each. */
export function farNotAskedLines(notAsked: readonly FarNotAsked[], what: "search" | "list"): string[] {
  const W = FAR_FIND_WORDS;
  return notAsked.map((n) => {
    if (n.kind === "older") return what === "search" ? W.searchOlder(n.name) : W.listOlder(n.name);
    if (n.kind === "refused" && n.words) return what === "search" ? W.searchRefused(n.name, n.words) : W.listRefused(n.name, n.words);
    if (n.kind === "preparing" && what === "search") return W.searchPreparing(n.name);
    return what === "search" ? W.searchAway(n.name) : W.listAway(n.name);
  });
}

export function farScopeQuery(query: URLSearchParams, scope: FarProjectAsk[] | null): void {
  if (scope === null) query.set("all", "1");
  else query.set("scope", JSON.stringify(scope.map(({ name, remote }) => ({ name, remote }))));
}

/**
 * The ask's scope as the door reads it: null for every project; a scope that does not read is empty (matches
 * nothing). A remote that is not a key (no `/`) or `null` reads as unknown.
 */
export function farScopeFromQuery(query: URLSearchParams): FarProjectAsk[] | null {
  if (query.get("all") === "1") return null;
  try {
    const value = JSON.parse(query.get("scope") ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).flatMap((p: { name?: unknown; remote?: unknown }) =>
      p && typeof p.name === "string"
        ? [{ name: p.name.slice(0, 200), remote: p.remote === null ? null : typeof p.remote === "string" && p.remote.includes("/") ? p.remote.slice(0, 400).toLowerCase() : FAR_REMOTE_UNKNOWN }]
        : [],
    );
  } catch {
    return [];
  }
}

/** A remote key's repository path (`owner/repo`, a group's subgroups too), its host left out. */
const remotePath = (key: string): string => key.slice(key.indexOf("/") + 1);

/**
 * Whether a project on the answering machine is the one asked for: the same repository when both know their remote
 * (`owner/repo`, whatever host or SSH alias each names), else the same folder name (case aside) when either has none.
 * Two different repositories never match, and while either remote is unknown nothing matches.
 */
export function farProjectMatches(asked: readonly FarProjectAsk[], project: { name: string; remote: FarRemote }): boolean {
  const name = project.name.toLowerCase();
  return asked.some((a) => {
    if (a.remote === FAR_REMOTE_UNKNOWN || project.remote === FAR_REMOTE_UNKNOWN) return false;
    if (a.remote !== null && project.remote !== null) return remotePath(a.remote) === remotePath(project.remote);
    return a.name.toLowerCase() === name;
  });
}

/**
 * A repository's remote as both machines write it: `host/owner/repo`, lower case, no `.git`, no port, and never a
 * user or a token (nothing up to an `@`). The host is kept for reading; matching compares `owner/repo` only.
 */
export function farRemoteKey(repo: { display: string; host: string | null } | null): string | null {
  if (!repo) return null;
  const path = repo.display
    .slice(repo.display.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (!path) return null;
  const host = (repo.host ?? "").slice((repo.host ?? "").lastIndexOf("@") + 1).toLowerCase().replace(/:\d*$/, "").replace(/\//g, "");
  return `${host}/${path}`;
}

/**
 * A project root's remote from the repo cache (inbox-repos.ts): at once when a read has landed, else a read now for at
 * most `waitMs`. Past that it is unknown (the read goes on and fills the cache), never "none".
 */
export async function farRemoteOf(repos: Pick<InboxRepoCache, "known" | "get" | "refresh">, root: string, waitMs: number): Promise<FarRemote> {
  if (repos.known(root)) return farRemoteKey(repos.get(root));
  const read = repos.refresh(root).then((repo) => ({ repo }));
  const answer = await within(read, waitMs);
  return answer === null ? FAR_REMOTE_UNKNOWN : farRemoteKey(answer.repo);
}

/** A promise's value, or null when it has not settled within `waitMs` (or failed). */
export async function within<T>(promise: Promise<T> | undefined, waitMs: number): Promise<T | null> {
  if (!promise) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, waitMs))));
  try {
    return await Promise.race([promise.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A count a far machine sent: a non-negative safe integer, else 0. */
export const count = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

type Outcome<T> = { kind: "found"; peer: PeerLink; answer: T } | FarNotAsked;

export interface MachineAgentFindDeps {
  peers: () => Iterable<PeerLink>;
  nameOf: (id: string) => string;
  waitMs?: number;
}

/** What each machine answered, and which could not be asked. */
export interface FarFound<T> {
  answers: { machine: FarMachine; answer: T }[];
  notAsked: FarNotAsked[];
}

const isTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** A far search answer that reads as one: rows with message ids and a number rank, else null. */
function searchAnswerOf(value: unknown): FarSearchAnswer | null {
  const answer = value as Partial<FarSearchAnswer> | null;
  if (!answer || typeof answer.total !== "number" || !Array.isArray(answer.results)) return null;
  const results = answer.results.filter((r) => r && isInboxId("msg", r.thread_id) && isInboxId("msg", r.message_id) && typeof r.score === "number" && Number.isFinite(r.score) && isTime(r.at));
  return { total: Math.max(count(answer.total), results.length), results };
}

/** A far list answer that reads as one. */
function threadsAnswerOf(value: unknown): FarThreadsAnswer | null {
  const answer = value as Partial<FarThreadsAnswer> | null;
  if (!answer || typeof answer.total !== "number" || !Array.isArray(answer.threads)) return null;
  const threads = answer.threads.filter((t) => t && isInboxId("msg", t.thread_id) && isTime(t.last_at) && t.questions && typeof t.questions === "object");
  return { total: Math.max(count(answer.total), threads.length), threads };
}

/** A refusal's code and words as the far door wrote them (`{ code, error }`), else null: a proxy's page, or nothing. */
async function refusalOf(response: Response): Promise<{ code: string; words: string } | null> {
  try {
    const text = await readCapped(response, FAR_REFUSAL_MAX_BYTES);
    const body = text === null ? null : (JSON.parse(text) as { code?: unknown; error?: unknown });
    const words = body && typeof body.error === "string" ? oneLine(body.error).slice(0, 300) : "";
    return body && typeof body.code === "string" && words ? { code: body.code, words } : null;
  } catch {
    return null;
  }
}

export function createMachineAgentFind(deps: MachineAgentFindDeps) {
  const waitMs = deps.waitMs ?? FAR_READ_WAIT_MS;
  const nameOf = (peer: PeerLink) => machineNameWords(deps.nameOf(peer.id));
  const linked = () => [...deps.peers()].filter((peer) => peer.state !== "revoked");
  /** Why a machine cannot be asked now, or null when it can. */
  const blocked = (peer: PeerLink): FarNotAsked["kind"] | null => {
    if (peer.state === "needs_update" || (peer.list && !peer.list.marks.includes(AGENT_SEARCH_MARK))) return "older";
    if (peer.state !== "online") return "away";
    return null;
  };

  const ask = async <T>(peer: PeerLink, route: string, query: string, read: (value: unknown) => T | null, by: number): Promise<Outcome<T>> => {
    const name = nameOf(peer);
    const stop = blocked(peer);
    if (stop) return { kind: stop, name };
    for (let asks = 1; ; asks++) {
      const left = by - Date.now();
      if (left <= 0) return { kind: "away", name };
      try {
        // The signal bounds the body too: a far side that sends its headers and then stalls never holds the agent.
        // A search says how long its door may wait for its index, so a "still preparing" comes back inside the bound.
        const search = route === AGENT_SEARCH_ROUTE ? `${query}&wait_ms=${Math.max(0, left - FAR_FIND_MARGIN_MS)}` : query;
        const response = await peer.request(route, search, { method: "GET", headers: {}, signal: AbortSignal.timeout(left), timeoutMs: left });
        if (response.status === 404) {
          void response.body?.cancel().catch(() => {});
          return { kind: "older", name };
        }
        if (!response.ok) {
          // Its token refused, or a proxy's answer for an Inbox that is down: not reached. Else it answered, in its words.
          if (response.status === 401 || response.status === 502 || response.status === 504) {
            void response.body?.cancel().catch(() => {});
            return { kind: "away", name };
          }
          const refusal = await refusalOf(response);
          if (!refusal) return { kind: "away", name };
          if (route === AGENT_SEARCH_ROUTE && response.status === 503 && refusal.code === "search_indexing") {
            if (asks < FAR_FIND_ASKS_MAX && by - Date.now() > FAR_FIND_RETRY_MIN_MS) continue;
            return { kind: "preparing", name };
          }
          return { kind: "refused", name, words: refusal.words };
        }
        const text = await readCapped(response, FAR_FIND_MAX_BYTES);
        const answer = text === null ? null : read(JSON.parse(text));
        return answer ? { kind: "found", peer, answer } : { kind: "away", name };
      } catch {
        return { kind: "away", name };
      }
    }
  };

  const everyMachine = async <T>(route: string, query: string, read: (value: unknown) => T | null, by: number): Promise<FarFound<T>> => {
    const outcomes = await Promise.all(linked().map((peer) => ask(peer, route, query, read, by)));
    const answers: FarFound<T>["answers"] = [];
    const notAsked: FarNotAsked[] = [];
    for (const o of outcomes) {
      if (o.kind === "found") answers.push({ machine: { id: o.peer.id, name: nameOf(o.peer) }, answer: o.answer });
      else notAsked.push(o);
    }
    return { answers, notAsked };
  };

  /** `search` on every linked machine at once, answered by `by` (default: the bound from now). */
  const search = (asked: FarSearchAsk, by = Date.now() + waitMs): Promise<FarFound<FarSearchAnswer>> => {
    const query = new URLSearchParams({ q: asked.q, limit: String(asked.limit) });
    farScopeQuery(query, asked.scope);
    return everyMachine(AGENT_SEARCH_ROUTE, `?${query}`, searchAnswerOf, by);
  };

  /** read_thread's list on every linked machine at once, answered by `by`. */
  const threads = (asked: FarThreadsAsk, by = Date.now() + waitMs): Promise<FarFound<FarThreadsAnswer>> => {
    const query = new URLSearchParams({ limit: String(asked.limit) });
    if (asked.include_resolved) query.set("include_resolved", "1");
    farScopeQuery(query, asked.scope);
    return everyMachine(AGENT_THREADS_ROUTE, `?${query}`, threadsAnswerOf, by);
  };

  /** Whether any machine is linked (no machine: the tools answer exactly as before). */
  const any = (): boolean => linked().length > 0;
  /** Whether any linked machine can be asked now (online and taking the mark): else no scope is worth building. */
  const askable = (): boolean => linked().some((peer) => blocked(peer) === null);

  return { search, threads, any, askable, waitMs };
}

export type MachineAgentFind = ReturnType<typeof createMachineAgentFind>;
