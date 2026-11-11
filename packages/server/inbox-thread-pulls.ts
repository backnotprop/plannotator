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
 *   the device door see it. Checks and the review verdict are kept here only;
 *   a change to them tells the windows (`onLiveChange`, `event: thread-pulls`).
 * - No gh or glab, signed out, a failure or a timeout: nothing is written, the
 *   PR keeps its last state (`unknown` until a first answer), the failure is
 *   kept for 1 min, and nothing nags. Why it failed is kept as a problem
 *   (inbox-thread-pull-problem.ts: one of six tool states in the one table's
 *   words) that the window's card shows under what is known; a new or
 *   cleared problem tells the windows like checks do. The person's Try again
 *   (`GET …/pulls?retry=1`) reads a held failure again at once.
 * - The window's read never waits on a forge: it answers what is known at
 *   once and reads behind it (a hover once said "Loading" for as long as a
 *   stuck glab ran). Every CLI has a hard deadline (the runner) and no slot is
 *   held forever (`createRefSlots`).
 */

import { forgeRefKey, parseForgeRefUrl, type ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import {
  inboxThreadPullGroups,
  inboxThreadPullText,
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
import { sessionLastSawThread } from "./inbox-session-reads";
import type { ProblemDiag } from "@plannotator/core/problem";
import { createToolStatus, type ToolStatus } from "@plannotator/shared/tool-state";
import { githubPullFailure, gitlabPullFailure, type ThreadPullFailure } from "./inbox-thread-pull-problem";
import { createRefSlots, REF_AUTH_HOSTS_MS, REF_FAILURE_MS, REF_RATE_LIMIT_MS, readSignedInHosts, refCliRunner, refErrorOf, type RefCards, type RefRunner } from "./ref-cards";

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
  live(key: string): { checks: InboxThreadPullChecks | null; review: InboxThreadPullReview | null; problem?: ThreadPullFailure["problem"] } | undefined;
  /** The private detail of a PR's last failed read (the tool's last line, exit, time), never sent; undefined when none. */
  diag(key: string): ProblemDiag | null | undefined;
  /**
   * Read the PRs still in play among `pulls` whose answer is not fresh, and
   * write each change on every thread that holds that PR. `refresh`: a read
   * older than 30 s counts as stale (a thread opened, the window's focus);
   * `retry`: the person's Try again, so a held failure is read again too.
   * Never throws.
   */
  refresh(pulls: readonly InboxThreadPull[], options?: { refresh?: boolean; retry?: boolean }): Promise<void>;
}

interface Cached {
  read: ThreadPullRead | null;
  at: number;
  /** Why the last read failed (read null), when known. */
  failure?: ThreadPullFailure;
}

export function createThreadPullStates(options: {
  store: InboxStore;
  run?: RefRunner;
  refCards?: RefCards;
  /** The gh / glab status check (default: the hover cards', else one of its own). */
  tools?: ToolStatus;
  now?: () => number;
  fixture?: (() => ThreadPullFixture | null) | null;
  /**
   * A read changed what only this reader keeps (checks, the review verdict) for these threads' PRs: the windows'
   * streams say so (`event: thread-pulls`), since no record is written for it. A changed state, title or branch is
   * a `thread_pull` record already.
   */
  onLiveChange?: (threadIds: readonly string[]) => void;
}): ThreadPullStates {
  const { store } = options;
  const run = options.run ?? refCliRunner;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Cached>();
  const pending = new Map<string, Promise<void>>();
  const holdUntil = new Map<string, number>();
  const tools = options.tools ?? options.refCards?.tools ?? createToolStatus({ run, now });
  let hosts: { at: number; ttl: number; set: Promise<Set<string>> } | null = null;
  // At most CARD_MARKS_MAX_CONCURRENT reads; never stuck (createRefSlots): a stalled queue fails its reads, kept as failures.
  const slots = createRefSlots(CARD_MARKS_MAX_CONCURRENT);
  const slot = <T>(job: () => Promise<T>): Promise<T> => slots.run(job);

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

  const fresh = (hit: Cached | undefined, refresh: boolean, retry = false): boolean => {
    if (!hit) return false;
    const age = now() - hit.at;
    if (!hit.read) return !retry && age < CARD_MARK_FAILURE_MS;
    return age < (refresh ? CARD_MARK_REFRESH_MS : CARD_MARK_FRESH_MS);
  };

  const tellWindows = (key: string) => {
    if (!options.onLiveChange) return;
    const threads = [...new Set(store.allThreadPulls().filter((pull) => pull.pull === key).map((pull) => pull.thread_id))];
    if (threads.length > 0) options.onLiveChange(threads);
  };

  /** One answer kept, and written on every live coupling of that PR. A failure keeps why (`failure`), when known. */
  const land = (key: string, read: ThreadPullRead | null, failure?: ThreadPullFailure) => {
    const prev = cache.get(key);
    const before = prev?.read;
    const problemBefore = prev?.failure?.problem.code ?? null;
    cache.set(key, { read, at: now(), ...(failure ? { failure } : {}) });
    // A problem that appeared, changed or cleared reaches the windows (the card shows it under what is known).
    const problemNow = read ? null : (failure?.problem.code ?? null);
    if (!read) {
      if (problemNow !== problemBefore) tellWindows(key);
      return;
    }
    if ((before?.checks ?? null) !== read.checks || (before?.review ?? null) !== read.review || problemBefore !== null) tellWindows(key);
    for (const pull of store.allThreadPulls()) {
      if (pull.pull !== key) continue;
      try {
        store.setThreadPullState(pull.thread_id, key, read);
      } catch {
        // A write that fails leaves the last state; the next read tries again.
      }
    }
  };

  const readGithub = (host: string, owner: string, repo: string, items: readonly { key: string; number: number; url: string }[]): Promise<void> => {
    const batchKey = `${host}/${owner}/${repo}`.toLowerCase() + "#" + items.map((i) => i.number).sort((a, b) => a - b).join(",");
    const inFlight = pending.get(batchKey);
    if (inFlight) return inFlight;
    const failAll = () => {
      for (const item of items) land(item.key, null);
    };
    /** Every PR of the batch failed: why, per PR (its own page for "Open on GitHub"), outside the slot. */
    const failWhy = async (run: Parameters<typeof githubPullFailure>[0]["run"], rateLimited = false) => {
      const why = await Promise.all(items.map((item) => githubPullFailure({ tools, host, url: item.url, at: now, run, rateLimited }).catch(() => undefined)));
      items.forEach((item, i) => land(item.key, null, why[i]));
    };
    const job = slot(async (): Promise<(() => Promise<void>) | void> => {
      if (now() < (holdUntil.get(host) ?? 0)) return () => failWhy(null, true);
      if (host !== "github.com" && !(await signedIn()).has(host)) return () => failWhy(null);
      const numbers = [...new Set(items.map((i) => i.number))];
      const startedAt = now();
      const result = await run("gh", ["api", "graphql", "--hostname", host, "-f", `query=${githubThreadPullsQuery(numbers)}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`]);
      let repository: Json | null = null;
      try {
        const r = obj(obj(JSON.parse(result.stdout)).data).repository;
        repository = r && typeof r === "object" ? (r as Json) : null;
      } catch {
        repository = null;
      }
      if (!repository) {
        const failed = { ...result, exitCode: result.exitCode || 1 };
        if (refErrorOf("gh", failed) === "rate_limited") holdUntil.set(host, now() + REF_RATE_LIMIT_MS);
        // Why, outside the slot: the status check it may wait on never holds another read.
        const ms = now() - startedAt;
        return () => failWhy({ result: failed, ms });
      }
      // A partial answer (one number not a PR) still carries the others.
      for (const item of items) land(item.key, githubThreadPullRead(repository[`n${item.number}`]));
    })
      .then((why) => (why ? why() : undefined))
      .catch(failAll)
      .finally(() => pending.delete(batchKey));
    pending.set(batchKey, job);
    return job;
  };

  const readGitlab = async (key: string, url: string, host: string, retry: boolean): Promise<void> => {
    const result = options.refCards ? await options.refCards.get(url, retry ? { retry } : undefined).catch(() => null) : null;
    const read = result?.ok ? cardDataThreadPullRead(result.data) : null;
    if (read || result?.ok) return land(key, read);
    const why = await gitlabPullFailure({ tools, refCards: options.refCards ?? null, host, url, at: now, result }).catch(() => undefined);
    land(key, null, why);
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
      const hit = cache.get(key);
      if (hit?.read) return { checks: hit.read.checks, review: hit.read.review };
      return hit?.failure ? { checks: null, review: null, problem: hit.failure.problem } : undefined;
    },
    diag(key) {
      return cache.get(key)?.failure?.diag;
    },
    async refresh(pulls, { refresh = false, retry = false } = {}) {
      const githubBatches = new Map<string, { host: string; owner: string; repo: string; items: { key: string; number: number; url: string }[] }>();
      const jobs: Promise<void>[] = [];
      const seen = new Set<string>();
      const fixture = options.fixture?.() ?? null;
      for (const pull of pulls) {
        // Merged and closed are final: never read again.
        if (pull.state === "merged" || pull.state === "closed") continue;
        if (seen.has(pull.pull) || fresh(cache.get(pull.pull), refresh, retry)) continue;
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
          batch.items.push({ key: pull.pull, number: ref.number, url: pull.url });
          githubBatches.set(repoKey, batch);
        } else {
          jobs.push(readGitlab(pull.pull, pull.url, ref.host, retry));
        }
      }
      for (const batch of githubBatches.values()) {
        for (let i = 0; i < batch.items.length; i += CARD_MARKS_BATCH) jobs.push(readGithub(batch.host, batch.owner, batch.repo, batch.items.slice(i, i + CARD_MARKS_BATCH)));
      }
      await Promise.all(jobs.map((job) => job.catch(() => undefined)));
    },
  };
}

/** How long the person's Add waits for the new PR's first read before answering with what is known. */
export const THREAD_PULLS_ADD_WAIT_MS = 1_500;

/**
 * How long the person's Try again waits for the read before answering with what is known: under the window's own
 * read limit (10 s), so the button never ends on a cancelled read; a slower tool answers later, over the stream.
 */
export const THREAD_PULLS_RETRY_WAIT_MS = 6_000;

/** Wait for `work`, but no longer than `ms`; never throws (the work goes on behind). */
function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
        // A PR just added is read at once, so the popover shows its state; a forge slower than
        // THREAD_PULLS_ADD_WAIT_MS answers later, over the stream (a `thread_pull` record, `event: thread-pulls`).
        if (change.added.length > 0) await settledWithin(states.refresh(change.added), THREAD_PULLS_ADD_WAIT_MS);
      } else if (owner && new URL(req.url).searchParams.get("retry") === "1") {
        // The person's Try again on the card: a held failure is read again now, and the answer waits a little for it.
        await settledWithin(states.refresh(store.threadPulls(threadId), { refresh: true, retry: true }), THREAD_PULLS_RETRY_WAIT_MS);
      } else if (owner) {
        // The thread was opened, a row's mark hovered, or the window got its focus back: the answer is what is known
        // now, at once, and its PRs still in play are read behind it if older than 30 s. Never waits on gh or glab:
        // what the read changes reaches the window over the stream (a `thread_pull` record, `event: thread-pulls`).
        void states.refresh(store.threadPulls(threadId), { refresh: true });
      }
      return json({ serverSession: options.serverSession, ...threadPullsAnswer(store, states, threadId, now()) });
    },
  };
}

/**
 * What the person changed on a thread's PRs since its owner last saw the
 * thread (the session's reads, its deliveries and its own messages, and its
 * own PR changes), as the wake says it (`pulls_changed`, inboxPullsWakeLine):
 * net, so a PR the person added and took off again is not named. Null for any
 * session but the thread's owner, or with nothing to say. Never throws.
 */
export function threadPullsChangedForWake(store: InboxStore, threadId: string, session: string): { added: string[]; removed: string[] } | null {
  try {
    if (store.threadOwner(threadId)?.session !== session) return null;
    let since = sessionLastSawThread(store, session, threadId) ?? "";
    for (const event of store.threadPullEvents(threadId)) {
      if (event.by.kind === "agent" && event.by.session === session && event.at > since) since = event.at;
    }
    const { added, removed } = store.personPullChangesSince(threadId, since);
    if (added.length + removed.length === 0) return null;
    return { added: added.map((pull) => inboxThreadPullText(pull)), removed: removed.map((pull) => inboxThreadPullText(pull)) };
  } catch {
    return null;
  }
}
