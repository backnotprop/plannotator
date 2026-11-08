/**
 * A thread's PRs on the Inbox server (approval "inbox-pr-binding",
 * 2026-11-08): the state reader that keeps each coupled PR's state current,
 * and the window's read and edit.
 *
 *   GET  /api/inbox/threads/:id/pulls → { serverSession, pulls, groups, removed }
 *   POST /api/inbox/threads/:id/pulls { add?, remove?, serverSession } → the same, after the person's change
 *
 * The state reader, kept cheap and safe like the Board's lane marks
 * (inbox-card-marks.ts), whose rules it follows:
 * - GitHub: one `gh api graphql` query per repository for all its coupled
 *   PRs being read (aliases `n<number>: pullRequest(number: <number>)`), asking
 *   for the state, title, base and head (stacks are found from those), the
 *   review decision and the head commit's checks. `--hostname` is always
 *   named, and a host other than github.com is asked only when this
 *   computer's own gh is signed in to it (#2187's rule).
 * - GitLab: the hover cards' lookup (`RefCards`), with its own cap, cache and
 *   rate-limit hold.
 * - Only PRs still in play (open, a draft, or not read yet) are read: merged
 *   and closed are final. Only on view: when the window lists threads (the
 *   threads not archived) and when it reads one thread's PRs.
 * - Cache per PR: an answer is fresh for 5 min, a failure for 1 min, and the
 *   window's read of one thread (it opened, or got its focus back) reads what
 *   is older than 30 s. At most 2 forge calls at once, one query per batch at
 *   a time, and a rate-limit answer holds that host.
 * - A changed state, title or branch is written on the coupling (the store's
 *   `setThreadPullState`), so rows paint without a forge call and phones and
 *   the device door see it. Checks and the review verdict are kept here only.
 * - No gh or glab, signed out, or a failure: nothing is written, the PR keeps
 *   its last state (`unknown` until a first answer), and nothing nags.
 */

import { forgeRefKey, parseForgeRefUrl, type ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import {
  inboxThreadPullGroups,
  inboxThreadPullWire,
  INBOX_THREAD_PULLS_REMOVED_MS,
  parseInboxThreadPullRefs,
  type InboxThreadPull,
  type InboxThreadPullChecks,
  type InboxThreadPullReview,
  type InboxThreadPullsAnswer,
  type InboxThreadPullState,
} from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { CARD_MARK_FAILURE_MS, CARD_MARK_FRESH_MS, CARD_MARK_REFRESH_MS, CARD_MARKS_BATCH, CARD_MARKS_MAX_CONCURRENT } from "./inbox-card-marks";
import { REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCards, type RefRunner } from "./ref-cards";

/** What the reader learns about one PR. */
export interface ThreadPullRead {
  state: InboxThreadPullState;
  title: string | null;
  base: string | null;
  head: string | null;
  checks: InboxThreadPullChecks | null;
  review: InboxThreadPullReview | null;
}

/** The batch query for one repository's coupled PRs: what the mark, the stacks and the popover need, nothing else. */
export function githubThreadPullsQuery(numbers: readonly number[]): string {
  const items = numbers
    .map((n) => {
      if (!Number.isSafeInteger(n) || n < 1) throw new Error("thread pulls: a PR number is a whole number");
      return `n${n}: pullRequest(number: ${n}) { state isDraft title baseRefName headRefName reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
    })
    .join("\n    ");
  return `query ThreadPulls($owner: String!, $repo: String!) {\n  repository(owner: $owner, name: $repo) {\n    ${items}\n  }\n}`;
}
if (!/^query\b/.test(githubThreadPullsQuery([1]))) throw new Error("thread pulls: the query must be a query");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** One PR from the batch answer's node; null when the node is not a PR the answer describes. */
export function githubThreadPullRead(node: unknown): ThreadPullRead | null {
  const n = obj(node);
  const state: InboxThreadPullState | null = n.state === "MERGED" ? "merged" : n.state === "CLOSED" ? "closed" : n.state === "OPEN" ? (n.isDraft === true ? "draft" : "open") : null;
  if (!state) return null;
  const rollup = obj(obj(obj(obj((obj(n.commits).nodes as unknown[] | undefined)?.[0]).commit).statusCheckRollup)).state;
  const checks: InboxThreadPullChecks | null =
    rollup === "SUCCESS" ? "passing" : rollup === "FAILURE" || rollup === "ERROR" ? "failing" : rollup === "PENDING" || rollup === "EXPECTED" ? "running" : null;
  const review: InboxThreadPullReview | null =
    n.reviewDecision === "APPROVED" ? "approved" : n.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : n.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null;
  return { state, title: str(n.title), base: str(n.baseRefName), head: str(n.headRefName), checks, review };
}

/** The hover card's data as a read (GitLab). */
export function cardDataThreadPullRead(data: ForgeRefCardData): ThreadPullRead | null {
  if (data.kind !== "pull") return null;
  const state: InboxThreadPullState | null = data.state === "open" || data.state === "draft" || data.state === "merged" || data.state === "closed" ? data.state : null;
  if (!state) return null;
  const checks = data.pull?.checks?.state;
  return {
    state,
    title: data.title || null,
    base: data.pull?.base || null,
    head: data.pull?.head || null,
    checks: checks === "success" ? "passing" : checks === "failure" ? "failing" : checks === "pending" ? "running" : null,
    review: data.pull?.review ?? null,
  };
}

/**
 * A sandboxed test's stand-in for the forges (PLANNOTATOR_TEST_FORGE_STATES):
 * each PR's read by its key or by how an agent writes it. Nothing runs.
 */
export type ThreadPullFixture = Readonly<Record<string, Partial<ThreadPullRead>>>;

export interface ThreadPullStates {
  /** What the reader knows now about a PR beyond the stored state (checks, review), or undefined. */
  live(key: string): { checks: InboxThreadPullChecks | null; review: InboxThreadPullReview | null } | undefined;
  /**
   * Read the PRs still in play among `pulls` whose answer is not fresh, and
   * write each change on every thread that holds that PR. `refresh`: a read
   * older than 30 s counts as stale (a thread opened, the window's focus).
   * Never throws.
   */
  refresh(pulls: readonly InboxThreadPull[], options?: { refresh?: boolean }): Promise<void>;
}

interface Cached {
  read: ThreadPullRead | null;
  at: number;
}

export function createThreadPullStates(options: { store: InboxStore; run?: RefRunner; refCards?: RefCards; now?: () => number; fixture?: (() => ThreadPullFixture | null) | null }): ThreadPullStates {
  const { store } = options;
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

  const fresh = (hit: Cached | undefined, refresh: boolean): boolean => {
    if (!hit) return false;
    const age = now() - hit.at;
    if (!hit.read) return age < CARD_MARK_FAILURE_MS;
    return age < (refresh ? CARD_MARK_REFRESH_MS : CARD_MARK_FRESH_MS);
  };

  /** One answer kept, and written on every live coupling of that PR. */
  const land = (key: string, read: ThreadPullRead | null) => {
    cache.set(key, { read, at: now() });
    if (!read) return;
    for (const pull of store.allThreadPulls()) {
      if (pull.pull !== key) continue;
      try {
        store.setThreadPullState(pull.thread_id, key, read);
      } catch {
        // A write that fails leaves the last state; the next read tries again.
      }
    }
  };

  const readGithub = (host: string, owner: string, repo: string, items: readonly { key: string; number: number }[]): Promise<void> => {
    const batchKey = `${host}/${owner}/${repo}`.toLowerCase() + "#" + items.map((i) => i.number).sort((a, b) => a - b).join(",");
    const inFlight = pending.get(batchKey);
    if (inFlight) return inFlight;
    const failAll = () => {
      for (const item of items) land(item.key, null);
    };
    const job = slot(async () => {
      if (now() < (holdUntil.get(host) ?? 0)) return failAll();
      if (host !== "github.com" && !(await signedIn()).has(host)) return failAll();
      const numbers = [...new Set(items.map((i) => i.number))];
      const result = await run("gh", ["api", "graphql", "--hostname", host, "-f", `query=${githubThreadPullsQuery(numbers)}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`]);
      let repository: Json | null = null;
      try {
        const r = obj(obj(JSON.parse(result.stdout)).data).repository;
        repository = r && typeof r === "object" ? (r as Json) : null;
      } catch {
        repository = null;
      }
      if (!repository) {
        if (refErrorOf("gh", { ...result, exitCode: result.exitCode || 1 }) === "rate_limited") holdUntil.set(host, now() + REF_RATE_LIMIT_MS);
        return failAll();
      }
      // A partial answer (one number not a PR) still carries the others.
      for (const item of items) land(item.key, githubThreadPullRead(repository[`n${item.number}`]));
    })
      .catch(failAll)
      .finally(() => pending.delete(batchKey));
    pending.set(batchKey, job);
    return job;
  };

  const readGitlab = async (key: string, url: string): Promise<void> => {
    const result = options.refCards ? await options.refCards.get(url).catch(() => null) : null;
    land(key, result?.ok ? cardDataThreadPullRead(result.data) : null);
  };

  const readFixture = (fixture: ThreadPullFixture, pull: InboxThreadPull): void => {
    const ref = parseForgeRefUrl(pull.url);
    const named = fixture[pull.pull] ?? (ref ? fixture[`${ref.owner}/${ref.repo}${ref.platform === "gitlab" ? "!" : "#"}${ref.number}`] : undefined) ?? fixture[pull.url];
    land(
      pull.pull,
      named?.state
        ? { state: named.state, title: named.title ?? null, base: named.base ?? null, head: named.head ?? null, checks: named.checks ?? null, review: named.review ?? null }
        : null,
    );
  };

  return {
    live(key) {
      const read = cache.get(key)?.read;
      return read ? { checks: read.checks, review: read.review } : undefined;
    },
    async refresh(pulls, { refresh = false } = {}) {
      const githubBatches = new Map<string, { host: string; owner: string; repo: string; items: { key: string; number: number }[] }>();
      const jobs: Promise<void>[] = [];
      const seen = new Set<string>();
      const fixture = options.fixture?.() ?? null;
      for (const pull of pulls) {
        // Merged and closed are final: never read again.
        if (pull.state === "merged" || pull.state === "closed") continue;
        if (seen.has(pull.pull) || fresh(cache.get(pull.pull), refresh)) continue;
        seen.add(pull.pull);
        if (fixture) {
          readFixture(fixture, pull);
          continue;
        }
        const ref = parseForgeRefUrl(pull.url);
        if (!ref || ref.kind !== "pull" || forgeRefKey(ref) !== pull.pull) {
          land(pull.pull, null);
        } else if (ref.platform === "github") {
          const repoKey = `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase();
          const batch = githubBatches.get(repoKey) ?? { host: ref.host, owner: ref.owner, repo: ref.repo, items: [] };
          batch.items.push({ key: pull.pull, number: ref.number });
          githubBatches.set(repoKey, batch);
        } else {
          jobs.push(readGitlab(pull.pull, pull.url));
        }
      }
      for (const batch of githubBatches.values()) {
        for (let i = 0; i < batch.items.length; i += CARD_MARKS_BATCH) jobs.push(readGithub(batch.host, batch.owner, batch.repo, batch.items.slice(i, i + CARD_MARKS_BATCH)));
      }
      await Promise.all(jobs.map((job) => job.catch(() => undefined)));
    },
  };
}

/** A thread's PRs as the window reads them: the live list with stack groups, and what was removed in the last 7 days. */
export function threadPullsAnswer(store: InboxStore, states: Pick<ThreadPullStates, "live">, threadId: string, now: number = Date.now()): InboxThreadPullsAnswer {
  const live = store.threadPulls(threadId);
  const removed = store.threadPullsRemoved(threadId, new Date(now - INBOX_THREAD_PULLS_REMOVED_MS).toISOString());
  return {
    pulls: live.map((pull) => inboxThreadPullWire(pull, states.live(pull.pull))),
    groups: inboxThreadPullGroups(live),
    removed: removed.map((pull) => inboxThreadPullWire(pull)),
  };
}

/**
 * The window's route (packages/server/inbox.ts runs its guards first: the
 * same origin, and for a change the owner's window only, so a tailnet guest
 * gets 403 and never reaches this). The person's add and remove are written
 * `by: person`; an edit alone wakes no one and notifies no one: the thread's
 * owner hears of it on its next wake (inboxPullsWakeLine).
 */
export function createThreadPullsRoute(options: {
  store: InboxStore;
  states: ThreadPullStates;
  serverSession: string;
  json: (data: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** The serverSession check of a write (`mismatch`: a window from before a restart). */
  sessionMismatch: (body: Record<string, unknown>) => Response | null;
  localOnly: () => Response;
  now?: () => number;
}) {
  const { store, states, json } = options;
  const now = options.now ?? Date.now;
  return {
    /** `owner`: this request may change the PRs and run gh / glab (the owner's window). */
    async route(req: Request, path: string, owner: boolean): Promise<Response | null> {
      const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/pulls$/.exec(path);
      if (!match) return null;
      if (req.method !== "GET" && req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const message = store.message(match[1]!);
      if (!message) return json({ error: `No thread ${match[1]}.`, code: "thread_not_found" }, 404);
      const threadId = message.thread_id;
      if (req.method === "POST") {
        if (!owner) return options.localOnly();
        const body = await options.readBody(req);
        const mismatch = options.sessionMismatch(body);
        if (mismatch) return mismatch;
        const add = body.add === undefined ? { refs: [] } : parseInboxThreadPullRefs(body.add, "add");
        if ("error" in add) throw new InboxError("validation_error", add.error, { field: add.field });
        const all = Array.isArray(body.remove) && body.remove.length === 1 && body.remove[0] === "all";
        const remove = all || body.remove === undefined ? { refs: [] } : parseInboxThreadPullRefs(body.remove, "remove");
        if ("error" in remove) throw new InboxError("validation_error", remove.error, { field: remove.field });
        const change = store.changeThreadPulls({ thread_id: threadId, add: add.refs, remove: all ? "all" : remove.refs, by: { kind: "person" } });
        // A PR just added is read at once, so the popover shows its state.
        if (change.added.length > 0) await states.refresh(change.added);
      } else if (owner) {
        // The thread was opened (or the window got its focus back): its PRs still in play are read if older than 30 s.
        await states.refresh(store.threadPulls(threadId), { refresh: true });
      }
      return json({ serverSession: options.serverSession, ...threadPullsAnswer(store, states, threadId, now()) });
    },
  };
}
