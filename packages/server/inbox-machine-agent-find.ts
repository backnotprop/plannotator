/**
 * An agent on this computer finds threads on the linked machines (the owner, 2026-11-21: "An agent should be able to
 * read any thread across any computer if they're already connected"): its `search` and read_thread's list ask every
 * linked machine at once, beside this Inbox's own answer. Reading a thread by id is inbox-machine-agent-read.ts.
 *
 * The other machine answers two door routes only a linked machine's token reaches (`DOOR_OWN_ROUTES` in
 * inbox-devices.ts, mark `agent-search`; inbox-far-find.ts): `GET agent-search` and `GET agent-threads`, reads only,
 * as a guest's (nothing marked read, settled or written). Each ask is bounded (`FAR_READ_WAIT_MS`, the far read's), so
 * a machine asleep or slow never holds the agent: the answer comes back with this computer's rows and one line naming
 * that machine. Nothing of a far answer is kept, in memory or on disk.
 *
 * A project is a folder on one computer; the same repository usually sits at another path on the other. The window
 * shows each machine's projects apart ("api · Mini"), so there is no shared project id to send. The ask names the
 * project by what both machines can tell: its git remote (host and path, `projectRemoteKey`), else its folder's name
 * (`FarProjectAsk`). `scope: null` is every project there.
 */

import { isInboxId } from "@plannotator/core/inbox-types";
import { machineNameWords } from "./inbox-far-read";
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

/** One project of the ask, as the other machine can match it: its folder's name, and its git remote when known. */
export interface FarProjectAsk {
  name: string;
  /** `host/owner/repo`, lower case (`projectRemoteKey`); null when this computer knows none. */
  remote: string | null;
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
export type FarThreadRow = InboxAgentThreadRow & { project: string };
export interface FarThreadsAnswer {
  total: number;
  threads: FarThreadRow[];
}

/** Which computer a far row is on. */
export interface FarMachine {
  id: string;
  name: string;
}

/** A machine that was not asked or did not answer, by why. */
export interface FarNotAsked {
  kind: "older" | "away";
  name: string;
}

/** DRAFT words (the owner's to approve): a linked machine that a search or a list could not reach. */
export const FAR_FIND_WORDS = {
  searchAway: (name: string) => `Not searched: ${name}, which cannot be reached now (asleep, offline or still connecting).`,
  searchOlder: (name: string) => `Not searched: ${name}, whose Plannotator is too old to share threads with agents (ask the person to update it there).`,
  listAway: (name: string) => `Not listed: ${name}, which cannot be reached now (asleep, offline or still connecting).`,
  listOlder: (name: string) => `Not listed: ${name}, whose Plannotator is too old to share threads with agents (ask the person to update it there).`,
} as const;

/** The lines a search or a list adds for the machines it could not reach, one each. */
export function farNotAskedLines(notAsked: readonly FarNotAsked[], what: "search" | "list"): string[] {
  return notAsked.map((n) =>
    what === "search" ? (n.kind === "older" ? FAR_FIND_WORDS.searchOlder(n.name) : FAR_FIND_WORDS.searchAway(n.name)) : n.kind === "older" ? FAR_FIND_WORDS.listOlder(n.name) : FAR_FIND_WORDS.listAway(n.name),
  );
}

export function farScopeQuery(query: URLSearchParams, scope: FarProjectAsk[] | null): void {
  if (scope === null) query.set("all", "1");
  else query.set("scope", JSON.stringify(scope.map(({ name, remote }) => ({ name, remote }))));
}

/** The ask's scope as the door reads it: null for every project; a scope that does not read is empty (matches nothing). */
export function farScopeOf(query: URLSearchParams): FarProjectAsk[] | null {
  if (query.get("all") === "1") return null;
  try {
    const value = JSON.parse(query.get("scope") ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).flatMap((p: { name?: unknown; remote?: unknown }) =>
      p && typeof p.name === "string" ? [{ name: p.name.slice(0, 200), remote: typeof p.remote === "string" && p.remote ? p.remote.slice(0, 400) : null }] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Whether a project on the answering machine is the one asked for: the same git remote when both know theirs, else
 * the same folder name (case aside). Two different remotes never match, whatever the folders are called.
 */
export function farProjectMatches(asked: readonly FarProjectAsk[], project: { name: string; remote: string | null }): boolean {
  const name = project.name.toLowerCase();
  return asked.some((a) => (a.remote && project.remote ? a.remote === project.remote : a.name.toLowerCase() === name));
}

/** A repository's remote as both machines write it: `host/path`, lower case, no `.git`. */
export const farRemoteKey = (repo: { display: string; host: string | null } | null): string | null =>
  repo ? `${(repo.host ?? "").toLowerCase()}/${repo.display.toLowerCase().replace(/\.git$/, "")}` : null;

type Outcome<T> = { kind: "found"; peer: PeerLink; answer: T } | FarNotAsked | { kind: "missing" };

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
  return { total: Math.max(answer.total, results.length), results };
}

/** A far list answer that reads as one. */
function threadsAnswerOf(value: unknown): FarThreadsAnswer | null {
  const answer = value as Partial<FarThreadsAnswer> | null;
  if (!answer || typeof answer.total !== "number" || !Array.isArray(answer.threads)) return null;
  const threads = answer.threads.filter((t) => t && isInboxId("msg", t.thread_id) && isTime(t.last_at) && t.questions && typeof t.questions === "object");
  return { total: Math.max(answer.total, threads.length), threads };
}

export function createMachineAgentFind(deps: MachineAgentFindDeps) {
  const waitMs = deps.waitMs ?? FAR_READ_WAIT_MS;
  const nameOf = (peer: PeerLink) => machineNameWords(deps.nameOf(peer.id));

  const ask = async <T>(peer: PeerLink, route: string, query: string, read: (value: unknown) => T | null): Promise<Outcome<T>> => {
    const name = nameOf(peer);
    if (peer.state === "needs_update" || (peer.list && !peer.list.marks.includes(AGENT_SEARCH_MARK))) return { kind: "older", name };
    if (peer.state !== "online") return { kind: "away", name };
    try {
      // The signal bounds the body too: a far side that sends its headers and then stalls never holds the agent.
      const signal = AbortSignal.timeout(waitMs);
      const response = await peer.request(route, query, { method: "GET", headers: {}, signal, timeoutMs: waitMs });
      if (response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return { kind: "older", name };
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return { kind: "away", name };
      }
      const text = await readCapped(response, FAR_FIND_MAX_BYTES);
      const answer = text === null ? null : read(JSON.parse(text));
      return answer ? { kind: "found", peer, answer } : { kind: "away", name };
    } catch {
      return { kind: "away", name };
    }
  };

  const everyMachine = async <T>(route: string, query: string, read: (value: unknown) => T | null): Promise<FarFound<T>> => {
    const peers = [...deps.peers()].filter((peer) => peer.state !== "revoked");
    const outcomes = await Promise.all(peers.map((peer) => ask(peer, route, query, read)));
    const answers: FarFound<T>["answers"] = [];
    const notAsked: FarNotAsked[] = [];
    for (const o of outcomes) {
      if (o.kind === "found") answers.push({ machine: { id: o.peer.id, name: nameOf(o.peer) }, answer: o.answer });
      else if (o.kind === "older" || o.kind === "away") notAsked.push({ kind: o.kind, name: o.name });
    }
    return { answers, notAsked };
  };

  /** `search` on every linked machine at once. */
  const search = (asked: FarSearchAsk): Promise<FarFound<FarSearchAnswer>> => {
    const query = new URLSearchParams({ q: asked.q, limit: String(asked.limit) });
    farScopeQuery(query, asked.scope);
    return everyMachine(AGENT_SEARCH_ROUTE, `?${query}`, searchAnswerOf);
  };

  /** read_thread's list on every linked machine at once. */
  const threads = (asked: FarThreadsAsk): Promise<FarFound<FarThreadsAnswer>> => {
    const query = new URLSearchParams({ limit: String(asked.limit) });
    if (asked.include_resolved) query.set("include_resolved", "1");
    farScopeQuery(query, asked.scope);
    return everyMachine(AGENT_THREADS_ROUTE, `?${query}`, threadsAnswerOf);
  };

  /** Whether any machine is linked (no machine: the tools answer exactly as before). */
  const any = (): boolean => [...deps.peers()].some((peer) => peer.state !== "revoked");

  return { search, threads, any };
}

export type MachineAgentFind = ReturnType<typeof createMachineAgentFind>;
