/**
 * The Board's lane marks (owner, 2026-10-26: "a symbol or something to
 * indicate merged vs unmerged"): the state of the one link each lane card
 * marks (`inboxCardMarkRef`: its latest PR, else its latest issue), read for
 * the cards on screen while the Board page is open. Display only: a link's
 * state never moves a card.
 *
 * Kept cheap and safe:
 * - GitHub: one `gh api graphql` query per repository for all its links on
 *   screen (aliases `n<number>: issueOrPullRequest(number: <number>)`, at most
 *   `CARD_MARKS_BATCH` a query), asking only the state and title, never the
 *   hover card's whole body. `--hostname` is always named, and a host other
 *   than github.com is asked only when this computer's own gh is signed in to
 *   it (#2187's rule), so a link cannot send a token anywhere else. The query
 *   is a `query` (refused to load otherwise) and the numbers in it are whole
 *   numbers the URL parser read.
 * - GitLab: #2187's hover-card lookup (`RefCards`), with its own concurrency
 *   cap, rate-limit hold and cache. Bitbucket and any other source: no reader
 *   yet, `unknown`.
 * - Cache, per link: an answer is fresh for `CARD_MARK_FRESH_MS`, a failure
 *   for `CARD_MARK_FAILURE_MS`; a request with `refresh` (the window got its
 *   focus back) reads again what is older than `CARD_MARK_REFRESH_MS`. One
 *   query per batch at a time (requests that overlap share it), at most
 *   `CARD_MARKS_MAX_CONCURRENT` gh at once, and a rate-limit answer holds a
 *   host for `REF_RATE_LIMIT_MS`.
 * - Anything that cannot be read is `unknown`: the window draws a quiet
 *   neutral mark, never an error.
 *
 * The route (`POST /api/inbox/cards/marks`) answers only this computer's
 * window while the Board is on: never through the tailnet, never on the
 * phone's door.
 */

import { forgeRefKey, parseForgeRefUrl, type ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import type { InboxCardMark, InboxCardMarkState, InboxCardRef } from "@plannotator/core/inbox-types";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCards, type RefRunner } from "./ref-cards";

export const CARD_MARK_FRESH_MS = 5 * 60_000;
export const CARD_MARK_FAILURE_MS = 60_000;
export const CARD_MARK_REFRESH_MS = 30_000;
export const CARD_MARKS_BATCH = 50;
export const CARD_MARKS_MAX_CONCURRENT = 2;

/** The batch query for one repository's links: the state and title of each, nothing else. */
export function githubMarksQuery(numbers: readonly number[]): string {
  const items = numbers
    .map((n) => {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("card marks: a link number is a whole number");
      return `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { state isDraft title } ... on Issue { state stateReason title } }`;
    })
    .join("\n    ");
  return `query CardMarks($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n    ${items}\n  }\n}`;
}
if (!/^query\b/.test(githubMarksQuery([1]))) throw new Error("card marks: the query must be a query");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** One GitHub item's mark state, from the batch answer's node. */
export function githubMarkState(node: unknown): { state: InboxCardMarkState; title: string | null } {
  const n = obj(node);
  const title = typeof n.title === "string" ? n.title : null;
  if (n.__typename === "PullRequest") {
    if (n.state === "MERGED") return { state: "merged", title };
    if (n.state === "CLOSED") return { state: "closed", title };
    if (n.state === "OPEN") return { state: n.isDraft === true ? "draft" : "open", title };
  }
  if (n.__typename === "Issue") {
    if (n.state === "OPEN") return { state: "open", title };
    if (n.state === "CLOSED") return { state: n.stateReason === "NOT_PLANNED" ? "not_planned" : "completed", title };
  }
  return { state: "unknown", title: null };
}

/** The hover card's state as a mark (GitLab): the same words. */
function cardDataMark(data: ForgeRefCardData): { state: InboxCardMarkState; title: string | null } {
  return { state: data.state, title: data.title };
}

interface Cached {
  state: InboxCardMarkState;
  title: string | null;
  at: number;
}

export interface CardMarks {
  /** Each link's mark, keyed by the link's URL. Never throws. */
  marks(refs: readonly InboxCardRef[], options?: { refresh?: boolean }): Promise<Map<string, InboxCardMark>>;
}

export function createCardMarks(options: { run?: RefRunner; now?: () => number; refCards?: RefCards } = {}): CardMarks {
  const run = options.run ?? refCliRunner;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<void>>();
  const holdUntil = new Map<string, number>();
  let hosts: { at: number; ttl: number; set: Promise<Set<string>> } | null = null;
  let running = 0;
  const waiting: (() => void)[] = [];

  const slot = async <T>(job: () => Promise<T>): Promise<T> => {
    if (running >= CARD_MARKS_MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };

  const signedIn = (): Promise<Set<string>> => {
    if (hosts && now() - hosts.at < hosts.ttl) return hosts.set;
    const set = readSignedInHosts(run, "gh").catch(() => new Set<string>());
    const entry = { at: now(), ttl: REF_AUTH_HOSTS_MS, set };
    hosts = entry;
    void set.then((found) => {
      if (found.size === 0) entry.ttl = REF_FAILURE_MS;
    });
    return set;
  };

  const usable = (hit: Cached | undefined, refresh: boolean): boolean => {
    if (!hit) return false;
    const age = now() - hit.at;
    if (hit.state === "unknown") return age < CARD_MARK_FAILURE_MS;
    return age < (refresh ? CARD_MARK_REFRESH_MS : CARD_MARK_FRESH_MS);
  };

  const setAll = (keys: readonly string[], state: InboxCardMarkState) => {
    for (const key of keys) cache.set(key, { state, title: cache.get(key)?.title ?? null, at: now() });
  };

  /** One repository's links, one query. */
  const readGithub = (host: string, owner: string, repo: string, items: readonly { key: string; number: number }[]): Promise<void> => {
    const batchKey = `${host}/${owner}/${repo}`.toLowerCase() + "#" + items.map((i) => i.number).sort((a, b) => a - b).join(",");
    const inFlight = pending.get(batchKey);
    if (inFlight) return inFlight;
    const keys = items.map((i) => i.key);
    const job = slot(async () => {
      if (now() < (holdUntil.get(host) ?? 0)) return setAll(keys, "unknown");
      if (host !== "github.com" && !(await signedIn()).has(host)) return setAll(keys, "unknown");
      const numbers = [...new Set(items.map((i) => i.number))];
      const result = await run("gh", ["api", "graphql", "--hostname", host, "-f", `query=${githubMarksQuery(numbers)}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`]);
      let repository: Json | null = null;
      try {
        const parsed = obj(JSON.parse(result.stdout));
        const r = obj(parsed.data).repository;
        repository = r && typeof r === "object" ? (r as Json) : null;
      } catch {
        repository = null;
      }
      if (!repository) {
        // No data at all: a refused repo, a rate limit, no gh. Every link of the batch is unknown for a while.
        if (refErrorOf("gh", { ...result, exitCode: result.exitCode || 1 }) === "rate_limited") holdUntil.set(host, now() + REF_RATE_LIMIT_MS);
        return setAll(keys, "unknown");
      }
      // A partial answer (one number not found) still carries the others.
      for (const item of items) {
        const mark = githubMarkState(repository[`n${item.number}`]);
        cache.set(item.key, { ...mark, at: now() });
      }
    })
      .catch(() => setAll(keys, "unknown"))
      .finally(() => pending.delete(batchKey));
    pending.set(batchKey, job);
    return job;
  };

  const readOther = async (key: string, ref: InboxCardRef): Promise<void> => {
    const result = options.refCards ? await options.refCards.get(ref.url).catch(() => null) : null;
    const mark = result?.ok ? cardDataMark(result.data) : { state: "unknown" as const, title: null };
    cache.set(key, { ...mark, at: now() });
  };

  return {
    async marks(refs, { refresh = false } = {}) {
      const keyed = refs.map((ref) => {
        const forge = parseForgeRefUrl(ref.url);
        return { ref, forge, key: forge ? forgeRefKey(forge) : `url:${ref.url}` };
      });
      const githubBatches = new Map<string, { host: string; owner: string; repo: string; items: { key: string; number: number }[] }>();
      const others: Promise<void>[] = [];
      const seen = new Set<string>();
      for (const { ref, forge, key } of keyed) {
        if (seen.has(key) || usable(cache.get(key), refresh)) continue;
        seen.add(key);
        if (forge?.platform === "github" && ref.source === "github") {
          const repoKey = `${forge.host}/${forge.owner}/${forge.repo}`.toLowerCase();
          const batch = githubBatches.get(repoKey) ?? { host: forge.host, owner: forge.owner, repo: forge.repo, items: [] };
          batch.items.push({ key, number: forge.number });
          githubBatches.set(repoKey, batch);
        } else if (forge?.platform === "gitlab") {
          others.push(readOther(key, ref));
        } else {
          cache.set(key, { state: "unknown", title: null, at: now() });
        }
      }
      const jobs: Promise<void>[] = [...others];
      for (const batch of githubBatches.values()) {
        for (let i = 0; i < batch.items.length; i += CARD_MARKS_BATCH) jobs.push(readGithub(batch.host, batch.owner, batch.repo, batch.items.slice(i, i + CARD_MARKS_BATCH)));
      }
      await Promise.all(jobs);
      const out = new Map<string, InboxCardMark>();
      for (const { ref, key } of keyed) {
        const hit = cache.get(key);
        out.set(ref.url, { kind: ref.kind === "issue" ? "issue" : "pr", ref: ref.ref, url: ref.url, state: hit?.state ?? "unknown", title: hit?.title ?? null });
      }
      return out;
    },
  };
}

